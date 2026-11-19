package localmodels

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
)

const (
	harnessStatusSchema = "localmodels.harness-status/v1"
	harnessPlanSchema   = "localmodels.harness-plan/v1"
	harnessErrorSchema  = "localmodels.harness-error/v1"
	maxHarnessOutput    = 4 << 20
)

var hex64Pattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type harnessStatusDoc struct {
	Schema   string `json:"schema"`
	Runtimes []struct {
		Runtime    string   `json:"runtime"`
		Installed  bool     `json:"installed"`
		Executable string   `json:"executable"`
		ArgvPrefix []string `json:"argvPrefix"`
		Source     string   `json:"source"`
	} `json:"runtimes"`
}

type harnessPlanDoc struct {
	Schema  string `json:"schema"`
	ID      string `json:"id"`
	Runtime string `json:"runtime"`
}

type harnessErrorDoc struct {
	Schema string `json:"schema"`
	Code   string `json:"code"`
}

// InspectPi reports the verified Pi executable managed under harnessDir, or an
// empty string when no managed Pi runtime is installed there yet.
func (t Tool) InspectPi(ctx context.Context, environment map[string]string, harnessDir string) (string, error) {
	if harnessDir == "" || !t.installed() {
		return "", nil
	}
	harnessDir = filepath.Clean(harnessDir)
	if !filepath.IsAbs(harnessDir) {
		return "", errors.New("harness root must be absolute")
	}
	info, err := os.Stat(harnessDir)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", errors.New("harness root is not a directory")
	}
	stdout, exitCode, err := t.runHarness(
		ctx,
		environment,
		[]string{"-P", "-s", "-m", "localmodels", "harness", "status", "--root", harnessDir, "--runtime", "pi", "--json"},
	)
	if err != nil {
		return "", err
	}
	if exitCode != 0 {
		return "", harnessCommandError("status", exitCode, stdout)
	}
	return parsePiFromHarnessStatus(stdout, harnessDir, true)
}

// EnsurePi returns a ready Pi executable provisioned via localmodels harness
// under harnessDir, planning and applying the pinned Pi install when needed.
// When nodePath names an existing regular non-symlink file, it is passed via
// --node so harness does not download a separate Node binary.
func (t Tool) EnsurePi(ctx context.Context, environment map[string]string, harnessDir, nodePath string) (string, error) {
	if harnessDir == "" || !t.installed() {
		return "", nil
	}
	harnessDir = filepath.Clean(harnessDir)
	if !filepath.IsAbs(harnessDir) {
		return "", errors.New("harness root must be absolute")
	}
	if existing, err := t.InspectPi(ctx, environment, harnessDir); err == nil && existing != "" {
		return existing, nil
	}
	if err := privatefs.EnsureDir(harnessDir); err != nil {
		return "", err
	}
	planDir, err := os.MkdirTemp(harnessDir, ".pi-plan-*")
	if err != nil {
		return "", err
	}
	defer func() { _ = os.RemoveAll(planDir) }()
	if err := privatefs.EnsureDir(planDir); err != nil {
		return "", err
	}
	planPath := filepath.Join(planDir, "plan.json")
	planArgs := []string{"-P", "-s", "-m", "localmodels", "harness", "plan", "--runtime", "pi", "--root", harnessDir}
	if nodePath != "" && filepath.IsAbs(nodePath) {
		if info, statErr := os.Lstat(nodePath); statErr == nil && info.Mode().IsRegular() {
			planArgs = append(planArgs, "--node", nodePath)
		}
	}
	planArgs = append(planArgs, "--out", planPath, "--json")
	if stdout, exitCode, err := t.runHarness(ctx, environment, planArgs); err != nil {
		return "", err
	} else if exitCode != 0 {
		return "", harnessCommandError("plan", exitCode, stdout)
	}
	encodedPlan, err := os.ReadFile(planPath)
	if err != nil {
		return "", err
	}
	var plan harnessPlanDoc
	if err := json.Unmarshal(encodedPlan, &plan); err != nil {
		return "", fmt.Errorf("decode harness plan: %w", err)
	}
	if plan.Schema != harnessPlanSchema || plan.Runtime != "pi" || !hex64Pattern.MatchString(plan.ID) {
		return "", errors.New("harness plan is outside the contract")
	}
	stdout, exitCode, err := t.runHarness(
		ctx,
		environment,
		[]string{"-P", "-s", "-m", "localmodels", "harness", "apply", planPath, "--approve", plan.ID, "--jsonl"},
	)
	if err != nil {
		return "", err
	}
	if exitCode != 0 {
		return "", harnessCommandError("apply", exitCode, stdout)
	}
	if executable, parseErr := parseLastHarnessStatus(stdout, harnessDir, false); parseErr == nil && executable != "" {
		return executable, nil
	}
	statusStdout, statusExit, statusErr := t.runHarness(
		ctx,
		environment,
		[]string{"-P", "-s", "-m", "localmodels", "harness", "status", "--root", harnessDir, "--runtime", "pi", "--json"},
	)
	if statusErr != nil {
		return "", statusErr
	}
	if statusExit != 0 {
		return "", harnessCommandError("status", statusExit, statusStdout)
	}
	return parsePiFromHarnessStatus(statusStdout, harnessDir, false)
}

func (t Tool) runHarness(ctx context.Context, environment map[string]string, args []string) ([]byte, int, error) {
	stdout, err := os.CreateTemp("", "localmodels-harness-*.out")
	if err != nil {
		return nil, -1, err
	}
	defer func() { _ = os.Remove(stdout.Name()) }()
	stderr, err := os.CreateTemp("", "localmodels-harness-*.err")
	if err != nil {
		_ = stdout.Close()
		return nil, -1, err
	}
	defer func() { _ = os.Remove(stderr.Name()) }()
	cmd := t.commandArgs(environment, args)
	cmd.Stdout, cmd.Stderr = stdout, stderr
	runErr := process.Run(ctx, cmd, time.Second)
	_ = stdout.Close()
	_ = stderr.Close()
	if ctx.Err() != nil {
		return nil, -1, context.Cause(ctx)
	}
	var exitErr *exec.ExitError
	if runErr != nil && !errors.As(runErr, &exitErr) {
		return nil, -1, runErr
	}
	if cmd.ProcessState == nil {
		return nil, -1, runErr
	}
	exitCode := cmd.ProcessState.ExitCode()
	output, readErr := readBounded(stdout.Name(), maxHarnessOutput)
	if exitCode != 0 {
		if diagnostic, diagErr := readBounded(stderr.Name(), 4096); diagErr == nil && len(diagnostic) > 0 {
			slog.Debug("local_models.harness_stderr", "stderr", string(diagnostic))
		}
	}
	return output, exitCode, readErr
}

func harnessCommandError(action string, exitCode int, stdout []byte) error {
	lines := bytes.Split(stdout, []byte{'\n'})
	for index := len(lines) - 1; index >= 0; index-- {
		line := bytes.TrimSpace(lines[index])
		if len(line) == 0 {
			continue
		}
		var doc harnessErrorDoc
		if json.Unmarshal(line, &doc) == nil && doc.Schema == harnessErrorSchema && doc.Code != "" {
			return fmt.Errorf("harness %s failed (%s)", action, doc.Code)
		}
		break
	}
	return fmt.Errorf("harness %s exited with code %d", action, exitCode)
}

func parseLastHarnessStatus(stdout []byte, harnessDir string, managedOnly bool) (string, error) {
	lines := bytes.Split(stdout, []byte{'\n'})
	for index := len(lines) - 1; index >= 0; index-- {
		line := bytes.TrimSpace(lines[index])
		if len(line) == 0 {
			continue
		}
		return parsePiFromHarnessStatus(line, harnessDir, managedOnly)
	}
	return "", errors.New("harness output is empty")
}

func parsePiFromHarnessStatus(encoded []byte, harnessDir string, managedOnly bool) (string, error) {
	var doc harnessStatusDoc
	if err := json.Unmarshal(bytes.TrimSpace(encoded), &doc); err != nil {
		return "", fmt.Errorf("decode harness status: %w", err)
	}
	if doc.Schema != harnessStatusSchema {
		return "", fmt.Errorf("harness status schema is %q", doc.Schema)
	}
	for _, row := range doc.Runtimes {
		if row.Runtime != "pi" {
			continue
		}
		if !row.Installed || len(row.ArgvPrefix) != 0 || !filepath.IsAbs(row.Executable) {
			return "", nil
		}
		if managedOnly {
			if row.Source != "" && row.Source != "managed" {
				return "", nil
			}
			if row.Source == "" && !isWithinDirectory(harnessDir, row.Executable) {
				return "", nil
			}
		}
		return row.Executable, nil
	}
	return "", nil
}

func isWithinDirectory(dir, target string) bool {
	if rel, err := filepath.Rel(filepath.Clean(dir), filepath.Clean(target)); err == nil &&
		rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return true
	}
	resolvedDir, errDir := filepath.EvalSymlinks(dir)
	resolvedTarget, errTarget := filepath.EvalSymlinks(target)
	if errDir != nil || errTarget != nil {
		return false
	}
	rel, err := filepath.Rel(resolvedDir, resolvedTarget)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
