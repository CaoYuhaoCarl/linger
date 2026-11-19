import {
  AiChipIcon,
  ArrowDown01Icon,
  ChatGptIcon,
  ClaudeIcon,
  DeepseekIcon,
  GoogleGeminiIcon,
  GrokIcon,
  KimiAiIcon,
  MetaIcon,
  MicrosoftIcon,
  MistralIcon,
  QwenIcon,
} from "@hugeicons/core-free-icons";
import { useId, type MouseEvent } from "react";
import { Link, useInRouterContext } from "react-router";

import { AutoHeight } from "@/components/ui/auto-height";
import { Button, buttonClassName } from "@/components/ui/button";
import { Icon, type IconSvgElement } from "@/components/ui/icon";
import type { TeamHubLocalComputerPage } from "@/features/teamhub/teamhub-types";
import { cn } from "@/lib/cn";

import {
  isAgentUsingModel,
  usedByAgentNames,
  type LocalModelAssignableAgent,
} from "./local-model-agents";
import { ModelFacts } from "./local-model-details";
import { unavailableShortCopy } from "./local-models-copy";
import type {
  LocalModel,
  LocalModelAction,
  LocalModelsView,
} from "./local-models-queries";
import {
  downloadPercent,
  downloadStatusDetail,
  downloadStopped,
  downloadTransferSummary,
  formatGigabytes,
  loadPercent,
  loadStatusDetail,
  placeName,
  rowBadges,
  rowBadgesOverflowTitle,
  type ModelEntry,
  type ModelStatus,
} from "./local-models-rules";

type LocalComputer = TeamHubLocalComputerPage["items"][number];
type ModelFamily = NonNullable<LocalModel["family"]>;

const familyIcons: Record<ModelFamily, IconSvgElement> = {
  claude: ClaudeIcon,
  deepseek: DeepseekIcon,
  gemma: GoogleGeminiIcon,
  glm: AiChipIcon,
  grok: GrokIcon,
  kimi: KimiAiIcon,
  llama: MetaIcon,
  mistral: MistralIcon,
  openai: ChatGptIcon,
  other: AiChipIcon,
  phi: MicrosoftIcon,
  qwen: QwenIcon,
};

const familyTints: Record<ModelFamily, string> = {
  claude: "bg-sun-500/12 text-sun-700",
  deepseek: "bg-bluebell-500/12 text-bluebell-700",
  gemma: "bg-rain-500/12 text-rain-700",
  glm: "bg-lake-500/12 text-lake-700",
  grok: "bg-foreground/8 text-foreground",
  kimi: "bg-bubblegum-500/12 text-bubblegum-700",
  llama: "bg-bluebell-500/12 text-bluebell-700",
  mistral: "bg-acorn-500/12 text-acorn-700",
  openai: "bg-grass-500/12 text-grass-700",
  other: "bg-muted text-foreground",
  phi: "bg-rain-500/12 text-rain-700",
  qwen: "bg-lavender-500/12 text-lavender-700",
};

function familyIcon(family: LocalModel["family"]) {
  return family ? familyIcons[family] : AiChipIcon;
}

function familyTint(family: LocalModel["family"]) {
  return family ? familyTints[family] : familyTints.other;
}

/**
 * The status word every row shows under its name, with the dot that colors
 * it. Models not on the Computer carry no dot, like an unconnected Connector.
 */
const statusTags: Record<
  ModelStatus,
  { dot?: string; label: string; working?: boolean }
> = {
  available: { label: "Not downloaded" },
  downloading: {
    dot: "bg-app-info",
    label: "Downloading",
    working: true,
  },
  failed: { dot: "bg-app-danger", label: "Couldn't load" },
  idle: { dot: "bg-muted-foreground/60", label: "Downloaded" },
  loaded: { dot: "bg-app-success", label: "Loaded" },
  loading: { dot: "bg-app-info", label: "Loading", working: true },
  unavailable: { label: "Can't download" },
};

function cardSurfaceClass(
  status: ModelStatus,
  recommended: boolean,
  expanded: boolean,
): string {
  switch (status) {
    case "loaded":
      return expanded
        ? "border-app-success/55 bg-card"
        : "border-[var(--app-status-success-border)] bg-card hover:bg-accent/35";
    case "downloading":
    case "loading":
      return expanded
        ? "border-app-info/55 bg-[var(--app-card-info-surface)]/60"
        : "border-[var(--app-card-info-border)] bg-[var(--app-card-info-surface)]/40 hover:bg-[var(--app-card-info-surface)]/65";
    case "failed":
      return expanded
        ? "border-app-danger/55 bg-[var(--app-status-danger-surface)]/60"
        : "border-[var(--app-status-danger-border)] bg-[var(--app-status-danger-surface)]/40 hover:bg-[var(--app-status-danger-surface)]/65";
    case "unavailable":
      return expanded
        ? "border-border-hover bg-muted/35"
        : "border-border/70 bg-muted/25";
    default:
      if (status === "available" && recommended) {
        return expanded
          ? "border-foreground/30 bg-card"
          : "border-foreground/20 bg-card hover:bg-accent/40";
      }
      return expanded
        ? "border-border-hover bg-card"
        : "border-border bg-card hover:bg-accent/40";
  }
}

export function OpenChatLink({
  anotherMeRoomId,
  tenantId,
  tone = "secondary",
}: {
  anotherMeRoomId: string;
  tenantId: string;
  tone?: "primary" | "secondary" | "subtle";
}) {
  const inRouter = useInRouterContext();
  const to = `/t/${tenantId}/rooms/${anotherMeRoomId}/chat`;
  const className = buttonClassName({ size: "compact", tone });
  if (!inRouter) {
    return (
      <a className={className} href={to}>
        Open chat
      </a>
    );
  }
  return (
    <Link className={className} state={{ focusComposer: true }} to={to}>
      Open chat
    </Link>
  );
}

interface Handlers {
  onAssignAgent?: (agent: LocalModelAssignableAgent) => void;
  onCancel: () => void;
  onCreateAgent?: (piModel: string) => void;
  onDownload: () => void;
  onLoad: () => void;
  onRemove: () => void;
  onToggle: () => void;
  onTogglePendingSwitch?: (agentId: string) => void;
  onUnload: () => void;
}

function stopRowClick(event: MouseEvent) {
  event.stopPropagation();
}

/**
 * One catalog model on one Computer: a full-width card whose header carries
 * status, badges, agent routing, and lifecycle action, expanding to full facts.
 */
export function ModelRow({
  anotherMeRoomId,
  assignableAgents = [],
  assigning = false,
  computer,
  disabled,
  elevateRecommended = false,
  entry,
  expanded,
  offline = false,
  pendingSwitchAgentIds = [],
  primaryAgent,
  readOnly = false,
  requested,
  tenantId,
  view,
  ...handlers
}: Handlers & {
  anotherMeRoomId?: string;
  assignableAgents?: readonly LocalModelAssignableAgent[];
  assigning?: boolean;
  computer?: LocalComputer;
  /** Actions are off: the Computer is offline, the viewer only reads, or one is pending. */
  disabled: boolean;
  elevateRecommended?: boolean;
  entry: ModelEntry;
  expanded: boolean;
  offline?: boolean;
  pendingSwitchAgentIds?: readonly string[];
  primaryAgent?: LocalModelAssignableAgent;
  readOnly?: boolean;
  /** An action asked for and not yet in a snapshot. */
  requested?: LocalModelAction;
  tenantId: string;
  view: LocalModelsView;
}) {
  const panelId = useId();
  const { model } = entry;
  const computerId = view.computer.computer_id;
  // A requested load or download reads as started at once; the snapshot that
  // follows says how it went.
  const status: ModelStatus =
    requested === "load"
      ? "loading"
      : requested === "download"
        ? "downloading"
        : entry.status;
  const started = status !== entry.status;
  const stopped = status === "failed" && downloadStopped(model);
  const where = placeName(view, model.pool);
  const tag = stopped
    ? { ...statusTags.failed, label: "Download stopped" }
    : statusTags[status];
  const progress = downloadPercent(model);
  const loadProgress = loadPercent(model);
  const transferSummary =
    status === "downloading" && !started
      ? downloadTransferSummary(model)
      : undefined;
  const download = formatGigabytes(model.download_bytes);
  const badges = rowBadges(model);
  const overflowTitle = rowBadgesOverflowTitle(model);
  const usedNames = usedByAgentNames(entry, assignableAgents, computerId);
  const detail = {
    available: model.recommended
      ? `${download} · Recommended`
      : model.fit === "system"
        ? `${download} · runs slower`
        : download,
    downloading: started ? null : downloadStatusDetail(model),
    failed: null,
    idle: model.note ? "no room to load yet" : null,
    loaded: [
      where ? `${where[0]!.toUpperCase()}${where.slice(1)}` : undefined,
      formatGigabytes(model.memory_bytes),
    ]
      .filter(Boolean)
      .join(" · "),
    loading: loadStatusDetail(model, where),
    unavailable: unavailableShortCopy(model.availability.reason),
  }[status];

  const action = (
    {
      available: ["Download", handlers.onDownload, "download"],
      downloading: ["Cancel", handlers.onCancel, "cancel"],
      failed: stopped
        ? (["Resume download", handlers.onDownload, "download"] as const)
        : (["Retry", handlers.onLoad, "load"] as const),
      idle: ["Load", handlers.onLoad, "load"],
      loaded: ["Unload", handlers.onUnload, "unload"],
      loading: null,
      unavailable: null,
    } as const
  )[status];
  // A stopped download has no record to remove; discarding it deletes the
  // kept partial instead.
  const removable =
    status === "loaded" ||
    status === "idle" ||
    (status === "failed" && !stopped);

  const primaryUsingModel = Boolean(
    primaryAgent &&
    model.pi_model &&
    isAgentUsingModel(primaryAgent, computerId, model.pi_model),
  );
  const showOpenChat =
    !readOnly &&
    status === "loaded" &&
    Boolean(primaryAgent?.isAnotherMe) &&
    primaryUsingModel &&
    Boolean(anotherMeRoomId);
  const showUseWithPrimary =
    !readOnly &&
    status === "loaded" &&
    Boolean(model.pi_model) &&
    Boolean(primaryAgent) &&
    !primaryUsingModel &&
    Boolean(handlers.onAssignAgent);
  const showUseWhenReady =
    !readOnly &&
    !offline &&
    (status === "downloading" || status === "loading") &&
    Boolean(model.pi_model) &&
    Boolean(primaryAgent) &&
    !primaryAgent!.busy &&
    !primaryUsingModel &&
    Boolean(handlers.onTogglePendingSwitch);
  const isQueued = Boolean(
    primaryAgent && pendingSwitchAgentIds.includes(primaryAgent.actorId),
  );
  const primaryActionTone =
    model.recommended &&
    elevateRecommended &&
    (status === "available" || status === "idle" || status === "failed")
      ? "primary"
      : status === "downloading"
        ? "ghost"
        : "secondary";
  const progressBar =
    entry.status === "downloading"
      ? {
          ariaLabel: `${model.name} download progress`,
          fillPercent: progress,
          pulse: model.download?.step === "verify",
          value: progress,
        }
      : status === "loading" && loadProgress !== null
        ? {
            ariaLabel: `${model.name} load progress`,
            fillPercent: Math.max(loadProgress, 8),
            pulse: false,
            value: loadProgress,
          }
        : null;

  return (
    <article
      className={cn(
        "@container rounded-xl border transition-colors duration-150 motion-reduce:transition-none",
        cardSurfaceClass(status, model.recommended, expanded),
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 @lg:flex-nowrap">
        <button
          aria-controls={panelId}
          aria-expanded={expanded}
          aria-label={model.name}
          className={cn(
            "flex min-w-0 flex-1 basis-52 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            status === "unavailable" && "opacity-60",
          )}
          onClick={handlers.onToggle}
          type="button"
        >
          <span
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-lg shadow-outline",
              familyTint(model.family),
            )}
            data-family={model.family ?? "other"}
          >
            <Icon icon={familyIcon(model.family)} size={20} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">
              {model.name}
            </span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {tag.dot ? (
                <span
                  aria-hidden
                  className={cn("size-1.5 shrink-0 rounded-full", tag.dot)}
                />
              ) : null}
              <span
                className={cn(
                  "truncate tabular-nums",
                  tag.working && "town-shimmer-text",
                )}
                title={transferSummary}
              >
                <span className={tag.dot ? "text-foreground" : undefined}>
                  {tag.label}
                </span>
                {detail ? ` · ${detail}` : null}
              </span>
            </span>
          </span>
        </button>

        {usedNames.length > 0 || badges.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 @lg:shrink-0">
            {usedNames.length > 0 ? (
              <span
                className="max-w-44 truncate rounded-full bg-lake-500/12 px-2 py-0.5 text-xs text-lake-700"
                title={`Used by ${usedNames.join(", ")}`}
              >
                Used by {usedNames.join(", ")}
              </span>
            ) : null}
            {badges.map((badge, index) => {
              const isOverflow =
                index === badges.length - 1 &&
                overflowTitle !== undefined &&
                badge.startsWith("+");
              return (
                <span
                  className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground tabular-nums"
                  key={badge}
                  title={isOverflow ? overflowTitle : undefined}
                >
                  {badge}
                </span>
              );
            })}
          </div>
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {showOpenChat && anotherMeRoomId ? (
            <OpenChatLink
              anotherMeRoomId={anotherMeRoomId}
              tenantId={tenantId}
              tone="secondary"
            />
          ) : null}
          {showUseWithPrimary && primaryAgent && handlers.onAssignAgent ? (
            <Button
              disabled={disabled || primaryAgent.busy || assigning}
              loading={assigning}
              onClick={(event) => {
                stopRowClick(event);
                handlers.onAssignAgent?.(primaryAgent);
              }}
              size="compact"
              title={
                primaryAgent.busy
                  ? `${primaryAgent.name} is working`
                  : undefined
              }
              tone="primary"
            >
              Use with {primaryAgent.name}
            </Button>
          ) : null}
          {showUseWhenReady &&
          primaryAgent &&
          handlers.onTogglePendingSwitch ? (
            <Button
              aria-pressed={isQueued}
              disabled={
                requested === "cancel" ||
                requested === "remove" ||
                requested === "unload"
              }
              onClick={(event) => {
                stopRowClick(event);
                handlers.onTogglePendingSwitch?.(primaryAgent.actorId);
              }}
              size="compact"
              tone={isQueued ? "subtle" : "secondary"}
            >
              {isQueued ? `Queued for ${primaryAgent.name}` : "Use when ready"}
            </Button>
          ) : null}
          {action ? (
            <Button
              aria-label={`${action[0]} ${model.name}`}
              className="px-2.5"
              disabled={disabled}
              loading={requested === action[2]}
              onClick={(event) => {
                stopRowClick(event);
                action[1]();
              }}
              size="compact"
              tone={primaryActionTone}
            >
              {action[0]}
            </Button>
          ) : null}
          <Button
            aria-hidden
            className="text-muted-foreground"
            onClick={handlers.onToggle}
            size="compactIcon"
            tabIndex={-1}
            tone="ghost"
          >
            <Icon
              className={cn(
                "transition-transform duration-200 motion-reduce:transition-none",
                !expanded && "-rotate-90",
              )}
              icon={ArrowDown01Icon}
              size={14}
            />
          </Button>
        </div>
      </div>

      {progressBar ? (
        <div className="px-4 pb-3">
          <span
            aria-label={progressBar.ariaLabel}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={progressBar.value}
            className="block h-1.5 overflow-hidden rounded-full bg-muted"
            role="progressbar"
          >
            <span
              className={cn(
                "block h-full origin-left rounded-full bg-app-info transition-transform duration-200 motion-reduce:transition-none",
                progressBar.pulse && "animate-pulse motion-reduce:animate-none",
              )}
              style={{ transform: `scaleX(${progressBar.fillPercent / 100})` }}
            />
          </span>
        </div>
      ) : null}

      <AutoHeight open={expanded}>
        {expanded ? (
          <div
            aria-label={`${model.name} details`}
            className="border-t border-border/80 px-4 pt-2 pb-3"
            id={panelId}
            role="region"
          >
            {model.description ? (
              <p className="pb-1 text-sm text-muted-foreground">
                {model.description}
              </p>
            ) : null}
            <ModelFacts
              assignableAgents={assignableAgents}
              assigning={assigning}
              computer={computer}
              disabled={disabled}
              entry={entry}
              offline={offline}
              onAssignAgent={handlers.onAssignAgent}
              onCreateAgent={handlers.onCreateAgent}
              readOnly={readOnly}
              usedNames={usedNames}
              view={view}
            />
            {removable ? (
              <Button
                className="mt-3"
                disabled={disabled}
                loading={requested === "remove"}
                onClick={handlers.onRemove}
                size="compact"
                tone="danger"
              >
                Remove from computer
              </Button>
            ) : null}
            {stopped ? (
              <Button
                className="mt-3"
                disabled={disabled}
                loading={requested === "cancel"}
                onClick={handlers.onCancel}
                size="compact"
                tone="danger"
              >
                Discard download
              </Button>
            ) : null}
          </div>
        ) : null}
      </AutoHeight>
    </article>
  );
}
