package integration_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
)

// localModelsQueryTracer records the SQL that touches Local Computers while
// recording is on.
type localModelsQueryTracer struct {
	mu        sync.Mutex
	recording bool
	queries   []string
}

func (r *localModelsQueryTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.recording && strings.Contains(data.SQL, "local_computer") {
		r.queries = append(r.queries, data.SQL)
	}
	return ctx
}

func (*localModelsQueryTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func (r *localModelsQueryTracer) record(on bool) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	queries := r.queries
	r.recording, r.queries = on, nil
	return queries
}

// TestLocalModelsComputerSummaries covers what needs PostgreSQL: the summary
// the migration's function stores beside each snapshot, readiness from it on
// the list, the library view and the Computers page, one query for many
// Computers that never reads a snapshot, readiness and owner-only hardware
// from stored profiles, and refresh's owner and online rules.
func TestLocalModelsComputerSummaries(t *testing.T) {
	allowParallelIntegrationTest(t)
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	computers := &localModelsComputers{}
	tracer := &localModelsQueryTracer{}
	application, err := newTestApp(context.Background(), config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.TeamHubInternalToken = teamHubInternalToken
		c.NodeServicesInternalToken = nodeServicesInternalToken
		c.AgentRunTokenSecret = agentRunTokenSecret
		c.SSEHeartbeatInterval = 5 * time.Second
		c.SSEQueueCapacity = 8
		c.ArtifactStorageRoot = t.TempDir()
	}), withLocalComputers(computers), withQueryTracer(tracer))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)
	bob := seedPeerHuman(t, env)

	// 50 of Alice's Computers: three report libraries below, one is Simplex
	// era, one just connected, three report profiles, and the rest never
	// reported.
	if _, err := pool.Exec(t.Context(), `
INSERT INTO local_computers(computer_id,display_name,status,owner_tenant_id,owner_actor_id,last_seen_at,daemon_version,platform,workspace_grants)
SELECT format('computer_fleet_%s', lpad(n::text, 2, '0')), format('fleet-%s', n), 'offline', 'tenant_acme', 'actor_acme_alice',
       now()-interval '1 day', '0.52.0', 'linux', '[]'::jsonb
FROM generate_series(1, 50) AS n;
UPDATE local_computers SET status='online', last_seen_at=now()-interval '5 seconds'
WHERE computer_id IN ('computer_fleet_01','computer_fleet_02','computer_fleet_03','computer_fleet_05');
UPDATE local_computers SET daemon_version='0.50.0', platform='win32' WHERE computer_id='computer_fleet_04';
UPDATE local_computers SET connected_at=now()-interval '10 seconds' WHERE computer_id='computer_fleet_05';
UPDATE local_computers
SET workspace_grants='[{"grant_id":"grant_fleet","tenant_id":"tenant_acme","scope":"owner","mode":"workspace-write"}]'::jsonb
WHERE computer_id='computer_fleet_01';`); err != nil {
		t.Fatal(err)
	}
	record := func(computerID string, snapshot map[string]any) {
		t.Helper()
		status, body := agentRuntimeStateRequest(t, server.Config.Handler, http.MethodPost,
			"/v0/agent-runtime/local-computers/local-models", teamHubInternalToken,
			map[string]any{"computer_id": computerID, "snapshot": snapshot})
		if status != http.StatusNoContent {
			t.Fatalf("record %s status=%d body=%s", computerID, status, body)
		}
	}
	host := func(gpus ...any) map[string]any {
		return map[string]any{"platform": "linux", "arch": "x86_64", "os_label": "Ubuntu 24.04", "engine_label": "llama.cpp",
			"ram_total_bytes": 64 << 30, "disk_free_bytes": 100 << 30, "gpus": append([]any{}, gpus...)}
	}
	model := func(id, state, fit string, downloadable bool) map[string]any {
		availability := map[string]any{"downloadable": downloadable}
		if !downloadable {
			availability["reason"] = map[string]any{"code": "MEMORY_INSUFFICIENT"}
		}
		return map[string]any{
			"id": id, "name": id, "description": "", "quant": "Q4", "context_tokens": 32768, "vision": false,
			"download_bytes": 4 << 30, "memory_bytes": 6 << 30, "fit": fit, "recommended": false,
			"availability": availability, "state": state,
		}
	}
	gpu := map[string]any{"index": 0, "name": "NVIDIA RTX 4090", "total_bytes": 24 << 30, "free_bytes": 16 << 30}
	record("computer_fleet_01", map[string]any{
		"available": true, "observed_at": time.Now().UTC(), "host": host(gpu),
		"pools": []any{
			map[string]any{"id": "gpu:0", "kind": "gpu", "gpu_index": 0, "total_bytes": 24 << 30, "used_bytes": 6 << 30, "holders": []any{}},
			map[string]any{"id": "system", "kind": "system", "total_bytes": 50 << 30, "used_bytes": 1 << 30, "holders": []any{}},
		},
		"models": []any{model("a:Q4", "loaded", "gpu", true), model("b:Q4", "idle", "gpu", true), model("c:Q4", "absent", "none", false)},
	})
	record("computer_fleet_02", map[string]any{
		"available": false, "reason": map[string]any{"code": "TOOL_NOT_INSTALLED"}, "observed_at": time.Now().UTC(),
		"pools": []any{}, "models": []any{},
	})
	record("computer_fleet_03", map[string]any{
		"available": true, "observed_at": time.Now().UTC(), "host": host(),
		"pools":  []any{map[string]any{"id": "unified", "kind": "unified", "total_bytes": 50 << 30, "used_bytes": 0, "holders": []any{}}},
		"models": []any{model("a:Q4", "absent", "unified", true)},
	})

	// Profiles: fleet-2 is a container with a 24 GiB NVIDIA GPU and no tool;
	// fleet-6 never reported a library and its last self-update failed;
	// fleet-7's models come from another machine. Each stored profile sends
	// one computers hint.
	drainHints := listenTenantHints(t, pool)
	recordProfile := func(computerID, installKind, mode string, update map[string]any) {
		t.Helper()
		localModels := map[string]any{"mode": mode}
		if mode == "remote" {
			localModels["managed_by"] = map[string]any{"label": "GPU server lab-118", "computer_id": "computer_fleet_01"}
		}
		status, body := agentRuntimeStateRequest(t, server.Config.Handler, http.MethodPost,
			"/v0/agent-runtime/local-computers/profile", teamHubInternalToken,
			map[string]any{"computer_id": computerID, "observed_at": time.Now().UTC(), "profile": map[string]any{
				"install_kind": installKind,
				"accelerators": map[string]any{"probe": "ok", "ram_total_bytes": 64 << 30, "apple_silicon": false,
					"gpus": []any{map[string]any{"vendor": "nvidia", "name": "NVIDIA L40S", "memory_bytes": 24 << 30}}},
				"local_models": localModels,
				"update":       update,
			}})
		if status != http.StatusNoContent {
			t.Fatalf("record profile %s status=%d body=%s", computerID, status, body)
		}
	}
	idle := map[string]any{"state": "idle"}
	recordProfile("computer_fleet_02", "container", "none", idle)
	recordProfile("computer_fleet_06", "cli", "none", map[string]any{
		"state": "failed", "attempted_at": time.Now().UTC(), "error_code": "VERIFY_FAILED", "detail": "sha256 does not match target_release"})
	recordProfile("computer_fleet_07", "cli", "remote", idle)
	if hints := drainHints()[realtime.InvalidationKindPrefix+realtime.InvalidateComputers]; hints != 3 {
		t.Fatalf("stored profiles sent %d computers hints, want 3", hints)
	}
	status, body := agentRuntimeStateRequest(t, server.Config.Handler, http.MethodPost,
		"/v0/agent-runtime/local-computers/profile", teamHubInternalToken,
		map[string]any{"computer_id": "computer_fleet_02", "observed_at": time.Now().UTC(), "profile": map[string]any{
			"install_kind": "vm", "accelerators": map[string]any{"probe": "ok", "ram_total_bytes": 1, "apple_silicon": false, "gpus": []any{}},
			"local_models": map[string]any{"mode": "none"}, "update": idle}})
	if status != http.StatusBadRequest {
		t.Fatalf("an unknown install kind was stored: status=%d body=%s", status, body)
	}

	var summary string
	if err := pool.QueryRow(t.Context(), `SELECT summary::text FROM local_computer_model_snapshots WHERE computer_id='computer_fleet_01'`).Scan(&summary); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"usable": 2`, `"counts": {"loaded": 1, "on_disk": 2, "working": 0}`,
		`"memory": {"kind": "gpu", "used_bytes": 6442450944, "total_bytes": 25769803776}`, `"unavailable_code": "MEMORY_INSUFFICIENT"`, `"gpus": 1`} {
		if !strings.Contains(summary, want) {
			t.Fatalf("summary %s lacks %s", summary, want)
		}
	}

	var page struct {
		Items []struct {
			ComputerID    string `json:"computer_id"`
			ViewerIsOwner bool   `json:"viewer_is_owner"`
			Status        string `json:"status"`
			Owner         struct {
				DisplayName string `json:"display_name"`
			} `json:"owner"`
			Readiness struct {
				State     string `json:"state"`
				Reason    string `json:"reason"`
				SetupPath string `json:"setup_path"`
			} `json:"readiness"`
			Counts *struct {
				Loaded int `json:"loaded"`
				OnDisk int `json:"on_disk"`
			} `json:"counts"`
			Memory *struct {
				Kind string `json:"kind"`
			} `json:"memory"`
			InstallKind  string `json:"install_kind"`
			Accelerators *struct {
				Gpus []struct {
					Vendor string `json:"vendor"`
				} `json:"gpus"`
			} `json:"accelerators"`
			ManagedBy *struct {
				Label string `json:"label"`
			} `json:"managed_by"`
		} `json:"items"`
	}
	list := "/v0/tenants/" + acmeTenant + "/local-models/computers"
	tracer.record(true)
	status, _, body = env.request(alice, http.MethodGet, list+"?scope=mine", nil, "")
	queries := tracer.record(false)
	if status != http.StatusOK {
		t.Fatalf("list status=%d body=%s", status, body)
	}
	if len(queries) != 1 || regexp.MustCompile(`snapshot\.snapshot|SELECT snapshot,|snapshot\.host`).MatchString(queries[0]) {
		t.Fatalf("the list ran %d Local Computer queries or read a snapshot: %q", len(queries), queries)
	}
	decode(t, body, &page)
	if len(page.Items) != 50 {
		t.Fatalf("listed %d Computers", len(page.Items))
	}
	want := map[string]string{
		"computer_fleet_01": "loaded//nvidia", "computer_fleet_02": "not_set_up/SETUP_AVAILABLE/nvidia",
		"computer_fleet_07": "managed_elsewhere//nvidia",
		"computer_fleet_03": "unsupported_hardware/NO_SUPPORTED_GPU/unknown", "computer_fleet_04": "needs_reinstall/DAEMON_LEGACY/unknown",
		"computer_fleet_05": "checking//unknown", "computer_fleet_06": "needs_reinstall/UPDATE_FAILED/nvidia",
		"computer_fleet_08": "not_reported/NOT_REPORTED/unknown",
	}
	for _, item := range page.Items {
		got := fmt.Sprintf("%s/%s/%s", item.Readiness.State, item.Readiness.Reason, item.Readiness.SetupPath)
		if expected, ok := want[item.ComputerID]; ok && got != expected {
			t.Errorf("%s readiness %s, want %s", item.ComputerID, got, expected)
		}
		if !item.ViewerIsOwner || item.Owner.DisplayName == "" {
			t.Errorf("%s owner: %+v", item.ComputerID, item)
		}
		if item.ComputerID == "computer_fleet_01" && (item.Status != "online" || item.Counts == nil || item.Counts.Loaded != 1 ||
			item.Counts.OnDisk != 2 || item.Memory == nil || item.Memory.Kind != "gpu") {
			t.Errorf("fleet-1 row: %+v", item)
		}
		if item.ComputerID == "computer_fleet_02" && (item.Counts != nil || item.Memory != nil || item.InstallKind != "container" ||
			item.Accelerators == nil || len(item.Accelerators.Gpus) != 1 || item.Accelerators.Gpus[0].Vendor != "nvidia") {
			t.Errorf("fleet-2 row: %+v", item)
		}
		if item.ComputerID == "computer_fleet_07" && (item.ManagedBy == nil || item.ManagedBy.Label != "GPU server lab-118") {
			t.Errorf("fleet-7 row: %+v", item)
		}
	}
	if status, _, body := env.request(alice, http.MethodGet, list+"?scope=space", nil, ""); status != http.StatusBadRequest {
		t.Fatalf("scope space status=%d body=%s", status, body)
	}
	if status, _, body := env.request(bob, http.MethodGet, list, nil, ""); status != http.StatusOK || containsJSONText(body, "computer_fleet") {
		t.Fatalf("another member lists Alice's Computers: status=%d body=%s", status, body)
	}

	base := "/v0/tenants/" + acmeTenant + "/local-computers/computer_fleet_03/local-models"
	status, _, body = env.request(bob, http.MethodGet, base, nil, "")
	if status != http.StatusOK || !containsJSONText(body, `"state":"unsupported_hardware"`) || !containsJSONText(body, `"display_name":`) {
		t.Fatalf("library view readiness status=%d body=%s", status, body)
	}
	// The hardware is the owner's to see; the install kind is not private.
	fleet2 := "/v0/tenants/" + acmeTenant + "/local-computers/computer_fleet_02/local-models"
	status, _, body = env.request(alice, http.MethodGet, fleet2, nil, "")
	if status != http.StatusOK || !containsJSONText(body, `"install_kind":"container"`) || !containsJSONText(body, `"name":"NVIDIA L40S"`) {
		t.Fatalf("owner library view status=%d body=%s", status, body)
	}
	status, _, body = env.request(bob, http.MethodGet, fleet2, nil, "")
	if status != http.StatusOK || !containsJSONText(body, `"install_kind":"container"`) || containsJSONText(body, `"accelerators"`) {
		t.Fatalf("member library view status=%d body=%s", status, body)
	}
	status, _, body = env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/local-computers", nil, "")
	if status != http.StatusOK || !containsJSONText(body, `"local_models_readiness":{"enable_command":false,"setup_path":"nvidia","state":"loaded"}`) {
		t.Fatalf("Computers page readiness status=%d body=%s", status, body)
	}

	refresh := func(client *http.Client, computerID string) (int, []byte) {
		t.Helper()
		status, _, body := env.request(client, http.MethodPost, "/v0/tenants/"+acmeTenant+"/local-computers/"+computerID+"/local-models/refresh", nil, "")
		return status, body
	}
	if status, body := refresh(alice, "computer_fleet_01"); status != http.StatusAccepted || !containsJSONText(body, `"computer_id":"computer_fleet_01"`) {
		t.Fatalf("owner refresh status=%d body=%s", status, body)
	}
	if len(computers.commands) != 1 || computers.commands[0].Action != roomagent.LocalModelActionRefresh || computers.commands[0].ModelID != "" {
		t.Fatalf("forwarded commands=%+v", computers.commands)
	}
	if status, body := refresh(bob, "computer_fleet_01"); status != http.StatusForbidden || !containsJSONText(body, "LOCAL_MODEL_ACTION_FORBIDDEN") {
		t.Fatalf("member refresh status=%d body=%s", status, body)
	}
	if status, body := refresh(alice, "computer_fleet_08"); status != http.StatusServiceUnavailable || !containsJSONText(body, "LOCAL_COMPUTER_OFFLINE") {
		t.Fatalf("offline refresh status=%d body=%s", status, body)
	}
	if len(computers.commands) != 1 {
		t.Fatalf("a refused refresh reached the Computer: %+v", computers.commands)
	}
}
