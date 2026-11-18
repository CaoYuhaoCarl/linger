import { ArrowDown01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";

import { ComputerChip, PlatformGlyph } from "./computer-chip";
import { pickerGroups } from "./computer-picker-rules";
import type { LocalModelsComputerSummary } from "./local-models-queries";

type Computer = LocalModelsComputerSummary;

/** Above this many Computers the picker offers a search field. */
const SEARCH_THRESHOLD = 6;
const POPUP_WIDTH_PX = 320;
const VIEWPORT_GUTTER_PX = 8;

/**
 * The pill combobox that chooses one of the viewer's own Computers, grouped
 * as This computer, Yours online and Yours offline (collapsed).
 */
export function ComputerPicker({
  computers,
  onChoose,
  selectedId,
  thisComputerId,
}: {
  computers: readonly Computer[];
  onChoose: (computerId: string) => void;
  /** May name a Computer outside the list, such as another member's. */
  selectedId: string | undefined;
  thisComputerId: string | undefined;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupId = useId();
  const [open, setOpen] = useState(false);
  const selected = computers.find(
    (computer) => computer.computer_id === selectedId,
  );

  function close(focusTrigger = false) {
    setOpen(false);
    if (focusTrigger) requestAnimationFrame(() => triggerRef.current?.focus());
  }

  return (
    <>
      <button
        aria-controls={open ? popupId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Computer"
        className="select-pill min-w-0 text-left"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        ref={triggerRef}
        role="combobox"
        type="button"
      >
        {selected ? (
          <>
            <PlatformGlyph computer={selected} />
            <span className="min-w-0 truncate">{selected.display_name}</span>
            <span aria-hidden className="text-muted-foreground">
              ·
            </span>
            <ComputerChip computer={selected} />
          </>
        ) : (
          <span className="min-w-0 truncate text-muted-foreground">
            Your computers
          </span>
        )}
        <Icon
          className={cn(
            "shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
          icon={ArrowDown01Icon}
          size={14}
        />
      </button>
      {open ? (
        <PickerPopup
          computers={computers}
          id={popupId}
          onChoose={(computerId) => {
            close(true);
            if (computerId !== selectedId) onChoose(computerId);
          }}
          onClose={close}
          selectedId={selectedId}
          thisComputerId={thisComputerId}
          triggerRef={triggerRef}
        />
      ) : null}
    </>
  );
}

function PickerPopup({
  computers,
  id,
  onChoose,
  onClose,
  selectedId,
  thisComputerId,
  triggerRef,
}: {
  computers: readonly Computer[];
  id: string;
  onChoose: (computerId: string) => void;
  onClose: (focusTrigger?: boolean) => void;
  selectedId: string | undefined;
  thisComputerId: string | undefined;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [showOffline, setShowOffline] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const closePopup = useEffectEvent(onClose);
  const searchable = computers.length > SEARCH_THRESHOLD;
  const groups = pickerGroups(computers, thisComputerId, search);
  // A search reaches offline Computers without expanding the group.
  const offlineOpen = showOffline || search.trim() !== "";
  const visible = [
    ...(groups.thisComputer ? [groups.thisComputer] : []),
    ...groups.online,
    ...(offlineOpen ? groups.offline : []),
  ];
  const supportsPopover =
    typeof HTMLElement.prototype.showPopover === "function";

  useLayoutEffect(() => {
    const popup = popupRef.current;
    // The top layer escapes any clipping ancestor of the trigger.
    if (supportsPopover) popup?.showPopover();
    function place() {
      const trigger = triggerRef.current?.getBoundingClientRect();
      if (!trigger) return;
      const width = Math.min(
        POPUP_WIDTH_PX,
        window.innerWidth - 2 * VIEWPORT_GUTTER_PX,
      );
      const height = popupRef.current?.offsetHeight ?? 0;
      const below = trigger.bottom + 4;
      setPosition({
        // Right-aligned with the trigger, which sits at the header's end.
        left: Math.max(
          VIEWPORT_GUTTER_PX,
          Math.min(
            trigger.right - width,
            window.innerWidth - width - VIEWPORT_GUTTER_PX,
          ),
        ),
        top:
          below + height <= window.innerHeight - VIEWPORT_GUTTER_PX
            ? below
            : Math.max(VIEWPORT_GUTTER_PX, trigger.top - height - 4),
      });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      if (supportsPopover) popup?.hidePopover();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [supportsPopover, triggerRef, visible.length]);

  useEffect(() => {
    requestAnimationFrame(() => {
      if (searchRef.current) {
        searchRef.current.focus({ preventScroll: true });
        return;
      }
      const options = focusables(popupRef.current);
      (
        options.find(
          (option) => option.getAttribute("aria-selected") === "true",
        ) ?? options[0]
      )?.focus({ preventScroll: true });
    });
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !popupRef.current?.contains(target)
      )
        closePopup();
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [triggerRef]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    }
    if (event.key === "Tab") {
      onClose();
      return;
    }
    const direction =
      event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    const items = focusables(popupRef.current);
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next =
      current < 0
        ? direction > 0
          ? 0
          : items.length - 1
        : (current + direction + items.length) % items.length;
    items[next]?.focus();
  }

  const option = (computer: Computer) => (
    <ComputerOption
      computer={computer}
      key={computer.computer_id}
      idPrefix={id}
      onChoose={onChoose}
      selected={computer.computer_id === selectedId}
    />
  );

  return createPortal(
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- arrow keys move between the dialog's native search field and option buttons; Escape closes it
    <div
      aria-label="Choose a computer"
      className="dropdown-options z-[100] m-0 text-app-ink"
      id={id}
      onKeyDown={handleKeyDown}
      popover={supportsPopover ? "manual" : undefined}
      ref={popupRef}
      role="dialog"
      style={{
        inset: "auto",
        left: position.left,
        position: "fixed",
        top: position.top,
        width: `min(${POPUP_WIDTH_PX}px, calc(100vw - ${2 * VIEWPORT_GUTTER_PX}px))`,
      }}
    >
      {searchable ? (
        <label className="mb-1 flex items-center gap-2 border-b border-border px-2 pb-1.5 pt-1 text-sm">
          <Icon
            className="shrink-0 text-muted-foreground"
            icon={Search01Icon}
            size={14}
          />
          <input
            aria-label="Search computers"
            className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              if (visible[0]) onChoose(visible[0].computer_id);
            }}
            placeholder="Search computers"
            ref={searchRef}
            type="search"
            value={search}
          />
        </label>
      ) : null}
      <div
        aria-label="Your computers"
        className="dropdown-options-list workspace-scrollbar"
        role="listbox"
      >
        {groups.thisComputer ? (
          <OptionGroup label="This computer">
            {option(groups.thisComputer)}
          </OptionGroup>
        ) : null}
        {groups.online.length ? (
          <OptionGroup label="Yours, online">
            {groups.online.map(option)}
          </OptionGroup>
        ) : null}
        {offlineOpen && groups.offline.length ? (
          <OptionGroup label="Yours, offline">
            {groups.offline.map(option)}
          </OptionGroup>
        ) : null}
      </div>
      {!offlineOpen && groups.offline.length ? (
        <button
          className="dropdown-option justify-between text-muted-foreground"
          data-picker-item=""
          onClick={() => {
            setShowOffline(true);
            // The button unmounts with focus on it; keep focus in the popup
            // so the keyboard and Escape still reach it.
            const first = groups.offline[0]?.computer_id;
            requestAnimationFrame(() =>
              popupRef.current
                ?.querySelector<HTMLElement>(
                  `[data-computer-id="${CSS.escape(first ?? "")}"]`,
                )
                ?.focus(),
            );
          }}
          type="button"
        >
          Show {groups.offline.length} offline
          <Icon
            className="shrink-0 -rotate-90"
            icon={ArrowDown01Icon}
            size={14}
          />
        </button>
      ) : null}
      {visible.length === 0 && search.trim() ? (
        <p className="px-2 py-1.5 text-sm text-muted-foreground" role="status">
          No computers match
        </p>
      ) : null}
    </div>,
    document.body,
  );
}

function OptionGroup({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  const labelId = useId();
  return (
    <div aria-labelledby={labelId} role="group">
      <p
        className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
        id={labelId}
      >
        {label}
      </p>
      {children}
    </div>
  );
}

function ComputerOption({
  computer,
  idPrefix,
  onChoose,
  selected,
}: {
  computer: Computer;
  idPrefix: string;
  onChoose: (computerId: string) => void;
  selected: boolean;
}) {
  const chipId = `${idPrefix}-${computer.computer_id}-chip`;
  return (
    <button
      aria-describedby={chipId}
      aria-label={computer.display_name}
      aria-selected={selected}
      className="dropdown-option gap-2"
      data-computer-id={computer.computer_id}
      data-picker-item=""
      onClick={() => onChoose(computer.computer_id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onChoose(computer.computer_id);
        }
      }}
      role="option"
      tabIndex={-1}
      type="button"
    >
      <PlatformGlyph computer={computer} />
      <span className="min-w-0 flex-1 truncate">{computer.display_name}</span>
      <ComputerChip computer={computer} id={chipId} />
    </button>
  );
}

/** The options and the Show offline button, in page order. */
function focusables(popup: HTMLElement | null) {
  return popup
    ? [...popup.querySelectorAll<HTMLElement>("[data-picker-item]")]
    : [];
}
