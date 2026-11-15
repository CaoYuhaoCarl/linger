import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useEffect, useState, type RefObject } from "react";

import { cn } from "@/lib/cn";

import { Button } from "./ui/button";
import type { DocumentHeading } from "./document-headings";

/** The rendered block a heading row points at, when it is on the page. */
function headingElement(root: HTMLElement, id: string): HTMLElement | null {
  const selector = `[data-id="${typeof CSS === "undefined" ? id : CSS.escape(id)}"]`;
  return root.querySelector<HTMLElement>(selector);
}

function scrollToHeading(
  root: HTMLElement | null,
  id: string,
  reduceMotion: boolean,
) {
  if (!root) return;
  headingElement(root, id)?.scrollIntoView({
    behavior: reduceMotion ? "auto" : "smooth",
    block: "start",
  });
}

/**
 * Keeps the highlight on the heading the reader is looking at. Each heading
 * block reports its own visibility, and the first visible one in document
 * order wins, so a short section between two long ones still lights up.
 */
function useActiveHeading(
  contentRef: RefObject<HTMLElement | null>,
  headings: DocumentHeading[],
) {
  const [activeHeadingId, setActiveHeadingId] = useState<string | undefined>(
    () => headings[0]?.id,
  );
  // The effect watches elements, so it depends on which headings exist and
  // their order, not on the array identity each render recreates.
  const headingOrder = headings.map((heading) => heading.id).join("|");
  useEffect(() => {
    const root = contentRef.current;
    const Observer = globalThis.IntersectionObserver;
    if (!root || !Observer) return;
    const order = headingOrder.split("|").filter(Boolean);
    const watched = new Map<Element, string>();
    for (const id of order) {
      const element = headingElement(root, id);
      if (element) watched.set(element, id);
    }
    if (watched.size === 0) return;
    const visible = new Set<string>();
    const observer = new Observer(
      (entries) => {
        for (const entry of entries) {
          const id = watched.get(entry.target);
          if (!id) continue;
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        const first = order.find((id) => visible.has(id));
        if (first) setActiveHeadingId(first);
      },
      // Ignore the bottom of the viewport so the highlight moves when a heading
      // reaches the top, not when the next one enters from below.
      { rootMargin: "0px 0px -60% 0px" },
    );
    for (const element of watched.keys()) observer.observe(element);
    return () => observer.disconnect();
  }, [contentRef, headingOrder]);
  return [activeHeadingId, setActiveHeadingId] as const;
}

export function DocumentTableOfContents({
  contentRef,
  headings,
  id,
  onClose,
}: {
  contentRef: RefObject<HTMLElement | null>;
  headings: DocumentHeading[];
  id?: string;
  onClose: () => void;
}) {
  const baseLevel = Math.min(...headings.map((heading) => heading.level), 6);
  const [activeHeadingId, setActiveHeadingId] = useActiveHeading(
    contentRef,
    headings,
  );
  return (
    <aside
      className="absolute inset-y-0 right-0 z-30 w-[min(300px,calc(100vw-24px))] border-l border-app-border bg-app-surface shadow-xl sm:relative sm:z-auto sm:shrink-0 sm:shadow-none"
      id={id}
    >
      <header className="flex h-12 items-center justify-between border-b border-app-border/60 px-3">
        <h3 className="text-sm font-semibold">Table of contents</h3>
        <Button
          aria-label="Close table of contents"
          onClick={onClose}
          size="icon"
          tone="ghost"
        >
          <Icon icon={Cancel01Icon} />
        </Button>
      </header>
      <nav
        aria-label="Document table of contents"
        className="workspace-scrollbar h-[calc(100%-48px)] overflow-y-auto p-2"
      >
        {headings.length === 0 ? (
          <p className="px-2 py-6 text-sm text-app-muted">No headings</p>
        ) : (
          headings.map((heading) => {
            const active = heading.id === activeHeadingId;
            return (
              <button
                aria-current={active ? "location" : undefined}
                className={cn(
                  "block h-8 w-full truncate rounded-lg px-2 text-left text-sm text-app-body transition-colors duration-300 hover:bg-muted/70 hover:text-app-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active && "bg-app-selected font-medium text-app-ink",
                )}
                key={heading.id}
                onClick={() => {
                  setActiveHeadingId(heading.id);
                  scrollToHeading(
                    contentRef.current,
                    heading.id,
                    window.matchMedia?.("(prefers-reduced-motion: reduce)")
                      ?.matches ?? false,
                  );
                }}
                style={{
                  paddingLeft: `${8 + (heading.level - baseLevel) * 12}px`,
                }}
                type="button"
              >
                {heading.text}
              </button>
            );
          })
        )}
      </nav>
    </aside>
  );
}
