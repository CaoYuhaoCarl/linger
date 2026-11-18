package agentruntimestate

import (
	"os"
	"regexp"
	"strconv"
	"testing"
	"time"

	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

type readinessHost struct {
	platform, arch string
	gpus           int
}

func readinessSummary(available bool, reason string, host *readinessHost, edit func(*LocalModelsSummary)) *LocalModelsSummary {
	summary := &LocalModelsSummary{Available: available, Usable: 1}
	if reason != "" {
		summary.Reason = &reason
	}
	if host != nil {
		summary.Host = &struct {
			Platform string `json:"platform"`
			Arch     string `json:"arch"`
			GPUs     int    `json:"gpus"`
		}{host.platform, host.arch, host.gpus}
	}
	if edit != nil {
		edit(summary)
	}
	return summary
}

func probedAccelerators(appleSilicon bool, unified int64, gpus ...httpapi.LocalComputerAcceleratorGpu) *httpapi.LocalComputerAccelerators {
	accelerators := &httpapi.LocalComputerAccelerators{
		Probe: httpapi.LocalComputerAcceleratorProbeOk, RamTotalBytes: 32 << 30, AppleSilicon: appleSilicon,
		Gpus: append([]httpapi.LocalComputerAcceleratorGpu{}, gpus...),
	}
	if appleSilicon {
		accelerators.UnifiedMemoryBytes = &unified
	}
	return accelerators
}

// profile is a stored profile of a Linux host with one 24 GiB NVIDIA GPU.
func profile(installKind httpapi.LocalComputerInstallKind, mode, update string) *LocalComputerProfile {
	stored := &LocalComputerProfile{InstallKind: installKind, Accelerators: *probedAccelerators(false, 0, nvidiaGPU(24<<30))}
	stored.LocalModels.Mode, stored.Update.State = mode, update
	return stored
}

func nvidiaGPU(memory int64) httpapi.LocalComputerAcceleratorGpu {
	return httpapi.LocalComputerAcceleratorGpu{Vendor: httpapi.LocalComputerGpuVendorNvidia, Name: "NVIDIA GPU", MemoryBytes: &memory}
}

func TestLocalModelsReadinessRules(t *testing.T) {
	now := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	justConnected, longAgo := now.Add(-30*time.Second), now.Add(-time.Hour)
	pendingAWhile, pendingTooLong := now.Add(-2*time.Hour), now.Add(-2*time.Hour-time.Second)
	nvidiaHost := &readinessHost{"linux", "x86_64", 1}
	macHost := &readinessHost{"darwin", "arm64", 0}
	gpuLessHost := &readinessHost{"linux", "x86_64", 0}
	notInstalled := readinessSummary(false, "TOOL_NOT_INSTALLED", nil, nil)
	working := readinessSummary(true, "", nvidiaHost, func(s *LocalModelsSummary) { s.Counts.Working, s.Counts.Loaded = 1, 1 })
	loaded := readinessSummary(true, "", macHost, func(s *LocalModelsSummary) { s.Counts.Loaded = 2 })
	ready := readinessSummary(true, "", nvidiaHost, nil)
	diskCode := "DISK_INSUFFICIENT"
	nothingFits := readinessSummary(true, "", nvidiaHost, func(s *LocalModelsSummary) { s.Usable, s.UnavailableCode = 0, &diskCode })
	emptyCatalog := readinessSummary(true, "", nvidiaHost, func(s *LocalModelsSummary) { s.Usable = 0 })

	type want struct {
		state  httpapi.LocalModelsReadinessState
		reason httpapi.LocalModelsReadinessReason
		path   httpapi.LocalModelsSetupPath
	}
	tests := []struct {
		name  string
		facts LocalModelsReadinessFacts
		want  want
	}{
		{"1: upgrade_required", LocalModelsReadinessFacts{Status: "upgrade_required", DaemonVersion: "0.52.0", Summary: ready},
			want{httpapi.LocalModelsReadinessNeedsReinstall, httpapi.LocalModelsReadinessDaemonUnsupported, httpapi.LocalModelsSetupPathNvidia}},
		{"1: 0.42.9 is below protocol 2", LocalModelsReadinessFacts{Status: "offline", DaemonVersion: "0.42.9"},
			want{httpapi.LocalModelsReadinessNeedsReinstall, httpapi.LocalModelsReadinessDaemonUnsupported, httpapi.LocalModelsSetupPathUnknown}},
		{"1: an unparsable version", LocalModelsReadinessFacts{Status: "online", DaemonVersion: "1.0.0-beta"},
			want{httpapi.LocalModelsReadinessNeedsReinstall, httpapi.LocalModelsReadinessDaemonUnsupported, httpapi.LocalModelsSetupPathUnknown}},
		{"2: 0.43.0 is Simplex era", LocalModelsReadinessFacts{Status: "offline", DaemonVersion: "0.43.0"},
			want{httpapi.LocalModelsReadinessNeedsReinstall, httpapi.LocalModelsReadinessDaemonLegacy, httpapi.LocalModelsSetupPathUnknown}},
		{"2: 0.50.9 is Simplex era", LocalModelsReadinessFacts{Status: "online", Online: true, DaemonVersion: "0.50.9"},
			want{httpapi.LocalModelsReadinessNeedsReinstall, httpapi.LocalModelsReadinessDaemonLegacy, httpapi.LocalModelsSetupPathUnknown}},
		{"2 before 3: a stuck Simplex-era Daemon stays legacy", LocalModelsReadinessFacts{Status: "online", Online: true, DaemonVersion: "0.50.0", UpdatePendingSince: &pendingTooLong},
			want{httpapi.LocalModelsReadinessNeedsReinstall, httpapi.LocalModelsReadinessDaemonLegacy, httpapi.LocalModelsSetupPathUnknown}},
		{"3: 0.51.0 behind for more than 2 h", LocalModelsReadinessFacts{Status: "online", Online: true, DaemonVersion: "0.51.0", UpdatePendingSince: &pendingTooLong},
			want{httpapi.LocalModelsReadinessNeedsReinstall, httpapi.LocalModelsReadinessUpdateFailed, httpapi.LocalModelsSetupPathUnknown}},
		{"3: a snapshot does not hide a stuck update", LocalModelsReadinessFacts{Status: "online", Online: true, DaemonVersion: "0.52.0", UpdatePendingSince: &pendingTooLong, Summary: ready},
			want{httpapi.LocalModelsReadinessNeedsReinstall, httpapi.LocalModelsReadinessUpdateFailed, httpapi.LocalModelsSetupPathNvidia}},
		{"3 not yet: behind for exactly 2 h", LocalModelsReadinessFacts{Status: "online", Online: true, DaemonVersion: "0.51.0", UpdatePendingSince: &pendingAWhile},
			want{httpapi.LocalModelsReadinessNeedsUpdate, httpapi.LocalModelsReadinessUpdatePending, httpapi.LocalModelsSetupPathUnknown}},
		{"4: 0.52.0 without a snapshot behind the release", LocalModelsReadinessFacts{Status: "online", Online: true, DaemonVersion: "0.52.0", ConnectedAt: &longAgo, UpdatePendingSince: &justConnected},
			want{httpapi.LocalModelsReadinessNeedsUpdate, httpapi.LocalModelsReadinessUpdatePending, httpapi.LocalModelsSetupPathUnknown}},
		{"4 skipped: behind the release with a snapshot shows it", LocalModelsReadinessFacts{Status: "online", Online: true, DaemonVersion: "0.52.0", UpdatePendingSince: &justConnected, Summary: ready},
			want{httpapi.LocalModelsReadinessReady, "", httpapi.LocalModelsSetupPathNvidia}},
		{"4: 0.51.0 without a snapshot is updating", LocalModelsReadinessFacts{Status: "online", Online: true, DaemonVersion: "0.51.0", ConnectedAt: &justConnected},
			want{httpapi.LocalModelsReadinessNeedsUpdate, httpapi.LocalModelsReadinessUpdatePending, httpapi.LocalModelsSetupPathUnknown}},
		{"4 skipped: 0.51.0 with a snapshot shows it", LocalModelsReadinessFacts{Status: "online", Online: true, DaemonVersion: "0.51.0", Summary: ready},
			want{httpapi.LocalModelsReadinessReady, "", httpapi.LocalModelsSetupPathNvidia}},
		{"6: 0.52.0 connected moments ago", LocalModelsReadinessFacts{Status: "online", Online: true, DaemonVersion: "0.52.0", ConnectedAt: &justConnected},
			want{httpapi.LocalModelsReadinessChecking, "", httpapi.LocalModelsSetupPathUnknown}},
		{"6: dev connected moments ago", LocalModelsReadinessFacts{Status: "online", Online: true, DaemonVersion: "dev", ConnectedAt: &justConnected},
			want{httpapi.LocalModelsReadinessChecking, "", httpapi.LocalModelsSetupPathUnknown}},
		{"7: connected long ago", LocalModelsReadinessFacts{Status: "online", Online: true, DaemonVersion: "0.52.0", ConnectedAt: &longAgo},
			want{httpapi.LocalModelsReadinessNotReported, httpapi.LocalModelsReadinessNotReportedReason, httpapi.LocalModelsSetupPathUnknown}},
		{"7: offline right after connecting", LocalModelsReadinessFacts{Status: "offline", DaemonVersion: "0.52.0", ConnectedAt: &justConnected},
			want{httpapi.LocalModelsReadinessNotReported, httpapi.LocalModelsReadinessNotReportedReason, httpapi.LocalModelsSetupPathUnknown}},
		{"7: never connected", LocalModelsReadinessFacts{Status: "offline"},
			want{httpapi.LocalModelsReadinessNotReported, httpapi.LocalModelsReadinessNotReportedReason, httpapi.LocalModelsSetupPathUnknown}},
		{"8: tool failed", LocalModelsReadinessFacts{Status: "online", DaemonVersion: "0.52.0", Summary: readinessSummary(false, "TOOL_FAILED", nvidiaHost, nil)},
			want{httpapi.LocalModelsReadinessNeedsAttention, httpapi.LocalModelsReadinessToolFailed, httpapi.LocalModelsSetupPathNvidia}},
		{"9: Apple silicon 16 GiB", LocalModelsReadinessFacts{DaemonVersion: "0.52.0", Platform: "darwin", Summary: notInstalled, Accelerators: probedAccelerators(true, 16<<30)},
			want{httpapi.LocalModelsReadinessNotSetUp, httpapi.LocalModelsReadinessSetupAvailable, httpapi.LocalModelsSetupPathAppleSilicon}},
		{"10: Apple silicon 8 GiB", LocalModelsReadinessFacts{DaemonVersion: "0.52.0", Platform: "darwin", Summary: notInstalled, Accelerators: probedAccelerators(true, 8<<30)},
			want{httpapi.LocalModelsReadinessUnsupportedHardware, httpapi.LocalModelsReadinessMemoryInsufficient, httpapi.LocalModelsSetupPathAppleSilicon}},
		{"10: Intel Mac", LocalModelsReadinessFacts{DaemonVersion: "0.52.0", Platform: "darwin", Summary: notInstalled, Accelerators: probedAccelerators(false, 0)},
			want{httpapi.LocalModelsReadinessUnsupportedHardware, httpapi.LocalModelsReadinessPlatformUnsupported, httpapi.LocalModelsSetupPathUnknown}},
		{"9: NVIDIA 8 GiB", LocalModelsReadinessFacts{DaemonVersion: "0.52.0", Platform: "linux", Summary: notInstalled, Accelerators: probedAccelerators(false, 0, nvidiaGPU(8<<30))},
			want{httpapi.LocalModelsReadinessNotSetUp, httpapi.LocalModelsReadinessSetupAvailable, httpapi.LocalModelsSetupPathNvidia}},
		{"10: NVIDIA 6 GiB", LocalModelsReadinessFacts{DaemonVersion: "0.52.0", Platform: "win32", Summary: notInstalled, Accelerators: probedAccelerators(false, 0, nvidiaGPU(6<<30))},
			want{httpapi.LocalModelsReadinessUnsupportedHardware, httpapi.LocalModelsReadinessMemoryInsufficient, httpapi.LocalModelsSetupPathNvidia}},
		{"10: AMD only", LocalModelsReadinessFacts{DaemonVersion: "0.52.0", Platform: "linux", Summary: notInstalled,
			Accelerators: probedAccelerators(false, 0, httpapi.LocalComputerAcceleratorGpu{Vendor: httpapi.LocalComputerGpuVendorAmd, Name: "AMD GPU"})},
			want{httpapi.LocalModelsReadinessUnsupportedHardware, httpapi.LocalModelsReadinessNoSupportedGpu, httpapi.LocalModelsSetupPathUnknown}},
		{"11: no profile", LocalModelsReadinessFacts{DaemonVersion: "0.52.0", Platform: "linux", Summary: notInstalled},
			want{httpapi.LocalModelsReadinessNotSetUp, httpapi.LocalModelsReadinessHardwareUnknown, httpapi.LocalModelsSetupPathUnknown}},
		{"11: the probe failed", LocalModelsReadinessFacts{DaemonVersion: "0.52.0", Platform: "linux", Summary: notInstalled,
			Accelerators: &httpapi.LocalComputerAccelerators{Probe: httpapi.LocalComputerAcceleratorProbeFailed, Gpus: []httpapi.LocalComputerAcceleratorGpu{}}},
			want{httpapi.LocalModelsReadinessNotSetUp, httpapi.LocalModelsReadinessHardwareUnknown, httpapi.LocalModelsSetupPathUnknown}},
		{"10b: GPU-less x86 host with the tool", LocalModelsReadinessFacts{DaemonVersion: "0.52.0", Platform: "linux", Summary: readinessSummary(true, "", gpuLessHost, nil)},
			want{httpapi.LocalModelsReadinessUnsupportedHardware, httpapi.LocalModelsReadinessNoSupportedGpu, httpapi.LocalModelsSetupPathUnknown}},
		{"10b: Intel Mac with the tool", LocalModelsReadinessFacts{DaemonVersion: "0.52.0", Platform: "darwin", Summary: readinessSummary(true, "", &readinessHost{"darwin", "x86_64", 0}, nil)},
			want{httpapi.LocalModelsReadinessUnsupportedHardware, httpapi.LocalModelsReadinessPlatformUnsupported, httpapi.LocalModelsSetupPathUnknown}},
		{"10b: the profile overrides the host", LocalModelsReadinessFacts{DaemonVersion: "0.52.0", Platform: "linux", Summary: ready, Accelerators: probedAccelerators(false, 0)},
			want{httpapi.LocalModelsReadinessUnsupportedHardware, httpapi.LocalModelsReadinessNoSupportedGpu, httpapi.LocalModelsSetupPathUnknown}},
		{"3d: a desktop Computer stuck behind the release needs a desktop app update", LocalModelsReadinessFacts{Status: "online", Online: true, DaemonVersion: "0.53.0", Platform: "linux", UpdatePendingSince: &pendingTooLong, Summary: ready}.WithProfile(profile("desktop", "local", "idle")),
			want{httpapi.LocalModelsReadinessNeedsUpdate, httpapi.LocalModelsReadinessDesktopAppOutdated, httpapi.LocalModelsSetupPathNvidia}},
		{"4d: a desktop Computer behind the release without a snapshot", LocalModelsReadinessFacts{Status: "online", Online: true, DaemonVersion: "0.53.0", Platform: "linux", UpdatePendingSince: &justConnected}.WithProfile(profile("desktop", "none", "idle")),
			want{httpapi.LocalModelsReadinessNeedsUpdate, httpapi.LocalModelsReadinessDesktopAppOutdated, httpapi.LocalModelsSetupPathNvidia}},
		{"3: the last self-update failed", LocalModelsReadinessFacts{DaemonVersion: "0.53.0", Platform: "linux", Summary: ready}.WithProfile(profile("cli", "none", "failed")),
			want{httpapi.LocalModelsReadinessNeedsReinstall, httpapi.LocalModelsReadinessUpdateFailed, httpapi.LocalModelsSetupPathNvidia}},
		{"3: a desktop Computer is never told to reinstall", LocalModelsReadinessFacts{DaemonVersion: "0.53.0", Platform: "linux", Summary: ready}.WithProfile(profile("desktop", "local", "failed")),
			want{httpapi.LocalModelsReadinessReady, "", httpapi.LocalModelsSetupPathNvidia}},
		{"5: models served by another machine", LocalModelsReadinessFacts{DaemonVersion: "0.53.0", Platform: "linux", Summary: notInstalled}.WithProfile(profile("container", "remote", "idle")),
			want{httpapi.LocalModelsReadinessManagedElsewhere, "", httpapi.LocalModelsSetupPathNvidia}},
		{"5: before its first snapshot", LocalModelsReadinessFacts{Status: "online", Online: true, DaemonVersion: "0.53.0", ConnectedAt: &justConnected}.WithProfile(profile("cli", "remote", "idle")),
			want{httpapi.LocalModelsReadinessManagedElsewhere, "", httpapi.LocalModelsSetupPathNvidia}},
		{"9: the profile's NVIDIA GPU", LocalModelsReadinessFacts{DaemonVersion: "0.53.0", Platform: "linux", Summary: notInstalled}.WithProfile(profile("container", "none", "idle")),
			want{httpapi.LocalModelsReadinessNotSetUp, httpapi.LocalModelsReadinessSetupAvailable, httpapi.LocalModelsSetupPathNvidia}},
		{"12: working wins over loaded", LocalModelsReadinessFacts{DaemonVersion: "0.52.0", Summary: working},
			want{httpapi.LocalModelsReadinessWorking, "", httpapi.LocalModelsSetupPathNvidia}},
		{"13: loaded on Apple silicon", LocalModelsReadinessFacts{DaemonVersion: "0.52.0", Platform: "darwin", Summary: loaded},
			want{httpapi.LocalModelsReadinessLoaded, "", httpapi.LocalModelsSetupPathAppleSilicon}},
		{"14: nothing fits the disk", LocalModelsReadinessFacts{DaemonVersion: "0.52.0", Summary: nothingFits},
			want{httpapi.LocalModelsReadinessUnsupportedHardware, httpapi.LocalModelsReadinessDiskInsufficient, httpapi.LocalModelsSetupPathNvidia}},
		{"14: an empty catalog", LocalModelsReadinessFacts{DaemonVersion: "0.52.0", Summary: emptyCatalog},
			want{httpapi.LocalModelsReadinessUnsupportedHardware, httpapi.LocalModelsReadinessPlatformUnsupported, httpapi.LocalModelsSetupPathNvidia}},
		{"15: ready, offline keeps it", LocalModelsReadinessFacts{Status: "offline", DaemonVersion: "0.52.0", Summary: ready},
			want{httpapi.LocalModelsReadinessReady, "", httpapi.LocalModelsSetupPathNvidia}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := LocalModelsReadiness(test.facts, now)
			var reason httpapi.LocalModelsReadinessReason
			if got.Reason != nil {
				reason = *got.Reason
			}
			if got.State != test.want.state || reason != test.want.reason || got.SetupPath == nil || *got.SetupPath != test.want.path {
				t.Fatalf("got %s/%s/%v, want %+v", got.State, reason, got.SetupPath, test.want)
			}
			if got.EnableCommand {
				t.Fatal("no Computer release ships local-models enable yet")
			}
		})
	}
}

func TestComputerVersionAtLeast(t *testing.T) {
	for _, test := range []struct {
		version string
		want    bool
	}{
		{"0.51.0", true}, {"0.51.1", true}, {"0.52.0", true}, {"1.0.0", true}, {"dev", true},
		{"0.50.9", false}, {"0.5.10", false}, {"", false}, {"0.51", false}, {"v0.51.0", false}, {"0.051.0", false},
	} {
		if got := computerVersionAtLeast(test.version, firstLingerComputerVersion); got != test.want {
			t.Errorf("computerVersionAtLeast(%q) = %t, want %t", test.version, got, test.want)
		}
	}
}

// TestReadinessVersionBoundariesMatchAgentService pins the boundaries the
// Agent Service also gates on to its constants.
func TestReadinessVersionBoundariesMatchAgentService(t *testing.T) {
	source, err := os.ReadFile("../../../node-services/src/agent/runner-gateway/local-computer-management.ts")
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{
		"FIRST_PROTOCOL_2_COMPUTER_VERSION":       firstProtocol2ComputerVersion,
		"FIRST_SERVICE_FEATURES_COMPUTER_VERSION": firstServiceFeaturesComputerVersion,
	} {
		match := regexp.MustCompile(`export const ` + name + ` = "([^"]+)";`).FindSubmatch(source)
		if match == nil || string(match[1]) != want {
			t.Errorf("%s: Agent Service has %q, readiness has %q", name, match, want)
		}
	}
}

// TestReadinessFloorsMatchDocs pins the hardware floors to the table that
// docs/local-inference.md publishes.
func TestReadinessFloorsMatchDocs(t *testing.T) {
	docs, err := os.ReadFile("../../../../docs/local-inference.md")
	if err != nil {
		t.Fatal(err)
	}
	for row, want := range map[string]int64{
		`\| Apple silicon \| macOS +\| (\d+) GiB unified memory +\|`: appleSiliconMinimumUnifiedMemoryBytes,
		`\| NVIDIA GPU +\| Windows or Linux \| (\d+) GiB VRAM +\|`:   nvidiaMinimumVRAMBytes,
	} {
		match := regexp.MustCompile(row).FindSubmatch(docs)
		if match == nil {
			t.Errorf("docs/local-inference.md has no row matching %s", row)
			continue
		}
		gib, _ := strconv.ParseInt(string(match[1]), 10, 64)
		if gib<<30 != want {
			t.Errorf("docs say %d GiB, readiness uses %d bytes", gib, want)
		}
	}
}
