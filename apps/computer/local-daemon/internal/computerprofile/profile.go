package computerprofile

import (
	"context"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/computerconfig"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/selfupdate"
	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

// Install kinds, as the wire names them.
const (
	InstallDesktop   = "desktop"
	InstallCLI       = "cli"
	InstallContainer = "container"
)

// containerRuntimeCgroups are cgroup path segments container runtimes create
// for PID 1: Docker, containerd, Kubernetes, Podman and LXC.
var containerRuntimeCgroups = []string{"docker", "containerd", "kubepods", "libpod", "lxc"}

// InstallKind tells a Desktop child, a container and a host install apart.
// A container is known from the marker files Docker (/.dockerenv) and Podman
// (/run/.containerenv) create, or from PID 1's cgroup path.
func InstallKind(desktop bool, goos string, stat func(string) error, readFile func(string) ([]byte, error)) string {
	if desktop {
		return InstallDesktop
	}
	if goos != "linux" {
		return InstallCLI
	}
	for _, marker := range []string{"/.dockerenv", "/run/.containerenv"} {
		if stat(marker) == nil {
			return InstallContainer
		}
	}
	cgroups, err := readFile("/proc/1/cgroup")
	if err != nil {
		return InstallCLI
	}
	for _, line := range strings.Split(string(cgroups), "\n") {
		// hierarchy-ID:controllers:path
		parts := strings.SplitN(line, ":", 3)
		if len(parts) != 3 {
			continue
		}
		for _, segment := range strings.FieldsFunc(parts[2], func(r rune) bool { return r == '/' || r == '-' || r == '.' }) {
			for _, name := range containerRuntimeCgroups {
				if segment == name {
					return InstallContainer
				}
			}
		}
	}
	return InstallCLI
}

// HostInstallKind is InstallKind on this host.
func HostInstallKind(desktop bool, goos string) string {
	return InstallKind(desktop, goos, func(path string) error {
		_, err := os.Stat(path)
		return err
	}, os.ReadFile)
}

// LocalModels reports the config's local_models section.
func LocalModels(config computerconfig.Config) wire.ComputerProfileLocalModels {
	switch {
	case config.RemoteLocalModels != nil:
		return wire.ComputerProfileLocalModels{Mode: "remote", ManagedBy: &wire.ComputerProfileManagedBy{
			Label: config.RemoteLocalModels.Label, ComputerID: config.RemoteLocalModels.ComputerID,
		}}
	case config.LocalModels != nil:
		managed := config.LocalModels.Managed
		return wire.ComputerProfileLocalModels{Mode: "local", Managed: &managed}
	}
	return wire.ComputerProfileLocalModels{Mode: "none"}
}

// Update reports a self-update status.
func Update(status selfupdate.Status) wire.ComputerProfileUpdate {
	update := wire.ComputerProfileUpdate{State: status.State, ErrorCode: status.ErrorCode, Detail: status.Detail}
	if !status.AttemptedAt.IsZero() {
		update.AttemptedAt = status.AttemptedAt.UTC().Format(time.RFC3339Nano)
	}
	return update
}

// Reporter keeps the Computer's profile: the fixed facts from the config,
// the accelerators of the last probe and the live self-update status.
type Reporter struct {
	installKind string
	localModels wire.ComputerProfileLocalModels
	// update is nil for a Computer that does not update itself.
	update func() selfupdate.Status
	prober Prober

	mu           sync.Mutex
	accelerators wire.ComputerAccelerators
	probed       bool
}

// NewReporter starts with failed accelerators until the first Probe. update
// is nil for a Computer that does not update itself (the desktop app ships
// it), which reports idle.
func NewReporter(installKind string, localModels wire.ComputerProfileLocalModels, update func() selfupdate.Status, prober Prober) *Reporter {
	return &Reporter{
		installKind: installKind, localModels: localModels, update: update, prober: prober,
		accelerators: wire.ComputerAccelerators{Probe: ProbeFailed, Gpus: []wire.ComputerAcceleratorGpu{}},
	}
}

// Probe rereads the hardware; it returns within the probe timeout.
func (r *Reporter) Probe(ctx context.Context) {
	accelerators := r.prober.Accelerators(ctx)
	r.mu.Lock()
	r.accelerators, r.probed = accelerators, true
	r.mu.Unlock()
}

// Current is the profile with the last probe's accelerators; probed is
// false before the first Probe.
func (r *Reporter) Current() (wire.ComputerProfile, bool) {
	r.mu.Lock()
	accelerators, probed := r.accelerators, r.probed
	r.mu.Unlock()
	update := wire.ComputerProfileUpdate{State: selfupdate.StatusIdle}
	if r.update != nil {
		update = Update(r.update())
	}
	return wire.ComputerProfile{InstallKind: r.installKind, Accelerators: accelerators, LocalModels: r.localModels, Update: update}, probed
}
