package localmodels

import (
	"encoding/json"
	"os"
	"slices"
	"testing"
	"time"

	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

// testdata/library-status-dev38.json is what localmodels 0.1.0.dev38 printed
// for library status --json on a Linux computer with one GPU and nothing
// downloaded, with the GPU's UUID zeroed.
func TestMapStatusKeepsTheModelCardOfARealDev38Status(t *testing.T) {
	encoded, err := os.ReadFile("testdata/library-status-dev38.json")
	if err != nil {
		t.Fatal(err)
	}
	// A row with a load record also carries the prefill speed, as
	// round(prompt_tokens_per_second, 1); nothing here has been loaded.
	var document map[string]any
	if err := json.Unmarshal(encoded, &document); err != nil {
		t.Fatal(err)
	}
	rows := document["models"].([]any)
	moe := rows[2].(map[string]any)
	moe["state"], moe["pi_model"] = "idle", "localmodels-library/qwen3-6-35b-a3b"
	moe["tokens_per_second"], moe["prompt_tokens_per_second"] = 151.3, 2840.6
	encoded, err = json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}

	snapshot, err := mapStatus(encoded, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.ToolVersion != "0.1.0.dev38" || len(snapshot.Models) != 4 {
		t.Fatalf("snapshot = %s, %d models", snapshot.ToolVersion, len(snapshot.Models))
	}
	dense := modelState(snapshot, "qwen3.8-27b:UD-Q4_K_M")
	if dense == nil || dense.Family != "qwen" || dense.Publisher != "Qwen" || dense.Architecture != "dense" ||
		dense.Parameters != "27B" || dense.ActiveParameters != "" || dense.License != "Apache-2.0" ||
		dense.SourceURL != "https://huggingface.co/unsloth/Qwen3.8-27B-GGUF" ||
		!slices.Equal(dense.Capabilities, []string{"vision"}) || !dense.Recommended {
		t.Fatalf("dense model = %+v", dense)
	}
	mixture := modelState(snapshot, "qwen3.6-35b-a3b:UD-Q4_K_M")
	if mixture == nil || mixture.Architecture != "moe" || mixture.Parameters != "35B" || mixture.ActiveParameters != "3B" ||
		mixture.PromptTokensPerSecond == nil || *mixture.PromptTokensPerSecond != 2840.6 ||
		mixture.TokensPerSecond == nil || *mixture.TokensPerSecond != 151.3 || mixture.Recommended {
		t.Fatalf("moe model = %+v", mixture)
	}

	// The snapshot sends the contract's names.
	sent, err := json.Marshal(mixture)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(sent, &fields); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"family", "publisher", "architecture", "parameters", "active_parameters", "license", "source_url", "capabilities", "prompt_tokens_per_second"} {
		if _, ok := fields[name]; !ok {
			t.Errorf("snapshot model has no %s: %s", name, sent)
		}
	}
}

func TestMapStatusClearsProgressOutsideActiveStateAndKeepsValidProgress(t *testing.T) {
	downloading := model("downloading-model:Q4_K_M", "downloading")
	downloading["download"] = map[string]any{
		"step": "download", "done_bytes": 512, "total_bytes": 1024, "bytes_per_second": 2048,
		"source": "modelscope", "connections": 16,
	}
	downloading["load"] = map[string]any{"step": "prepare", "done_steps": 1, "total_steps": 7}

	loading := model("loading-model:Q4_K_M", "loading")
	loading["download"] = map[string]any{"step": "verify", "done_bytes": 1024, "total_bytes": 1024}
	loading["load"] = map[string]any{"step": "load", "done_steps": 4, "total_steps": 7}

	idle := model("idle-model:Q4_K_M", "idle")
	idle["download"] = map[string]any{"step": "download", "done_bytes": 1024, "total_bytes": 1024, "source": "cache", "connections": 0}
	idle["load"] = map[string]any{"step": "warm", "done_steps": 7, "total_steps": 7}

	encoded, err := json.Marshal(status(downloading, loading, idle))
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := mapStatus(encoded, time.Now())
	if err != nil {
		t.Fatal(err)
	}

	gotDownloading := modelState(snapshot, "downloading-model:Q4_K_M")
	if gotDownloading == nil || gotDownloading.Download == nil || gotDownloading.Load != nil ||
		gotDownloading.Download.Source != "modelscope" || gotDownloading.Download.Connections == nil || *gotDownloading.Download.Connections != 16 {
		t.Fatalf("downloading model = %+v", gotDownloading)
	}
	gotLoading := modelState(snapshot, "loading-model:Q4_K_M")
	if gotLoading == nil || gotLoading.Load == nil || gotLoading.Download != nil ||
		gotLoading.Load.Step != "load" || gotLoading.Load.DoneSteps != 4 || gotLoading.Load.TotalSteps != 7 {
		t.Fatalf("loading model = %+v", gotLoading)
	}
	gotIdle := modelState(snapshot, "idle-model:Q4_K_M")
	if gotIdle == nil || gotIdle.Download != nil || gotIdle.Load != nil {
		t.Fatalf("idle model kept stale progress = %+v", gotIdle)
	}
}

func TestCheckModelValidatesDownloadAndLoadProgress(t *testing.T) {
	baseModel := func() wire.LocalModel {
		return wire.LocalModel{
			ID: testModel, Name: "Qwen3 4B", Quant: "Q4_K_M", Fit: "gpu", Pool: "gpu:0", State: "idle",
			Availability: wire.LocalModelAvailability{Downloadable: true},
		}
	}
	u64 := func(v uint64) *uint64 { return &v }

	for _, source := range []string{"", "huggingface", "modelscope", "custom", "cache"} {
		m := baseModel()
		m.State = "downloading"
		m.Download = &wire.LocalModelDownloadProgress{Step: "download", Source: source, Connections: u64(64)}
		if err := checkModel(m); err != nil {
			t.Errorf("valid download source %q rejected: %v", source, err)
		}
	}
	for _, step := range []string{"prepare", "start", "load", "warm"} {
		m := baseModel()
		m.State = "loading"
		m.Load = &wire.LocalModelLoadProgress{Step: step, DoneSteps: 1, TotalSteps: 100}
		if err := checkModel(m); err != nil {
			t.Errorf("valid load step %q rejected: %v", step, err)
		}
	}

	for name, mutate := range map[string]func(*wire.LocalModel){
		"invalid download.step": func(m *wire.LocalModel) {
			m.State = "downloading"
			m.Download = &wire.LocalModelDownloadProgress{Step: "extract"}
		},
		"invalid download.source": func(m *wire.LocalModel) {
			m.State = "downloading"
			m.Download = &wire.LocalModelDownloadProgress{Step: "download", Source: "s3"}
		},
		"download.connections > 64": func(m *wire.LocalModel) {
			m.State = "downloading"
			m.Download = &wire.LocalModelDownloadProgress{Step: "download", Connections: u64(65)}
		},
		"invalid load.step": func(m *wire.LocalModel) {
			m.State = "loading"
			m.Load = &wire.LocalModelLoadProgress{Step: "boot", DoneSteps: 1, TotalSteps: 5}
		},
		"empty load.step": func(m *wire.LocalModel) {
			m.State = "loading"
			m.Load = &wire.LocalModelLoadProgress{Step: "", DoneSteps: 1, TotalSteps: 5}
		},
		"load.total_steps == 0": func(m *wire.LocalModel) {
			m.State = "loading"
			m.Load = &wire.LocalModelLoadProgress{Step: "prepare", DoneSteps: 0, TotalSteps: 0}
		},
		"load.total_steps > 100": func(m *wire.LocalModel) {
			m.State = "loading"
			m.Load = &wire.LocalModelLoadProgress{Step: "load", DoneSteps: 10, TotalSteps: 101}
		},
		"load.done_steps > total_steps": func(m *wire.LocalModel) {
			m.State = "loading"
			m.Load = &wire.LocalModelLoadProgress{Step: "warm", DoneSteps: 8, TotalSteps: 7}
		},
	} {
		m := baseModel()
		mutate(&m)
		if err := checkModel(m); err == nil {
			t.Errorf("%s: unexpectedly accepted", name)
		}
	}
}
