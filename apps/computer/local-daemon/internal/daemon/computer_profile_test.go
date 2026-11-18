package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

// fakeProfiler counts probes and serves a profile the test can change.
type fakeProfiler struct {
	mu      sync.Mutex
	probes  chan struct{}
	probed  bool
	profile wire.ComputerProfile
}

func (f *fakeProfiler) Probe(context.Context) {
	f.mu.Lock()
	f.probed = true
	f.mu.Unlock()
	f.probes <- struct{}{}
}

func (f *fakeProfiler) Current() (wire.ComputerProfile, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.profile, f.probed
}

func (f *fakeProfiler) setUpdate(update wire.ComputerProfileUpdate) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.profile.Update = update
}

func profileFrames(t *testing.T, stream *fakeStream) []wire.RunnerComputerProfile {
	t.Helper()
	var frames []wire.RunnerComputerProfile
	for _, event := range stream.snapshotEvents() {
		if event.Type != protocol.EventComputerProfile {
			continue
		}
		var frame wire.RunnerComputerProfile
		if err := wire.Decode(event.Payload, &frame); err != nil {
			t.Fatal(err)
		}
		frames = append(frames, frame)
	}
	return frames
}

// runner.computer_profile goes only to an Agent Service whose welcome names
// computer_profile: an older service closes the connection on the frame. On
// such a connection the profile is sent after the first probe, again only
// when it changes, and the hardware is not probed at all without the feature.
func TestComputerProfileFollowsTheWelcomeServiceFeatures(t *testing.T) {
	for _, test := range []struct {
		name     string
		features []string
		want     bool
	}{
		{name: "older service", features: []string{"local_models"}, want: false},
		{name: "current service", features: []string{"local_models", "computer_profile"}, want: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			device, err := transport.GenerateIdentity()
			if err != nil {
				t.Fatal(err)
			}
			release := make(chan struct{})
			stream := &fakeStream{
				commands: []protocol.Command{
					{Type: protocol.CommandRunnerWelcome, ConnectionEpoch: 1, ServiceFeatures: test.features},
					{Type: protocol.CommandRunnerReconciled, RunnerID: "computer-1", ConnectionEpoch: 1},
				},
				wait: release,
			}
			profiler := &fakeProfiler{probes: make(chan struct{}, 4), profile: wire.ComputerProfile{
				InstallKind:  "cli",
				Accelerators: wire.ComputerAccelerators{Probe: "ok", RamTotalBytes: 64 << 30, Gpus: []wire.ComputerAcceleratorGpu{}},
				LocalModels:  wire.ComputerProfileLocalModels{Mode: "none"},
				Update:       wire.ComputerProfileUpdate{State: "idle"},
			}}
			d, err := newTestDaemon(t, Options{
				ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream}, IdentityStore: fakeStore{value: device},
				OperationResolver: fakeOperationResolver{}, ComputerProfile: profiler,
				Owners: []ComputerOwner{{TenantID: "tenant", OwnerActorID: "owner"}},
			})
			if err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() { done <- d.runConnection(t.Context(), device) }()
			deadline := time.Now().Add(5 * time.Second)
			for !d.Reconciled() && time.Now().Before(deadline) {
				time.Sleep(time.Millisecond)
			}
			if !d.Reconciled() {
				t.Fatal("the connection was not welcomed")
			}
			if test.want {
				select {
				case <-profiler.probes:
				case <-time.After(5 * time.Second):
					t.Fatal("the welcomed connection did not probe the hardware")
				}
				eventually(t, "the first profile", func() bool { return len(profileFrames(t, stream)) == 1 })
			}
			// An unchanged profile is not sent again; a self-update failure is.
			d.PublishComputerProfile()
			profiler.setUpdate(wire.ComputerProfileUpdate{State: "failed", AttemptedAt: "2026-11-18T00:00:00Z", ErrorCode: "VERIFY_FAILED"})
			d.PublishComputerProfile()

			close(release)
			if err := <-done; !errors.Is(err, io.EOF) {
				t.Fatalf("connection ended with %v", err)
			}
			frames := profileFrames(t, stream)
			if !test.want {
				if len(frames) != 0 {
					t.Fatalf("sent %d profiles to a service that does not accept them", len(frames))
				}
				select {
				case <-profiler.probes:
					t.Fatal("the hardware was probed for a service that does not accept profiles")
				default:
				}
				return
			}
			if len(frames) != 2 || frames[0].Revision >= frames[1].Revision ||
				frames[0].Profile.Update.State != "idle" || frames[1].Profile.Update.ErrorCode != "VERIFY_FAILED" {
				encoded, _ := json.Marshal(frames)
				t.Fatalf("profiles = %s", encoded)
			}
			// Once the connection is gone nothing is sent.
			profiler.setUpdate(wire.ComputerProfileUpdate{State: "idle"})
			d.PublishComputerProfile()
			if len(profileFrames(t, stream)) != 2 {
				t.Fatal("a profile was sent without a connection")
			}
		})
	}
}

// Before the connection's first probe finishes the hardware is unknown, so
// a self-update change does not send a profile without it.
func TestComputerProfileWaitsForTheFirstProbe(t *testing.T) {
	stream := &fakeStream{}
	profiler := &fakeProfiler{probes: make(chan struct{}, 1)}
	d := &Daemon{computerID: "computer", protocolVersion: protocol.Version, computerProfile: profiler, computerProfileStream: stream}
	d.PublishComputerProfile()
	if len(profileFrames(t, stream)) != 0 {
		t.Fatal("a profile was sent before the hardware was probed")
	}
}
