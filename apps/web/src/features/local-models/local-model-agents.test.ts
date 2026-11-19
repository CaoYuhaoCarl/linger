import { describe, expect, it } from "vitest";

import type {
  TeamHubLocalComputerPage,
  TeamHubTenantAgent,
  TeamHubTenantAgentAvailabilitySnapshot,
} from "@/features/teamhub/teamhub-types";

import {
  assignableLocalModelAgents,
  buildLocalModelRuntimeUpdate,
  gatewayReadiness,
  isAgentUsingModel,
  primaryLocalModelAgent,
  usedByAgentNames,
} from "./local-model-agents";
import { localModel, modelView } from "./local-models-test-support";

type LocalComputer = TeamHubLocalComputerPage["items"][number];

function makeAgent(
  id: string,
  name: string,
  {
    agentType = "general",
    computerId = "computer-lab",
    createdBy = "actor-jenny",
    model = "openai/gpt-5.4",
    reasoningEffort,
    revision = 1,
    runtimeType = "codex",
    workspaceGrantId = "grant-write",
  }: {
    agentType?: TeamHubTenantAgent["agent_type"];
    computerId?: string;
    createdBy?: string;
    model?: string;
    reasoningEffort?: TeamHubTenantAgent["runtime"]["reasoning_effort"];
    revision?: number;
    runtimeType?: "codex" | "claude" | "pi";
    workspaceGrantId?: string;
  } = {},
): TeamHubTenantAgent {
  return {
    actor: {
      created_at: "2026-10-01T00:00:00Z",
      display_name: name,
      handle: `@${id}`,
      id,
      kind: "agent",
      tenant_id: "tenant-1",
    },
    agent_management_id: `mgmt-${id}`,
    agent_type: agentType,
    configuration_revision: revision,
    created_at: "2026-10-01T00:00:00Z",
    created_by: {
      display_name: "Sponsor",
      id: createdBy,
      kind: "human",
      tenant_id: "tenant-1",
    },
    description: "",
    instructions: "Help.",
    runtime: {
      model,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      placement: {
        computer_id: computerId,
        runtime_type: runtimeType,
        type: "local",
        workspace_grant_id: workspaceGrantId,
      },
    },
    skill_bindings: [],
    updated_at: "2026-10-01T00:00:00Z",
    visibility_scope: "sponsor",
  };
}

function makeComputer(overrides: Partial<LocalComputer> = {}): LocalComputer {
  return {
    active_operations: 0,
    computer_id: "computer-lab",
    display_name: "lab-118",
    runtimes: [
      {
        models: [
          {
            id: "localmodels-library/qwen3-coder-30b",
            label: "Qwen3 Coder 30B",
          },
        ],
        status: "ready",
        type: "pi",
      },
    ],
    status: "online",
    upgrade_required: false,
    workspace_grants: [
      { grant_id: "grant-ro", label: "Read only", mode: "read-only" },
      { grant_id: "grant-write", label: "Workspace", mode: "workspace-write" },
    ],
    ...overrides,
  };
}

describe("local-model-agents", () => {
  it("filters sponsored agents, marks Another Me first, and tracks busy tasks", () => {
    const codex = makeAgent("actor-codex", "Codex");
    const other = makeAgent("actor-other", "Maya's Agent", {
      createdBy: "actor-maya",
    });
    const delegate = makeAgent("actor-delegate", "Jenny's Delegate", {
      agentType: "anotherme",
    });
    const availabilities: TeamHubTenantAgentAvailabilitySnapshot[] = [
      {
        actor_id: "actor-codex",
        availability: {
          active_task_count: 2,
          label: "Working",
          status: "online",
        },
      },
      {
        actor_id: "actor-delegate",
        availability: {
          active_task_count: 0,
          label: "Online",
          status: "online",
        },
      },
    ];

    const result = assignableLocalModelAgents([codex, other, delegate], {
      availabilities,
      currentActorId: "actor-jenny",
    });

    expect(result.map((item) => item.actorId)).toEqual([
      "actor-delegate",
      "actor-codex",
    ]);
    expect(result[0]).toMatchObject({ busy: false, isAnotherMe: true });
    expect(result[1]).toMatchObject({ busy: true, isAnotherMe: false });
    expect(
      assignableLocalModelAgents([codex], { currentActorId: undefined }),
    ).toEqual([]);
  });

  it("picks primary agent preferring Another Me, then agents on the Computer", () => {
    const onMac = makeAgent("actor-mac", "Mac Helper", {
      computerId: "computer-mac",
    });
    const onLab = makeAgent("actor-lab", "Lab Helper", {
      computerId: "computer-lab",
    });
    const delegate = makeAgent("actor-delegate", "Another Me", {
      agentType: "anotherme",
      computerId: "computer-mac",
    });

    const withoutAnotherMe = assignableLocalModelAgents([onMac, onLab], {
      currentActorId: "actor-jenny",
    });
    expect(
      primaryLocalModelAgent(withoutAnotherMe, "computer-lab")?.actorId,
    ).toBe("actor-lab");

    const withAnotherMe = assignableLocalModelAgents([onLab, delegate], {
      currentActorId: "actor-jenny",
    });
    expect(primaryLocalModelAgent(withAnotherMe, "computer-lab")?.actorId).toBe(
      "actor-delegate",
    );
    expect(primaryLocalModelAgent([], "computer-lab")).toBeUndefined();
  });

  it("checks whether an agent uses a specific model on a Computer via Pi", () => {
    const [agent] = assignableLocalModelAgents(
      [
        makeAgent("a1", "Coder", {
          computerId: "computer-lab",
          model: "localmodels-library/qwen3-coder-30b",
          runtimeType: "pi",
        }),
      ],
      { currentActorId: "actor-jenny" },
    );

    expect(
      isAgentUsingModel(
        agent!,
        "computer-lab",
        "localmodels-library/qwen3-coder-30b",
      ),
    ).toBe(true);
    expect(
      isAgentUsingModel(
        agent!,
        "computer-mac",
        "localmodels-library/qwen3-coder-30b",
      ),
    ).toBe(false);
    expect(isAgentUsingModel(agent!, "computer-lab", undefined)).toBe(false);
  });

  it("reconciles snapshot used_by with live assignable agent placements", () => {
    const delegate = makeAgent("actor-delegate", "Jenny's Delegate", {
      agentType: "anotherme",
      computerId: "computer-lab",
      model: "localmodels-library/gemma3-27b",
      runtimeType: "pi",
    });
    const codex = makeAgent("actor-codex", "Codex", {
      computerId: "computer-lab",
      model: "localmodels-library/qwen3-coder-30b",
      runtimeType: "pi",
    });
    const assignable = assignableLocalModelAgents([delegate, codex], {
      currentActorId: "actor-jenny",
    });

    const entry = modelView(
      localModel({
        id: "qwen3-coder-30b:Q4_K_M",
        name: "Qwen3 Coder 30B",
        pi_model: "localmodels-library/qwen3-coder-30b",
        state: "loaded",
      }),
    );
    // Stale snapshot still lists actor-delegate on Qwen while actor-codex just moved onto it.
    entry.used_by = [
      { agent_id: "actor-delegate", name: "Jenny's Delegate" },
      { agent_id: "external-research", name: "Research agent" },
    ];

    expect(usedByAgentNames(entry, assignable, "computer-lab")).toEqual([
      "Research agent",
      "Codex",
    ]);
  });

  it("builds PATCH runtime update using writable grants and valid reasoning effort", () => {
    const [agent] = assignableLocalModelAgents(
      [
        makeAgent("a1", "Coder", {
          computerId: "computer-mac",
          reasoningEffort: "high",
          revision: 4,
          runtimeType: "codex",
          workspaceGrantId: "grant-mac",
        }),
      ],
      { currentActorId: "actor-jenny" },
    );

    const computer = makeComputer({
      runtimes: [
        {
          models: [
            {
              allowed_reasoning_effort: ["low", "medium"],
              default_reasoning_effort: "medium",
              id: "localmodels-library/qwen3-coder-30b",
              label: "Qwen3 Coder 30B",
            },
          ],
          status: "ready",
          type: "pi",
        },
      ],
    });

    expect(
      buildLocalModelRuntimeUpdate(
        agent!,
        computer,
        "localmodels-library/qwen3-coder-30b",
      ),
    ).toEqual({
      expected_configuration_revision: 4,
      runtime: {
        model: "localmodels-library/qwen3-coder-30b",
        placement: {
          computer_id: "computer-lab",
          runtime_type: "pi",
          type: "local",
          workspace_grant_id: "grant-write",
        },
        reasoning_effort: "medium",
      },
    });

    expect(
      buildLocalModelRuntimeUpdate(
        agent!,
        makeComputer({ workspace_grants: [] }),
        "localmodels-library/qwen3-coder-30b",
      ),
    ).toBeUndefined();
  });

  it("computes Bifrost and Pi gateway readiness states for loaded models", () => {
    const loadedWithEndpoint = localModel({
      endpoint: { base_url: "http://127.0.0.1:18100/v1" },
      id: "qwen3-coder-30b:Q4_K_M",
      name: "Qwen3 Coder 30B",
      pi_model: "localmodels-library/qwen3-coder-30b",
      state: "loaded",
    });

    expect(gatewayReadiness(loadedWithEndpoint, makeComputer())).toEqual({
      label: "Ready · Bifrost (Pi)",
      tone: "success",
    });
    expect(
      gatewayReadiness(
        loadedWithEndpoint,
        makeComputer({
          runtimes: [{ models: [], status: "ready", type: "pi" }],
        }),
      ),
    ).toEqual({
      label: "Bifrost · Registering with Pi…",
      tone: "info",
    });
    expect(
      gatewayReadiness(
        loadedWithEndpoint,
        makeComputer({
          runtimes: [{ models: [], status: "unknown", type: "pi" }],
        }),
      ),
    ).toEqual({
      label: "Bifrost · Setting up Pi…",
      tone: "info",
    });
    expect(
      gatewayReadiness(
        loadedWithEndpoint,
        makeComputer({
          runtimes: [{ models: [], status: "not_installed", type: "pi" }],
        }),
      ),
    ).toEqual({
      label: "Bifrost · Pi unavailable",
      tone: "muted",
    });
    expect(
      gatewayReadiness(loadedWithEndpoint, makeComputer({ status: "offline" })),
    ).toEqual({
      label: "Bifrost · Pi unavailable",
      tone: "muted",
    });
    expect(
      gatewayReadiness(
        localModel({ id: "idle", name: "Idle", state: "idle" }),
        makeComputer(),
      ),
    ).toBeUndefined();
  });
});
