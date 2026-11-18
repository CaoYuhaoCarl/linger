package computerprofile

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

func recorded(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// commands answers each command line from a recording, a missing binary or
// a process error.
type commands map[string]func(ctx context.Context) ([]byte, error)

func (c commands) run(ctx context.Context, name string, args ...string) ([]byte, error) {
	answer, ok := c[strings.Join(append([]string{name}, args...), " ")]
	if !ok {
		return nil, &exec.Error{Name: name, Err: exec.ErrNotFound}
	}
	return answer(ctx)
}

func output(data []byte) func(context.Context) ([]byte, error) {
	return func(context.Context) ([]byte, error) { return data, nil }
}

// exitError is a real process exit, as nvidia-smi gives when no driver
// answers.
func exitError(t *testing.T) func(context.Context) ([]byte, error) {
	t.Helper()
	err := exec.Command("go", "tool", "-n", "no-such-tool-for-a-test").Run()
	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		t.Fatalf("could not produce an exit error: %v", err)
	}
	return func(context.Context) ([]byte, error) { return nil, exit }
}

func hang(ctx context.Context) ([]byte, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

const nvidiaQuery = "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits"

// linuxProber serves /proc/meminfo and a sysfs PCI tree of devices, keyed
// by address, each with its class, vendor and device IDs.
func linuxProber(t *testing.T, run commands, devices map[string][3]string) Prober {
	files := map[string][]byte{"/proc/meminfo": recorded(t, "meminfo")}
	addresses := make([]string, 0, len(devices))
	for address, ids := range devices {
		root := "/sys/bus/pci/devices/" + address
		addresses = append(addresses, root)
		files[root+"/class"], files[root+"/vendor"], files[root+"/device"] = []byte(ids[0]+"\n"), []byte(ids[1]+"\n"), []byte(ids[2]+"\n")
	}
	return Prober{
		GOOS: "linux", Run: run.run,
		ReadFile: func(path string) ([]byte, error) {
			if data, ok := files[path]; ok {
				return data, nil
			}
			return nil, os.ErrNotExist
		},
		Glob: func(string) ([]string, error) { return addresses, nil },
	}
}

func bytesOf(value uint64) *uint64 { return &value }

func TestLinuxProbeReadsNVIDIAFromNvidiaSMI(t *testing.T) {
	prober := linuxProber(t, commands{nvidiaQuery: output(recorded(t, "nvidia-smi-two-gpus.csv"))}, map[string][3]string{
		// The server's management VGA and the NVIDIA GPUs nvidia-smi already
		// listed are not repeated from sysfs.
		"0000:02:00.0": {"0x030000", "0x1a03", "0x2000"},
		"0000:27:00.0": {"0x030000", "0x10de", "0x2bb1"},
		"0000:00:14.0": {"0x0c0330", "0x8086", "0x7ae0"},
	})
	got := prober.Accelerators(t.Context())
	gpu := wire.ComputerAcceleratorGpu{Vendor: VendorNVIDIA, Name: "NVIDIA RTX PRO 6000 Blackwell Workstation Edition", MemoryBytes: bytesOf(97887 << 20)}
	want := wire.ComputerAccelerators{Probe: ProbeOK, RamTotalBytes: 527928832 << 10, Gpus: []wire.ComputerAcceleratorGpu{gpu, gpu}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("accelerators = %+v, want %+v", got, want)
	}
}

// GB10-class systems answer [N/A] for memory.total; the GPU stays listed
// with its memory unknown.
func TestLinuxProbeKeepsAnNVIDIAGPUWithUnknownMemory(t *testing.T) {
	got := linuxProber(t, commands{nvidiaQuery: output(recorded(t, "nvidia-smi-memory-unknown.csv"))}, nil).Accelerators(t.Context())
	if got.Probe != ProbeOK || len(got.Gpus) != 1 || got.Gpus[0].Vendor != VendorNVIDIA || got.Gpus[0].MemoryBytes != nil {
		t.Fatalf("accelerators = %+v", got)
	}
}

// Without nvidia-smi, or when it exits because no driver answers, there is
// no usable NVIDIA GPU; the probe still succeeds and lists AMD or Intel GPUs.
func TestLinuxProbeWithoutAWorkingNVIDIADriverListsNoNVIDIAGPU(t *testing.T) {
	devices := map[string][3]string{
		"0000:03:00.0": {"0x030000", "0x1002", "0x73bf"},
		"0000:27:00.0": {"0x030200", "0x10de", "0x2bb1"},
	}
	for name, run := range map[string]commands{
		"missing binary": {},
		"driver failure": {nvidiaQuery: exitError(t)},
	} {
		t.Run(name, func(t *testing.T) {
			got := linuxProber(t, run, devices).Accelerators(t.Context())
			want := []wire.ComputerAcceleratorGpu{{Vendor: VendorAMD, Name: "AMD GPU (1002:73bf)"}}
			if got.Probe != ProbeOK || !reflect.DeepEqual(got.Gpus, want) {
				t.Fatalf("accelerators = %+v", got)
			}
		})
	}
}

// A hung nvidia-smi (a wedged driver) ends the probe at its timeout with
// probe failed, which says nothing about the hardware.
func TestProbeTimesOutAsFailed(t *testing.T) {
	prober := linuxProber(t, commands{nvidiaQuery: hang}, nil)
	prober.Timeout = 50 * time.Millisecond
	started := time.Now()
	got := prober.Accelerators(t.Context())
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("probe took %s", elapsed)
	}
	want := wire.ComputerAccelerators{Probe: ProbeFailed, Gpus: []wire.ComputerAcceleratorGpu{}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("accelerators = %+v", got)
	}
}

func TestLinuxProbeWithoutMeminfoFails(t *testing.T) {
	prober := Prober{
		GOOS: "linux", Run: commands{}.run,
		ReadFile: func(string) ([]byte, error) { return nil, os.ErrNotExist },
		Glob:     func(string) ([]string, error) { return nil, nil },
	}
	if got := prober.Accelerators(t.Context()); got.Probe != ProbeFailed {
		t.Fatalf("accelerators = %+v", got)
	}
}

// Apple silicon's GPU runs on unified memory, which is all of hw.memsize.
func TestDarwinProbeReadsAppleSiliconUnifiedMemory(t *testing.T) {
	memory := recorded(t, "sysctl-hw.memsize-m3max")
	got := Prober{GOOS: "darwin", Run: commands{
		"sysctl -n hw.memsize":               output(memory),
		"sysctl -n hw.optional.arm64":        output([]byte("1\n")),
		"sysctl -n machdep.cpu.brand_string": output(recorded(t, "sysctl-brand-m3max")),
		// nvidia-smi is never run on a Mac.
		nvidiaQuery: func(context.Context) ([]byte, error) { panic("nvidia-smi ran on darwin") },
	}.run}.Accelerators(t.Context())
	want := wire.ComputerAccelerators{
		Probe: ProbeOK, RamTotalBytes: 64 << 30, AppleSilicon: true, UnifiedMemoryBytes: bytesOf(64 << 30),
		Gpus: []wire.ComputerAcceleratorGpu{{Vendor: VendorApple, Name: "Apple M3 Max"}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("accelerators = %+v, want %+v", got, want)
	}
}

// An Intel Mac has no hw.optional.arm64; sysctl exits with an error.
func TestDarwinProbeReportsAnIntelMac(t *testing.T) {
	got := Prober{GOOS: "darwin", Run: commands{
		"sysctl -n hw.memsize":        output(recorded(t, "sysctl-hw.memsize-intel")),
		"sysctl -n hw.optional.arm64": exitError(t),
	}.run}.Accelerators(t.Context())
	want := wire.ComputerAccelerators{Probe: ProbeOK, RamTotalBytes: 16 << 30, Gpus: []wire.ComputerAcceleratorGpu{}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("accelerators = %+v, want %+v", got, want)
	}
}

func TestWindowsProbeReadsMemoryAndNonNVIDIAAdapters(t *testing.T) {
	got := Prober{GOOS: "windows", Run: commands{
		"powershell.exe -NoProfile -NonInteractive -Command " + windowsProbeScript: output(recorded(t, "windows-probe.json")),
		nvidiaQuery: output([]byte("NVIDIA GeForce RTX 4070, 12282\n")),
	}.run}.Accelerators(t.Context())
	want := wire.ComputerAccelerators{Probe: ProbeOK, RamTotalBytes: 34282242048, Gpus: []wire.ComputerAcceleratorGpu{
		{Vendor: VendorNVIDIA, Name: "NVIDIA GeForce RTX 4070", MemoryBytes: bytesOf(12282 << 20)},
		{Vendor: VendorIntel, Name: "Intel(R) UHD Graphics 770"},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("accelerators = %+v, want %+v", got, want)
	}
}

func TestWindowsProbeFailsWhenPowerShellDoesNotAnswer(t *testing.T) {
	got := Prober{GOOS: "windows", Run: commands{
		"powershell.exe -NoProfile -NonInteractive -Command " + windowsProbeScript: exitError(t),
	}.run}.Accelerators(t.Context())
	if got.Probe != ProbeFailed {
		t.Fatalf("accelerators = %+v", got)
	}
}

func TestInstallKind(t *testing.T) {
	present := func(paths ...string) func(string) error {
		return func(path string) error {
			for _, candidate := range paths {
				if candidate == path {
					return nil
				}
			}
			return os.ErrNotExist
		}
	}
	cgroup := func(content string) func(string) ([]byte, error) {
		return func(string) ([]byte, error) { return []byte(content), nil }
	}
	for _, test := range []struct {
		name     string
		desktop  bool
		goos     string
		stat     func(string) error
		readFile func(string) ([]byte, error)
		want     string
	}{
		{"desktop wins", true, "linux", present("/.dockerenv"), cgroup(""), InstallDesktop},
		{"docker", false, "linux", present("/.dockerenv"), cgroup("0::/\n"), InstallContainer},
		{"podman", false, "linux", present("/run/.containerenv"), cgroup("0::/\n"), InstallContainer},
		{"docker cgroup v1", false, "linux", present(), cgroup("12:memory:/docker/0123abcd\n"), InstallContainer},
		{"podman under systemd", false, "linux", present(), cgroup("0::/machine.slice/libpod-0123abcd.scope\n"), InstallContainer},
		{"kubernetes", false, "linux", present(), cgroup("0::/kubepods.slice/kubepods-burstable.slice\n"), InstallContainer},
		{"host", false, "linux", present(), cgroup("0::/init.scope\n"), InstallCLI},
		{"host without proc", false, "linux", present(), func(string) ([]byte, error) { return nil, os.ErrNotExist }, InstallCLI},
		{"mac", false, "darwin", present("/.dockerenv"), cgroup(""), InstallCLI},
		{"windows", false, "windows", present(), cgroup(""), InstallCLI},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := InstallKind(test.desktop, test.goos, test.stat, test.readFile); got != test.want {
				t.Fatalf("install kind = %s, want %s", got, test.want)
			}
		})
	}
}
