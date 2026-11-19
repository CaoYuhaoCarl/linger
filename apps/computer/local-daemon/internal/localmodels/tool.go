// Package localmodels runs the installer's localmodels tool for the Daemon.
// It reads `library status`, starts the library actions a Computer owner
// chose, supervises the long ones (download, load), and maps the tool's
// localmodels.library-status/v1 into the Runner Gateway LocalModelsSnapshot.
// It never chooses a model: every action names the model the owner picked.
package localmodels

import (
	"os"
	"os/exec"
	"strings"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

// Tool is where the installer put the localmodels tool and its state, as
// the Computer config records it.
type Tool struct {
	Python          string
	ModuleDirectory string
	StateDirectory  string
	BaseDirectory   string
}

// Action is one owner-chosen library action. Model is empty only for
// refresh; UnloadFirst is only for load.
type Action struct {
	Name        string
	Model       string
	UnloadFirst []string
}

// Action names, as the Runner Gateway sends them.
const (
	ActionDownload = "download"
	ActionCancel   = "cancel"
	ActionLoad     = "load"
	ActionUnload   = "unload"
	ActionRemove   = "remove"
	ActionRefresh  = "refresh"
)

// arguments are the `library` arguments of one call. Model ids are validated
// by the caller, so none starts with "-".
func (t Tool) arguments(action Action) []string {
	args := []string{"-P", "-s", "-m", "localmodels", "library"}
	switch action.Name {
	case ActionRefresh:
		return append(args, "status", "--base-dir", t.BaseDirectory, "--json")
	case ActionDownload:
		return append(args, "download", action.Model, "--base-dir", t.BaseDirectory, "--jsonl")
	case ActionLoad:
		args = append(args, "load", action.Model)
		for _, other := range action.UnloadFirst {
			args = append(args, "--unload", other)
		}
		return append(args, "--base-dir", t.BaseDirectory, "--jsonl")
	default:
		return append(args, action.Name, action.Model, "--base-dir", t.BaseDirectory, "--json")
	}
}

// command builds one library invocation for the tool.
func (t Tool) command(environment map[string]string, action Action) *exec.Cmd {
	return t.commandArgs(environment, t.arguments(action))
}

// commandArgs builds one tool invocation the way the installer runs it: the
// sealed kit on PYTHONPATH and as the working directory, no user site
// packages, no bytecode writes into the sealed kit, PI_CODING_AGENT_DIR aligned
// with workspace.PiSourceEnvironment, and LINGER_LOCALMODELS_CACHE_DIR /
// LINGER_LOCALMODELS_REUSE_DIRS forwarded as LOCALMODELS_CACHE_DIR /
// LOCALMODELS_REUSE_DIRS when those LOCALMODELS_* settings are not already set.
func (t Tool) commandArgs(environment map[string]string, args []string) *exec.Cmd {
	cmd := exec.Command(t.Python, args...)
	cmd.Dir = t.ModuleDirectory
	values := make(map[string]string, len(environment)+7)
	var piAgentDir keyPreference
	var localCacheDir, lingerCacheDir keyPreference
	var localReuseDirs, lingerReuseDirs keyPreference
	for key, value := range environment {
		switch strings.ToUpper(key) {
		case "PYTHONHOME", "PYTHONSTARTUP", "PYTHONINSPECT", "PYTHONPATH", "LOCALMODELS_STATE":
			continue
		case "PI_CODING_AGENT_DIR":
			piAgentDir.record(key, "PI_CODING_AGENT_DIR", value)
			continue
		case "LOCALMODELS_CACHE_DIR":
			localCacheDir.record(key, "LOCALMODELS_CACHE_DIR", value)
			continue
		case "LOCALMODELS_REUSE_DIRS":
			localReuseDirs.record(key, "LOCALMODELS_REUSE_DIRS", value)
			continue
		case "LINGER_LOCALMODELS_CACHE_DIR":
			lingerCacheDir.record(key, "LINGER_LOCALMODELS_CACHE_DIR", value)
		case "LINGER_LOCALMODELS_REUSE_DIRS":
			lingerReuseDirs.record(key, "LINGER_LOCALMODELS_REUSE_DIRS", value)
		}
		values[key] = value
	}
	if piAgentDir.value != "" {
		values["PI_CODING_AGENT_DIR"] = piAgentDir.value
	}
	if piEnv, err := workspace.PiSourceEnvironment(values); err == nil && piEnv["PI_CODING_AGENT_DIR"] != "" {
		values["PI_CODING_AGENT_DIR"] = piEnv["PI_CODING_AGENT_DIR"]
	}
	if dir := firstNonEmpty(localCacheDir.value, lingerCacheDir.value); dir != "" {
		values["LOCALMODELS_CACHE_DIR"] = dir
	}
	if dirs := firstNonEmpty(localReuseDirs.value, lingerReuseDirs.value); dirs != "" {
		values["LOCALMODELS_REUSE_DIRS"] = dirs
	}
	values["PYTHONPATH"] = t.ModuleDirectory
	values["LOCALMODELS_STATE"] = t.StateDirectory
	values["PYTHONNOUSERSITE"] = "1"
	values["PYTHONDONTWRITEBYTECODE"] = "1"
	cmd.Env = make([]string, 0, len(values))
	for key, value := range values {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	return cmd
}

type keyPreference struct {
	exact bool
	value string
}

func (p *keyPreference) record(key, exactKey, value string) {
	trimmed := strings.TrimSpace(value)
	if key == exactKey {
		p.exact = true
		p.value = trimmed
	} else if !p.exact && p.value == "" {
		p.value = trimmed
	}
}

func firstNonEmpty(primary, fallback string) string {
	if primary != "" {
		return primary
	}
	return fallback
}

// installed reports whether the configured interpreter still exists.
func (t Tool) installed() bool {
	info, err := os.Stat(t.Python)
	return err == nil && info.Mode().IsRegular()
}
