import type {
  TeamHubAgentReasoningEffort,
  TeamHubLocalComputerPage,
  TeamHubLocalRuntimeType,
  TeamHubTenantAgent,
  TeamHubTenantAgentAvailabilitySnapshot,
  TeamHubTenantAgentUpdateInput,
} from "@/features/teamhub/teamhub-types";

import type { LocalModel, LocalModelView } from "./local-models-queries";

type LocalComputer = TeamHubLocalComputerPage["items"][number];

export interface LocalModelAssignableAgent {
  actorId: string;
  name: string;
  isAnotherMe: boolean;
  busy: boolean;
  configurationRevision: number;
  computerId?: string;
  runtimeType?: TeamHubLocalRuntimeType;
  model: string;
  workspaceGrantId?: string;
  reasoningEffort?: TeamHubAgentReasoningEffort;
}

export interface GatewayReadiness {
  label: string;
  tone: "success" | "info" | "muted";
}

/**
 * Agents the signed-in Human sponsors and may retarget onto a local model.
 * Another Me always sorts first so primary model actions highlight it.
 */
export function assignableLocalModelAgents(
  agents: readonly TeamHubTenantAgent[],
  {
    anotherMeActorId,
    availabilities = [],
    currentActorId,
  }: {
    anotherMeActorId?: string;
    availabilities?: readonly TeamHubTenantAgentAvailabilitySnapshot[];
    currentActorId?: string;
  },
): LocalModelAssignableAgent[] {
  if (!currentActorId) return [];
  const availabilityByActor = new Map(
    availabilities.map((snapshot) => [snapshot.actor_id, snapshot]),
  );
  return agents
    .filter((agent) => agent.created_by.id === currentActorId)
    .map((agent) => {
      const availability = availabilityByActor.get(agent.actor.id);
      return {
        actorId: agent.actor.id,
        busy: (availability?.availability.active_task_count ?? 0) > 0,
        computerId: agent.runtime.placement?.computer_id,
        configurationRevision: agent.configuration_revision,
        isAnotherMe:
          agent.agent_type === "anotherme" ||
          (anotherMeActorId !== undefined &&
            agent.actor.id === anotherMeActorId),
        model: agent.runtime.model,
        name: agent.actor.display_name,
        reasoningEffort: agent.runtime.reasoning_effort,
        runtimeType: agent.runtime.placement?.runtime_type,
        workspaceGrantId: agent.runtime.placement?.workspace_grant_id,
      };
    })
    .sort((a, b) => Number(b.isAnotherMe) - Number(a.isAnotherMe));
}

export function isAgentUsingModel(
  agent: Pick<
    LocalModelAssignableAgent,
    "computerId" | "runtimeType" | "model"
  >,
  computerId: string,
  piModel: string | undefined,
): boolean {
  return (
    Boolean(piModel) &&
    agent.computerId === computerId &&
    agent.runtimeType === "pi" &&
    agent.model === piModel
  );
}

/**
 * Combines TeamHub's `used_by` snapshot with live sponsored Agent configs so
 * switching an Agent reflects at once on both the old and new model rows.
 */
export function usedByAgentNames(
  entry: Pick<LocalModelView, "model" | "used_by">,
  assignableAgents: readonly LocalModelAssignableAgent[],
  computerId: string,
): string[] {
  const piModel = entry.model.pi_model;
  const assignableById = new Map(
    assignableAgents.map((agent) => [agent.actorId, agent]),
  );
  const seenActorIds = new Set<string>();
  const names: string[] = [];

  for (const user of entry.used_by) {
    const known = assignableById.get(user.agent_id);
    if (known) {
      if (isAgentUsingModel(known, computerId, piModel)) {
        seenActorIds.add(known.actorId);
        names.push(known.name);
      }
      continue;
    }
    seenActorIds.add(user.agent_id);
    names.push(user.name);
  }

  for (const agent of assignableAgents) {
    if (
      !seenActorIds.has(agent.actorId) &&
      isAgentUsingModel(agent, computerId, piModel)
    ) {
      seenActorIds.add(agent.actorId);
      names.push(agent.name);
    }
  }

  return names;
}

/**
 * The default Agent highlighted on row actions: Another Me if present, then
 * the first sponsored Agent already on this Computer, else the first sponsored.
 */
export function primaryLocalModelAgent(
  agents: readonly LocalModelAssignableAgent[],
  computerId?: string,
): LocalModelAssignableAgent | undefined {
  if (!agents.length) return undefined;
  return (
    agents.find((agent) => agent.isAnotherMe) ??
    (computerId
      ? agents.find((agent) => agent.computerId === computerId)
      : undefined) ??
    agents[0]
  );
}

/**
 * Builds the `PATCH` payload switching an Agent onto `piModel` on `computer`,
 * preserving an existing grant on the same Computer or picking a writable one.
 */
export function buildLocalModelRuntimeUpdate(
  agent: Pick<
    LocalModelAssignableAgent,
    | "computerId"
    | "configurationRevision"
    | "reasoningEffort"
    | "runtimeType"
    | "workspaceGrantId"
  >,
  computer:
    | Pick<LocalComputer, "computer_id" | "runtimes" | "workspace_grants">
    | undefined,
  piModel: string | undefined,
): TeamHubTenantAgentUpdateInput | undefined {
  if (!computer || !piModel) return undefined;
  const retainedGrant =
    agent.computerId === computer.computer_id &&
    agent.workspaceGrantId &&
    computer.workspace_grants.some(
      (grant) => grant.grant_id === agent.workspaceGrantId,
    )
      ? agent.workspaceGrantId
      : undefined;
  const workspaceGrantId =
    retainedGrant ??
    computer.workspace_grants.find((grant) => grant.mode === "workspace-write")
      ?.grant_id ??
    computer.workspace_grants[0]?.grant_id;
  if (!workspaceGrantId) return undefined;

  const piRuntime = computer.runtimes.find((runtime) => runtime.type === "pi");
  const piModelEntry = piRuntime?.models.find((item) => item.id === piModel);
  const allowedEfforts = piModelEntry?.allowed_reasoning_effort ?? [];
  let reasoningEffort: TeamHubAgentReasoningEffort | undefined;
  if (allowedEfforts.length) {
    if (
      agent.runtimeType === "pi" &&
      agent.reasoningEffort &&
      allowedEfforts.includes(agent.reasoningEffort)
    ) {
      reasoningEffort = agent.reasoningEffort;
    } else if (
      piModelEntry?.default_reasoning_effort &&
      allowedEfforts.includes(piModelEntry.default_reasoning_effort)
    ) {
      reasoningEffort = piModelEntry.default_reasoning_effort;
    } else {
      reasoningEffort = allowedEfforts[0];
    }
  }

  return {
    expected_configuration_revision: agent.configurationRevision,
    runtime: {
      model: piModel,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      placement: {
        computer_id: computer.computer_id,
        runtime_type: "pi",
        type: "local",
        workspace_grant_id: workspaceGrantId,
      },
    },
  };
}

/**
 * Summarizes whether a loaded model's local Bifrost gateway endpoint is
 * already exposed to Pi on the Computer.
 */
export function gatewayReadiness(
  model: Pick<LocalModel, "endpoint" | "pi_model" | "state">,
  computer: Pick<LocalComputer, "status" | "runtimes"> | undefined,
): GatewayReadiness | undefined {
  if (model.state !== "loaded" || !model.endpoint) return undefined;
  if (!computer || computer.status !== "online") {
    return { label: "Bifrost · Pi unavailable", tone: "muted" };
  }
  const piRuntime = computer.runtimes.find((runtime) => runtime.type === "pi");
  if (!piRuntime) {
    return { label: "Bifrost · Pi unavailable", tone: "muted" };
  }
  if (piRuntime.status === "ready") {
    const registered =
      Boolean(model.pi_model) &&
      piRuntime.models.some((item) => item.id === model.pi_model);
    return registered
      ? { label: "Ready · Bifrost (Pi)", tone: "success" }
      : { label: "Bifrost · Registering with Pi…", tone: "info" };
  }
  if (piRuntime.status === "unknown") {
    return { label: "Bifrost · Setting up Pi…", tone: "info" };
  }
  return { label: "Bifrost · Pi unavailable", tone: "muted" };
}
