package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

// serviceFeatureComputerProfile in runner.welcome's service_features says the
// Agent Service accepts runner.computer_profile. An Agent Service that
// predates it closes the connection on the frame.
const serviceFeatureComputerProfile = "computer_profile"

// computerProfileProbeInterval is how often a connected Computer rereads its
// hardware, so a GPU that appears later reaches the profile.
const computerProfileProbeInterval = 6 * time.Hour

// ComputerProfiler supplies the facts runner.computer_profile carries.
type ComputerProfiler interface {
	// Probe rereads the hardware; it returns within its own timeout.
	Probe(ctx context.Context)
	// Current is the profile now; probed is false until the first Probe
	// finished, when the hardware is not known yet.
	Current() (profile wire.ComputerProfile, probed bool)
}

// computerProfileLoop probes on a newly welcomed connection, then every
// computerProfileProbeInterval while it lasts. The probe runs off the
// connection path: a hung GPU driver must not delay the connect.
func (d *Daemon) computerProfileLoop(ctx context.Context) {
	ticker := time.NewTicker(computerProfileProbeInterval)
	defer ticker.Stop()
	for {
		d.computerProfile.Probe(ctx)
		if ctx.Err() != nil {
			return
		}
		d.PublishComputerProfile()
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// PublishComputerProfile sends runner.computer_profile on the live
// connection when its Agent Service accepts it and the profile differs from
// the one that connection last received. It is not periodic: callers call it
// when a fact may have changed.
func (d *Daemon) PublishComputerProfile() {
	if d.computerProfile == nil {
		return
	}
	d.computerProfileMu.Lock()
	defer d.computerProfileMu.Unlock()
	d.connectionMu.Lock()
	stream := d.computerProfileStream
	d.connectionMu.Unlock()
	if stream == nil {
		return
	}
	profile, probed := d.computerProfile.Current()
	if !probed {
		// The connection's first probe sends the profile when it finishes.
		return
	}
	encoded, err := json.Marshal(profile)
	if err != nil {
		slog.Warn("computer_profile.not_sent", "error", err)
		return
	}
	if stream == d.sentComputerProfileOn && bytes.Equal(encoded, d.sentComputerProfile) {
		return
	}
	d.computerProfileRevision++
	sentAt := time.Now().UTC()
	payload, err := json.Marshal(wire.RunnerComputerProfile{
		Type: wire.TypeRunnerComputerProfile, ProtocolVersion: d.protocolVersion, RunnerID: d.computerID,
		SentAt: sentAt.Format(time.RFC3339Nano), Revision: d.computerProfileRevision, Profile: profile,
	})
	if err == nil {
		err = stream.Send(context.Background(), protocol.Event{
			Type: protocol.EventComputerProfile, ProtocolVersion: d.protocolVersion, RunnerID: d.computerID,
			Revision: d.computerProfileRevision, SentAt: sentAt, Payload: payload,
		})
	}
	if err != nil {
		slog.Warn("computer_profile.not_sent", "revision", d.computerProfileRevision, "error", err)
		return
	}
	d.sentComputerProfile, d.sentComputerProfileOn = encoded, stream
	slog.Info("computer_profile.sent", "revision", d.computerProfileRevision, "install_kind", profile.InstallKind,
		"probe", profile.Accelerators.Probe, "gpus", len(profile.Accelerators.Gpus), "update", profile.Update.State)
}
