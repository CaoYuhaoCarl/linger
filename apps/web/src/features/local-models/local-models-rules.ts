import type { TeamHubLocalComputerPage } from "@/features/teamhub/teamhub-types";
import { formatBytes } from "@/lib/format-bytes";

import { architectureCopy, capabilityCopy } from "./local-models-copy";
import type {
  LocalModel,
  LocalModelPool,
  LocalModelsView,
  LocalModelView,
} from "./local-models-queries";

type LocalComputer = TeamHubLocalComputerPage["items"][number];
const piLibraryModelPrefix = "localmodels-library/";

/**
 * Presentation rules of the Local models page. The Computer decides fit,
 * availability, placement, the recommendation and every memory figure; these
 * rules only order, label and add up what it reported.
 */

/**
 * Every status a model has on one Computer, in list order. The first five
 * are on the Computer (or downloading to it); the last two are not.
 */
export const modelStatuses = [
  "loaded",
  "loading",
  "failed",
  "idle",
  "downloading",
  "available",
  "unavailable",
] as const;

export type ModelStatus = (typeof modelStatuses)[number];

export interface ModelEntry extends LocalModelView {
  status: ModelStatus;
}

export function modelStatus(model: LocalModel): ModelStatus {
  if (model.state !== "absent") return model.state;
  return model.availability.downloadable ? "available" : "unavailable";
}

/**
 * Whether a failed model is a download that stopped rather than a load that
 * failed. The library reports a failed model without a record only for a
 * download job that ended and kept its partial, and gives it one of these
 * download codes; such a model resumes with download and is discarded with
 * cancel, while load and remove are refused. Decided by the structured code,
 * never by the error detail.
 */
export function downloadStopped(model: LocalModel): boolean {
  return (
    model.state === "failed" &&
    (model.error?.code === "DOWNLOAD_FAILED" ||
      model.error?.code === "NETWORK_UNAVAILABLE")
  );
}

const fitOrder: Record<LocalModel["fit"], number> = {
  gpu: 0,
  none: 2,
  system: 1,
  unified: 0,
};

/** The library as one list: by status, then the recommended model, then by fit. */
export function modelEntries(view: LocalModelsView): ModelEntry[] {
  return view.models
    .map((item) => ({ ...item, status: modelStatus(item.model) }))
    .sort(
      (a, b) =>
        modelStatuses.indexOf(a.status) - modelStatuses.indexOf(b.status) ||
        Number(b.model.recommended) - Number(a.model.recommended) ||
        fitOrder[a.model.fit] - fitOrder[b.model.fit],
    );
}

/** The pool a model lives in; none when it fits nowhere or the pool is unreported. */
export function poolOf(view: LocalModelsView, poolId: string | undefined) {
  return poolId === undefined
    ? undefined
    : view.pools.find((pool) => pool.id === poolId);
}

function gpuName(view: LocalModelsView, pool: LocalModelPool) {
  return view.computer.host?.gpus.find((gpu) => gpu.index === pool.gpu_index)
    ?.name;
}

/** A pool's full name: "GPU 0 · RTX 4090", "System memory", "Unified memory". */
export function poolLabel(view: LocalModelsView, pool: LocalModelPool) {
  if (pool.kind === "system") return "System memory";
  if (pool.kind === "unified") return "Unified memory";
  const name = gpuName(view, pool);
  return name ? `GPU ${pool.gpu_index} · ${name}` : `GPU ${pool.gpu_index}`;
}

/**
 * A pool's short name for status lines: "GPU 0", "system memory", "memory".
 * Undefined without a pool, so no placement is shown.
 */
export function placeName(view: LocalModelsView, poolId: string | undefined) {
  const pool = poolOf(view, poolId);
  if (!pool) return undefined;
  if (pool.kind === "gpu") return `GPU ${pool.gpu_index}`;
  return pool.kind === "system" ? "system memory" : "memory";
}

/**
 * Model and memory sizes always read in GB with at most one decimal, so a
 * small model and an empty pool compare at a glance with the rest: 0.6 GB and
 * 0 GB, not 614.4 MB and 0 B.
 */
export function formatGigabytes(bytes: number) {
  return `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`;
}

export function poolFreeBytes(pool: LocalModelPool) {
  return Math.max(0, pool.total_bytes - pool.used_bytes);
}

function summaryPools(view: LocalModelsView) {
  const gpus = view.pools.filter((pool) => pool.kind === "gpu");
  return gpus.length ? gpus : view.pools;
}

/** What the header adds up: GPU memory when the Computer has GPUs, else its memory. */
export function memorySummary(view: LocalModelsView) {
  const gpus = view.pools.filter((pool) => pool.kind === "gpu");
  const pools = summaryPools(view);
  return {
    gpu: gpus.length > 0,
    totalBytes: pools.reduce((sum, pool) => sum + pool.total_bytes, 0),
    usedBytes: pools.reduce((sum, pool) => sum + pool.used_bytes, 0),
  };
}

export interface HeaderMemorySegment {
  id: string;
  kind: "model" | "component" | "other";
  name: string;
  bytes: number;
  percent: number;
  modelIndex?: number;
}

/**
 * Aggregated memory segments across the header's summary pools so users can
 * distinguish loaded models, foundation components, and other-app memory
 * without opening Details.
 */
export function headerMemorySegments(
  view: LocalModelsView,
): HeaderMemorySegment[] {
  const pools = summaryPools(view);
  const totalBytes = pools.reduce((sum, pool) => sum + pool.total_bytes, 0);
  if (totalBytes <= 0) return [];

  const modelHolders = new Map<string, { name: string; bytes: number }>();
  const componentHolders = new Map<string, { name: string; bytes: number }>();
  let otherBytes = 0;

  for (const pool of pools) {
    let accounted = 0;
    for (const holder of pool.holders) {
      accounted += holder.bytes;
      const target = holder.kind === "model" ? modelHolders : componentHolders;
      const existing = target.get(holder.id);
      if (existing) existing.bytes += holder.bytes;
      else target.set(holder.id, { name: holder.name, bytes: holder.bytes });
    }
    otherBytes += Math.max(0, pool.used_bytes - accounted);
  }

  const rawSegments: Array<Omit<HeaderMemorySegment, "percent">> = [];
  let modelIndex = 0;
  for (const [id, holder] of modelHolders) {
    if (holder.bytes > 0) {
      rawSegments.push({
        bytes: holder.bytes,
        id,
        kind: "model",
        modelIndex,
        name: holder.name,
      });
      modelIndex += 1;
    }
  }
  for (const [id, holder] of componentHolders) {
    if (holder.bytes > 0) {
      rawSegments.push({
        bytes: holder.bytes,
        id,
        kind: "component",
        name: holder.name,
      });
    }
  }
  if (otherBytes > 0) {
    rawSegments.push({
      bytes: otherBytes,
      id: "other-apps",
      kind: "other",
      name: "Other apps",
    });
  }

  const accountedTotal = rawSegments.reduce((sum, seg) => sum + seg.bytes, 0);
  const scaleBase = Math.max(totalBytes, accountedTotal);
  return rawSegments.map((segment) => ({
    ...segment,
    percent: (segment.bytes / scaleBase) * 100,
  }));
}

/** Whether a model holds usable files on the Computer (not absent or a partial download). */
export function isModelOnComputer(model: LocalModel): boolean {
  const status = modelStatus(model);
  return (
    status !== "available" &&
    status !== "unavailable" &&
    !downloadStopped(model)
  );
}

export function localModelsComputerStorageKey(tenantId: string): string {
  return `linger.local-models.computer:${tenantId}`;
}

export function readRememberedLocalModelsComputerId(
  tenantId: string,
): string | undefined {
  try {
    const value = globalThis.localStorage?.getItem(
      localModelsComputerStorageKey(tenantId),
    );
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function rememberLocalModelsComputerId(
  tenantId: string,
  computerId: string,
): void {
  try {
    globalThis.localStorage?.setItem(
      localModelsComputerStorageKey(tenantId),
      computerId,
    );
  } catch {
    // Ignore storage quota or private-mode access restrictions.
  }
}

/** Counts library models exposed through the Computer's Pi runtime. */
export function loadedLibraryModelCount(
  computer: Pick<LocalComputer, "runtimes">,
): number {
  const piRuntime = computer.runtimes.find((runtime) => runtime.type === "pi");
  if (!piRuntime) return 0;
  return piRuntime.models.filter((model) =>
    model.id.startsWith(piLibraryModelPrefix),
  ).length;
}

export function computerPickerLabel(
  computer: Pick<LocalComputer, "display_name" | "status" | "runtimes">,
): string {
  if (computer.status !== "online") {
    return `${computer.display_name} · Offline`;
  }
  const loadedCount = loadedLibraryModelCount(computer);
  return loadedCount > 0
    ? `${computer.display_name} · ${loadedCount} loaded`
    : computer.display_name;
}

/**
 * Picks the initial owned Computer when `?computer=` is omitted: the desktop's
 * own Computer, then the last remembered Computer, then an online Computer
 * already running a library model, then any online Computer, else the first.
 */
export function selectDefaultLocalModelsComputer<
  T extends Pick<LocalComputer, "computer_id" | "status" | "runtimes">,
>(
  computers: readonly T[],
  {
    desktopComputerId,
    rememberedComputerId,
  }: {
    desktopComputerId?: string;
    rememberedComputerId?: string;
  } = {},
): T | undefined {
  if (desktopComputerId) {
    const desktopComputer = computers.find(
      (item) => item.computer_id === desktopComputerId,
    );
    if (desktopComputer) return desktopComputer;
  }
  if (rememberedComputerId) {
    const remembered = computers.find(
      (item) => item.computer_id === rememberedComputerId,
    );
    if (remembered) return remembered;
  }
  return (
    computers.find(
      (item) => item.status === "online" && loadedLibraryModelCount(item) > 0,
    ) ??
    computers.find((item) => item.status === "online") ??
    computers[0]
  );
}

export interface LoadCheck {
  pool: LocalModelPool;
  needBytes: number;
  freeBytes: number;
  /** Loaded models in the same pool, the ones the user could unload. */
  loaded: ModelEntry[];
}

/** Why a model cannot load now, or `null` when its pool reports room for it. */
export function loadCheck(
  view: LocalModelsView,
  model: LocalModel,
): LoadCheck | null {
  const pool = poolOf(view, model.pool);
  if (!pool || poolFreeBytes(pool) >= model.memory_bytes) return null;
  return {
    freeBytes: poolFreeBytes(pool),
    loaded: modelEntries(view).filter(
      (entry) =>
        entry.status === "loaded" &&
        entry.model.pool === pool.id &&
        entry.model.id !== model.id,
    ),
    needBytes: model.memory_bytes,
    pool,
  };
}

function freedBytes(entries: ModelEntry[]) {
  return entries.reduce((sum, entry) => sum + entry.model.memory_bytes, 0);
}

/**
 * The models Make room preselects: the fewest that free enough memory, and
 * among those the fewest an Agent uses. Empty when unloading all of them is
 * still not enough.
 */
export function makeRoomSelection(check: LoadCheck): string[] {
  const deficit = check.needBytes - check.freeBytes;
  const largestFirst = (a: ModelEntry, b: ModelEntry) =>
    b.model.memory_bytes - a.model.memory_bytes;
  const unused = check.loaded
    .filter((entry) => entry.used_by.length === 0)
    .sort(largestFirst);
  const used = check.loaded
    .filter((entry) => entry.used_by.length > 0)
    .sort(largestFirst);
  // For a count and a number of used models, the largest of each group free
  // the most, so checking those picks is exhaustive.
  for (let count = 1; count <= check.loaded.length; count += 1) {
    for (let usedCount = 0; usedCount <= count; usedCount += 1) {
      const pick = [
        ...unused.slice(0, count - usedCount),
        ...used.slice(0, usedCount),
      ];
      if (pick.length === count && freedBytes(pick) >= deficit)
        return pick.map((entry) => entry.model.id);
    }
  }
  return [];
}

/** Whether unloading the selected models makes room. */
export function makesRoom(check: LoadCheck, selectedIds: ReadonlySet<string>) {
  const freed = freedBytes(
    check.loaded.filter((entry) => selectedIds.has(entry.model.id)),
  );
  return check.freeBytes + freed >= check.needBytes;
}

/** Whole-percent download progress. */
export function downloadPercent(model: LocalModel) {
  const download = model.download;
  if (!download?.total_bytes) return 0;
  return Math.min(
    100,
    Math.floor((download.done_bytes / download.total_bytes) * 100),
  );
}

export type LocalModelDownloadSource = NonNullable<
  NonNullable<LocalModel["download"]>["source"]
>;

const downloadSourceLabels: Record<LocalModelDownloadSource, string> = {
  cache: "Local cache",
  custom: "Custom source",
  huggingface: "Hugging Face",
  modelscope: "ModelScope mirror",
};

/** Human-readable name for the mirror or cache serving a model download. */
export function downloadSourceLabel(
  source?: LocalModelDownloadSource,
): string | undefined {
  return source ? downloadSourceLabels[source] : undefined;
}

/** Source, parallelism, and binary throughput unit details for a live download. */
export function downloadTransferSummary(model: LocalModel): string | undefined {
  const download = model.download;
  if (!download || (!download.source && download.connections === undefined)) {
    return undefined;
  }
  if (download.source === "cache") {
    return "Reusing verified local cache";
  }
  const connections = download.connections;
  const connectionLabel =
    connections !== undefined && connections > 0
      ? `${connections} ${connections === 1 ? "connection" : "connections"}`
      : undefined;
  return [
    downloadSourceLabel(download.source),
    connectionLabel,
    "binary MB/s (MiB/s)",
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

/** Whole-percent load progress across reported setup and weight-loading steps. */
export function loadPercent(model: LocalModel): number | null {
  const load = model.load;
  if (!load || load.total_steps <= 0) return null;
  return Math.max(
    0,
    Math.min(100, Math.round((load.done_steps / load.total_steps) * 100)),
  );
}

/** Live loading step text, falling back to pool placement when step progress is absent. */
export function loadStatusDetail(
  model: LocalModel,
  where?: string,
): string | null {
  const load = model.load;
  if (!load) return where ?? null;
  const pct = loadPercent(model);
  switch (load.step) {
    case "prepare":
      return "Preparing server…";
    case "start":
      return "Starting server…";
    case "load": {
      const base = where ? `Loading weights to ${where}` : "Loading weights";
      return pct !== null && pct > 0 ? `${base} · ${pct}%` : base;
    }
    case "warm":
      return pct !== null ? `Warming up · ${pct}%` : "Warming up";
    default: {
      const _exhaustive: never = load.step;
      return _exhaustive;
    }
  }
}

/** Context length in thousands of tokens, as model cards write it: 128K. */
export function contextLabel(tokens: number) {
  return `${Math.round(tokens / 1024)}K tokens`;
}

/** Agent names joined for a sentence. */
export function agentNames(entry: Pick<LocalModelView, "used_by">) {
  return entry.used_by.map((user) => user.name).join(", ");
}

export type LocalModelCapability = NonNullable<
  LocalModel["capabilities"]
>[number];

export const capabilityOrder: readonly LocalModelCapability[] = [
  "vision",
  "tool_use",
  "reasoning",
  "coding",
  "multilingual",
];

/** Ordered capabilities of a model, uniting `capabilities` with legacy `vision`. */
export function modelCapabilities(model: LocalModel): LocalModelCapability[] {
  const present = new Set<LocalModelCapability>(model.capabilities ?? []);
  if (model.vision) present.add("vision");
  return capabilityOrder.filter((capability) => present.has(capability));
}

/** Parameter scale and activation topology for details: "30B · 3B active (MoE)". */
export function parametersLabel(model: LocalModel) {
  const scale = [
    model.parameters,
    model.active_parameters ? `${model.active_parameters} active` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const arch = model.architecture
    ? architectureCopy(model.architecture)
    : undefined;
  if (scale && arch) return `${scale} (${arch})`;
  return scale || arch;
}

function allRowBadges(model: LocalModel): string[] {
  const badges: string[] = [];
  if (model.active_parameters) {
    badges.push(`${model.active_parameters} active`);
  } else if (model.parameters) {
    badges.push(model.parameters);
  }
  for (const capability of modelCapabilities(model)) {
    badges.push(capabilityCopy(capability));
  }
  return badges;
}

/** Concise badges for the collapsed row: structured scale and verified capabilities. */
export function rowBadges(model: LocalModel): string[] {
  const badges = allRowBadges(model);
  if (badges.length > 3) {
    return [...badges.slice(0, 3), `+${badges.length - 3}`];
  }
  return badges;
}

/** Full names of collapsed overflow badges for the `+N` pill tooltip. */
export function rowBadgesOverflowTitle(model: LocalModel): string | undefined {
  const badges = allRowBadges(model);
  return badges.length > 3 ? badges.slice(3).join(", ") : undefined;
}

function formatRemainingTime(seconds: number) {
  if (seconds < 60) return `${seconds}s left`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m left`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  if (minutes >= 60) return `${hours + 1}h left`;
  return minutes > 0 ? `${hours}h ${minutes}m left` : `${hours}h left`;
}

/** Live download progress summary: "checking file", "Reusing local cache…", or "25% · 50 MB/s · 5m left". */
export function downloadStatusDetail(model: LocalModel): string | null {
  const download = model.download;
  if (download?.step === "verify") return "checking file";
  if (download?.step === "download" && download.source === "cache") {
    return "Reusing local cache…";
  }
  const parts = [`${downloadPercent(model)}%`];
  if (download?.bytes_per_second && download.bytes_per_second > 0) {
    parts.push(`${formatBytes(download.bytes_per_second)}/s`);
    const remaining = download.total_bytes - download.done_bytes;
    if (remaining > 0) {
      parts.push(
        formatRemainingTime(Math.ceil(remaining / download.bytes_per_second)),
      );
    }
  }
  return parts.join(" · ");
}

/** Measured generation and prompt-processing throughput for model details. */
export function speedLabel(model: LocalModel) {
  const parts: string[] = [];
  if (model.tokens_per_second && model.tokens_per_second > 0) {
    parts.push(`${Math.round(model.tokens_per_second)} tokens/s`);
  }
  if (model.prompt_tokens_per_second && model.prompt_tokens_per_second > 0) {
    parts.push(`${Math.round(model.prompt_tokens_per_second)} prompt tokens/s`);
  }
  return parts.length ? parts.join(" · ") : undefined;
}

/** Returns `url` only when it parses as an `https:` URL. */
export function safeModelSourceUrl(url: string | undefined) {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/** Compact display label for a validated `https:` model card URL. */
export function modelSourceLabel(url: string) {
  const parsed = new URL(url);
  return `${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
}
