package selfupdate

import (
	"errors"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
)

// Status states, as runner.computer_profile reports them.
const (
	StatusIdle    = "idle"
	StatusStaging = "staging"
	StatusFailed  = "failed"
)

// Failure codes, as runner.computer_profile reports them.
const (
	FailureArchiveInvalid = "ARCHIVE_INVALID"
	FailureDownload       = "DOWNLOAD_FAILED"
	FailureVerify         = "VERIFY_FAILED"
	FailureStage          = "STAGE_FAILED"
	FailureActivate       = "ACTIVATE_FAILED"
)

// maxStatusDetail bounds the diagnostic text a Status carries.
const maxStatusDetail = 4000

// Status is the last self-update attempt. A failure stays until an attempt
// succeeds or the Agent's target is the running build, so a retry after a
// failure does not hide it.
type Status struct {
	State       string
	AttemptedAt time.Time
	// ErrorCode and Detail are set only when State is failed.
	ErrorCode string
	Detail    string
}

// Status reports the last self-update attempt.
func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	switch {
	case m.failure != nil:
		return *m.failure
	case m.phase == phaseRunning:
		return Status{State: StatusStaging, AttemptedAt: m.attemptAt}
	}
	return Status{State: StatusIdle}
}

// statusChanged tells the owner to read Status again. It runs off the
// caller's goroutine because the caller may hold m.mu.
func (m *Manager) statusChanged() {
	if m.options.OnStatusChange != nil {
		go m.options.OnStatusChange()
	}
}

// recordFailureLocked keeps err as the last attempt's failure. The caller
// holds m.mu.
func (m *Manager) recordFailureLocked(at time.Time, err error) {
	detail := redact.Text(err.Error())
	if len(detail) > maxStatusDetail {
		detail = detail[:maxStatusDetail]
	}
	m.failure = &Status{State: StatusFailed, AttemptedAt: at, ErrorCode: failureCode(err), Detail: detail}
	m.statusChanged()
}

// clearFailureLocked forgets the last failure. The caller holds m.mu.
func (m *Manager) clearFailureLocked() {
	if m.failure == nil {
		return
	}
	m.failure = nil
	m.statusChanged()
}

// failureCode names the step of the attempt that failed.
func failureCode(err error) string {
	var stageError *StageError
	if !errors.As(err, &stageError) {
		return FailureStage
	}
	switch stageError.Stage {
	case "archive":
		return FailureArchiveInvalid
	case "download":
		return FailureDownload
	case "verify":
		return FailureVerify
	case "activate", "timeout":
		return FailureActivate
	}
	return FailureStage
}
