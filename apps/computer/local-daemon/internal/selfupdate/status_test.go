package selfupdate

import (
	"context"
	"errors"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// A failed attempt reports failed with the step's code and keeps it through
// the retry, so the Computer's profile does not flip between failed and
// staging each hour. A target that is the running build clears it.
func TestStatusKeepsTheLastFailureUntilTheTargetIsReached(t *testing.T) {
	_, executable := installRoot(t, "lib-old")
	var changes atomic.Int32
	stager := &fakeStager{stage: func(context.Context, StageRequest) error {
		return &StageError{Stage: "verify", Err: errors.New("sha256 does not match target_release")}
	}}
	options := testOptions(executable, &fakeAdmission{}, stager, newStopSignal().stop)
	options.RetryDelay = 20 * time.Millisecond
	options.OnStatusChange = func() { changes.Add(1) }
	manager := New(options)
	if status := manager.Status(); status.State != StatusIdle {
		t.Fatalf("initial status = %+v", status)
	}

	manager.WelcomeAccepted(context.Background(), target("2.0.0"))
	eventually(t, func() bool { return manager.Status().State == StatusFailed })
	status := manager.Status()
	if status.ErrorCode != FailureVerify || status.AttemptedAt.IsZero() || status.Detail == "" {
		t.Fatalf("failed status = %+v", status)
	}
	eventually(t, func() bool { return stager.calls.Load() >= 2 })
	if retried := manager.Status(); retried.State != StatusFailed {
		t.Fatalf("status during the retry = %+v, want the failure kept", retried)
	}

	manager.WelcomeAccepted(context.Background(), target("lib-old"))
	if status := manager.Status(); status.State != StatusIdle {
		t.Fatalf("status at the target = %+v, want idle", status)
	}
	eventually(t, func() bool { return changes.Load() > 0 })
}

// A Computer that restarted after a rollback reports the rolled-back
// attempt as an activation failure.
func TestStatusAfterARollbackIsActivateFailed(t *testing.T) {
	root, executable := installRoot(t, "lib-old")
	writeFile(t, filepath.Join(root, "upgrade-failed"), `{"app_sha256":"`+buildSHA("2.0.0")+`","failed_at":"2026-10-22T00:00:00Z"}`, 0o600)
	manager := New(testOptions(executable, &fakeAdmission{}, &fakeStager{}, newStopSignal().stop))
	status := manager.Status()
	if status.State != StatusFailed || status.ErrorCode != FailureActivate ||
		!status.AttemptedAt.Equal(time.Date(2026, 10, 22, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("status = %+v", status)
	}
}

func TestFailureCodeNamesTheStep(t *testing.T) {
	for stage, want := range map[string]string{
		"archive": FailureArchiveInvalid, "download": FailureDownload, "verify": FailureVerify,
		"install": FailureStage, "activate": FailureActivate, "timeout": FailureActivate,
	} {
		if got := failureCode(&StageError{Stage: stage, Err: errors.New("x")}); got != want {
			t.Fatalf("stage %s: code %s, want %s", stage, got, want)
		}
	}
	if got := failureCode(errors.New("plain")); got != FailureStage {
		t.Fatalf("plain error: code %s", got)
	}
}
