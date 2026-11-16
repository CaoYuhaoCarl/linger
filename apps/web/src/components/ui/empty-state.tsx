import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

import { Icon, type IconSvgElement } from "./icon";

/**
 * The surface that stands in for a list or panel with nothing to show: what is
 * missing, why, and at most one way forward. Every empty list uses it so the
 * same absence reads the same way wherever it happens.
 */
export function EmptyState({
  action,
  className,
  detail,
  icon,
  title,
  tone = "muted",
}: {
  /** One way forward; a second action means the surface needs a redesign. */
  action?: { label: string; onSelect: () => void };
  /** Layout for the space the list would have filled. */
  className?: string;
  detail: string;
  icon: IconSvgElement;
  title: string;
  /** A failure that hides the list, rather than an empty one. */
  tone?: "danger" | "muted";
}) {
  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col items-center justify-center gap-1 px-6 text-center",
        className,
      )}
      role={tone === "danger" ? "alert" : "status"}
    >
      <span className="mb-2 grid size-10 place-items-center rounded-xl bg-(--app-field-surface) text-muted-foreground shadow-outline">
        <Icon icon={icon} size={20} />
      </span>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p
        className={cn(
          "text-sm",
          tone === "danger" ? "text-app-danger" : "text-muted-foreground",
        )}
      >
        {detail}
      </p>
      {action ? (
        <button
          className="mt-3 h-8 rounded-full border border-border px-3 text-xs font-medium text-foreground transition-colors duration-150 hover:border-foreground/15 hover:bg-accent"
          onClick={action.onSelect}
          type="button"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

/**
 * A quiet line where a section would list something it has none of, so a
 * section that is empty never reads as a section that failed to load.
 */
export function EmptyNote({
  children,
  className,
  icon,
}: {
  children: ReactNode;
  className?: string;
  icon?: IconSvgElement;
}) {
  return (
    <p
      className={cn(
        "flex items-center gap-2 text-sm text-muted-foreground",
        className,
      )}
    >
      {icon ? <Icon icon={icon} size={16} /> : null}
      {children}
    </p>
  );
}
