import {
  AiChipIcon,
  Settings01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  lazy,
  type RefObject,
  Suspense,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Link, useInRouterContext } from "react-router";

import { Icon } from "@/components/ui/icon";
import { localComputersQueryOptions } from "@/features/local-computer/local-computer-queries";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { type TeamHubClient } from "@/features/teamhub/teamhub-client";
import type {
  TeamHubLocalComputerPage,
  TeamHubTenantAgent,
} from "@/features/teamhub/teamhub-types";
import type { AgentRuntimeUpdateInput } from "../members/edit-agent-runtime-dialog";
import {
  reasoningEffortLabel,
  useResolvedAgentModelLabel,
} from "../members/use-agent-model-selection";
const EditAgentRuntimeDialog = lazy(async () => ({
  default: (await import("../members/edit-agent-runtime-dialog"))
    .EditAgentRuntimeDialog,
}));
import { tenantAgentsQueryKey } from "../room-queries";
import "./direct-agent-model-switch.css";

type LocalComputer = TeamHubLocalComputerPage["items"][number];

const LOCAL_MODELS_LIBRARY_PREFIX = "localmodels-library/";
const MENU_GAP = 6;
const MENU_MARGIN = 8;
const DEFAULT_MENU_WIDTH = 248;
const MENU_ITEM_CLASS =
  "flex min-h-[33px] w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-foreground outline-none hover:bg-accent focus:bg-accent disabled:pointer-events-none disabled:opacity-50";

interface QuickLocalOption {
  computerId: string;
  computerName: string;
  grantId: string;
  modelId: string;
  label: string;
}

interface Props {
  client: TeamHubClient;
  currentActorId?: string;
  registration: TeamHubTenantAgent;
  tenantId: string;
  busy?: boolean;
}

export function DirectAgentModelSwitch(props: Props) {
  const { currentActorId, registration } = props;
  if (!currentActorId || registration.created_by.id !== currentActorId)
    return null;
  return <RuntimeSettingsEntry {...props} />;
}

function buildQuickLocalOptions(
  computers: readonly LocalComputer[] | undefined,
  registration: TeamHubTenantAgent,
): QuickLocalOption[] {
  if (!computers?.length) return [];
  const placement = registration.runtime.placement;
  const options: QuickLocalOption[] = [];
  const seen = new Set<string>();
  for (const computer of computers) {
    if (computer.status !== "online" || computer.upgrade_required) continue;
    const retainedGrant =
      placement?.type === "local" &&
      placement.computer_id === computer.computer_id &&
      placement.workspace_grant_id
        ? computer.workspace_grants.find(
            (grant) =>
              grant.grant_id === placement.workspace_grant_id &&
              grant.mode === "workspace-write",
          )
        : undefined;
    const grant =
      retainedGrant ??
      computer.workspace_grants.find((item) => item.mode === "workspace-write");
    if (!grant) continue;
    const piRuntime = computer.runtimes.find(
      (runtime) => runtime.type === "pi" && runtime.status === "ready",
    );
    if (!piRuntime) continue;
    for (const model of piRuntime.models) {
      if (!model.id.startsWith(LOCAL_MODELS_LIBRARY_PREFIX)) continue;
      const key = `${computer.computer_id}\0${model.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({
        computerId: computer.computer_id,
        computerName: computer.display_name,
        grantId: grant.grant_id,
        modelId: model.id,
        label: model.label || model.id,
      });
    }
  }
  return options;
}

function isSameTarget(
  option: QuickLocalOption,
  registration: TeamHubTenantAgent,
): boolean {
  const placement = registration.runtime.placement;
  return (
    placement?.type === "local" &&
    placement.runtime_type === "pi" &&
    placement.computer_id === option.computerId &&
    registration.runtime.model === option.modelId
  );
}

function computePopoverPosition(
  triggerRect: DOMRect,
  menuRect: DOMRect | undefined,
): { left: number; top: number; side: "top" | "bottom" } {
  const width = menuRect?.width || DEFAULT_MENU_WIDTH;
  const height = menuRect?.height || 0;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.max(
    MENU_MARGIN,
    Math.min(triggerRect.left, vw - width - MENU_MARGIN),
  );
  const above = triggerRect.top - MENU_GAP - height;
  const openBelow = height > 0 && above < MENU_MARGIN;
  const rawTop = openBelow ? triggerRect.bottom + MENU_GAP : above;
  const top = Math.max(
    MENU_MARGIN,
    Math.min(rawTop, vh - height - MENU_MARGIN),
  );
  return { left, top, side: openBelow ? "bottom" : "top" };
}

function RuntimeSettingsEntry({ client, registration, tenantId, busy }: Props) {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const computersQuery = useQuery(localComputersQueryOptions(client, tenantId));
  const quickLocalOptions = buildQuickLocalOptions(
    computersQuery.data?.items,
    registration,
  );
  const hasAlternatives = quickLocalOptions.some(
    (opt) => !isSameTarget(opt, registration),
  );
  const showMenu = menuOpen && hasAlternatives;

  const effort = registration.runtime.reasoning_effort;
  const label = useResolvedAgentModelLabel({
    client,
    computers: computersQuery.data?.items,
    registration,
    tenantId,
  });
  const update = useMutation({
    mutationFn: (input: AgentRuntimeUpdateInput) =>
      teamHubData(
        client.api.PATCH("/v0/tenants/{tenantId}/agents/{agentId}", {
          params: { path: { tenantId, agentId: registration.actor.id } },
          body: {
            ...input,
            expected_configuration_revision:
              registration.configuration_revision,
          },
        }),
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        tenantAgentsQueryKey(tenantId),
        (current: { items: TeamHubTenantAgent[] } | undefined) =>
          current
            ? {
                ...current,
                items: current.items.map((item) =>
                  item.actor.id === updated.actor.id
                    ? { ...item, ...updated }
                    : item,
                ),
              }
            : current,
      );
      void queryClient.invalidateQueries({
        queryKey: tenantAgentsQueryKey(tenantId),
      });
      setDialogOpen(false);
      setMenuOpen(false);
    },
  });

  function openRuntimeDialog() {
    setMenuOpen(false);
    update.reset();
    setDialogOpen(true);
  }

  function handleTriggerClick() {
    if (!hasAlternatives) {
      openRuntimeDialog();
      return;
    }
    setMenuOpen((current) => !current);
  }

  function handleQuickSelect(opt: QuickLocalOption) {
    if (busy || update.isPending || isSameTarget(opt, registration)) return;
    setMenuOpen(false);
    update.reset();
    update.mutate({
      runtime: {
        model: opt.modelId,
        placement: {
          computer_id: opt.computerId,
          runtime_type: "pi",
          type: "local",
          workspace_grant_id: opt.grantId,
        },
        ...(registration.runtime.reasoning_effort
          ? { reasoning_effort: registration.runtime.reasoning_effort }
          : {}),
      },
    });
  }

  return (
    <div className="agent-model-switch">
      <button
        aria-expanded={hasAlternatives ? showMenu : dialogOpen}
        aria-haspopup={hasAlternatives ? "menu" : "dialog"}
        className="agent-model-switch-trigger"
        onClick={handleTriggerClick}
        ref={triggerRef}
        type="button"
      >
        <span className="agent-model-switch-trigger-label">{label}</span>
        {/* A long model label shortens with an ellipsis; the effort stays. */}
        {effort ? (
          <>
            {" "}
            <span className="agent-model-switch-trigger-effort">
              {reasoningEffortLabel(effort)}
            </span>
          </>
        ) : null}
      </button>
      {!dialogOpen && update.error ? (
        <span
          className="ml-2 max-w-[240px] truncate text-xs text-app-danger"
          role="alert"
          title={update.error.message}
        >
          {update.error.message}
        </span>
      ) : null}
      {showMenu ? (
        <QuickLocalModelMenu
          busy={busy}
          isPending={update.isPending}
          onClose={() => setMenuOpen(false)}
          onOpenRuntimeSettings={openRuntimeDialog}
          onSelect={handleQuickSelect}
          options={quickLocalOptions}
          registration={registration}
          tenantId={tenantId}
          triggerRef={triggerRef}
        />
      ) : null}
      {dialogOpen ? (
        <Suspense
          fallback={
            <span role="status" className="text-xs text-app-muted">
              Loading settings…
            </span>
          }
        >
          <EditAgentRuntimeDialog
            client={client}
            registration={registration}
            tenantId={tenantId}
            busy={busy}
            isPending={update.isPending}
            error={update.error?.message}
            onClose={() => {
              if (!update.isPending) setDialogOpen(false);
            }}
            onSave={(input) => update.mutate(input)}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

interface QuickLocalModelMenuProps {
  busy?: boolean;
  isPending: boolean;
  onClose: () => void;
  onOpenRuntimeSettings: () => void;
  onSelect: (option: QuickLocalOption) => void;
  options: readonly QuickLocalOption[];
  registration: TeamHubTenantAgent;
  tenantId: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
}

function QuickLocalModelMenu({
  busy,
  isPending,
  onClose,
  onOpenRuntimeSettings,
  onSelect,
  options,
  registration,
  tenantId,
  triggerRef,
}: QuickLocalModelMenuProps) {
  const inRouter = useInRouterContext();
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const [menuSide, setMenuSide] = useState<"top" | "bottom">("top");
  const menuRef = useRef<HTMLDivElement>(null);

  const showComputerNames = options.some(
    (other) => other.computerId !== options[0]?.computerId,
  );
  const placement = registration.runtime.placement;
  const primaryComputerId =
    placement?.type === "local" &&
    options.some((opt) => opt.computerId === placement.computer_id)
      ? placement.computer_id
      : options[0]?.computerId;
  const localModelsHref = primaryComputerId
    ? `/t/${encodeURIComponent(tenantId)}/settings/local-models?computer=${encodeURIComponent(primaryComputerId)}`
    : undefined;

  useLayoutEffect(() => {
    const updatePosition = () => {
      const triggerRect = triggerRef.current?.getBoundingClientRect();
      if (!triggerRect) return;
      const next = computePopoverPosition(
        triggerRect,
        menuRef.current?.getBoundingClientRect(),
      );
      setPosition({ left: next.left, top: next.top });
      setMenuSide(next.side);
    };
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(updatePosition);
    if (menuRef.current) observer?.observe(menuRef.current);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
      observer?.disconnect();
    };
  }, [triggerRef]);

  const closeMenu = useEffectEvent(onClose);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const firstEnabled = menuRef.current?.querySelector<HTMLElement>(
        '[role="menuitem"]:not(:disabled)',
      );
      firstEnabled?.focus({ preventScroll: true });
    });
    const closeOutside = (event: Event) => {
      const target = event.target as Node | null;
      if (
        target &&
        !triggerRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        closeMenu();
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMenu();
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [triggerRef]);

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      triggerRef.current?.focus();
      return;
    }
    if (event.key === "Tab") {
      onClose();
      return;
    }
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    event.preventDefault();
    const enabled = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? [],
    );
    if (!enabled.length) return;
    if (event.key === "Home") {
      enabled[0]?.focus();
      return;
    }
    if (event.key === "End") {
      enabled[enabled.length - 1]?.focus();
      return;
    }
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const current = enabled.indexOf(document.activeElement as HTMLElement);
    const next =
      current < 0
        ? direction > 0
          ? 0
          : enabled.length - 1
        : (current + direction + enabled.length) % enabled.length;
    enabled[next]?.focus();
  }

  return createPortal(
    <>
      <div
        aria-hidden="true"
        className="app-menu-scrim"
        onPointerDown={onClose}
      />
      <div
        aria-label="Switch local model"
        className="town-dropdown-enter app-popover-card fixed z-[100] w-[248px] max-w-[calc(100vw-16px)] p-1"
        data-side={menuSide}
        onKeyDown={handleMenuKeyDown}
        ref={menuRef}
        role="menu"
        style={position}
        tabIndex={-1}
      >
        <div className="px-2 py-1 text-xs text-muted-foreground">
          Local models (Pi)
        </div>
        {busy ? (
          <p className="px-2 pb-1 text-xs text-muted-foreground">
            Wait for reply to finish
          </p>
        ) : null}
        {options.map((opt) => {
          const isCurrent = isSameTarget(opt, registration);
          return (
            <button
              className={MENU_ITEM_CLASS}
              disabled={busy || isPending || isCurrent}
              key={`${opt.computerId}:${opt.modelId}`}
              onClick={() => onSelect(opt)}
              role="menuitem"
              tabIndex={-1}
              type="button"
            >
              <span className="flex size-4 shrink-0 items-center justify-center text-foreground">
                {isCurrent ? <Icon icon={Tick02Icon} size={14} /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{opt.label}</span>
                {showComputerNames ? (
                  <span className="block truncate text-xs text-muted-foreground">
                    {opt.computerName}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
        <hr className="-mx-1 my-1 border-0 border-t border-border/60" />
        <button
          className={MENU_ITEM_CLASS}
          onClick={onOpenRuntimeSettings}
          role="menuitem"
          tabIndex={-1}
          type="button"
        >
          <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
            <Icon icon={Settings01Icon} size={14} />
          </span>
          <span className="truncate">Runtime settings…</span>
        </button>
        {inRouter && localModelsHref ? (
          <Link
            className={MENU_ITEM_CLASS}
            onClick={onClose}
            role="menuitem"
            tabIndex={-1}
            to={localModelsHref}
          >
            <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
              <Icon icon={AiChipIcon} size={14} />
            </span>
            <span className="truncate">Manage local models…</span>
          </Link>
        ) : null}
      </div>
    </>,
    document.body,
  );
}
