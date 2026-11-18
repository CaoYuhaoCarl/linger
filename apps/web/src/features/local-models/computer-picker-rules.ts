import type {
  LocalModelsComputerSummary,
  LocalModelsReadinessState,
} from "./local-models-queries";

type Computer = LocalModelsComputerSummary;

/** Picker order within a group: usable first, then what the owner can fix, then what can't run models here. */
const stateRank: Record<LocalModelsReadinessState, number> = {
  loaded: 0,
  working: 1,
  ready: 2,
  needs_attention: 3,
  needs_update: 4,
  needs_reinstall: 5,
  not_set_up: 6,
  checking: 7,
  not_reported: 8,
  managed_elsewhere: 9,
  unsupported_hardware: 10,
};

/** The states a default selection prefers, best first. */
const preferredStates: LocalModelsReadinessState[] = [
  "loaded",
  "working",
  "ready",
  "needs_attention",
  "not_set_up",
];

const platformLabels: Record<NonNullable<Computer["platform"]>, string> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

function time(value: string | undefined) {
  return value ? Date.parse(value) : 0;
}

/** By state rank, then the most recent snapshot, then name. */
export function compareComputers(a: Computer, b: Computer) {
  return (
    stateRank[a.readiness.state] - stateRank[b.readiness.state] ||
    time(b.observed_at) - time(a.observed_at) ||
    a.display_name.localeCompare(b.display_name)
  );
}

/** Matches the Computer's name, its owner's name or its platform. */
export function matchesComputerSearch(computer: Computer, search: string) {
  const needle = search.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [
    computer.display_name,
    computer.owner.display_name,
    computer.platform,
    computer.platform ? platformLabels[computer.platform] : undefined,
  ].some((value) => value?.toLocaleLowerCase().includes(needle));
}

export interface PickerGroups {
  /** The Computer this desktop app runs on, when it is the viewer's. */
  thisComputer?: Computer;
  online: Computer[];
  offline: Computer[];
}

/**
 * The picker's groups. Only the viewer's own Computers are listed: another
 * member's Computer opens only through a link.
 */
export function pickerGroups(
  computers: readonly Computer[],
  thisComputerId: string | undefined,
  search = "",
): PickerGroups {
  const listed = computers
    .filter(
      (computer) =>
        computer.viewer_is_owner && matchesComputerSearch(computer, search),
    )
    .sort(compareComputers);
  const others = listed.filter(
    (computer) => computer.computer_id !== thisComputerId,
  );
  return {
    offline: others.filter((computer) => computer.status === "offline"),
    online: others.filter((computer) => computer.status === "online"),
    thisComputer: listed.find(
      (computer) => computer.computer_id === thisComputerId,
    ),
  };
}

/**
 * The Computer a visit opens when the address names none: this desktop's
 * Computer, the last one picked on this device, the best online one, any
 * online one, then the one seen most recently. Each must be the viewer's.
 */
export function defaultComputerId(
  computers: readonly Computer[],
  { desktopId, lastPickId }: { desktopId?: string; lastPickId?: string },
) {
  const own = computers.filter((computer) => computer.viewer_is_owner);
  const owned = (id: string | undefined) =>
    id && own.some((computer) => computer.computer_id === id) ? id : undefined;
  const online = own
    .filter((computer) => computer.status === "online")
    .sort(compareComputers);
  const preference = (computer: Computer) =>
    preferredStates.indexOf(computer.readiness.state);
  const best = online
    .filter((computer) => preference(computer) >= 0)
    .sort(
      (a, b) =>
        preference(a) - preference(b) ||
        (b.counts?.loaded ?? 0) - (a.counts?.loaded ?? 0) ||
        compareComputers(a, b),
    )[0];
  const lastSeen = [...own].sort(
    (a, b) =>
      time(b.last_seen_at) - time(a.last_seen_at) || compareComputers(a, b),
  )[0];
  return (
    owned(desktopId) ??
    owned(lastPickId) ??
    best?.computer_id ??
    online[0]?.computer_id ??
    lastSeen?.computer_id
  );
}

export type ChipDot = "success" | "info" | "neutral" | "warning" | "danger";

export interface ComputerChip {
  label: string;
  dot?: ChipDot;
  /** A model is moving: the label shimmers. */
  working?: boolean;
  /** Not usable for models: the chip is greyed. */
  muted?: boolean;
  /** "Offline · 3h" before the chip; an offline chip is greyed without a dot. */
  offline?: string;
}

const readinessChips: Record<
  LocalModelsReadinessState,
  (computer: Computer) => Omit<ComputerChip, "offline">
> = {
  checking: () => ({ dot: "info", label: "Checking" }),
  loaded: (computer) => ({
    dot: "success",
    label: computer.counts ? `${computer.counts.loaded} loaded` : "Loaded",
  }),
  managed_elsewhere: () => ({ label: "Managed elsewhere" }),
  needs_attention: () => ({ dot: "danger", label: "Needs attention" }),
  needs_reinstall: () => ({ dot: "warning", label: "Needs reinstall" }),
  needs_update: () => ({ dot: "warning", label: "Updating" }),
  not_reported: () => ({ label: "Not reported", muted: true }),
  not_set_up: () => ({ label: "Not set up" }),
  ready: () => ({ dot: "neutral", label: "Ready" }),
  unsupported_hardware: (computer) => ({
    label:
      computer.readiness.reason === "MEMORY_INSUFFICIENT"
        ? "Not enough memory"
        : computer.readiness.reason === "DISK_INSUFFICIENT"
          ? "Not enough disk"
          : "No supported GPU",
    muted: true,
  }),
  // The summary counts downloads and loads together, so the chip can't say which.
  working: () => ({ dot: "info", label: "Working", working: true }),
};

/** The readiness chip the picker, the overview and the Computers page show. */
export function computerChip(
  computer: Computer,
  now = Date.now(),
): ComputerChip {
  const chip = readinessChips[computer.readiness.state](computer);
  if (computer.status === "online") return chip;
  return {
    label: chip.label,
    muted: true,
    offline: computer.last_seen_at
      ? `Offline · ${shortAge(computer.last_seen_at, now)}`
      : "Offline",
  };
}

/** "5m", "3h" or "2d" since `value`. */
function shortAge(value: string, now: number) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60_000));
  if (minutes < 60) return `${Math.max(minutes, 1)}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (60 * 24))}d`;
}
