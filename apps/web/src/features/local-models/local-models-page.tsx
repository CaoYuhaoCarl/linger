import {
  AiChipIcon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons";
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  type ReactNode,
  Suspense,
  lazy,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useParams, useSearchParams } from "react-router";

import { Button } from "@/components/ui/button";
import { FormFeedback } from "@/components/ui/form-feedback";
import { Icon } from "@/components/ui/icon";
import { Select, SelectItem } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { relativeTime } from "@/features/local-computer/computer-relative-time";
import { useDesktopComputer } from "@/features/local-computer/desktop-computer";
import { localComputersQueryOptions } from "@/features/local-computer/local-computer-queries";
import {
  anotherMeQueryOptions,
  teamHubIdentityQueryOptions,
  tenantActorsQueryKey,
  tenantAgentAvailabilityQueryKey,
  tenantAgentAvailabilityQueryOptions,
  tenantAgentsQueryKey,
  tenantAgentsQueryOptions,
  tenantRoomsQueryKey,
} from "@/features/rooms/room-queries";
import { requireRoomRouteParam } from "@/features/rooms/room-route-params";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubLocalComputerPage } from "@/features/teamhub/teamhub-types";
import { cn } from "@/lib/cn";

import {
  assignableLocalModelAgents,
  buildLocalModelRuntimeUpdate,
  isAgentUsingModel,
  primaryLocalModelAgent,
  type LocalModelAssignableAgent,
} from "./local-model-agents";
import { AdvancedDialog, memorySegmentColorClass } from "./local-model-details";
import {
  MakeRoomDialog,
  RemoveModelDialog,
  UnloadModelDialog,
} from "./local-model-dialogs";
import { ModelRow, OpenChatLink } from "./local-model-row";
import { actionErrorCopy, libraryUnavailableCopy } from "./local-models-copy";
import {
  actOnLocalComputerModel,
  localModelActionMutationKey,
  localModelsQueryKey,
  localModelsQueryOptions,
  type LocalModelAction,
  type LocalModelActionInput,
  type LocalModelsView,
} from "./local-models-queries";
import {
  computerPickerLabel,
  downloadStopped,
  formatGigabytes,
  headerMemorySegments,
  loadCheck,
  memorySummary,
  modelEntries,
  readRememberedLocalModelsComputerId,
  rememberLocalModelsComputerId,
  selectDefaultLocalModelsComputer,
  type HeaderMemorySegment,
  type ModelEntry,
  type ModelStatus,
} from "./local-models-rules";

type LocalComputer = TeamHubLocalComputerPage["items"][number];

const QuickCreateLocalAgentDialog = lazy(async () => ({
  default: (await import("@/features/rooms/quick-create-local-agent-dialog"))
    .QuickCreateLocalAgentDialog,
}));

type Dialog =
  | { kind: "advanced" }
  | { kind: "createAgent"; piModel: string }
  | { kind: "makeRoom"; modelId: string }
  | { kind: "remove"; modelId: string }
  | { kind: "unload"; modelId: string };

interface SwitchedNotice {
  agentNames: string[];
  includesAnotherMe: boolean;
  modelName: string;
}

/**
 * The model states each confirmed action applies to, as the row offers it. A
 * stopped download is failed too but offers none of them.
 */
const actionStatuses: Record<"load" | "remove" | "unload", ModelStatus[]> = {
  load: ["idle", "failed"],
  remove: ["loaded", "idle", "failed"],
  unload: ["loaded"],
};

function computersPath(tenantId: string, computerId?: string) {
  const base = `/t/${tenantId}/settings/computers`;
  return computerId
    ? `${base}?computer=${encodeURIComponent(computerId)}`
    : base;
}

/**
 * The model library of one Computer, chosen by `?computer=`. Without it the
 * desktop app opens its own Computer and a browser opens the remembered or
 * most ready owned Computer.
 */
export function LocalModelsPage() {
  const { client } = useTeamHubRuntime();
  const tenantId = requireRoomRouteParam(useParams().tenantId, "Tenant");
  const { data: inventory } = useSuspenseQuery(
    localComputersQueryOptions(client, tenantId),
  );
  const desktop = useDesktopComputer();
  const [searchParams, setSearchParams] = useSearchParams();
  const computers = inventory.items;
  const linkedId = searchParams.get("computer");
  const ownedFromLink = linkedId
    ? computers.find((item) => item.computer_id === linkedId)
    : undefined;
  // A linked Computer the viewer does not own may be another member's: the
  // library API, not the owned inventory, decides whether they may read it.
  const sharedId = linkedId && !ownedFromLink ? linkedId : undefined;
  const rememberedId = readRememberedLocalModelsComputerId(tenantId);
  const computer = sharedId
    ? undefined
    : (ownedFromLink ??
      selectDefaultLocalModelsComputer(computers, {
        desktopComputerId: desktop?.status?.computerId,
        rememberedComputerId: rememberedId,
      }));
  const ownedLinkedComputerId = ownedFromLink?.computer_id;
  const identityQuery = useQuery(teamHubIdentityQueryOptions(client));
  const agentsQuery = useQuery(tenantAgentsQueryOptions(client, tenantId));
  const availabilityQuery = useQuery(
    tenantAgentAvailabilityQueryOptions(client, tenantId),
  );
  const anotherMeQuery = useQuery(anotherMeQueryOptions(client, tenantId));
  const currentActorId = identityQuery.data?.actors.find(
    (actor) => actor.tenant_id === tenantId,
  )?.id;
  const anotherMeActorId = anotherMeQuery.data?.agent_actor_id;
  const anotherMeRoomId = anotherMeQuery.data?.room_id;
  const assignableAgents = useMemo(
    () =>
      assignableLocalModelAgents(agentsQuery.data?.items ?? [], {
        anotherMeActorId,
        availabilities: availabilityQuery.data?.items,
        currentActorId,
      }),
    [
      agentsQuery.data?.items,
      anotherMeActorId,
      availabilityQuery.data?.items,
      currentActorId,
    ],
  );
  const agentsLoaded = agentsQuery.data !== undefined;

  useEffect(() => {
    if (linkedId && ownedLinkedComputerId) {
      rememberLocalModelsComputerId(tenantId, ownedLinkedComputerId);
    }
  }, [linkedId, ownedLinkedComputerId, tenantId]);

  function select(computerId: string) {
    rememberLocalModelsComputerId(tenantId, computerId);
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set("computer", computerId);
        return next;
      },
      { replace: true },
    );
  }

  return (
    <main className="mx-auto flex min-h-0 w-full max-w-(--app-settings-width) flex-col pb-4">
      {sharedId ? (
        <ComputerModels
          agentsLoaded={agentsLoaded}
          anotherMeRoomId={anotherMeRoomId}
          assignableAgents={assignableAgents}
          computerId={sharedId}
          computerPicker={null}
          key={sharedId}
          tenantId={tenantId}
        />
      ) : computer ? (
        <ComputerModels
          agentsLoaded={agentsLoaded}
          anotherMeRoomId={anotherMeRoomId}
          assignableAgents={assignableAgents}
          computer={computer}
          computerId={computer.computer_id}
          computerPicker={
            computers.length > 1 ? (
              <Select
                aria-label="Computer"
                onValueChange={select}
                value={computer.computer_id}
                variant="pill"
              >
                {computers.map((item) => (
                  <SelectItem key={item.computer_id} value={item.computer_id}>
                    {computerPickerLabel(item)}
                  </SelectItem>
                ))}
              </Select>
            ) : null
          }
          displayName={computer.display_name}
          key={computer.computer_id}
          tenantId={tenantId}
        />
      ) : (
        <>
          <h1 className="text-2xl text-foreground">Local models</h1>
          <EmptyState title="No computers yet">
            Connect a computer in{" "}
            <Link
              className="text-foreground underline underline-offset-2"
              to={computersPath(tenantId)}
            >
              Computers
            </Link>{" "}
            to download and run models on it.
          </EmptyState>
        </>
      )}
    </main>
  );
}

function EmptyState({
  action,
  children,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  title: string;
}) {
  return (
    <section
      aria-label={title}
      className="mt-6 flex flex-col items-center px-4 pt-12 text-center"
    >
      <span className="flex size-16 items-center justify-center rounded-[20%] bg-muted text-foreground">
        <Icon icon={AiChipIcon} size={28} />
      </span>
      <h2 className="mt-6 text-xl">{title}</h2>
      <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
        {children}
      </p>
      {action}
    </section>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p
      className="mt-6 rounded-xl bg-muted px-3.5 py-3 text-sm text-muted-foreground"
      role="status"
    >
      {children}
    </p>
  );
}

function HeaderMemoryMeter({
  gpu,
  segments,
  totalBytes,
  usedBytes,
}: {
  gpu: boolean;
  segments: readonly HeaderMemorySegment[];
  totalBytes: number;
  usedBytes: number;
}) {
  return (
    <div className="max-w-md space-y-1.5">
      <div
        aria-label={`${gpu ? "GPU memory" : "Memory"} breakdown: ${formatGigabytes(usedBytes)} of ${formatGigabytes(totalBytes)} in use`}
        className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="img"
      >
        {segments.map((segment) => (
          <span
            className={cn(
              "h-full border-r border-background last:border-r-0",
              memorySegmentColorClass(segment),
            )}
            key={segment.id}
            style={{ width: `${segment.percent}%` }}
            title={`${segment.name} · ${formatGigabytes(segment.bytes)}`}
          />
        ))}
      </div>
      {segments.length ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {segments.map((segment) => (
            <span
              className="inline-flex items-center gap-1.5 tabular-nums"
              key={segment.id}
            >
              <span
                aria-hidden
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  memorySegmentColorClass(segment),
                )}
              />
              <span>
                {segment.name} · {formatGigabytes(segment.bytes)}
              </span>
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}

function ModelsSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading models"
      className="mt-6 grid gap-2"
      role="status"
    >
      <span className="sr-only">Loading models</span>
      {[0, 1, 2].map((index) => (
        <div
          className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
          key={index}
        >
          <Skeleton className="size-10 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-3 w-32" />
          </div>
          <Skeleton className="h-7 w-20 rounded-md" />
        </div>
      ))}
    </div>
  );
}

function ComputerModels({
  agentsLoaded,
  anotherMeRoomId,
  assignableAgents,
  computer,
  computerId,
  computerPicker,
  displayName,
  tenantId,
}: {
  agentsLoaded: boolean;
  anotherMeRoomId?: string;
  assignableAgents: readonly LocalModelAssignableAgent[];
  computer?: LocalComputer;
  computerId: string;
  computerPicker: ReactNode;
  /** Absent for a Computer outside the viewer's own inventory. */
  displayName?: string;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const query = useQuery(localModelsQueryOptions(client, tenantId, computerId));
  const view = query.data;
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const summary = view?.available ? memorySummary(view) : undefined;
  const segments = view?.available ? headerMemorySegments(view) : [];
  const freeBytes = summary
    ? Math.max(0, summary.totalBytes - summary.usedBytes)
    : 0;

  return (
    <>
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl text-foreground">Local models</h1>
          {summary?.totalBytes ? (
            <div className="mt-1.5 space-y-2">
              <p className="text-sm text-muted-foreground">
                <span className="tabular-nums">
                  {formatGigabytes(summary.usedBytes)} of{" "}
                  {formatGigabytes(summary.totalBytes)}{" "}
                  {summary.gpu ? "GPU memory" : "memory"} in use
                </span>
                <span className="tabular-nums">
                  {" "}
                  · {formatGigabytes(freeBytes)} free
                </span>
              </p>
              <HeaderMemoryMeter
                gpu={summary.gpu}
                segments={segments}
                totalBytes={summary.totalBytes}
                usedBytes={summary.usedBytes}
              />
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {computerPicker}
          {view?.available ? (
            <Button
              onClick={() => setDialog({ kind: "advanced" })}
              size="compact"
            >
              Details
            </Button>
          ) : null}
        </div>
      </header>

      {view ? (
        <Library
          agentsLoaded={agentsLoaded}
          anotherMeRoomId={anotherMeRoomId}
          assignableAgents={assignableAgents}
          computer={computer}
          dialog={dialog}
          setDialog={setDialog}
          tenantId={tenantId}
          view={view}
        />
      ) : query.isError ? (
        <EmptyState
          action={
            <Button
              className="mt-6"
              onClick={() => void query.refetch()}
              size="compact"
            >
              Try again
            </Button>
          }
          title={`Couldn't load the models of ${displayName ?? "this computer"}`}
        >
          {actionErrorCopy(
            query.error instanceof TeamHubError ? query.error.code : undefined,
          )}
        </EmptyState>
      ) : (
        <ModelsSkeleton />
      )}
    </>
  );
}

function Library({
  agentsLoaded,
  anotherMeRoomId,
  assignableAgents,
  computer,
  dialog,
  setDialog,
  tenantId,
  view,
}: {
  agentsLoaded: boolean;
  anotherMeRoomId?: string;
  assignableAgents: readonly LocalModelAssignableAgent[];
  computer?: LocalComputer;
  dialog: Dialog | null;
  setDialog: (dialog: Dialog | null) => void;
  tenantId: string;
  view: LocalModelsView;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const computerId = view.computer.computer_id;
  const name = view.computer.display_name;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    code?: string;
    modelId: string;
  } | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<Record<string, string[]>>(
    {},
  );
  const [switchedNotice, setSwitchedNotice] = useState<SwitchedNotice | null>(
    null,
  );
  const [assignError, setAssignError] = useState<string | null>(null);
  const triggeredAutoSwitchRef = useRef<Set<string>>(new Set());
  const primaryAgent = primaryLocalModelAgent(assignableAgents, computerId);

  // An action the Computer accepted, shown on its row until a snapshot moves
  // the model on: a different status or a newer snapshot.
  const [accepted, setAccepted] = useState<
    Record<
      string,
      { action: LocalModelAction; from?: ModelStatus; observedAt?: string }
    >
  >({});
  const entries = useMemo(
    () => (view.available ? modelEntries(view) : []),
    [view],
  );
  const find = (modelId: string) =>
    entries.find((entry) => entry.model.id === modelId);
  const mutationKey = localModelActionMutationKey(tenantId, computerId);
  const action = useMutation({
    mutationFn: (input: LocalModelActionInput) =>
      actOnLocalComputerModel(client, tenantId, computerId, input),
    mutationKey,
    onError: (error, input) => {
      clearPendingSwitch(input.modelId);
      setFailure({
        code: error instanceof TeamHubError ? error.code : undefined,
        modelId: input.modelId,
      });
    },
    onMutate: (input) => {
      setFailure(null);
      return { from: find(input.modelId)?.status };
    },
    onSuccess: (_result, input, started) =>
      setAccepted((current) => ({
        ...current,
        [input.modelId]: {
          action: input.action,
          from: started?.from,
          observedAt: queryClient.getQueryData<LocalModelsView>(
            localModelsQueryKey(tenantId, computerId),
          )?.observed_at,
        },
      })),
    // The Computer answers at once; a fresh read shows what it started even
    // before its next snapshot hint.
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: localModelsQueryKey(tenantId, computerId),
      }),
  });

  const assignMutation = useMutation({
    mutationFn: async (input: {
      agents: readonly LocalModelAssignableAgent[];
      modelId: string;
      modelName: string;
      piModel: string;
    }) => {
      const updates = input.agents.flatMap((agent) => {
        const body = buildLocalModelRuntimeUpdate(
          agent,
          computer,
          input.piModel,
        );
        return body ? [{ agent, body }] : [];
      });
      if (!updates.length) {
        throw new Error(
          "This computer has no writable workspace for Agents yet.",
        );
      }
      await Promise.all(
        updates.map(({ agent, body }) =>
          teamHubData(
            client.api.PATCH("/v0/tenants/{tenantId}/agents/{agentId}", {
              body,
              params: { path: { agentId: agent.actorId, tenantId } },
            }),
          ),
        ),
      );
      return {
        agentNames: updates.map(({ agent }) => agent.name),
        includesAnotherMe: updates.some(({ agent }) => agent.isAnotherMe),
        modelName: input.modelName,
      };
    },
    onError: (error) => {
      setSwitchedNotice(null);
      setAssignError(
        error instanceof Error
          ? error.message
          : "Couldn't switch Agent to this model. Try again.",
      );
      void queryClient.invalidateQueries({
        queryKey: tenantAgentsQueryKey(tenantId),
      });
    },
    onMutate: () => {
      setAssignError(null);
    },
    onSuccess: async (result) => {
      setSwitchedNotice(result);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: tenantAgentsQueryKey(tenantId),
        }),
        queryClient.invalidateQueries({
          queryKey: tenantAgentAvailabilityQueryKey(tenantId),
        }),
        queryClient.invalidateQueries({
          queryKey: tenantActorsQueryKey(tenantId),
        }),
        queryClient.invalidateQueries({
          queryKey: tenantRoomsQueryKey(tenantId),
        }),
        queryClient.invalidateQueries({
          queryKey: localModelsQueryKey(tenantId, computerId),
        }),
      ]);
    },
  });

  const sending = useMutationState({
    filters: { mutationKey, status: "pending" },
    select: (mutation) =>
      mutation.state.variables as LocalModelActionInput | undefined,
  });
  // The action each row shows as under way: one being sent, or one accepted
  // that no snapshot reflects yet.
  const requests = new Map<string, LocalModelAction>();
  for (const [modelId, request] of Object.entries(accepted)) {
    if (
      request.observedAt === view.observed_at &&
      request.from === find(modelId)?.status
    )
      requests.set(modelId, request.action);
  }
  for (const input of sending) {
    if (input) requests.set(input.modelId, input.action);
  }
  const offline = view.computer.status === "offline";
  const readOnly = !view.viewer_is_owner;
  const hasActiveOrLoadedModel = entries.some((entry) => {
    const requested = requests.get(entry.model.id);
    const effectiveStatus =
      requested === "load"
        ? "loading"
        : requested === "download"
          ? "downloading"
          : entry.status;
    return (
      effectiveStatus === "loaded" ||
      effectiveStatus === "loading" ||
      effectiveStatus === "downloading"
    );
  });

  function clearPendingSwitch(modelId: string) {
    triggeredAutoSwitchRef.current.delete(modelId);
    setPendingSwitch((current) => {
      if (!(modelId in current)) return current;
      const next = { ...current };
      delete next[modelId];
      return next;
    });
  }

  function queuePendingSwitch(modelId: string, agentIds: string[]) {
    triggeredAutoSwitchRef.current.delete(modelId);
    setPendingSwitch((current) => {
      if (!agentIds.length) {
        if (!(modelId in current)) return current;
        const next = { ...current };
        delete next[modelId];
        return next;
      }
      return { ...current, [modelId]: agentIds };
    });
  }

  function togglePendingSwitch(modelId: string, agentId: string) {
    triggeredAutoSwitchRef.current.delete(modelId);
    setPendingSwitch((current) => {
      const existing = current[modelId] ?? [];
      const nextIds = existing.includes(agentId)
        ? existing.filter((id) => id !== agentId)
        : [...existing, agentId];
      if (!nextIds.length) {
        const next = { ...current };
        delete next[modelId];
        return next;
      }
      return { ...current, [modelId]: nextIds };
    });
  }

  const processPendingSwitch = useEffectEvent(() => {
    const pendingEntries = Object.entries(pendingSwitch);
    if (!pendingEntries.length) return;
    const toClear: string[] = [];
    for (const [modelId, agentIds] of pendingEntries) {
      const entry = entries.find((item) => item.model.id === modelId);
      const requested = requests.get(modelId);
      const effectiveStatus =
        requested === "load"
          ? "loading"
          : requested === "download"
            ? "downloading"
            : entry?.status;
      if (
        !entry ||
        effectiveStatus === "failed" ||
        effectiveStatus === "available" ||
        effectiveStatus === "unavailable"
      ) {
        toClear.push(modelId);
        continue;
      }
      if (
        !offline &&
        !readOnly &&
        entry.status === "loaded" &&
        entry.model.pi_model &&
        agentsLoaded &&
        !triggeredAutoSwitchRef.current.has(modelId)
      ) {
        triggeredAutoSwitchRef.current.add(modelId);
        toClear.push(modelId);
        const targetAgents = agentIds
          .map((id) => assignableAgents.find((agent) => agent.actorId === id))
          .filter(
            (agent): agent is LocalModelAssignableAgent =>
              agent !== undefined &&
              !agent.busy &&
              !isAgentUsingModel(agent, computerId, entry.model.pi_model),
          );
        if (targetAgents.length) {
          assignMutation.mutate({
            agents: targetAgents,
            modelId,
            modelName: entry.model.name,
            piModel: entry.model.pi_model,
          });
        }
      }
    }
    if (toClear.length) {
      for (const id of toClear) triggeredAutoSwitchRef.current.delete(id);
      setPendingSwitch((current) => {
        const next = { ...current };
        for (const id of toClear) delete next[id];
        return next;
      });
    }
  });

  useEffect(() => {
    processPendingSwitch();
  }, [
    agentsLoaded,
    entries,
    offline,
    pendingSwitch,
    readOnly,
    view.observed_at,
  ]);

  // A dialog stays open across snapshots, so its confirm checks the model
  // and Computer as they are now, the way the row's buttons do.
  const confirmable = (
    entry: ModelEntry,
    actionName: "load" | "remove" | "unload",
  ) =>
    !offline &&
    !readOnly &&
    !requests.has(entry.model.id) &&
    !downloadStopped(entry.model) &&
    actionStatuses[actionName].includes(entry.status);
  const dialogEntry =
    dialog && dialog.kind !== "advanced" && dialog.kind !== "createAgent"
      ? find(dialog.modelId)
      : undefined;
  const makeRoom =
    dialog?.kind === "makeRoom" && dialogEntry
      ? loadCheck(view, dialogEntry.model)
      : null;
  const failedEntry = failure ? find(failure.modelId) : undefined;

  function act(input: LocalModelActionInput) {
    setDialog(null);
    if (
      input.action === "cancel" ||
      input.action === "unload" ||
      input.action === "remove"
    ) {
      clearPendingSwitch(input.modelId);
    }
    action.mutate(input);
  }

  function load(entry: ModelEntry) {
    if (loadCheck(view, entry.model))
      setDialog({ kind: "makeRoom", modelId: entry.model.id });
    else act({ action: "load", modelId: entry.model.id });
  }

  function unload(entry: ModelEntry) {
    if (entry.used_by.length)
      setDialog({ kind: "unload", modelId: entry.model.id });
    else act({ action: "unload", modelId: entry.model.id });
  }

  const unavailable = view.available
    ? undefined
    : libraryUnavailableCopy(view.reason?.code, name);

  return (
    <>
      {offline ? (
        <Notice>
          <span className="text-foreground">
            {name} is offline
            {view.computer.last_seen_at
              ? ` (last seen ${relativeTime(view.computer.last_seen_at)})`
              : ""}
            .
          </span>{" "}
          This is what it last reported.
          {readOnly ? null : (
            <>
              {" "}
              Reconnect it in{" "}
              <Link
                className="text-foreground underline underline-offset-2"
                to={computersPath(tenantId, computerId)}
              >
                Computers
              </Link>{" "}
              to manage its models.
            </>
          )}
        </Notice>
      ) : null}
      {readOnly ? (
        <Notice>
          Only the person who connected {name} can download, load or remove its
          models.
        </Notice>
      ) : null}

      {unavailable ? (
        <EmptyState title={unavailable.title}>{unavailable.body}</EmptyState>
      ) : (
        <>
          {failure ? (
            <div className="mt-6">
              <FormFeedback tone="danger">
                {failedEntry ? `${failedEntry.model.name}: ` : null}
                {actionErrorCopy(failure.code)}
              </FormFeedback>
            </div>
          ) : null}
          {assignError ? (
            <div className="mt-6">
              <FormFeedback tone="danger">{assignError}</FormFeedback>
            </div>
          ) : null}
          {switchedNotice ? (
            <div
              aria-live="polite"
              className="mt-6 flex items-center justify-between gap-3 rounded-lg border border-[var(--app-status-success-border)] bg-[var(--app-status-success-surface)] px-3 py-2.5 text-sm text-[var(--app-status-success-text)]"
            >
              <div className="flex min-w-0 items-center gap-2">
                <Icon
                  className="shrink-0"
                  icon={CheckmarkCircle02Icon}
                  size={14}
                />
                <span className="min-w-0">
                  {switchedNotice.agentNames.length === 1
                    ? `${switchedNotice.agentNames[0]} now uses ${switchedNotice.modelName}.`
                    : `${switchedNotice.agentNames.join(", ")} now use ${switchedNotice.modelName}.`}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {switchedNotice.includesAnotherMe && anotherMeRoomId ? (
                  <OpenChatLink
                    anotherMeRoomId={anotherMeRoomId}
                    tenantId={tenantId}
                    tone="secondary"
                  />
                ) : null}
                <Button
                  aria-label="Dismiss notice"
                  onClick={() => setSwitchedNotice(null)}
                  size="compactIcon"
                  tone="ghost"
                >
                  <Icon icon={Cancel01Icon} size={14} />
                </Button>
              </div>
            </div>
          ) : null}
          <section aria-label="Models" className="mt-6 grid gap-2">
            {entries.map((entry) => {
              const modelId = entry.model.id;
              const assigningThisModel =
                assignMutation.isPending &&
                assignMutation.variables?.modelId === modelId;
              return (
                <ModelRow
                  anotherMeRoomId={anotherMeRoomId}
                  assignableAgents={assignableAgents}
                  assigning={assigningThisModel}
                  computer={computer}
                  disabled={offline || readOnly || requests.has(modelId)}
                  elevateRecommended={!hasActiveOrLoadedModel}
                  entry={entry}
                  expanded={expandedId === modelId}
                  key={modelId}
                  offline={offline}
                  onAssignAgent={(agent) => {
                    if (!entry.model.pi_model || assignMutation.isPending)
                      return;
                    assignMutation.mutate({
                      agents: [agent],
                      modelId,
                      modelName: entry.model.name,
                      piModel: entry.model.pi_model,
                    });
                  }}
                  onCancel={() => act({ action: "cancel", modelId })}
                  onCreateAgent={(piModel) =>
                    setDialog({ kind: "createAgent", piModel })
                  }
                  onDownload={() => act({ action: "download", modelId })}
                  onLoad={() => load(entry)}
                  onRemove={() => setDialog({ kind: "remove", modelId })}
                  onToggle={() =>
                    setExpandedId((current) =>
                      current === modelId ? null : modelId,
                    )
                  }
                  onTogglePendingSwitch={(agentId) =>
                    togglePendingSwitch(modelId, agentId)
                  }
                  onUnload={() => unload(entry)}
                  pendingSwitchAgentIds={pendingSwitch[modelId]}
                  primaryAgent={primaryAgent}
                  readOnly={readOnly}
                  requested={requests.get(modelId)}
                  tenantId={tenantId}
                  view={view}
                />
              );
            })}
          </section>
        </>
      )}

      {dialog?.kind === "advanced" ? (
        <AdvancedDialog onClose={() => setDialog(null)} view={view} />
      ) : null}
      {dialog?.kind === "createAgent" ? (
        <Suspense fallback={null}>
          <QuickCreateLocalAgentDialog
            initialComputerId={computerId}
            initialModelId={dialog.piModel}
            initialRuntimeType="pi"
            onClose={() => setDialog(null)}
            tenantId={tenantId}
          />
        </Suspense>
      ) : null}
      {dialogEntry && makeRoom ? (
        <MakeRoomDialog
          assignableAgents={assignableAgents}
          check={makeRoom}
          disabled={!confirmable(dialogEntry, "load")}
          entry={dialogEntry}
          onClose={() => setDialog(null)}
          onConfirm={(unloadFirst, switchAgentIds) => {
            if (switchAgentIds.length) {
              queuePendingSwitch(dialogEntry.model.id, switchAgentIds);
            }
            act({
              action: "load",
              modelId: dialogEntry.model.id,
              unloadFirst,
            });
          }}
          primaryAgent={primaryAgent}
          view={view}
        />
      ) : null}
      {dialogEntry && dialog?.kind === "unload" ? (
        <UnloadModelDialog
          disabled={!confirmable(dialogEntry, "unload")}
          entry={dialogEntry}
          onClose={() => setDialog(null)}
          onConfirm={() =>
            act({ action: "unload", modelId: dialogEntry.model.id })
          }
          view={view}
        />
      ) : null}
      {dialogEntry && dialog?.kind === "remove" ? (
        <RemoveModelDialog
          disabled={!confirmable(dialogEntry, "remove")}
          entry={dialogEntry}
          onClose={() => setDialog(null)}
          onConfirm={() =>
            act({ action: "remove", modelId: dialogEntry.model.id })
          }
          view={view}
        />
      ) : null}
    </>
  );
}
