package integration_test

import (
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
)

// A Computer the Agent Service observes behind the deployment's Computer
// release is pending from its first such observation until one finds it
// current; each change sends a computers hint, and readiness reads it as
// stuck after two missed hourly offers. A Simplex-era Computer that can never
// update stays legacy.
func TestAgentRuntimeLocalComputerUpdatePending(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRuntimeStateTestEnv(t)
	drainHints := listenTenantHints(t, env.pool)
	computerHints := func() int {
		t.Helper()
		return drainHints()[realtime.InvalidationKindPrefix+realtime.InvalidateComputers]
	}
	behind, current := false, true
	start := time.Now().UTC().Truncate(time.Microsecond)
	readiness := func(computerID string, now time.Time) string {
		t.Helper()
		record, err := env.service.LocalModels(t.Context(), "tenant_acme", "actor_acme_alice", computerID)
		if err != nil {
			t.Fatalf("read %s: %v", computerID, err)
		}
		got := agentruntimestate.LocalModelsReadiness(agentruntimestate.LocalModelsReadinessFacts{
			Status: record.Status, Online: record.Status == "online", DaemonVersion: record.DaemonVersion,
			ConnectedAt: record.ConnectedAt, UpdatePendingSince: record.UpdatePendingSince, Summary: record.Summary,
		}, now)
		if got.Reason == nil {
			return string(got.State)
		}
		return string(got.State) + "/" + string(*got.Reason)
	}
	pendingSince := func(computerID string) *time.Time {
		t.Helper()
		var since *time.Time
		if err := env.pool.QueryRow(t.Context(), `SELECT update_pending_since FROM local_computers WHERE computer_id=$1`, computerID).Scan(&since); err != nil {
			t.Fatal(err)
		}
		return since
	}

	stuck := "computer_runtime_update_stuck"
	enrollRuntimeComputer(t, env, stuck)
	computerHints()
	connect := runtimeConnectInput(stuck, 0, start)
	connect.Status, connect.DaemonVersion, connect.RecommendedVersion, connect.ReleaseCurrent = "online", "0.51.0", "0.52.0", &behind
	if _, err := env.service.ConnectLocalComputer(t.Context(), connect); err != nil {
		t.Fatalf("connect a Computer behind the release: %v", err)
	}
	if since := pendingSince(stuck); since == nil || !since.Equal(start) {
		t.Fatalf("update_pending_since=%v, want %v", since, start)
	}
	if hints := computerHints(); hints != 1 {
		t.Fatalf("computers hints after connect=%d, want 1", hints)
	}
	if got := readiness(stuck, start); got != "needs_update/UPDATE_PENDING" {
		t.Fatalf("readiness right after connect=%s", got)
	}

	// The hourly offer fails and the Daemon reconnects behind again: the
	// pending time is kept, so the failure is not hidden by reconnecting.
	retry := runtimeConnectInput(stuck, 0, start.Add(time.Hour))
	retry.Status, retry.DaemonVersion, retry.RecommendedVersion, retry.ReleaseCurrent = "online", "0.51.0", "0.52.0", &behind
	if _, err := env.service.ConnectLocalComputer(t.Context(), retry); err != nil {
		t.Fatalf("reconnect behind the release: %v", err)
	}
	if _, err := env.service.TouchLocalComputer(t.Context(), agentruntimestate.TouchLocalComputerInput{
		ComputerID: stuck, Status: "online", SeenAt: start.Add(2 * time.Hour), ReleaseCurrent: &behind,
	}); err != nil {
		t.Fatalf("heartbeat behind the release: %v", err)
	}
	if since := pendingSince(stuck); since == nil || !since.Equal(start) {
		t.Fatalf("update_pending_since after retries=%v, want %v", since, start)
	}
	if hints := computerHints(); hints != 0 {
		t.Fatalf("computers hints while still pending=%d, want 0", hints)
	}
	if got := readiness(stuck, start.Add(2*time.Hour)); got != "needs_update/UPDATE_PENDING" {
		t.Fatalf("readiness at 2 h=%s", got)
	}
	if got := readiness(stuck, start.Add(2*time.Hour+time.Second)); got != "needs_reinstall/UPDATE_FAILED" {
		t.Fatalf("readiness after 2 h=%s", got)
	}

	// A touch without release facts keeps the pending time.
	if _, err := env.service.TouchLocalComputer(t.Context(), agentruntimestate.TouchLocalComputerInput{
		ComputerID: stuck, Status: "online", SeenAt: start.Add(3 * time.Hour),
	}); err != nil {
		t.Fatalf("heartbeat without release facts: %v", err)
	}
	if since := pendingSince(stuck); since == nil {
		t.Fatal("a touch without release facts cleared update_pending_since")
	}

	// The Computer catches up: the pending time clears and readiness recovers.
	caughtUp := runtimeConnectInput(stuck, 0, start.Add(4*time.Hour))
	caughtUp.Status, caughtUp.DaemonVersion, caughtUp.RecommendedVersion, caughtUp.ReleaseCurrent = "online", "0.52.0", "0.52.0", &current
	if _, err := env.service.ConnectLocalComputer(t.Context(), caughtUp); err != nil {
		t.Fatalf("connect after catching up: %v", err)
	}
	if since := pendingSince(stuck); since != nil {
		t.Fatalf("update_pending_since after catching up=%v, want none", since)
	}
	if hints := computerHints(); hints != 1 {
		t.Fatalf("computers hints after catching up=%d, want 1", hints)
	}
	if got := readiness(stuck, start.Add(4*time.Hour)); got != "checking" {
		t.Fatalf("readiness after catching up=%s", got)
	}

	// A Simplex-era Daemon is behind on every offer and never catches up; it
	// keeps the legacy reason, which names the reinstall that fixes it.
	legacy := "computer_runtime_update_legacy"
	enrollRuntimeComputer(t, env, legacy)
	for _, seenAt := range []time.Time{start, start.Add(3 * time.Hour)} {
		input := runtimeConnectInput(legacy, 0, seenAt)
		input.Status, input.DaemonVersion, input.RecommendedVersion, input.ReleaseCurrent = "online", "0.50.0", "0.52.0", &behind
		if _, err := env.service.ConnectLocalComputer(t.Context(), input); err != nil {
			t.Fatalf("connect a Simplex-era Computer: %v", err)
		}
	}
	if since := pendingSince(legacy); since == nil || !since.Equal(start) {
		t.Fatalf("Simplex-era update_pending_since=%v, want %v", since, start)
	}
	if got := readiness(legacy, start.Add(3*time.Hour)); got != "needs_reinstall/DAEMON_LEGACY" {
		t.Fatalf("Simplex-era readiness=%s", got)
	}
}
