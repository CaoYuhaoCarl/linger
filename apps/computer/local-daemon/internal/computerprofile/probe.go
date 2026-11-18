// Package computerprofile gathers the facts runner.computer_profile reports:
// how the Computer was installed, its accelerators, its local-models mode and
// its last self-update attempt. None of them needs the localmodels tool.
package computerprofile

import (
	"bufio"
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

// ProbeTimeout bounds one hardware probe. A broken GPU driver can hang
// nvidia-smi; the probe then reports failed instead of waiting.
const ProbeTimeout = 5 * time.Second

// Accelerator vendors and probe outcomes, as the wire names them.
const (
	VendorNVIDIA = "nvidia"
	VendorAMD    = "amd"
	VendorIntel  = "intel"
	VendorApple  = "apple"

	ProbeOK     = "ok"
	ProbeFailed = "failed"
)

// PCI vendor IDs of the OS device list.
const (
	pciVendorAMD   = "1002"
	pciVendorIntel = "8086"
)

// maxGPUs is the wire's limit on listed GPUs.
const maxGPUs = 64

// Prober reads the hardware with the operating system's own tools. Run and
// ReadFile default to the real process and filesystem; tests replace them.
type Prober struct {
	GOOS string
	// Run runs a command and returns its standard output.
	Run func(ctx context.Context, name string, args ...string) ([]byte, error)
	// ReadFile reads a file; Glob lists paths.
	ReadFile func(path string) ([]byte, error)
	Glob     func(pattern string) ([]string, error)
	Timeout  time.Duration
}

// errProbeIncomplete marks a probe step whose answer says nothing about the
// hardware, so the whole probe reports failed.
var errProbeIncomplete = errors.New("hardware probe incomplete")

// Accelerators probes the hardware. NVIDIA GPUs come only from nvidia-smi:
// without a working driver no model runs on them, so a GPU the OS lists but
// nvidia-smi cannot read is not reported as NVIDIA. Apple silicon and its
// unified memory come from sysctl. AMD and Intel GPUs come from the OS device
// list, by name only.
func (p Prober) Accelerators(ctx context.Context) wire.ComputerAccelerators {
	p = p.withDefaults()
	ctx, cancel := context.WithTimeout(ctx, p.Timeout)
	defer cancel()
	failed := wire.ComputerAccelerators{Probe: ProbeFailed, Gpus: []wire.ComputerAcceleratorGpu{}}
	var (
		wait      sync.WaitGroup
		nvidia    []wire.ComputerAcceleratorGpu
		nvidiaErr error
	)
	if p.GOOS != "darwin" {
		wait.Add(1)
		go func() {
			defer wait.Done()
			nvidia, nvidiaErr = p.nvidiaGPUs(ctx)
		}()
	}
	var result wire.ComputerAccelerators
	var err error
	switch p.GOOS {
	case "darwin":
		result, err = p.darwin(ctx)
	case "linux":
		result, err = p.linux()
	case "windows":
		result, err = p.windows(ctx)
	default:
		err = errProbeIncomplete
	}
	wait.Wait()
	if err != nil || nvidiaErr != nil || ctx.Err() != nil {
		return failed
	}
	result.Probe = ProbeOK
	result.Gpus = append(nvidia, result.Gpus...)
	if result.Gpus == nil {
		result.Gpus = []wire.ComputerAcceleratorGpu{}
	}
	if len(result.Gpus) > maxGPUs {
		result.Gpus = result.Gpus[:maxGPUs]
	}
	return result
}

func (p Prober) withDefaults() Prober {
	if p.Run == nil {
		p.Run = runCommand
	}
	if p.ReadFile == nil {
		p.ReadFile = os.ReadFile
	}
	if p.Glob == nil {
		p.Glob = filepath.Glob
	}
	if p.Timeout <= 0 {
		p.Timeout = ProbeTimeout
	}
	return p
}

func runCommand(ctx context.Context, name string, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, name, args...)
	command.WaitDelay = time.Second
	return command.Output()
}

// nvidiaGPUs lists the GPUs nvidia-smi reports. A missing nvidia-smi, or one
// that exits with an error because no driver answers, means no usable NVIDIA
// GPU. Only a timeout or unreadable output leaves the answer unknown.
func (p Prober) nvidiaGPUs(ctx context.Context) ([]wire.ComputerAcceleratorGpu, error) {
	output, err := p.Run(ctx, "nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits")
	var exitError *exec.ExitError
	switch {
	case ctx.Err() != nil:
		return nil, errProbeIncomplete
	case errors.Is(err, exec.ErrNotFound), errors.As(err, &exitError):
		return nil, nil
	case err != nil:
		return nil, err
	}
	records, err := csv.NewReader(bytes.NewReader(output)).ReadAll()
	if err != nil {
		return nil, errProbeIncomplete
	}
	gpus := make([]wire.ComputerAcceleratorGpu, 0, len(records))
	for _, record := range records {
		if len(record) != 2 {
			return nil, errProbeIncomplete
		}
		name := strings.TrimSpace(record[0])
		if name == "" {
			return nil, errProbeIncomplete
		}
		gpu := wire.ComputerAcceleratorGpu{Vendor: VendorNVIDIA, Name: displayName(name)}
		// memory.total is in MiB; "[N/A]" leaves it unknown.
		if mebibytes, err := strconv.ParseUint(strings.TrimSpace(record[1]), 10, 32); err == nil {
			bytes := mebibytes << 20
			gpu.MemoryBytes = &bytes
		}
		gpus = append(gpus, gpu)
	}
	return gpus, nil
}

// darwin reads the memory size and whether the CPU is Apple silicon. On
// Apple silicon the GPU shares that memory, so it is also the unified memory.
func (p Prober) darwin(ctx context.Context) (wire.ComputerAccelerators, error) {
	memory, err := p.sysctlUint(ctx, "hw.memsize")
	if err != nil {
		return wire.ComputerAccelerators{}, err
	}
	result := wire.ComputerAccelerators{RamTotalBytes: memory}
	// An Intel Mac has no hw.optional.arm64, and sysctl exits with an error.
	arm64, err := p.sysctlUint(ctx, "hw.optional.arm64")
	if ctx.Err() != nil {
		return wire.ComputerAccelerators{}, errProbeIncomplete
	}
	if appleSilicon := err == nil && arm64 == 1; !appleSilicon {
		return result, nil
	}
	result.AppleSilicon, result.UnifiedMemoryBytes = true, &memory
	name := "Apple silicon"
	if brand, err := p.Run(ctx, "sysctl", "-n", "machdep.cpu.brand_string"); err == nil && strings.TrimSpace(string(brand)) != "" {
		name = displayName(strings.TrimSpace(string(brand)))
	}
	result.Gpus = []wire.ComputerAcceleratorGpu{{Vendor: VendorApple, Name: name}}
	return result, nil
}

func (p Prober) sysctlUint(ctx context.Context, name string) (uint64, error) {
	output, err := p.Run(ctx, "sysctl", "-n", name)
	if err != nil {
		return 0, err
	}
	value, err := strconv.ParseUint(strings.TrimSpace(string(output)), 10, 64)
	if err != nil {
		return 0, errProbeIncomplete
	}
	return value, nil
}

// linux reads MemTotal and lists display-class PCI devices from sysfs.
func (p Prober) linux() (wire.ComputerAccelerators, error) {
	meminfo, err := p.ReadFile("/proc/meminfo")
	if err != nil {
		return wire.ComputerAccelerators{}, errProbeIncomplete
	}
	var memory uint64
	scanner := bufio.NewScanner(bytes.NewReader(meminfo))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 3 && fields[0] == "MemTotal:" && fields[2] == "kB" {
			memory, err = strconv.ParseUint(fields[1], 10, 64)
			if err != nil {
				return wire.ComputerAccelerators{}, errProbeIncomplete
			}
			memory <<= 10
		}
	}
	if memory == 0 {
		return wire.ComputerAccelerators{}, errProbeIncomplete
	}
	result := wire.ComputerAccelerators{RamTotalBytes: memory}
	devices, _ := p.Glob("/sys/bus/pci/devices/*")
	for _, device := range devices {
		class, classErr := p.ReadFile(filepath.Join(device, "class"))
		vendor, vendorErr := p.ReadFile(filepath.Join(device, "vendor"))
		model, _ := p.ReadFile(filepath.Join(device, "device"))
		// PCI base class 0x03 is a display controller.
		if classErr != nil || vendorErr != nil || !strings.HasPrefix(strings.TrimSpace(string(class)), "0x03") {
			continue
		}
		if gpu, listed := osListedGPU(pciID(vendor), pciID(model)); listed {
			result.Gpus = append(result.Gpus, gpu)
		}
	}
	return result, nil
}

func pciID(raw []byte) string {
	return strings.ToLower(strings.TrimPrefix(strings.TrimSpace(string(raw)), "0x"))
}

// osListedGPU names an AMD or Intel GPU from the OS device list by its PCI
// IDs, so the page can say which GPU is not supported. NVIDIA GPUs are left
// to nvidia-smi; other display controllers (a server's management VGA, a
// virtual machine's display) run no models and are not listed.
func osListedGPU(vendor, device string) (wire.ComputerAcceleratorGpu, bool) {
	id := vendor
	if device != "" {
		id += ":" + device
	}
	switch vendor {
	case pciVendorAMD:
		return wire.ComputerAcceleratorGpu{Vendor: VendorAMD, Name: "AMD GPU (" + id + ")"}, true
	case pciVendorIntel:
		return wire.ComputerAcceleratorGpu{Vendor: VendorIntel, Name: "Intel GPU (" + id + ")"}, true
	}
	return wire.ComputerAcceleratorGpu{}, false
}

// windowsProbeScript prints the physical memory and the display adapters
// with their PnP device IDs, which carry the PCI vendor.
const windowsProbeScript = `$ErrorActionPreference='Stop';` +
	`$m=(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory;` +
	`$g=@(Get-CimInstance Win32_VideoController|ForEach-Object{[pscustomobject]@{name=$_.Name;pnp=$_.PNPDeviceID}});` +
	`[pscustomobject]@{memory=[uint64]$m;gpus=$g}|ConvertTo-Json -Compress -Depth 3`

func (p Prober) windows(ctx context.Context) (wire.ComputerAccelerators, error) {
	output, err := p.Run(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", windowsProbeScript)
	if err != nil {
		return wire.ComputerAccelerators{}, errProbeIncomplete
	}
	var decoded struct {
		Memory uint64 `json:"memory"`
		GPUs   []struct {
			Name string `json:"name"`
			PNP  string `json:"pnp"`
		} `json:"gpus"`
	}
	if err := json.Unmarshal(output, &decoded); err != nil || decoded.Memory == 0 {
		return wire.ComputerAccelerators{}, errProbeIncomplete
	}
	result := wire.ComputerAccelerators{RamTotalBytes: decoded.Memory}
	for _, adapter := range decoded.GPUs {
		vendor, device := windowsPCIIDs(adapter.PNP)
		gpu, listed := osListedGPU(vendor, device)
		if !listed {
			continue
		}
		if name := strings.TrimSpace(adapter.Name); name != "" {
			gpu.Name = displayName(name)
		}
		result.Gpus = append(result.Gpus, gpu)
	}
	return result, nil
}

// windowsPCIIDs reads VEN_ and DEV_ from a PnP device ID such as
// PCI\VEN_10DE&DEV_2684&SUBSYS_...; a non-PCI adapter has neither.
func windowsPCIIDs(pnp string) (string, string) {
	var vendor, device string
	for _, part := range strings.FieldsFunc(strings.ToUpper(pnp), func(r rune) bool { return r == '\\' || r == '&' }) {
		switch {
		case vendor == "" && strings.HasPrefix(part, "VEN_"):
			vendor = strings.ToLower(strings.TrimPrefix(part, "VEN_"))
		case device == "" && strings.HasPrefix(part, "DEV_"):
			device = strings.ToLower(strings.TrimPrefix(part, "DEV_"))
		}
	}
	return vendor, device
}

// displayName bounds a name to the wire's 200 characters.
func displayName(name string) string {
	runes := []rune(name)
	if len(runes) > 200 {
		return string(runes[:200])
	}
	return name
}
