import { AiChipIcon } from "@hugeicons/core-free-icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useRef, useState } from "react";
import { Link } from "react-router";

import { Button, buttonClassName } from "@/components/ui/button";
import { FormFeedback } from "@/components/ui/form-feedback";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { UnderlineTabs } from "@/components/ui/underline-tabs";
import { CopyValueButton } from "@/features/local-computer/computer-setup-instructions";
import { useDesktopComputer } from "@/features/local-computer/desktop-computer";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";

import { actionErrorCopy } from "./local-models-copy";
import {
  docsUrl,
  type EmptyStateAction,
  type EmptyStateLink,
  emptyStatePlan,
  type EmptyStateSection,
  type SetupTab,
} from "./local-models-empty-state-copy";
import {
  localModelsQueryKey,
  type LocalModelsView,
  refreshLocalComputerModels,
} from "./local-models-queries";

// The desktop shell's local-models setup (`window.lingerDesktop.localModels`).
// Only a desktop app that ships the kit-only setup exposes it.
interface DesktopLocalModelsApi {
  setup(): Promise<unknown>;
}

function desktopLocalModels(): DesktopLocalModelsApi | undefined {
  return typeof window === "undefined"
    ? undefined
    : (window as { lingerDesktop?: { localModels?: DesktopLocalModelsApi } })
        .lingerDesktop?.localModels;
}

export function computersPath(tenantId: string) {
  return `/t/${tenantId}/settings/computers`;
}

/** The library page's centered empty state: chip icon, title, body, then any actions. */
export function EmptyState({
  action,
  children,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  title: string;
}) {
  return (
    <section
      aria-label={title}
      className="mt-6 flex flex-col items-center px-4 pt-12 text-center"
    >
      <span className="flex size-16 items-center justify-center rounded-[20%] bg-muted text-foreground">
        <Icon icon={AiChipIcon} size={28} />
      </span>
      <h2 className="mt-6 text-xl">{title}</h2>
      {children ? (
        <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
          {children}
        </p>
      ) : null}
      {action}
    </section>
  );
}

const tabLabels: Record<SetupTab, string> = {
  cli: "Terminal",
  container: "Container",
  desktop: "Desktop app",
};
const tabOrder: SetupTab[] = ["desktop", "cli", "container"];

/**
 * What a Computer whose library the page doesn't list needs, from the
 * readiness TeamHub decided: one primary action, docs links, and the
 * Computer's diagnostic detail for its owner only, collapsed.
 */
export function ReadinessEmptyState({
  tenantId,
  view,
}: {
  tenantId: string;
  view: LocalModelsView;
}) {
  const desktop = useDesktopComputer();
  const [desktopApi] = useState(desktopLocalModels);
  const computerId = view.computer.computer_id;
  const onThisComputer = desktop?.status?.computerId === computerId;
  const plan = emptyStatePlan(view, {
    desktopSetup: Boolean(desktopApi) && onThisComputer,
  });
  const [tab, setTab] = useState<SetupTab>(onThisComputer ? "desktop" : "cli");
  const section = plan.tabs ? plan.tabs[tab] : undefined;

  return (
    <EmptyState
      action={
        <div className="mt-6 flex w-full max-w-md flex-col items-center gap-4">
          {plan.spinner ? (
            <span className="text-muted-foreground" role="status">
              <Spinner size={20} />
              <span className="sr-only">Checking</span>
            </span>
          ) : null}
          {plan.tabs && section ? (
            <div className="flex w-full flex-col items-center gap-4">
              <UnderlineTabs
                items={tabOrder.map((id) => ({ id, label: tabLabels[id] }))}
                label="How it was installed"
                onChange={setTab}
                value={tab}
              />
              <div
                aria-label={tabLabels[tab]}
                className="flex w-full flex-col items-center gap-4"
                role="tabpanel"
              >
                <p className="text-sm text-muted-foreground">{section.body}</p>
                <SectionActions
                  section={section}
                  tenantId={tenantId}
                  view={view}
                />
              </div>
            </div>
          ) : null}
          <SectionActions section={plan} tenantId={tenantId} view={view} />
          {plan.detail ? (
            <details className="w-full text-left text-xs text-muted-foreground">
              <summary className="cursor-pointer text-center">
                Technical details
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 font-mono">
                {plan.detail}
              </pre>
            </details>
          ) : null}
        </div>
      }
      title={plan.title}
    >
      {plan.body}
    </EmptyState>
  );
}

function SectionActions({
  section,
  tenantId,
  view,
}: {
  section: EmptyStateSection;
  tenantId: string;
  view: LocalModelsView;
}) {
  if (!section.primary && !section.secondary.length) return null;
  return (
    <>
      {section.primary ? (
        <PrimaryAction
          action={section.primary}
          tenantId={tenantId}
          view={view}
        />
      ) : null}
      {section.secondary.length ? (
        <ul className="flex w-full flex-col items-center gap-2 text-sm">
          {section.secondary.map((link) => (
            <li className="w-full" key={link.label}>
              <SecondaryLink link={link} tenantId={tenantId} />
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function PrimaryAction({
  action,
  tenantId,
  view,
}: {
  action: EmptyStateAction;
  tenantId: string;
  view: LocalModelsView;
}) {
  switch (action.kind) {
    case "command":
      return <CommandBlock command={action.command} />;
    case "desktopSetup":
      return <DesktopSetupButton />;
    case "docs":
      return (
        <a
          className={buttonClassName({ size: "compact", tone: "primary" })}
          href={docsUrl(action.path)}
          rel="noreferrer"
          target="_blank"
        >
          {action.label}
        </a>
      );
    case "open":
      return (
        <Link
          className={buttonClassName({ size: "compact", tone: "primary" })}
          to={{ search: `?computer=${encodeURIComponent(action.computerId)}` }}
        >
          {action.label}
        </Link>
      );
    case "refresh":
      return <CheckAgainButton tenantId={tenantId} view={view} />;
  }
}

function SecondaryLink({
  link,
  tenantId,
}: {
  link: EmptyStateLink;
  tenantId: string;
}) {
  const className =
    "text-muted-foreground underline underline-offset-2 hover:text-foreground";
  switch (link.kind) {
    case "command":
      return (
        <div className="flex flex-col items-center gap-1.5">
          <span className="text-xs text-muted-foreground">{link.label}</span>
          <CommandBlock command={link.command} />
        </div>
      );
    case "computers":
      return (
        <Link className={className} to={computersPath(tenantId)}>
          {link.label}
        </Link>
      );
    case "docs":
      return (
        <a
          className={className}
          href={docsUrl(link.path)}
          rel="noreferrer"
          target="_blank"
        >
          {link.label}
        </a>
      );
  }
}

function CommandBlock({ command }: { command: string }) {
  const commandRef = useRef<HTMLElement>(null);
  return (
    <div className="flex w-full min-w-0 items-center gap-1.5 rounded-lg border border-border bg-muted/60 px-2.5 py-2 text-left">
      <code
        className="workspace-scrollbar min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-foreground"
        ref={commandRef}
      >
        {command}
      </code>
      <CopyValueButton selectionTargetRef={commandRef} value={command} />
    </div>
  );
}

function DesktopSetupButton() {
  const [api] = useState(desktopLocalModels);
  const [failed, setFailed] = useState(false);
  if (!api) return null;
  return (
    <>
      <Button
        onClick={() => {
          setFailed(false);
          api.setup().catch(() => setFailed(true));
        }}
        size="compact"
        tone="primary"
      >
        Set up local models
      </Button>
      {failed ? (
        <FormFeedback tone="danger">
          The desktop app couldn't open local-models setup. Try again.
        </FormFeedback>
      ) : null}
    </>
  );
}

function CheckAgainButton({
  tenantId,
  view,
}: {
  tenantId: string;
  view: LocalModelsView;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const computerId = view.computer.computer_id;
  const refresh = useMutation({
    mutationFn: () => refreshLocalComputerModels(client, tenantId, computerId),
    // The new snapshot arrives as a local-models hint; a fresh read also
    // catches one that landed before the hint subscription saw it.
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: localModelsQueryKey(tenantId, computerId),
      }),
  });
  return (
    <>
      <Button
        disabled={view.computer.status === "offline"}
        loading={refresh.isPending}
        onClick={() => refresh.mutate()}
        size="compact"
        tone="primary"
      >
        Check again
      </Button>
      {refresh.isError ? (
        <FormFeedback tone="danger">
          {actionErrorCopy(
            refresh.error instanceof TeamHubError
              ? refresh.error.code
              : undefined,
          )}
        </FormFeedback>
      ) : null}
    </>
  );
}
