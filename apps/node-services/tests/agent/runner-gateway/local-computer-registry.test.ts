import type { ComputerProfile } from "@linger/wire-contracts/runner-gateway/types";
import { describe, expect, it, vi } from "vitest";

import { createTeamHubLocalComputerRegistry } from "../../../src/agent/runner-gateway/local-computer-registry.js";
import { hello } from "./runner-gateway-fixtures.js";

describe("createTeamHubLocalComputerRegistry", () => {
  it("sends release_current only when the observation carries it", async () => {
    const connectLocalComputer = vi.fn(async () => ({
      computer: {} as never,
      placements: [],
    }));
    const touchLocalComputer = vi.fn(
      async (_request: Record<string, unknown>) => ({}) as never,
    );
    const registry = createTeamHubLocalComputerRegistry({
      getLocalComputer: vi.fn(),
      connectLocalComputer,
      touchLocalComputer,
      removeLocalComputer: vi.fn(),
      recordLocalModels: vi.fn(),
      recordLocalComputerProfile: vi.fn(),
    });
    const owner = { tenantId: "tenant-acme", ownerActorId: "actor-alice" };
    const seenAt = "2026-11-18T00:00:00.000Z";

    await registry.connect({
      computerId: "runner-local",
      owner,
      credentialGeneration: 0,
      hello: hello(),
      status: "offline",
      recommendedVersion: "0.52.0",
      releaseCurrent: false,
    });
    await registry.touch("runner-local", {
      status: "online",
      seenAt,
      releaseCurrent: true,
    });
    await registry.touch("runner-local", { status: "online", seenAt });

    expect(connectLocalComputer).toHaveBeenCalledWith(
      expect.objectContaining({ release_current: false }),
    );
    expect(touchLocalComputer.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({ release_current: true }),
      expect.not.objectContaining({ release_current: expect.anything() }),
    ]);
  });

  it("records a profile with the time the Computer sent it", async () => {
    const recordLocalComputerProfile = vi.fn(
      async (_request: Record<string, unknown>) => undefined,
    );
    const registry = createTeamHubLocalComputerRegistry({
      getLocalComputer: vi.fn(),
      connectLocalComputer: vi.fn(),
      touchLocalComputer: vi.fn(),
      removeLocalComputer: vi.fn(),
      recordLocalModels: vi.fn(),
      recordLocalComputerProfile,
    });
    const profile: ComputerProfile = {
      install_kind: "cli",
      accelerators: {
        probe: "ok",
        ram_total_bytes: 32 * 2 ** 30,
        apple_silicon: false,
        gpus: [],
      },
      local_models: { mode: "none" },
      update: { state: "idle" },
    };

    await registry.recordComputerProfile(
      "runner-local",
      "2026-11-18T00:00:00.000Z",
      profile,
    );

    expect(recordLocalComputerProfile).toHaveBeenCalledWith({
      computer_id: "runner-local",
      observed_at: "2026-11-18T00:00:00.000Z",
      profile,
    });
  });
});
