import type { components } from "@linger/wire-contracts/teamhub-public/types";
import { queryOptions } from "@tanstack/react-query";

import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";

type Schemas = components["schemas"];
export type LocalModelsView = Schemas["LocalModelsView"];
export type LocalModelView = Schemas["LocalModelView"];
export type LocalModel = Schemas["LocalModel"];
export type LocalModelPool = Schemas["LocalModelPool"];
export type LocalModelHost = Schemas["LocalModelHost"];
export type LocalModelActionRequest = Schemas["LocalModelActionRequest"];
export type LocalModelAction = LocalModelActionRequest["action"];
export type LocalModelsComputerSummary = Schemas["LocalModelsComputerSummary"];
export type LocalModelsReadinessState = Schemas["LocalModelsReadinessState"];

const localModelsPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/local-models";
const localModelsComputersPath =
  "/v0/tenants/{tenantId}/local-models/computers";
const localModelActionPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/local-models/{modelId}/actions";

/** Every Computer's local-models view of a Tenant: the prefix a computers hint refreshes. */
export function tenantLocalModelsQueryKey(tenantId: string) {
  return ["teamhub", tenantId, "local-models"] as const;
}

export function localModelsQueryKey(tenantId: string, computerId: string) {
  return [...tenantLocalModelsQueryKey(tenantId), computerId] as const;
}

/**
 * The viewer's own Computers with their readiness, as the picker lists them.
 * It sits under the Tenant prefix, so a computers hint refreshes it; a
 * local-models hint refreshes it too, throttled.
 */
export function localModelsSummaryQueryKey(tenantId: string) {
  return [...tenantLocalModelsQueryKey(tenantId), "summary", "mine"] as const;
}

export function localModelsSummaryQueryOptions(
  client: TeamHubClient,
  tenantId: string,
) {
  return queryOptions({
    queryFn: ({ signal }) =>
      teamHubData(
        client.api.GET(localModelsComputersPath, {
          params: { path: { tenantId }, query: { scope: "mine" } },
          signal,
        }),
      ),
    queryKey: localModelsSummaryQueryKey(tenantId),
    retry: false,
  });
}

/**
 * One Computer's model library as it last reported it. A local-models hint
 * with the Computer ID refreshes it while a download or load runs.
 */
export function localModelsQueryOptions(
  client: TeamHubClient,
  tenantId: string,
  computerId: string,
) {
  return queryOptions({
    queryFn: ({ signal }) =>
      teamHubData(
        client.api.GET(localModelsPath, {
          params: { path: { computerId, tenantId } },
          signal,
        }),
      ),
    queryKey: localModelsQueryKey(tenantId, computerId),
    retry: false,
  });
}

/** Identifies pending actions of one Computer, so each row can show its own. */
export function localModelActionMutationKey(
  tenantId: string,
  computerId: string,
) {
  return ["teamhub", tenantId, "local-model-action", computerId] as const;
}

export interface LocalModelActionInput {
  action: LocalModelAction;
  modelId: string;
  unloadFirst?: string[];
}

/** Asks the Computer to start an action; the outcome arrives as a new snapshot. */
export function actOnLocalComputerModel(
  client: TeamHubClient,
  tenantId: string,
  computerId: string,
  { action, modelId, unloadFirst }: LocalModelActionInput,
) {
  return teamHubData(
    client.api.POST(localModelActionPath, {
      body: unloadFirst?.length
        ? { action, unload_first: unloadFirst }
        : { action },
      params: { path: { computerId, modelId, tenantId } },
    }),
  );
}

const localModelsRefreshPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/local-models/refresh";

/** Asks the owner's Computer to reread its library; a local-models hint brings the result. */
export function refreshLocalComputerModels(
  client: TeamHubClient,
  tenantId: string,
  computerId: string,
) {
  return teamHubData(
    client.api.POST(localModelsRefreshPath, {
      params: { path: { computerId, tenantId } },
    }),
  );
}
