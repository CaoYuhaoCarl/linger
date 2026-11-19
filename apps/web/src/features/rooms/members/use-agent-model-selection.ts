import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { localComputersQueryOptions } from "@/features/local-computer/local-computer-queries";
import { localModelsQueryOptions } from "@/features/local-models/local-models-queries";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type {
  TeamHubAgentReasoningEffort,
  TeamHubLocalComputerPage,
  TeamHubTenantAgent,
} from "@/features/teamhub/teamhub-types";

const LOCAL_MODELS_LIBRARY_PREFIX = "localmodels-library/";

interface RuntimeModel {
  id: string;
  label: string;
  allowed_reasoning_effort?: readonly TeamHubAgentReasoningEffort[];
  default_reasoning_effort?: TeamHubAgentReasoningEffort;
}

interface UseResolvedAgentModelLabelOptions {
  client: TeamHubClient;
  computers?: readonly TeamHubLocalComputerPage["items"][number][];
  registration?: TeamHubTenantAgent;
  tenantId: string;
}

/**
 * Resolves a human-readable model label for an Agent: checks the placed
 * Runtime's reported catalog first, and reads Local models on that Computer
 * when a `localmodels-library/` model is not yet listed there.
 */
export function useResolvedAgentModelLabel(options: {
  client: TeamHubClient;
  computers?: readonly TeamHubLocalComputerPage["items"][number][];
  registration: TeamHubTenantAgent;
  tenantId: string;
}): string;
export function useResolvedAgentModelLabel(
  options: UseResolvedAgentModelLabelOptions,
): string | undefined;
export function useResolvedAgentModelLabel({
  client,
  computers,
  registration,
  tenantId,
}: UseResolvedAgentModelLabelOptions): string | undefined {
  const runtimeModel = registration?.runtime.model ?? "";
  const placement = registration?.runtime.placement;
  const computerId =
    placement?.type === "local" ? placement.computer_id : undefined;
  const isLocalLibraryModel = runtimeModel.startsWith(
    LOCAL_MODELS_LIBRARY_PREFIX,
  );
  const runtimeType =
    placement?.runtime_type ?? (isLocalLibraryModel ? "pi" : undefined);

  const computersQuery = useQuery({
    ...localComputersQueryOptions(client, tenantId),
    enabled: computers === undefined && Boolean(computerId),
  });
  const availableComputers = computers ?? computersQuery.data?.items;
  const runtimeModels = availableComputers
    ?.find((item) => item.computer_id === computerId)
    ?.runtimes.find((item) => item.type === runtimeType)?.models;
  const runtimeModelLabel = runtimeModels?.find(
    (item) => item.id === runtimeModel,
  )?.label;
  const hasResolvedRuntimeLabel = Boolean(
    runtimeModelLabel && runtimeModelLabel !== runtimeModel,
  );

  const localModelsQuery = useQuery({
    ...localModelsQueryOptions(client, tenantId, computerId ?? ""),
    enabled:
      Boolean(computerId) && isLocalLibraryModel && !hasResolvedRuntimeLabel,
  });

  if (!registration) return undefined;
  if (hasResolvedRuntimeLabel) return runtimeModelLabel;
  if (isLocalLibraryModel) {
    const matched = localModelsQuery.data?.models.find(
      (entry) => entry.model.pi_model === runtimeModel,
    );
    if (matched?.model.name) return matched.model.name;
  }
  return runtimeModelLabel || runtimeModel;
}

/** The model and reasoning effort of a new Agent, chosen among the models the
 * selected Computer Runtime reports; the first model is the default. */
export function useAgentModelSelection(models: readonly RuntimeModel[]) {
  const [requestedModel, setRequestedModel] = useState("");
  const [requestedReasoningEffort, setRequestedReasoningEffort] = useState<
    TeamHubAgentReasoningEffort | ""
  >("");
  const selectedModel =
    models.find(({ id }) => id === requestedModel) ?? models[0];
  const reasoningEfforts = [...(selectedModel?.allowed_reasoning_effort ?? [])];
  const defaultReasoningEffort =
    selectedModel?.default_reasoning_effort &&
    reasoningEfforts.includes(selectedModel.default_reasoning_effort)
      ? selectedModel.default_reasoning_effort
      : reasoningEfforts[0];
  const reasoningEffort = reasoningEfforts.includes(
    requestedReasoningEffort as TeamHubAgentReasoningEffort,
  )
    ? (requestedReasoningEffort as TeamHubAgentReasoningEffort)
    : defaultReasoningEffort;

  return {
    items: models.map(({ id, label }) => ({ value: id, label })),
    model: selectedModel?.id ?? "",
    reasoningEffort,
    reasoningEfforts,
    selectModel: setRequestedModel,
    selectReasoningEffort: setRequestedReasoningEffort,
  };
}

export function reasoningEffortLabel(value: TeamHubAgentReasoningEffort) {
  return (
    {
      none: "None",
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "Extra high",
      max: "Maximum",
      ultra: "Ultra",
    } satisfies Record<TeamHubAgentReasoningEffort, string>
  )[value];
}
