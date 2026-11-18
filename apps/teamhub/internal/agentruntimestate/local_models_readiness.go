package agentruntimestate

import (
	"encoding/json"
	"regexp"
	"strconv"
	"time"

	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// Computer release boundaries readiness reads from daemon_version. The Agent
// Service's local-computer-management.ts owns the gates; a test pins the
// shared ones against it.
const (
	// firstProtocol2ComputerVersion is the oldest release that still connects;
	// anything older is reinstalled.
	firstProtocol2ComputerVersion = "0.43.0"
	// firstLingerComputerVersion is the first release after the Simplex to
	// Linger rename. Older releases fail every self-update because their
	// archive layout changed.
	firstLingerComputerVersion = "0.51.0"
	// firstServiceFeaturesComputerVersion is the first release that is told
	// to send runner.local_models. Some 0.51.0 builds already send it, so this
	// boundary counts only for a Computer without a snapshot.
	firstServiceFeaturesComputerVersion = "0.52.0"
)

// Hardware floors below which local-model setup is not offered (no CPU-only
// mode). docs/local-inference.md publishes the same table; a test pins it.
const (
	appleSiliconMinimumUnifiedMemoryBytes int64 = 16 << 30
	nvidiaMinimumVRAMBytes                int64 = 8 << 30
)

// checkingWindow is how long a connected Computer without a snapshot reads
// as checking: a release that reports local models sends its library right
// after hello.
const checkingWindow = 2 * time.Minute

// LocalModelsSummary is what local_models_snapshot_summary (migration
// 00876) keeps from a stored snapshot.
type LocalModelsSummary struct {
	Available bool    `json:"available"`
	Reason    *string `json:"reason"`
	Counts    struct {
		Loaded  int `json:"loaded"`
		OnDisk  int `json:"on_disk"`
		Working int `json:"working"`
	} `json:"counts"`
	// Usable counts models on disk or downloadable; zero means nothing fits.
	Usable          int     `json:"usable"`
	UnavailableCode *string `json:"unavailable_code"`
	Memory          *struct {
		Kind       string `json:"kind"`
		UsedBytes  int64  `json:"used_bytes"`
		TotalBytes int64  `json:"total_bytes"`
	} `json:"memory"`
	Host *struct {
		Platform string `json:"platform"`
		Arch     string `json:"arch"`
		// GPUs counts the GPUs localmodels reported. Its engine uses CUDA off
		// macOS, so it reports only NVIDIA GPUs.
		GPUs int `json:"gpus"`
	} `json:"host"`
}

// ParseLocalModelsSummary reads a stored summary; nil for none.
func ParseLocalModelsSummary(raw []byte) (*LocalModelsSummary, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var summary LocalModelsSummary
	if err := json.Unmarshal(raw, &summary); err != nil {
		return nil, err
	}
	return &summary, nil
}

// LocalModelsReadinessFacts is what TeamHub knows about one Computer.
type LocalModelsReadinessFacts struct {
	// Status is the stored status: online, offline or upgrade_required.
	Status string
	// Online is true while the Runner Gateway's observation is fresh.
	Online bool
	// DaemonVersion is empty when the Computer never reported one.
	DaemonVersion string
	Platform      string
	ConnectedAt   *time.Time
	// Summary is nil when the Computer never sent a snapshot.
	Summary *LocalModelsSummary
	// Accelerators is nil until the Computer reports a profile.
	Accelerators *httpapi.LocalComputerAccelerators
}

// LocalModelsReadiness applies the readiness rules in order; the first match
// wins. Offline is not a state: an offline Computer keeps its readiness.
func LocalModelsReadiness(facts LocalModelsReadinessFacts, now time.Time) httpapi.LocalModelsReadiness {
	path := localModelsSetupPath(facts)
	readiness := func(state httpapi.LocalModelsReadinessState, reason httpapi.LocalModelsReadinessReason) httpapi.LocalModelsReadiness {
		result := httpapi.LocalModelsReadiness{State: state, SetupPath: &path}
		if reason != "" {
			result.Reason = &reason
		}
		return result
	}
	versionKnown := facts.DaemonVersion != ""
	switch {
	case facts.Status == "upgrade_required" ||
		versionKnown && !computerVersionAtLeast(facts.DaemonVersion, firstProtocol2ComputerVersion):
		return readiness(httpapi.LocalModelsReadinessNeedsReinstall, httpapi.LocalModelsReadinessDaemonUnsupported)
	case versionKnown && !computerVersionAtLeast(facts.DaemonVersion, firstLingerComputerVersion):
		return readiness(httpapi.LocalModelsReadinessNeedsReinstall, httpapi.LocalModelsReadinessDaemonLegacy)
	}
	summary := facts.Summary
	if summary == nil {
		switch {
		case versionKnown && !computerVersionAtLeast(facts.DaemonVersion, firstServiceFeaturesComputerVersion):
			return readiness(httpapi.LocalModelsReadinessNeedsUpdate, httpapi.LocalModelsReadinessUpdatePending)
		case facts.Online && facts.ConnectedAt != nil && now.Sub(*facts.ConnectedAt) < checkingWindow:
			return readiness(httpapi.LocalModelsReadinessChecking, "")
		default:
			return readiness(httpapi.LocalModelsReadinessNotReported, httpapi.LocalModelsReadinessNotReportedReason)
		}
	}
	if !summary.Available {
		if summary.Reason != nil && *summary.Reason == "TOOL_FAILED" {
			return readiness(httpapi.LocalModelsReadinessNeedsAttention, httpapi.LocalModelsReadinessToolFailed)
		}
		state, reason := localModelsSetupReadiness(facts)
		return readiness(state, reason)
	}
	if reason, unsupported := unsupportedLocalModelsHost(facts); unsupported {
		return readiness(httpapi.LocalModelsReadinessUnsupportedHardware, reason)
	}
	switch {
	case summary.Counts.Working > 0:
		return readiness(httpapi.LocalModelsReadinessWorking, "")
	case summary.Counts.Loaded > 0:
		return readiness(httpapi.LocalModelsReadinessLoaded, "")
	case summary.Usable == 0:
		reason := httpapi.LocalModelsReadinessPlatformUnsupported
		if summary.UnavailableCode != nil {
			if code := httpapi.LocalModelsReadinessReason(*summary.UnavailableCode); code.Valid() {
				reason = code
			}
		}
		return readiness(httpapi.LocalModelsReadinessUnsupportedHardware, reason)
	default:
		return readiness(httpapi.LocalModelsReadinessReady, "")
	}
}

// localModelsSetupReadiness decides a Computer without the tool against the
// hardware floors, or reports that its hardware is unknown.
func localModelsSetupReadiness(facts LocalModelsReadinessFacts) (httpapi.LocalModelsReadinessState, httpapi.LocalModelsReadinessReason) {
	accelerators := facts.Accelerators
	if accelerators == nil || accelerators.Probe != httpapi.LocalComputerAcceleratorProbeOk {
		return httpapi.LocalModelsReadinessNotSetUp, httpapi.LocalModelsReadinessHardwareUnknown
	}
	unsupported := httpapi.LocalModelsReadinessUnsupportedHardware
	if accelerators.AppleSilicon {
		memory := accelerators.RamTotalBytes
		if accelerators.UnifiedMemoryBytes != nil {
			memory = *accelerators.UnifiedMemoryBytes
		}
		if memory < appleSiliconMinimumUnifiedMemoryBytes {
			return unsupported, httpapi.LocalModelsReadinessMemoryInsufficient
		}
		return httpapi.LocalModelsReadinessNotSetUp, httpapi.LocalModelsReadinessSetupAvailable
	}
	if facts.Platform == "darwin" {
		return unsupported, httpapi.LocalModelsReadinessPlatformUnsupported
	}
	nvidia := false
	for _, gpu := range accelerators.Gpus {
		if gpu.Vendor != httpapi.LocalComputerGpuVendorNvidia {
			continue
		}
		nvidia = true
		// A GPU whose memory the probe could not read gets the benefit of the
		// doubt; local-models enable checks it again.
		if gpu.MemoryBytes == nil || *gpu.MemoryBytes >= nvidiaMinimumVRAMBytes {
			return httpapi.LocalModelsReadinessNotSetUp, httpapi.LocalModelsReadinessSetupAvailable
		}
	}
	if nvidia {
		return unsupported, httpapi.LocalModelsReadinessMemoryInsufficient
	}
	return unsupported, httpapi.LocalModelsReadinessNoSupportedGpu
}

// unsupportedLocalModelsHost reports a Computer whose tool runs without a
// supported GPU path: neither Apple silicon nor an NVIDIA GPU. The tool may
// still offer models from system memory, but there is no CPU-only mode.
func unsupportedLocalModelsHost(facts LocalModelsReadinessFacts) (httpapi.LocalModelsReadinessReason, bool) {
	if accelerators := facts.Accelerators; accelerators != nil && accelerators.Probe == httpapi.LocalComputerAcceleratorProbeOk {
		if accelerators.AppleSilicon || hasNVIDIAGPU(accelerators) {
			return "", false
		}
		if facts.Platform == "darwin" {
			return httpapi.LocalModelsReadinessPlatformUnsupported, true
		}
		return httpapi.LocalModelsReadinessNoSupportedGpu, true
	}
	host := facts.Summary.Host
	switch {
	case host == nil, host.Platform == "darwin" && host.Arch == "arm64", host.Platform != "darwin" && host.GPUs > 0:
		return "", false
	case host.Platform == "darwin":
		return httpapi.LocalModelsReadinessPlatformUnsupported, true
	default:
		return httpapi.LocalModelsReadinessNoSupportedGpu, true
	}
}

// localModelsSetupPath names the guided setup from the best hardware facts
// TeamHub has: the profile's accelerators, else the last snapshot host.
func localModelsSetupPath(facts LocalModelsReadinessFacts) httpapi.LocalModelsSetupPath {
	if accelerators := facts.Accelerators; accelerators != nil && accelerators.Probe == httpapi.LocalComputerAcceleratorProbeOk {
		switch {
		case accelerators.AppleSilicon:
			return httpapi.LocalModelsSetupPathAppleSilicon
		case hasNVIDIAGPU(accelerators):
			return httpapi.LocalModelsSetupPathNvidia
		}
		return httpapi.LocalModelsSetupPathUnknown
	}
	if facts.Summary != nil && facts.Summary.Host != nil {
		host := facts.Summary.Host
		switch {
		case host.Platform == "darwin" && host.Arch == "arm64":
			return httpapi.LocalModelsSetupPathAppleSilicon
		case host.Platform != "darwin" && host.GPUs > 0:
			return httpapi.LocalModelsSetupPathNvidia
		}
	}
	return httpapi.LocalModelsSetupPathUnknown
}

func hasNVIDIAGPU(accelerators *httpapi.LocalComputerAccelerators) bool {
	for _, gpu := range accelerators.Gpus {
		if gpu.Vendor == httpapi.LocalComputerGpuVendorNvidia {
			return true
		}
	}
	return false
}

var computerReleaseVersion = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

// computerVersionAtLeast mirrors the Agent Service's isComputerVersionAtLeast:
// a source build reports dev and counts as current; any other version that
// is not major.minor.patch counts as older than every release.
func computerVersionAtLeast(version, minimum string) bool {
	if version == "dev" {
		return true
	}
	observed, required := computerReleaseVersion.FindStringSubmatch(version), computerReleaseVersion.FindStringSubmatch(minimum)
	if observed == nil || required == nil {
		return false
	}
	for index := 1; index <= 3; index++ {
		left, leftErr := strconv.ParseUint(observed[index], 10, 53)
		right, rightErr := strconv.ParseUint(required[index], 10, 53)
		if leftErr != nil || rightErr != nil {
			return false
		}
		if left != right {
			return left > right
		}
	}
	return true
}
