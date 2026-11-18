import type { components } from "@linger/wire-contracts/teamhub-public/types";

import {
  computerCommand,
  computerInstallCommand,
} from "@/features/local-computer/computer-platform";

import type { LocalModelsView } from "./local-models-queries";
import { formatGigabytes } from "./local-models-rules";

type Schemas = components["schemas"];
type ReadinessState = Schemas["LocalModelsReadinessState"];
type InstallKind = Schemas["LocalComputerInstallKind"];

/** The states whose model library the page lists; every other one is an empty state. */
const libraryStates = new Set<ReadinessState>(["loaded", "working", "ready"]);
type EmptyStateKind = Exclude<ReadinessState, "loaded" | "working" | "ready">;

const docsOrigin = "https://docs.heylinger.com";

/** The docs.heylinger.com pages the empty states link; none carries a token. */
export type DocsPath =
  | "/install/reinstall-legacy"
  | "/install/update-computer"
  | "/local-models/cli"
  | "/local-models/containers"
  | "/local-models/desktop"
  | "/local-models/remote"
  | "/local-models/requirements"
  | "/local-models/troubleshooting";

export function docsUrl(path: DocsPath) {
  return `${docsOrigin}${path}`;
}

export type EmptyStateAction =
  | { kind: "command"; command: string }
  | { kind: "desktopSetup" }
  | { kind: "docs"; label: string; path: DocsPath }
  | { kind: "open"; computerId: string; label: string }
  | { kind: "refresh" };

export type EmptyStateLink =
  | { kind: "command"; command: string; label: string }
  | { kind: "computers"; label: string }
  | { kind: "docs"; label: string; path: DocsPath };

export interface EmptyStateSection {
  body: string;
  primary?: EmptyStateAction;
  secondary: EmptyStateLink[];
}

export type SetupTab = InstallKind;

export interface EmptyStatePlan extends EmptyStateSection {
  title: string;
  /** Diagnostic text from the Computer, for its owner only (collapsed). */
  detail?: string;
  spinner?: boolean;
  /** One way to set up per install kind, when the Computer never said how it was installed. */
  tabs?: Record<SetupTab, EmptyStateSection>;
}

export interface EmptyStateContext {
  /** The page runs in the desktop window of this Computer and it offers local-models setup. */
  desktopSetup: boolean;
}

const links = {
  cli: { kind: "docs", label: "CLI setup", path: "/local-models/cli" },
  containers: {
    kind: "docs",
    label: "GPU passthrough",
    path: "/local-models/containers",
  },
  desktop: {
    kind: "docs",
    label: "Set up in the desktop app",
    path: "/local-models/desktop",
  },
  manualSteps: {
    kind: "docs",
    label: "Manual steps",
    path: "/install/reinstall-legacy",
  },
  remote: {
    kind: "docs",
    label: "Remote gateways",
    path: "/local-models/remote",
  },
  requirements: {
    kind: "docs",
    label: "Requirements",
    path: "/local-models/requirements",
  },
  troubleshooting: {
    kind: "docs",
    label: "Troubleshooting",
    path: "/local-models/troubleshooting",
  },
  updating: {
    kind: "docs",
    label: "Updating a computer",
    path: "/install/update-computer",
  },
} as const satisfies Record<string, EmptyStateLink>;

/** What a non-owner is told to ask the owner for; null keeps the owner's copy without actions. */
const ownerAsks: Record<EmptyStateKind, string | null> = {
  checking: null,
  managed_elsewhere: null,
  needs_attention: "check the model tools",
  needs_reinstall: "reinstall Linger",
  needs_update: "update Linger",
  not_reported: "restart Linger",
  not_set_up: "set them up",
  unsupported_hardware: null,
};

type Computer = LocalModelsView["computer"];

function versionNote(computer: Computer) {
  return computer.daemon_version ? ` (${computer.daemon_version})` : "";
}

/** The GPU the copy names: Apple silicon, the first NVIDIA GPU, or none. */
function gpuName(computer: Computer) {
  const accelerators = computer.accelerators;
  if (!accelerators || accelerators.probe !== "ok") return undefined;
  if (accelerators.apple_silicon) return "Apple silicon";
  return accelerators.gpus.find((gpu) => gpu.vendor === "nvidia")?.name;
}

function cliSection(view: LocalModelsView): EmptyStateSection {
  const c = view.computer.display_name;
  return view.computer.readiness.enable_command
    ? {
        body: `Run this on ${c} as the user that runs Linger. It downloads the model tools for this Linger version, checks the hardware and connects them. Models appear here within a minute.`,
        primary: {
          command: `${computerCommand()} local-models enable`,
          kind: "command",
        },
        secondary: [links.cli],
      }
    : {
        body: `Follow the CLI setup steps on ${c} as the user that runs Linger. They download the model tools, check the hardware and connect them. Models appear here within a minute.`,
        primary: {
          kind: "docs",
          label: "CLI setup",
          path: "/local-models/cli",
        },
        secondary: [],
      };
}

function containerSection(view: LocalModelsView): EmptyStateSection {
  const c = view.computer.display_name;
  const accelerators = view.computer.accelerators;
  const gpu = gpuName(view.computer);
  const visible =
    accelerators?.probe === "ok"
      ? gpu
        ? ` (${gpu} is visible)`
        : " (none is visible now)"
      : "";
  const intro = `${c} runs in a container. It needs a GPU passed through${visible} and a volume for the model files.`;
  return view.computer.readiness.enable_command
    ? {
        body: `${intro} Then run the command inside the container as the Linger user.`,
        primary: {
          command: `${computerCommand()} local-models enable --base-dir <volume path>`,
          kind: "command",
        },
        secondary: [links.containers, links.cli],
      }
    : {
        body: `${intro} Then follow the CLI setup steps inside the container as the Linger user.`,
        primary: {
          kind: "docs",
          label: "CLI setup",
          path: "/local-models/cli",
        },
        secondary: [links.containers],
      };
}

function desktopSection(
  view: LocalModelsView,
  context: EmptyStateContext,
): EmptyStateSection {
  const c = view.computer.display_name;
  return context.desktopSetup
    ? {
        body: `Run AI models on this computer's ${gpuName(view.computer) ?? "GPU"}. Linger checks the hardware, downloads the model tools and recommends a model.`,
        primary: { kind: "desktopSetup" },
        secondary: [links.requirements],
      }
    : {
        body: `On ${c}, open the Linger app and choose Set up local models in Settings › Local models.`,
        secondary: [links.desktop],
      };
}

function notSetUp(
  view: LocalModelsView,
  context: EmptyStateContext,
): EmptyStatePlan {
  const c = view.computer.display_name;
  const kind = view.computer.install_kind;
  if (view.computer.readiness.reason === "HARDWARE_UNKNOWN" || !kind)
    return {
      body: `Set them up the way ${c} was installed:`,
      secondary: [links.requirements],
      tabs: {
        cli: cliSection(view),
        container: containerSection(view),
        desktop: desktopSection(view, context),
      },
      title: `Local models aren't set up on ${c}`,
    };
  switch (kind) {
    case "desktop":
      return {
        ...desktopSection(view, context),
        title: context.desktopSetup
          ? `Set up local models on ${c}`
          : `Local models aren't set up on ${c}`,
      };
    case "cli":
      return { ...cliSection(view), title: `Set up local models on ${c}` };
    case "container":
      return {
        ...containerSection(view),
        title: `Set up local models in ${c}`,
      };
  }
}

/** Why the Computer's hardware falls short, from what it probed; empty when unknown. */
function hardwareShortfall(computer: Computer) {
  const accelerators = computer.accelerators;
  const c = computer.display_name;
  const reason = computer.readiness.reason;
  if (reason === "PLATFORM_UNSUPPORTED")
    return computer.platform === "darwin"
      ? ` ${c} has an Intel processor.`
      : "";
  if (!accelerators || accelerators.probe !== "ok")
    // Without a profile, the tool's last host is the only hardware fact; off
    // macOS it lists only NVIDIA GPUs.
    return computer.host &&
      computer.host.platform !== "darwin" &&
      !computer.host.gpus.length
      ? " No GPU was found."
      : "";
  if (accelerators.apple_silicon)
    return accelerators.unified_memory_bytes === undefined
      ? ""
      : ` ${c} has ${formatGigabytes(accelerators.unified_memory_bytes)}.`;
  const nvidia = accelerators.gpus.find((gpu) => gpu.vendor === "nvidia");
  if (nvidia)
    return nvidia.memory_bytes === undefined
      ? ""
      : ` ${nvidia.name} has ${formatGigabytes(nvidia.memory_bytes)}.`;
  const other = accelerators.gpus[0];
  return other ? ` ${other.name} isn't supported.` : " No GPU was found.";
}

function unsupportedHardware(view: LocalModelsView): EmptyStatePlan {
  const computer = view.computer;
  const c = computer.display_name;
  const mac =
    computer.platform === "darwin" ||
    computer.readiness.setup_path === "apple_silicon";
  if (computer.readiness.reason === "DISK_INSUFFICIENT")
    return {
      body: `None of the models fits the free disk on ${c}. Free up disk space there; this page updates when it reports again.`,
      secondary: [links.requirements],
      title: `${c} doesn't have enough free disk`,
    };
  if (mac)
    return {
      body: `Local models run on Apple silicon's GPU and need at least 16 GB of unified memory.${hardwareShortfall(computer)} Agents on ${c} keep working with cloud models through Codex, Claude Code or Pi.`,
      secondary: [links.requirements],
      title: `${c} can't run local models`,
    };
  return {
    body: `Local models need an NVIDIA GPU with at least 8 GB of memory; they don't run on the CPU alone.${hardwareShortfall(computer)} Agents on ${c} keep working with cloud models.`,
    secondary:
      computer.install_kind === "container"
        ? [links.requirements, links.containers]
        : [links.requirements],
    title: `${c} has no supported GPU`,
  };
}

/** The installer for the Computer's platform, or the manual steps when there is none to show. */
function installAction(computer: Computer): EmptyStateAction {
  return computer.platform
    ? { command: computerInstallCommand(computer.platform), kind: "command" }
    : {
        kind: "docs",
        label: "See the steps",
        path: "/install/reinstall-legacy",
      };
}

function needsReinstall(view: LocalModelsView): EmptyStatePlan {
  const computer = view.computer;
  const c = computer.display_name;
  const v = versionNote(computer);
  switch (computer.readiness.reason) {
    case "DAEMON_LEGACY":
      // The Windows installer does not move a Simplex-era install yet; run
      // there, it would connect a second Computer beside the old one.
      return computer.platform === "win32" || !computer.platform
        ? {
            body: `${c} runs a version from before Simplex became Linger${v} and can't update itself. Follow the steps to move it once; it keeps its name, Agents and Workspaces.`,
            primary: {
              kind: "docs",
              label: "See the steps",
              path: "/install/reinstall-legacy",
            },
            secondary: [links.updating],
            title: `Move ${c} to Linger`,
          }
        : {
            body: `${c} runs a version from before Simplex became Linger${v} and can't update itself. Run the install command on ${c} once. It waits until ${c} is idle, moves it to the current version and keeps its name, Agents and Workspaces.`,
            primary: installAction(computer),
            secondary: [links.manualSteps, links.updating],
            title: `Move ${c} to Linger`,
          };
    case "UPDATE_FAILED":
      return {
        body: `It hasn't been able to update to the current Linger version. Run the install command on ${c} to reinstall it; it keeps its name and Agents.`,
        primary: installAction(computer),
        secondary: [links.updating],
        title: `${c} couldn't update`,
      };
    default:
      return {
        body: `This version${v} can no longer connect. Run the install command on ${c}; it keeps its name and Agents.`,
        primary: installAction(computer),
        secondary: [links.manualSteps, links.updating],
        title: `Reinstall Linger on ${c}`,
      };
  }
}

function needsAttention(view: LocalModelsView): EmptyStatePlan {
  const computer = view.computer;
  const c = computer.display_name;
  const repairable =
    computer.readiness.enable_command && computer.install_kind !== "desktop";
  return {
    body: `The model tools on ${c} didn't answer. Check again; if it keeps happening, repair them.`,
    primary: { kind: "refresh" },
    secondary: repairable
      ? [
          {
            command: `${computerCommand()} local-models enable --repair`,
            kind: "command",
            label: "Repair",
          },
          links.troubleshooting,
        ]
      : [links.troubleshooting],
    title: `Couldn't read the local models on ${c}`,
  };
}

function managedElsewhere(view: LocalModelsView): EmptyStatePlan {
  const c = view.computer.display_name;
  const managedBy = view.computer.managed_by;
  const label = managedBy?.label ?? "another computer";
  return {
    body: `Its Agents use models served by ${label}. Manage downloads and loading there.`,
    primary: managedBy?.computer_id
      ? {
          computerId: managedBy.computer_id,
          kind: "open",
          label: `Open ${managedBy.label}`,
        }
      : undefined,
    secondary: [links.remote],
    title: `${c} uses models from ${label}`,
  };
}

const plans: Record<
  EmptyStateKind,
  (view: LocalModelsView, context: EmptyStateContext) => EmptyStatePlan
> = {
  checking: (view) => ({
    body: "",
    secondary: [],
    spinner: true,
    title: `Checking local models on ${view.computer.display_name}`,
  }),
  managed_elsewhere: managedElsewhere,
  needs_attention: needsAttention,
  needs_reinstall: needsReinstall,
  needs_update: (view) => ({
    body: `Its Linger version${versionNote(view.computer)} can't report local models yet. It updates itself within the hour; this page refreshes when it does. Desktop app: update Linger from the tray menu.`,
    secondary: [links.updating],
    title: `${view.computer.display_name} is updating`,
  }),
  not_reported: (view) => ({
    body: `It's connected but hasn't sent its model list. Restart Linger on ${view.computer.display_name}.`,
    secondary: [links.troubleshooting],
    title: `${view.computer.display_name} hasn't reported local models`,
  }),
  not_set_up: notSetUp,
  unsupported_hardware: unsupportedHardware,
};

/** States an offline Computer without a snapshot can't say more about than that it is offline. */
const offlineStates = new Set<ReadinessState>([
  "checking",
  "needs_update",
  "not_reported",
]);

/** Whether the page lists the Computer's models instead of an empty state. */
export function listsModels(view: LocalModelsView) {
  return view.available && libraryStates.has(view.computer.readiness.state);
}

/**
 * The empty state the library page shows instead of the model list, from the
 * readiness TeamHub decided. Only the owner gets commands, buttons, links and
 * Technical details.
 */
export function emptyStatePlan(
  view: LocalModelsView,
  context: EmptyStateContext,
): EmptyStatePlan {
  const { computer } = view;
  const state = computer.readiness.state;
  const c = computer.display_name;
  if (
    computer.status === "offline" &&
    !view.observed_at &&
    offlineStates.has(state)
  )
    return {
      body: "Its local models show here once it reconnects.",
      secondary: view.viewer_is_owner
        ? [{ kind: "computers", label: "Computers" }]
        : [],
      title: `${c} is offline`,
    };
  // A library state without a usable library can only be a stale read.
  const kind: EmptyStateKind = isEmptyStateKind(state) ? state : "not_reported";
  const plan = plans[kind](view, context);
  if (view.viewer_is_owner)
    return view.reason?.detail ? { ...plan, detail: view.reason.detail } : plan;
  const ask = ownerAsks[kind];
  return ask === null
    ? {
        body: plan.body,
        secondary: [],
        spinner: plan.spinner,
        title: plan.title,
      }
    : {
        body: `Only ${computer.owner.display_name} can set up local models on ${c}. Ask them to ${ask}.`,
        secondary: [],
        title: plan.title,
      };
}

function isEmptyStateKind(state: ReadinessState): state is EmptyStateKind {
  return !libraryStates.has(state);
}
