package computerconfig

import "testing"

func TestLocalModelsConfigIsOptional(t *testing.T) {
	config, err := loadConfigFields(t, "")
	if err != nil {
		t.Fatal(err)
	}
	if config.LocalModels != nil {
		t.Fatalf("config without local_models has LocalModels = %+v", config.LocalModels)
	}
}

func TestLocalModelsConfigReadsToolLocation(t *testing.T) {
	config, err := loadConfigFields(t, `,"local_models":{"python":"/kit/python/bin/python3","module_directory":"/kit","state_directory":"/home/runtime/localmodels/state","base_directory":"/home/runtime/localmodels/models"}`)
	if err != nil {
		t.Fatal(err)
	}
	want := LocalModels{
		Python: "/kit/python/bin/python3", ModuleDirectory: "/kit",
		StateDirectory: "/home/runtime/localmodels/state", BaseDirectory: "/home/runtime/localmodels/models",
	}
	if config.LocalModels == nil || *config.LocalModels != want {
		t.Fatalf("LocalModels = %+v", config.LocalModels)
	}
}

func TestLocalModelsConfigRejectsRelativeOrMissingPaths(t *testing.T) {
	for _, field := range []string{
		`,"local_models":{"python":"python3","module_directory":"/kit","state_directory":"/s","base_directory":"/b"}`,
		`,"local_models":{"python":"/kit/python3","module_directory":"/kit","state_directory":"/s"}`,
		`,"local_models":{"python":"/kit/python3","module_directory":"/kit","state_directory":"/s","base_directory":"/b","extra":"/x"}`,
	} {
		if _, err := loadConfigFields(t, field); err == nil {
			t.Fatalf("invalid local_models accepted: %s", field)
		}
	}
}

func TestLocalModelsConfigReadsManagedAndExplicitLocalMode(t *testing.T) {
	config, err := loadConfigFields(t, `,"local_models":{"mode":"local","managed":true,"python":"/kit/python3","module_directory":"/kit","state_directory":"/s","base_directory":"/b"}`)
	if err != nil {
		t.Fatal(err)
	}
	if config.LocalModels == nil || !config.LocalModels.Managed || config.RemoteLocalModels != nil {
		t.Fatalf("LocalModels = %+v, RemoteLocalModels = %+v", config.LocalModels, config.RemoteLocalModels)
	}
}

// Mode remote names the machine that serves the models; the Computer runs
// no tool, so the section carries no tool paths.
func TestLocalModelsConfigReadsRemoteMode(t *testing.T) {
	config, err := loadConfigFields(t, `,"local_models":{"mode":"remote","label":"GPU server lab-118","computer_id":"computer_abc-1"}`)
	if err != nil {
		t.Fatal(err)
	}
	want := RemoteLocalModels{Label: "GPU server lab-118", ComputerID: "computer_abc-1"}
	if config.LocalModels != nil || config.RemoteLocalModels == nil || *config.RemoteLocalModels != want {
		t.Fatalf("LocalModels = %+v, RemoteLocalModels = %+v", config.LocalModels, config.RemoteLocalModels)
	}
}

func TestLocalModelsConfigRejectsInvalidModes(t *testing.T) {
	for _, field := range []string{
		`,"local_models":{"mode":"cpu","python":"/p","module_directory":"/kit","state_directory":"/s","base_directory":"/b"}`,
		`,"local_models":{"mode":"remote"}`,
		`,"local_models":{"mode":"remote","label":"lab","python":"/p"}`,
		`,"local_models":{"mode":"remote","label":"lab","managed":true}`,
		`,"local_models":{"mode":"remote","label":"lab","computer_id":"../other"}`,
		`,"local_models":{"mode":"remote","label":"two\nlines"}`,
		`,"local_models":{"label":"lab","python":"/p","module_directory":"/kit","state_directory":"/s","base_directory":"/b"}`,
	} {
		if _, err := loadConfigFields(t, field); err == nil {
			t.Fatalf("invalid local_models accepted: %s", field)
		}
	}
}
