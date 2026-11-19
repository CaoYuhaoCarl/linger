import {
  Add01Icon,
  Alert02Icon,
  AlertCircleIcon,
  Copy01Icon,
  LinkSquare02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { Select, SelectItem } from "@/components/ui/select";
import type { TeamHubLocalComputerPage } from "@/features/teamhub/teamhub-types";
import { cn } from "@/lib/cn";

import {
  gatewayReadiness,
  isAgentUsingModel,
  type LocalModelAssignableAgent,
} from "./local-model-agents";
import {
  capabilityCopy,
  modelErrorCopy,
  modelNoteCopy,
  unavailableCopy,
} from "./local-models-copy";
import type { LocalModelPool, LocalModelsView } from "./local-models-queries";
import {
  contextLabel,
  downloadStopped,
  downloadTransferSummary,
  formatGigabytes,
  isModelOnComputer,
  modelCapabilities,
  modelSourceLabel,
  parametersLabel,
  placeName,
  poolFreeBytes,
  poolLabel,
  poolOf,
  safeModelSourceUrl,
  speedLabel,
  type HeaderMemorySegment,
  type ModelEntry,
} from "./local-models-rules";

type LocalComputer = TeamHubLocalComputerPage["items"][number];

/** Category colors from the Nature palette, one per model holding memory. */
export const segmentColors = [
  "bg-rain-500",
  "bg-lichen-500",
  "bg-sun-500",
  "bg-bluebell-500",
  "bg-lavender-500",
] as const;
/** Foundation components hold memory too, but are not models of the list. */
export const componentColor = "bg-muted-foreground/45";
export const otherAppsColor = "bg-muted-foreground/25";

export function memorySegmentColorClass(
  segment: Pick<HeaderMemorySegment, "kind" | "modelIndex">,
): string {
  if (segment.kind === "other") return otherAppsColor;
  if (segment.kind === "component") return componentColor;
  return segmentColors[(segment.modelIndex ?? 0) % segmentColors.length]!;
}

function Fact({
  children,
  className,
  label,
}: {
  children: ReactNode;
  className?: string;
  label: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-9 items-center gap-3 py-1.5 text-sm",
        className,
      )}
    >
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 text-foreground">{children}</span>
    </div>
  );
}

function DiagnosticCallout({
  children,
  label,
  tone,
}: {
  children: ReactNode;
  label: string;
  tone: "danger" | "warning";
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
        tone === "danger"
          ? "border-[var(--app-status-danger-border)] bg-[var(--app-status-danger-surface)] text-[var(--app-status-danger-text)]"
          : "border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-surface)] text-[var(--app-status-warning-text)]",
      )}
    >
      <Icon
        className="mt-0.5 shrink-0"
        icon={tone === "danger" ? AlertCircleIcon : Alert02Icon}
        size={14}
      />
      <p className="min-w-0 flex-1 leading-snug">
        <span className="font-medium">{label}: </span>
        <span>{children}</span>
      </p>
    </div>
  );
}

function CopyEndpoint({ endpoint, name }: { endpoint: string; name: string }) {
  const [copied, setCopied] = useState(false);
  const mountedRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
    };
  }, []);

  function copy() {
    void navigator.clipboard
      ?.writeText(endpoint)
      .then(() => {
        if (!mountedRef.current) return;
        setCopied(true);
        if (timerRef.current !== undefined) {
          clearTimeout(timerRef.current);
        }
        timerRef.current = setTimeout(() => {
          timerRef.current = undefined;
          if (mountedRef.current) setCopied(false);
        }, 2_000);
      })
      .catch(() => undefined);
  }

  return (
    <span className="flex items-center gap-1">
      <code className="min-w-0 truncate font-mono text-xs">{endpoint}</code>
      <Button
        aria-label={`Copy ${name} endpoint`}
        onClick={copy}
        size="compactIcon"
        title={copied ? "Copied" : "Copy endpoint"}
        tone="ghost"
      >
        <Icon
          className={copied ? "text-app-success" : undefined}
          icon={copied ? Tick02Icon : Copy01Icon}
          size={14}
        />
      </Button>
    </span>
  );
}

/** Everything about one model on one Computer, shown when its row expands. */
export function ModelFacts({
  assignableAgents = [],
  assigning = false,
  computer,
  disabled = false,
  entry,
  offline = false,
  onAssignAgent,
  onCreateAgent,
  readOnly = false,
  usedNames,
  view,
}: {
  assignableAgents?: readonly LocalModelAssignableAgent[];
  assigning?: boolean;
  computer?: LocalComputer;
  disabled?: boolean;
  entry: ModelEntry;
  offline?: boolean;
  onAssignAgent?: (agent: LocalModelAssignableAgent) => void;
  onCreateAgent?: (piModel: string) => void;
  readOnly?: boolean;
  usedNames?: readonly string[];
  view: LocalModelsView;
}) {
  const { model, status } = entry;
  const stopped = downloadStopped(model);
  const onComputer = isModelOnComputer(model);
  const pool = poolOf(view, model.pool);
  const plannedPlace =
    status === "available" || stopped ? placeName(view, model.pool) : undefined;
  const capabilities = modelCapabilities(model);
  const parameters = parametersLabel(model);
  const speed = speedLabel(model);
  const sourceUrl = safeModelSourceUrl(model.source_url);
  const transfer =
    status === "downloading" ? downloadTransferSummary(model) : undefined;
  const resolvedUsedNames = usedNames ?? entry.used_by.map((user) => user.name);
  const gateway = gatewayReadiness(model, computer);
  const piModel = model.pi_model;
  const canRouteAgents =
    status === "loaded" &&
    Boolean(piModel) &&
    !disabled &&
    !readOnly &&
    !offline;
  const hasDiagnostics =
    Boolean(model.error) || Boolean(model.note) || status === "unavailable";
  const factSeparator = "border-b border-border/50";

  return (
    <div className="space-y-2 pt-1">
      {hasDiagnostics ? (
        <div className="space-y-2 pb-1">
          {model.error ? (
            <DiagnosticCallout
              label={stopped ? "Last download" : "Last load"}
              tone="danger"
            >
              {modelErrorCopy(model.error.code)}
            </DiagnosticCallout>
          ) : null}
          {model.note ? (
            <DiagnosticCallout label="Note" tone="warning">
              {modelNoteCopy(model.note.code, placeName(view, model.pool))}
            </DiagnosticCallout>
          ) : null}
          {status === "unavailable" ? (
            <DiagnosticCallout label="Why not" tone="danger">
              {unavailableCopy(model.availability.reason)}
            </DiagnosticCallout>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-x-6 @xl:grid-cols-2">
        {model.publisher ? (
          <Fact className={factSeparator} label="Publisher">
            {model.publisher}
          </Fact>
        ) : null}
        {parameters ? (
          <Fact className={factSeparator} label="Parameters">
            {parameters}
          </Fact>
        ) : null}
        <Fact className={factSeparator} label="Version">
          {model.quant}
        </Fact>
        <Fact className={factSeparator} label="Memory">
          <span className="tabular-nums">
            {formatGigabytes(model.memory_bytes)}
          </span>
          {onComputer && pool
            ? ` on ${poolLabel(view, pool)}`
            : plannedPlace
              ? ` on ${plannedPlace}`
              : ""}
        </Fact>
        <Fact
          className={factSeparator}
          label={onComputer ? "On disk" : "Download"}
        >
          <span className="tabular-nums">
            {formatGigabytes(model.download_bytes)}
          </span>
        </Fact>
        {transfer ? (
          <Fact className={factSeparator} label="Transfer">
            <span className="tabular-nums">{transfer}</span>
          </Fact>
        ) : null}
        <Fact className={factSeparator} label="Context">
          <span className="tabular-nums">
            {contextLabel(model.context_tokens)}
          </span>
        </Fact>
        {speed ? (
          <Fact className={factSeparator} label="Speed">
            <span className="tabular-nums">{speed}</span>
          </Fact>
        ) : null}
        {model.license ? (
          <Fact className={factSeparator} label="License">
            {model.license}
          </Fact>
        ) : null}
        {sourceUrl ? (
          <Fact className={factSeparator} label="Source">
            <a
              className="inline-flex max-w-full items-center gap-1 text-foreground underline underline-offset-2"
              href={sourceUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              <span className="truncate">{modelSourceLabel(sourceUrl)}</span>
              <Icon className="shrink-0" icon={LinkSquare02Icon} size={14} />
            </a>
          </Fact>
        ) : null}
        {gateway ? (
          <Fact className={factSeparator} label="Gateway">
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  gateway.tone === "success"
                    ? "bg-app-success"
                    : gateway.tone === "info"
                      ? "bg-app-info"
                      : "bg-muted-foreground/60",
                )}
              />
              <span
                className={
                  gateway.tone === "success"
                    ? "text-app-success"
                    : gateway.tone === "info"
                      ? "text-app-info"
                      : "text-muted-foreground"
                }
              >
                {gateway.label}
              </span>
            </span>
          </Fact>
        ) : null}
        {capabilities.length ? (
          <Fact
            className={cn(factSeparator, "@xl:col-span-2")}
            label="Capabilities"
          >
            <span className="flex flex-wrap gap-1.5">
              {capabilities.map((capability) => (
                <span
                  className="rounded-full bg-muted px-2 py-0.5 text-xs text-secondary-foreground"
                  key={capability}
                >
                  {capabilityCopy(capability)}
                </span>
              ))}
            </span>
          </Fact>
        ) : null}
        {onComputer ? (
          <Fact className={cn(factSeparator, "@xl:col-span-2")} label="Used by">
            <span className="flex flex-wrap items-center gap-2">
              <span>
                {resolvedUsedNames.length
                  ? resolvedUsedNames.join(", ")
                  : "No Agent yet"}
              </span>
              {canRouteAgents &&
              assignableAgents.length > 0 &&
              onAssignAgent ? (
                <Select
                  aria-label="Switch Agent"
                  disabled={assigning}
                  onValueChange={(actorId) => {
                    const target = assignableAgents.find(
                      (agent) => agent.actorId === actorId,
                    );
                    if (target) onAssignAgent(target);
                  }}
                  placeholder="Switch Agent…"
                  value=""
                  variant="pill"
                >
                  {assignableAgents.map((agent) => {
                    const using = isAgentUsingModel(
                      agent,
                      view.computer.computer_id,
                      piModel,
                    );
                    return (
                      <SelectItem
                        disabled={agent.busy || using}
                        key={agent.actorId}
                        value={agent.actorId}
                      >
                        {agent.busy
                          ? `${agent.name} · Working`
                          : using
                            ? `${agent.name} · Current`
                            : agent.name}
                      </SelectItem>
                    );
                  })}
                </Select>
              ) : null}
              {canRouteAgents && piModel && onCreateAgent ? (
                <Button
                  onClick={() => onCreateAgent(piModel)}
                  size="compact"
                  tone="secondary"
                >
                  <Icon icon={Add01Icon} size={14} />
                  New Agent
                </Button>
              ) : null}
            </span>
          </Fact>
        ) : null}
        {model.endpoint ? (
          <Fact className="@xl:col-span-2" label="Endpoint">
            <CopyEndpoint
              endpoint={model.endpoint.base_url}
              name={model.name}
            />
          </Fact>
        ) : null}
      </div>
    </div>
  );
}

function PoolBar({
  colorOf,
  pool,
  view,
}: {
  colorOf: (holderId: string) => string;
  pool: LocalModelPool;
  view: LocalModelsView;
}) {
  const label = poolLabel(view, pool);
  // used_bytes is the device's real use; on a shared card other processes
  // hold memory that no holder accounts for.
  const otherBytes = Math.max(
    0,
    pool.used_bytes -
      pool.holders.reduce((sum, holder) => sum + holder.bytes, 0),
  );
  const width = (bytes: number) =>
    `${pool.total_bytes ? Math.min(100, (bytes / pool.total_bytes) * 100) : 0}%`;
  return (
    <div className="flex min-h-10 items-center gap-3 py-1.5 text-sm">
      <span className="w-24 shrink-0 text-muted-foreground">
        {pool.kind === "gpu" ? `GPU ${pool.gpu_index}` : label}
      </span>
      <span
        aria-label={`${label}: ${formatGigabytes(pool.used_bytes)} of ${formatGigabytes(pool.total_bytes)} in use`}
        className="flex h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
        role="img"
      >
        {pool.holders.map((holder) => (
          <span
            className={cn(
              "h-full border-r-2 border-card last:border-r-0",
              colorOf(holder.id),
            )}
            key={holder.id}
            style={{ width: width(holder.bytes) }}
            title={`${holder.name} · ${formatGigabytes(holder.bytes)}`}
          />
        ))}
        {otherBytes ? (
          <span
            className={cn("h-full", otherAppsColor)}
            style={{ width: width(otherBytes) }}
            title={`Other apps · ${formatGigabytes(otherBytes)}`}
          />
        ) : null}
      </span>
      <span className="w-24 shrink-0 text-right text-xs whitespace-nowrap tabular-nums text-muted-foreground">
        {formatGigabytes(poolFreeBytes(pool))} free
      </span>
    </div>
  );
}

/** Memory and hardware of one Computer, for people who want the numbers. */
export function AdvancedDialog({
  onClose,
  view,
}: {
  onClose: () => void;
  view: LocalModelsView;
}) {
  const host = view.computer.host;
  const holders = view.pools.flatMap((pool) => pool.holders);
  const models = holders.filter((holder) => holder.kind === "model");
  const components = holders.filter((holder) => holder.kind === "component");
  const colorOf = (holderId: string) => {
    const index = models.findIndex((holder) => holder.id === holderId);
    return index < 0
      ? componentColor
      : segmentColors[index % segmentColors.length]!;
  };

  return (
    <ModalDialog
      closeOnBackdrop
      description={
        host
          ? [host.os_label, host.engine_label].filter(Boolean).join(" · ")
          : undefined
      }
      onClose={onClose}
      size="md"
      title={`${view.computer.display_name} details`}
    >
      <div className="px-5 py-4">
        <h3 className="mb-1 text-sm font-medium text-muted-foreground">
          Memory
        </h3>
        <div className="divide-y divide-border">
          {view.pools.map((pool) => (
            <PoolBar colorOf={colorOf} key={pool.id} pool={pool} view={view} />
          ))}
        </div>
        {holders.length ? (
          <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {[...models, ...components].map((holder) => (
              <span className="flex items-center gap-1.5" key={holder.id}>
                <span
                  aria-hidden
                  className={cn("size-1.5 rounded-full", colorOf(holder.id))}
                />
                {holder.name}
              </span>
            ))}
          </p>
        ) : null}
        {host ? (
          <>
            <h3 className="mt-5 mb-1 text-sm font-medium text-muted-foreground">
              Hardware
            </h3>
            <div className="space-y-0.5">
              <Fact label="Memory">
                <span className="tabular-nums">
                  {formatGigabytes(host.ram_total_bytes)}
                </span>
              </Fact>
              {host.gpus.map((gpu) => (
                <Fact key={gpu.index} label={`GPU ${gpu.index}`}>
                  {gpu.name} ·{" "}
                  <span className="tabular-nums">
                    {formatGigabytes(gpu.total_bytes)}
                  </span>
                </Fact>
              ))}
              <Fact label="Free disk">
                <span className="tabular-nums">
                  {formatGigabytes(host.disk_free_bytes)}
                </span>
              </Fact>
            </div>
          </>
        ) : null}
      </div>
    </ModalDialog>
  );
}
