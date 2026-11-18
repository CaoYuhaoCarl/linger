import { describe, expect, it } from "vitest";

import { TeamHubRuntimeStateError } from "../../../src/agent/executor/teamhub-runtime-state-client.js";
import { createTeamHubLocalComputerRegistry } from "../../../src/agent/runner-gateway/local-computer-registry.js";
import { RunnerDaemonIdentityInUseError } from "../../../src/agent/runner-gateway/runner-gateway.js";
import { MINIMUM_CURRENT_COMPUTER_VERSION } from "../../../src/agent/runner-gateway/local-computer-management.js";
import {
  CURRENT_RUNNER_CAPABILITIES,
  currentRunnerIdentity,
} from "../test-support/runner-capabilities.js";

const unused = (): never => {
  throw new Error("not called");
};

describe("TeamHub Local Computer registry", () => {
  it("reports a Daemon Identity another Computer holds as its own error", async () => {
    const registry = createTeamHubLocalComputerRegistry({
      getLocalComputer: unused,
      touchLocalComputer: unused,
      removeLocalComputer: unused,
      recordLocalModels: unused,
      connectLocalComputer: () =>
        Promise.reject(
          new TeamHubRuntimeStateError(
            409,
            "Another Local Computer holds this Daemon Identity",
            "DAEMON_IDENTITY_IN_USE",
          ),
        ),
    });
    await expect(
      registry.connect({
        computerId: "runner-local",
        owner: { tenantId: "tenant-acme", ownerActorId: "actor-alice" },
        credentialGeneration: 0,
        hello: {
          type: "runner.hello",
          platform: "darwin",
          daemon_version: MINIMUM_CURRENT_COMPUTER_VERSION,
          protocol_version: "2",
          ...currentRunnerIdentity(),
          capabilities: [...CURRENT_RUNNER_CAPABILITIES],
          runner_id: "runner-local",
          connection_nonce: "nonce-1",
          sent_at: "2026-07-29T00:00:00.000Z",
          runtimes: ["codex"],
          runtime_diagnostics: [],
          workspace_grants: [],
          agent_runners: [],
          active_operations: [],
        },
        status: "offline",
      }),
    ).rejects.toBeInstanceOf(RunnerDaemonIdentityInUseError);
  });
});
