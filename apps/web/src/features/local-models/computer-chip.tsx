import {
  AppleIcon,
  ComputerIcon,
  ComputerTerminal01Icon,
  CubeIcon,
  WindowsNewIcon,
} from "@hugeicons/core-free-icons";

import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";

import { type ChipDot, computerChip } from "./computer-picker-rules";
import type { LocalModelsComputerSummary } from "./local-models-queries";

const dotClasses: Record<ChipDot, string> = {
  danger: "bg-app-danger",
  info: "bg-app-info",
  neutral: "bg-muted-foreground/60",
  success: "bg-app-success",
  warning: "bg-app-warning",
};

/** The Computer's readiness as a status word with its dot, muted when not usable. */
export function ComputerChip({
  computer,
  id,
}: {
  computer: LocalModelsComputerSummary;
  id?: string;
}) {
  const chip = computerChip(computer);
  return (
    <span
      className={cn(
        "flex min-w-0 shrink-0 items-center gap-1.5 text-xs",
        chip.muted ? "text-muted-foreground" : "text-foreground",
      )}
      data-state={computer.readiness.state}
      id={id}
    >
      {chip.dot ? (
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", dotClasses[chip.dot])}
        />
      ) : null}
      <span className={cn("truncate", chip.working && "town-shimmer-text")}>
        {chip.offline ? `${chip.offline} · ` : null}
        {chip.label}
      </span>
    </span>
  );
}

/** A 14px glyph for the Computer's platform, or a box for a container. */
export function PlatformGlyph({
  computer,
}: {
  computer: Pick<LocalModelsComputerSummary, "install_kind" | "platform">;
}) {
  const icon =
    computer.install_kind === "container"
      ? CubeIcon
      : computer.platform === "darwin"
        ? AppleIcon
        : computer.platform === "win32"
          ? WindowsNewIcon
          : computer.platform === "linux"
            ? ComputerTerminal01Icon
            : ComputerIcon;
  return (
    <Icon className="shrink-0 text-muted-foreground" icon={icon} size={14} />
  );
}
