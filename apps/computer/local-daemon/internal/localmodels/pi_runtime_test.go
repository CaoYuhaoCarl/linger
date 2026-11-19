package localmodels

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

func TestToolCommandAlignsPiCodingAgentDir(t *testing.T) {
	fake := newFakeTool(t)
	home := filepath.Join(filepath.Dir(fake.state), "home")
	explicit := filepath.Join(filepath.Dir(fake.state), "custom-pi")
	if err := os.MkdirAll(explicit, 0o700); err != nil {
		t.Fatal(err)
	}

	defaultInput := map[string]string{"HOME": home, "PI_CODING_AGENT_DIR": ""}
	wantDefaultEnv, err := workspace.PiSourceEnvironment(defaultInput)
	if err != nil {
		t.Fatal(err)
	}
	cmdDefault := fake.tool.command(defaultInput, Action{Name: ActionRefresh})
	wantDefault := "PI_CODING_AGENT_DIR=" + wantDefaultEnv["PI_CODING_AGENT_DIR"]
	if !slices.Contains(cmdDefault.Env, wantDefault) {
		t.Fatalf("expected %q in env %v", wantDefault, cmdDefault.Env)
	}

	messyExplicit := explicit + string(filepath.Separator) + "." + string(filepath.Separator)
	wantExplicitEnv, err := workspace.PiSourceEnvironment(map[string]string{"HOME": home, "PI_CODING_AGENT_DIR": messyExplicit})
	if err != nil {
		t.Fatal(err)
	}
	cmdExplicit := fake.tool.command(map[string]string{"HOME": home, "pi_coding_agent_dir": messyExplicit}, Action{Name: ActionRefresh})
	wantExplicit := "PI_CODING_AGENT_DIR=" + wantExplicitEnv["PI_CODING_AGENT_DIR"]
	if !slices.Contains(cmdExplicit.Env, wantExplicit) {
		t.Fatalf("expected %q in env %v", wantExplicit, cmdExplicit.Env)
	}
}

func TestToolCommandForwardsLocalModelsCacheAndReuseEnv(t *testing.T) {
	fake := newFakeTool(t)
	home := filepath.Join(filepath.Dir(fake.state), "home")
	envMap := func(cmdEnv []string) map[string]string {
		out := make(map[string]string, len(cmdEnv))
		for _, entry := range cmdEnv {
			if key, value, ok := strings.Cut(entry, "="); ok {
				out[key] = value
			}
		}
		return out
	}

	t.Run("maps LINGER_LOCALMODELS_* when LOCALMODELS_* unset or blank", func(t *testing.T) {
		cmd := fake.tool.command(map[string]string{
			"HOME":                          home,
			"LOCALMODELS_CACHE_DIR":         "   ",
			"LOCALMODELS_REUSE_DIRS":        "",
			"LINGER_LOCALMODELS_CACHE_DIR":  "  /shared/models/cache  ",
			"LINGER_LOCALMODELS_REUSE_DIRS": " /shared/models/a:/shared/models/b ",
		}, Action{Name: ActionDownload, Model: testModel})
		got := envMap(cmd.Env)
		if got["LOCALMODELS_CACHE_DIR"] != "/shared/models/cache" {
			t.Fatalf("LOCALMODELS_CACHE_DIR = %q, want /shared/models/cache", got["LOCALMODELS_CACHE_DIR"])
		}
		if got["LOCALMODELS_REUSE_DIRS"] != "/shared/models/a:/shared/models/b" {
			t.Fatalf("LOCALMODELS_REUSE_DIRS = %q, want /shared/models/a:/shared/models/b", got["LOCALMODELS_REUSE_DIRS"])
		}
		if _, ok := got["LINGER_LOCALMODELS_CACHE_DIR"]; !ok {
			t.Fatalf("LINGER_LOCALMODELS_CACHE_DIR was dropped from cmd.Env")
		}
		if _, ok := got["LINGER_LOCALMODELS_REUSE_DIRS"]; !ok {
			t.Fatalf("LINGER_LOCALMODELS_REUSE_DIRS was dropped from cmd.Env")
		}
	})

	t.Run("does not override explicit LOCALMODELS_* settings", func(t *testing.T) {
		cmd := fake.tool.command(map[string]string{
			"HOME":                          home,
			"LOCALMODELS_CACHE_DIR":         "/explicit/cache",
			"LOCALMODELS_REUSE_DIRS":        "/explicit/reuse",
			"LINGER_LOCALMODELS_CACHE_DIR":  "/linger/cache",
			"LINGER_LOCALMODELS_REUSE_DIRS": "/linger/reuse",
		}, Action{Name: ActionRefresh})
		got := envMap(cmd.Env)
		if got["LOCALMODELS_CACHE_DIR"] != "/explicit/cache" {
			t.Fatalf("LOCALMODELS_CACHE_DIR = %q, want /explicit/cache", got["LOCALMODELS_CACHE_DIR"])
		}
		if got["LOCALMODELS_REUSE_DIRS"] != "/explicit/reuse" {
			t.Fatalf("LOCALMODELS_REUSE_DIRS = %q, want /explicit/reuse", got["LOCALMODELS_REUSE_DIRS"])
		}
		if got["LINGER_LOCALMODELS_CACHE_DIR"] != "/linger/cache" || got["LINGER_LOCALMODELS_REUSE_DIRS"] != "/linger/reuse" {
			t.Fatalf("LINGER_LOCALMODELS_* were altered: %+v", got)
		}
	})

	t.Run("skips empty fallback values", func(t *testing.T) {
		cmd := fake.tool.command(map[string]string{
			"HOME":                          home,
			"LINGER_LOCALMODELS_CACHE_DIR":  "   ",
			"LINGER_LOCALMODELS_REUSE_DIRS": "",
		}, Action{Name: ActionRefresh})
		got := envMap(cmd.Env)
		if value, ok := got["LOCALMODELS_CACHE_DIR"]; ok {
			t.Fatalf("unexpected LOCALMODELS_CACHE_DIR = %q", value)
		}
		if value, ok := got["LOCALMODELS_REUSE_DIRS"]; ok {
			t.Fatalf("unexpected LOCALMODELS_REUSE_DIRS = %q", value)
		}
	})
}

func TestInspectPiReportsManagedOnlyAndSkipsMissingRoot(t *testing.T) {
	fake := newFakeTool(t)
	env := map[string]string{"LOCALMODELS_FAKE_TOOL": "1", "HOME": t.TempDir(), "PATH": os.Getenv("PATH")}
	harnessDir := filepath.Join(filepath.Dir(fake.state), "harness")

	found, err := fake.tool.InspectPi(context.Background(), env, harnessDir)
	if err != nil || found != "" {
		t.Fatalf("missing harness dir InspectPi = (%q, %v)", found, err)
	}
	if _, statErr := os.Stat(filepath.Join(fake.state, "calls.log")); !os.IsNotExist(statErr) {
		t.Fatalf("missing harness dir invoked localmodels: %v", fake.calls())
	}

	if err := os.MkdirAll(harnessDir, 0o700); err != nil {
		t.Fatal(err)
	}

	hostMarker := filepath.Join(fake.state, "harness-pi-host")
	if err := os.WriteFile(hostMarker, []byte("1"), 0o600); err != nil {
		t.Fatal(err)
	}
	found, err = fake.tool.InspectPi(context.Background(), env, harnessDir)
	if err != nil || found != "" {
		t.Fatalf("host-sourced Pi should be ignored by InspectPi: (%q, %v)", found, err)
	}
	_ = os.Remove(hostMarker)

	prefixMarker := filepath.Join(fake.state, "harness-pi-bad-prefix")
	if err := os.WriteFile(prefixMarker, []byte("1"), 0o600); err != nil {
		t.Fatal(err)
	}
	found, err = fake.tool.InspectPi(context.Background(), env, harnessDir)
	if err != nil || found != "" {
		t.Fatalf("non-empty argvPrefix should be rejected: (%q, %v)", found, err)
	}
	_ = os.Remove(prefixMarker)

	installedMarker := filepath.Join(fake.state, "harness-pi-installed")
	if err := os.WriteFile(installedMarker, []byte("1"), 0o600); err != nil {
		t.Fatal(err)
	}
	omitSourceMarker := filepath.Join(fake.state, "harness-pi-omit-source")
	if err := os.WriteFile(omitSourceMarker, []byte("1"), 0o600); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(harnessDir, "tools", "pi", "1.3.0", "pi")
	found, err = fake.tool.InspectPi(context.Background(), env, harnessDir)
	if err != nil || found != want {
		t.Fatalf("InspectPi without source inside harnessDir = (%q, %v), want %q", found, err, want)
	}
	_ = os.Remove(omitSourceMarker)

	found, err = fake.tool.InspectPi(context.Background(), env, harnessDir)
	if err != nil || found != want {
		t.Fatalf("InspectPi managed = (%q, %v), want %q", found, err, want)
	}
}

func TestEnsurePiValidatesPlanContractAndNodeBootstrap(t *testing.T) {
	env := map[string]string{"LOCALMODELS_FAKE_TOOL": "1", "HOME": t.TempDir(), "PATH": os.Getenv("PATH")}
	for _, tc := range []struct {
		name string
		body string
	}{
		{name: "bad schema", body: `{"schema":"localmodels.harness-plan/v0","id":"` + strings.Repeat("a", 64) + `","runtime":"pi"}`},
		{name: "wrong runtime", body: `{"schema":"localmodels.harness-plan/v1","id":"` + strings.Repeat("a", 64) + `","runtime":"codex"}`},
		{name: "non-hex id", body: `{"schema":"localmodels.harness-plan/v1","id":"not-64-hex","runtime":"pi"}`},
		{name: "uppercase hex id", body: `{"schema":"localmodels.harness-plan/v1","id":"` + strings.Repeat("A", 64) + `","runtime":"pi"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake := newFakeTool(t)
			if err := os.WriteFile(filepath.Join(fake.state, "harness-plan-body"), []byte(tc.body), 0o600); err != nil {
				t.Fatal(err)
			}
			harnessDir := filepath.Join(filepath.Dir(fake.state), "harness")
			if got, err := fake.tool.EnsurePi(context.Background(), env, harnessDir, ""); err == nil || got != "" {
				t.Fatalf("expected contract validation failure, got (%q, %v)", got, err)
			}
			if slices.ContainsFunc(fake.calls(), func(c string) bool { return strings.HasPrefix(c, "harness apply ") }) {
				t.Fatalf("invalid plan still invoked harness apply: %v", fake.calls())
			}
		})
	}

	t.Run("structured error from apply", func(t *testing.T) {
		fake := newFakeTool(t)
		if err := os.WriteFile(filepath.Join(fake.state, "harness-apply-fail"), []byte("1"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(fake.state, "harness-apply-error"), []byte(`{"schema":"localmodels.harness-error/v1","code":"RUNTIME_DOWNLOAD_FAILED","message":"timeout"}`), 0o600); err != nil {
			t.Fatal(err)
		}
		harnessDir := filepath.Join(filepath.Dir(fake.state), "harness")
		_, err := fake.tool.EnsurePi(context.Background(), env, harnessDir, "")
		if err == nil || !strings.Contains(err.Error(), "RUNTIME_DOWNLOAD_FAILED") {
			t.Fatalf("expected structured error code, got %v", err)
		}
	})

	t.Run("falls back to harness status when apply omits status", func(t *testing.T) {
		fake := newFakeTool(t)
		if err := os.WriteFile(filepath.Join(fake.state, "harness-apply-no-status"), []byte("1"), 0o600); err != nil {
			t.Fatal(err)
		}
		harnessDir := filepath.Join(filepath.Dir(fake.state), "harness")
		want := filepath.Join(harnessDir, "tools", "pi", "1.3.0", "pi")
		got, err := fake.tool.EnsurePi(context.Background(), env, harnessDir, "")
		if err != nil || got != want {
			t.Fatalf("EnsurePi fallback = (%q, %v), want %q", got, err, want)
		}
	})

	if runtime.GOOS != "windows" {
		t.Run("skips symlink nodePath", func(t *testing.T) {
			fake := newFakeTool(t)
			realNode := filepath.Join(t.TempDir(), "real-node")
			if err := os.WriteFile(realNode, []byte("#!/bin/sh\n"), 0o700); err != nil {
				t.Fatal(err)
			}
			linkNode := filepath.Join(t.TempDir(), "node")
			if err := os.Symlink(realNode, linkNode); err != nil {
				t.Fatal(err)
			}
			harnessDir := filepath.Join(filepath.Dir(fake.state), "harness")
			if _, err := fake.tool.EnsurePi(context.Background(), env, harnessDir, linkNode); err != nil {
				t.Fatal(err)
			}
			for _, call := range fake.calls() {
				if strings.HasPrefix(call, "harness plan ") && strings.Contains(call, "--node") {
					t.Fatalf("symlink nodePath passed to harness plan: %q", call)
				}
			}
		})
	}
}

func TestLoadProvisionsPiInHarnessDirectoryWithNodePathAndNotifiesRuntimeChanged(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "idle")))
	loaded, _ := json.Marshal(status(model(testModel, "loaded")))
	fake.script("load", fakeScript{
		Lines: []fakeLine{
			{Line: progressLine(testModel, "load", 0, 1)},
			{Line: resultLine(testModel), DelayMS: 20},
		},
		StatusAfter: loaded,
	})
	harnessDir := filepath.Join(filepath.Dir(fake.state), "harness")
	home := filepath.Join(filepath.Dir(fake.state), "home")
	nodePath := filepath.Join(t.TempDir(), "node")
	if err := os.WriteFile(nodePath, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	record := &recorder{}
	var seenMu sync.Mutex
	var seenPiAtChange string
	library := New(Options{
		Tool:             &fake.tool,
		Environment:      map[string]string{"LOCALMODELS_FAKE_TOOL": "1", "HOME": home, "PATH": os.Getenv("PATH")},
		JobDirectory:     filepath.Join(t.TempDir(), "jobs"),
		HarnessDirectory: harnessDir,
		NodePath:         nodePath,
		Publish:          record.publish,
		ProgressInterval: 20 * time.Millisecond,
	})
	library.runtimeChanged = func() {
		if executable := library.PiExecutable(); executable != "" {
			seenMu.Lock()
			seenPiAtChange = executable
			seenMu.Unlock()
		}
		record.runtimeChanged()
	}
	t.Cleanup(library.Close)

	library.Refresh(context.Background())
	if library.PiExecutable() != "" {
		t.Fatalf("idle library unexpectedly provisioned Pi: %q", library.PiExecutable())
	}

	if refusal, answered := library.Act(context.Background(), Action{Name: ActionLoad, Model: testModel}, soon()); refusal != nil || !answered {
		t.Fatalf("load refusal=%+v answered=%v", refusal, answered)
	}
	want := filepath.Join(harnessDir, "tools", "pi", "1.3.0", "pi")
	waitFor(t, "Pi provisioned and runtimeChanged fired", func() bool {
		seenMu.Lock()
		seen := seenPiAtChange
		seenMu.Unlock()
		return record.changes() > 0 && library.PiExecutable() == want && seen == want
	})
	calls := fake.calls()
	if !slices.ContainsFunc(calls, func(c string) bool {
		return strings.HasPrefix(c, "harness plan ") && strings.Contains(c, "--node "+nodePath)
	}) ||
		!slices.ContainsFunc(calls, func(c string) bool { return strings.HasPrefix(c, "harness apply ") }) {
		t.Fatalf("expected harness plan(--node)/apply in calls: %v", calls)
	}
	wantPiDir := "PI_CODING_AGENT_DIR=" + filepath.Join(home, ".pi", "agent")
	if !slices.ContainsFunc(calls, func(c string) bool { return strings.HasPrefix(c, "load ") && strings.Contains(c, wantPiDir) }) {
		t.Fatalf("expected load call with %s in %v", wantPiDir, calls)
	}
}

func TestInitialRefreshProvisionsPiAndInspectPiSeedsInitialExecutable(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "loaded")))
	harnessDir := filepath.Join(filepath.Dir(fake.state), "harness")
	record := &recorder{}
	env := map[string]string{"LOCALMODELS_FAKE_TOOL": "1", "HOME": t.TempDir(), "PATH": os.Getenv("PATH")}
	library := New(Options{
		Tool:             &fake.tool,
		Environment:      env,
		JobDirectory:     filepath.Join(t.TempDir(), "jobs"),
		HarnessDirectory: harnessDir,
		Publish:          record.publish,
		RuntimeChanged:   record.runtimeChanged,
		ProgressInterval: time.Second,
	})
	t.Cleanup(library.Close)

	library.Refresh(context.Background())
	want := filepath.Join(harnessDir, "tools", "pi", "1.3.0", "pi")
	waitFor(t, "initial loaded model provisions Pi asynchronously", func() bool {
		return library.PiExecutable() == want && record.changes() == 1
	})

	inspected, err := fake.tool.InspectPi(context.Background(), env, harnessDir)
	if err != nil {
		t.Fatalf("InspectPi error: %v", err)
	}
	if inspected != want {
		t.Fatalf("InspectPi=%q want=%q", inspected, want)
	}
	seeded := New(Options{
		Tool:                &fake.tool,
		Environment:         env,
		JobDirectory:        filepath.Join(t.TempDir(), "jobs"),
		HarnessDirectory:    harnessDir,
		InitialPiExecutable: inspected,
	})
	t.Cleanup(seeded.Close)
	if seeded.PiExecutable() != want {
		t.Fatalf("InitialPiExecutable=%q want=%q", seeded.PiExecutable(), want)
	}
}

func TestFailedPiProvisioningDoesNotFailLoadedSnapshot(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "loaded")))
	if err := os.WriteFile(filepath.Join(fake.state, "harness-plan-fail"), []byte("1"), 0o600); err != nil {
		t.Fatal(err)
	}
	harnessDir := filepath.Join(filepath.Dir(fake.state), "harness")
	library := New(Options{
		Tool:                  &fake.tool,
		Environment:           map[string]string{"LOCALMODELS_FAKE_TOOL": "1", "PATH": os.Getenv("PATH")},
		JobDirectory:          filepath.Join(t.TempDir(), "jobs"),
		HarnessDirectory:      harnessDir,
		EnsurePiRetryInterval: time.Minute,
	})
	t.Cleanup(library.Close)

	snapshot := library.Refresh(context.Background())
	if !snapshot.Available || modelState(snapshot, testModel).State != "loaded" {
		t.Fatalf("snapshot=%+v", snapshot)
	}
	waitFor(t, "failed Pi attempt recorded", func() bool {
		library.mu.Lock()
		defer library.mu.Unlock()
		return !library.piEnsuring && library.piFailures == 1
	})
	if library.PiExecutable() != "" {
		t.Fatalf("unexpected PiExecutable=%q", library.PiExecutable())
	}
}

func TestEnsurePiRunsOutsideRefreshLockAndSingleflightsConcurrentCalls(t *testing.T) {
	fake := newFakeTool(t)
	const otherModel = "other-model:Q4_K_M"
	fake.write("status.json", status(model(testModel, "loaded"), model(otherModel, "absent")))
	waitGate := filepath.Join(fake.state, "harness-plan-wait")
	if err := os.WriteFile(waitGate, []byte("1"), 0o600); err != nil {
		t.Fatal(err)
	}
	harnessDir := filepath.Join(filepath.Dir(fake.state), "harness")
	record := &recorder{}
	library := New(Options{
		Tool:             &fake.tool,
		Environment:      map[string]string{"LOCALMODELS_FAKE_TOOL": "1", "HOME": t.TempDir(), "PATH": os.Getenv("PATH")},
		JobDirectory:     filepath.Join(t.TempDir(), "jobs"),
		HarnessDirectory: harnessDir,
		Publish:          record.publish,
		RuntimeChanged:   record.runtimeChanged,
		ProgressInterval: 10 * time.Millisecond,
	})
	t.Cleanup(library.Close)

	first := library.Refresh(context.Background())
	if !first.Available || modelState(first, testModel).State != "loaded" {
		t.Fatalf("first Refresh=%+v", first)
	}
	waitFor(t, "background harness plan started", func() bool {
		_, err := os.Stat(filepath.Join(fake.state, "harness-plan-entered"))
		return err == nil
	})

	// Concurrent Refreshes must neither block on refreshMu nor launch duplicate installs.
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() {
			snap := library.Refresh(context.Background())
			if !snap.Available || modelState(snap, testModel).State != "loaded" {
				t.Errorf("concurrent Refresh=%+v", snap)
			}
		})
	}
	wg.Wait()

	downloaded, _ := json.Marshal(status(model(testModel, "loaded"), model(otherModel, "idle")))
	fake.script("download", fakeScript{
		Lines: []fakeLine{
			{Line: progressLine(otherModel, "download", 10, 100)},
			{Line: resultLine(otherModel), DelayMS: 40},
		},
		StatusAfter: downloaded,
	})
	if refusal, answered := library.Act(context.Background(), Action{Name: ActionDownload, Model: otherModel}, soon()); refusal != nil || !answered {
		t.Fatalf("download refusal=%+v answered=%v", refusal, answered)
	}
	waitFor(t, "phaseStarted published downloading snapshot while EnsurePi waits", func() bool {
		state := modelState(record.last(), otherModel)
		return state != nil && state.State == "downloading"
	})

	if err := os.Remove(waitGate); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(harnessDir, "tools", "pi", "1.3.0", "pi")
	waitFor(t, "blocked EnsurePi finished after gate released", func() bool {
		return library.PiExecutable() == want && record.changes() == 1
	})

	planCount := 0
	for _, call := range fake.calls() {
		if strings.HasPrefix(call, "harness plan ") {
			planCount++
		}
	}
	if planCount != 1 {
		t.Fatalf("expected singleflight 1 harness plan call, got %d (%v)", planCount, fake.calls())
	}
}

func TestEnsurePiRetriesWithExponentialBackoffAndStopsWhenUnloaded(t *testing.T) {
	t.Run("fake clock exponential backoff", func(t *testing.T) {
		fake := newFakeTool(t)
		fake.write("status.json", status(model(testModel, "loaded")))
		failMarker := filepath.Join(fake.state, "harness-plan-fail")
		if err := os.WriteFile(failMarker, []byte("1"), 0o600); err != nil {
			t.Fatal(err)
		}
		harnessDir := filepath.Join(filepath.Dir(fake.state), "harness")
		record := &recorder{}
		var clockMu sync.Mutex
		currentTime := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
		library := New(Options{
			Tool:                  &fake.tool,
			Environment:           map[string]string{"LOCALMODELS_FAKE_TOOL": "1", "HOME": t.TempDir(), "PATH": os.Getenv("PATH")},
			JobDirectory:          filepath.Join(t.TempDir(), "jobs"),
			HarnessDirectory:      harnessDir,
			Publish:               record.publish,
			RuntimeChanged:        record.runtimeChanged,
			EnsurePiRetryInterval: 30 * time.Second,
		})
		library.now = func() time.Time {
			clockMu.Lock()
			defer clockMu.Unlock()
			return currentTime
		}
		t.Cleanup(library.Close)

		planCalls := func() int {
			count := 0
			for _, call := range fake.calls() {
				if strings.HasPrefix(call, "harness plan ") {
					count++
				}
			}
			return count
		}

		library.Refresh(context.Background())
		waitFor(t, "first Pi install failure recorded", func() bool {
			library.mu.Lock()
			defer library.mu.Unlock()
			return !library.piEnsuring && library.piFailures == 1
		})
		if got := planCalls(); got != 1 {
			t.Fatalf("expected 1 harness plan call, got %d", got)
		}

		// Within the 30s backoff window, Refreshes are suppressed.
		library.Refresh(context.Background())
		if got := planCalls(); got != 1 {
			t.Fatalf("expected backoff to suppress retries before 30s, got %d calls", got)
		}

		// After 31s, second failure doubles backoff to 60s.
		clockMu.Lock()
		currentTime = currentTime.Add(31 * time.Second)
		clockMu.Unlock()
		library.Refresh(context.Background())
		waitFor(t, "second Pi install failure recorded", func() bool {
			library.mu.Lock()
			defer library.mu.Unlock()
			return !library.piEnsuring && library.piFailures == 2
		})
		if got := planCalls(); got != 2 {
			t.Fatalf("expected 2 harness plan calls, got %d", got)
		}

		// Advancing only 31s (less than doubled 60s backoff) still suppresses retries.
		if err := os.Remove(failMarker); err != nil {
			t.Fatal(err)
		}
		clockMu.Lock()
		currentTime = currentTime.Add(31 * time.Second)
		clockMu.Unlock()
		library.Refresh(context.Background())
		if got := planCalls(); got != 2 {
			t.Fatalf("expected doubled 60s backoff to suppress retry at +31s, got %d calls", got)
		}

		clockMu.Lock()
		currentTime = currentTime.Add(30 * time.Second)
		clockMu.Unlock()
		library.Refresh(context.Background())
		want := filepath.Join(harnessDir, "tools", "pi", "1.3.0", "pi")
		waitFor(t, "Pi install succeeded after doubled backoff elapsed", func() bool {
			return library.PiExecutable() == want && record.changes() == 1
		})
	})

	t.Run("timer retries automatically without another Refresh", func(t *testing.T) {
		fake := newFakeTool(t)
		fake.write("status.json", status(model(testModel, "loaded")))
		failMarker := filepath.Join(fake.state, "harness-plan-fail")
		if err := os.WriteFile(failMarker, []byte("1"), 0o600); err != nil {
			t.Fatal(err)
		}
		harnessDir := filepath.Join(filepath.Dir(fake.state), "harness")
		record := &recorder{}
		library := New(Options{
			Tool:                  &fake.tool,
			Environment:           map[string]string{"LOCALMODELS_FAKE_TOOL": "1", "HOME": t.TempDir(), "PATH": os.Getenv("PATH")},
			JobDirectory:          filepath.Join(t.TempDir(), "jobs"),
			HarnessDirectory:      harnessDir,
			Publish:               record.publish,
			RuntimeChanged:        record.runtimeChanged,
			EnsurePiRetryInterval: 30 * time.Millisecond,
		})
		t.Cleanup(library.Close)

		library.Refresh(context.Background())
		waitFor(t, "initial failure recorded", func() bool {
			library.mu.Lock()
			defer library.mu.Unlock()
			return !library.piEnsuring && library.piFailures >= 1
		})

		if err := os.Remove(failMarker); err != nil {
			t.Fatal(err)
		}
		want := filepath.Join(harnessDir, "tools", "pi", "1.3.0", "pi")
		waitFor(t, "automatic timer retry provisioned Pi", func() bool {
			return library.PiExecutable() == want && record.changes() == 1
		})
	})

	t.Run("unloading models cancels pending Pi retry timer", func(t *testing.T) {
		fake := newFakeTool(t)
		fake.write("status.json", status(model(testModel, "loaded")))
		failMarker := filepath.Join(fake.state, "harness-plan-fail")
		if err := os.WriteFile(failMarker, []byte("1"), 0o600); err != nil {
			t.Fatal(err)
		}
		harnessDir := filepath.Join(filepath.Dir(fake.state), "harness")
		library := New(Options{
			Tool:                  &fake.tool,
			Environment:           map[string]string{"LOCALMODELS_FAKE_TOOL": "1", "HOME": t.TempDir(), "PATH": os.Getenv("PATH")},
			JobDirectory:          filepath.Join(t.TempDir(), "jobs"),
			HarnessDirectory:      harnessDir,
			EnsurePiRetryInterval: 80 * time.Millisecond,
		})
		t.Cleanup(library.Close)

		library.Refresh(context.Background())
		waitFor(t, "initial failure recorded", func() bool {
			library.mu.Lock()
			defer library.mu.Unlock()
			return !library.piEnsuring && library.piFailures == 1
		})

		_ = os.Remove(failMarker)
		fake.write("status.json", status(model(testModel, "idle")))
		library.Refresh(context.Background())

		time.Sleep(180 * time.Millisecond)
		if library.PiExecutable() != "" {
			t.Fatalf("Pi was provisioned after models were unloaded: %q", library.PiExecutable())
		}
	})
}

func TestLibraryCloseCancelsInFlightPiProvisionAndWaitsCleanly(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "loaded")))
	if err := os.WriteFile(filepath.Join(fake.state, "harness-apply-wait"), []byte("1"), 0o600); err != nil {
		t.Fatal(err)
	}
	harnessDir := filepath.Join(filepath.Dir(fake.state), "harness")
	record := &recorder{}
	library := New(Options{
		Tool:                  &fake.tool,
		Environment:           map[string]string{"LOCALMODELS_FAKE_TOOL": "1", "HOME": t.TempDir(), "PATH": os.Getenv("PATH")},
		JobDirectory:          filepath.Join(t.TempDir(), "jobs"),
		HarnessDirectory:      harnessDir,
		Publish:               record.publish,
		RuntimeChanged:        record.runtimeChanged,
		EnsurePiRetryInterval: 10 * time.Millisecond,
	})

	library.Refresh(context.Background())
	waitFor(t, "harness apply entered", func() bool {
		_, err := os.Stat(filepath.Join(fake.state, "harness-apply-entered"))
		return err == nil
	})

	done := make(chan struct{})
	go func() {
		library.Close()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		_ = os.Remove(filepath.Join(fake.state, "harness-apply-wait"))
		t.Fatal("Library.Close timed out waiting for in-flight Pi setup")
	}

	library.mu.Lock()
	ensuring := library.piEnsuring
	retryTimer := library.piRetryTimer
	library.mu.Unlock()
	if ensuring || retryTimer != nil || library.PiExecutable() != "" || record.changes() != 0 {
		t.Fatalf("unexpected post-close state: ensuring=%v timer=%v exec=%q changes=%d",
			ensuring, retryTimer != nil, library.PiExecutable(), record.changes())
	}
}
