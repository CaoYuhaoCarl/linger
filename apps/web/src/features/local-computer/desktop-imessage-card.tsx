import { useState, type FormEvent, type ReactNode } from "react";

import { Alert02Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { FormFeedback } from "@/components/ui/form-feedback";
import { Icon } from "@/components/ui/icon";
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowText,
} from "@/components/ui/settings-group";
import { Spinner } from "@/components/ui/spinner";

import {
  useDesktopIMessage,
  type DesktopIMessage,
  type DesktopIMessageStatus,
} from "./desktop-imessage";

const RUNTIME_ERROR: Record<
  NonNullable<DesktopIMessageStatus["runtimeError"]>,
  string
> = {
  download_failed: "The download failed. Check your network and retry.",
  checksum_mismatch: "The download was damaged. Retry.",
  extract_failed: "The download could not be unpacked. Retry.",
  executable_missing: "The download is incomplete. Retry.",
};

const BRIDGE_LINE: Record<DesktopIMessageStatus["bridge"], string | undefined> =
  {
    stopped: undefined,
    starting: "Connecting...",
    running: "Connected",
    signed_out: "Sign in to Linger to use iMessage",
    no_another_me: "Another Me is not set up yet",
    other_account:
      "Signed in to a different account. Turn iMessage off and on to use it with this account.",
    error: "Cannot reach Linger. Trying again...",
  };

function bridgeLine(status: DesktopIMessageStatus): string {
  return BRIDGE_LINE[status.bridge] ?? "Finish setup below";
}

// Chatting with Another Me from Messages; shown only in the macOS desktop app.
export function DesktopIMessageCard() {
  const imessage = useDesktopIMessage();
  if (!imessage?.status) return null;
  return <IMessageCard imessage={imessage} status={imessage.status} />;
}

function IMessageCard({
  imessage,
  status,
}: {
  imessage: DesktopIMessage;
  status: DesktopIMessageStatus;
}) {
  return (
    <div className="mt-8 flex flex-col gap-4">
      <SettingsGroup
        footer="Chat with Another Me from Messages on this Mac."
        label="iMessage"
      >
        <SettingsRow>
          {/* The bridge line wraps; SettingsRowText would truncate it. */}
          <span className="min-w-0 flex-1">
            <SettingsRowText title="Use iMessage" />
            {status.enabled ? (
              <span className="mt-px block text-xs leading-[17px] text-muted-foreground">
                {bridgeLine(status)}
              </span>
            ) : null}
          </span>
          <button
            aria-checked={status.enabled}
            aria-label="Use iMessage"
            className={`relative h-4 w-7 shrink-0 rounded-full shadow-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${status.enabled ? "bg-primary" : "bg-input"}`}
            disabled={imessage.pending}
            onClick={() => void imessage.set({ enabled: !status.enabled })}
            role="switch"
            type="button"
          >
            <span
              className={`absolute left-0 top-0.5 size-3 rounded-full bg-card shadow-sm transition-transform duration-150 ${status.enabled ? "translate-x-3.5" : "translate-x-0.5"}`}
            />
          </button>
        </SettingsRow>
      </SettingsGroup>
      {status.enabled ? (
        <>
          <HandlesEditor imessage={imessage} handles={status.handles} />
          <Checklist imessage={imessage} status={status} />
        </>
      ) : null}
      {imessage.error ? (
        <FormFeedback tone="danger">{imessage.error}</FormFeedback>
      ) : null}
    </div>
  );
}

function HandlesEditor({
  handles,
  imessage,
}: {
  handles: readonly string[];
  imessage: DesktopIMessage;
}) {
  const [draft, setDraft] = useState("");

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    if (await imessage.set({ handles: [...handles, draft] })) setDraft("");
  }

  return (
    <SettingsGroup
      footer="The phone numbers and Apple ID emails you message from. Messages from anyone else are ignored."
      label="Your handles"
    >
      {handles.map((handle) => (
        <SettingsRow key={handle}>
          <SettingsRowText title={handle} />
          <Button
            disabled={imessage.pending}
            onClick={() =>
              void imessage.set({
                handles: handles.filter((item) => item !== handle),
              })
            }
            size="compact"
            tone="ghost"
          >
            Remove
          </Button>
        </SettingsRow>
      ))}
      <SettingsRow>
        <form
          className="flex flex-1 items-center gap-2"
          onSubmit={(event) => void add(event)}
        >
          <input
            aria-label="Phone number or email"
            className="min-w-0 flex-1 bg-transparent text-[14px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none"
            onChange={(event) => setDraft(event.target.value)}
            placeholder="+1 415 555 0100 or name@icloud.com"
            value={draft}
          />
          <Button
            disabled={imessage.pending || !draft.trim()}
            size="compact"
            type="submit"
          >
            Add
          </Button>
        </form>
      </SettingsRow>
    </SettingsGroup>
  );
}

function Checklist({
  imessage,
  status,
}: {
  imessage: DesktopIMessage;
  status: DesktopIMessageStatus;
}) {
  return (
    <SettingsGroup label="Setup">
      <CheckRow
        done={status.runtime === "ready"}
        busy={status.runtime === "installing"}
        title="iMessage component"
        description={
          status.runtime === "ready"
            ? "Installed"
            : status.runtime === "installing"
              ? "Installing..."
              : status.runtime === "failed"
                ? RUNTIME_ERROR[status.runtimeError ?? "download_failed"]
                : "Installs when you turn on iMessage"
        }
        action={
          status.runtime === "failed" ? (
            <Button
              onClick={() => imessage.act("retry_install")}
              size="compact"
            >
              Retry
            </Button>
          ) : null
        }
      />
      <CheckRow
        done={status.fullDisk === "granted"}
        title="Full Disk Access"
        description={
          status.fullDisk === "granted"
            ? "Allowed"
            : status.fullDisk === "messagesNotSetUp"
              ? "Open Messages on this Mac once, then check again"
              : "Lets Linger read your messages"
        }
        action={
          status.fullDisk === "granted" ? null : (
            <Button
              onClick={() => imessage.act("open_full_disk_settings")}
              size="compact"
            >
              Open Settings
            </Button>
          )
        }
      />
      <CheckRow
        done={status.messagesAutomation === "granted"}
        title="Control Messages"
        description={
          status.messagesAutomation === "granted"
            ? "Allowed"
            : status.messagesAutomation === "denied"
              ? "Turn on Messages for Linger under Automation"
              : "Lets Linger send replies"
        }
        action={
          status.messagesAutomation ===
          "granted" ? null : status.messagesAutomation === "denied" ? (
            <Button
              onClick={() => imessage.act("open_automation_settings")}
              size="compact"
            >
              Open Settings
            </Button>
          ) : (
            <Button
              onClick={() => imessage.act("request_automation")}
              size="compact"
            >
              Allow
            </Button>
          )
        }
      />
      <CheckRow
        done={status.iMessageSignedIn === "yes"}
        title="Signed in to iMessage"
        description={
          status.iMessageSignedIn === "yes"
            ? "Signed in"
            : status.iMessageSignedIn === "no"
              ? "Sign in to iMessage in the Messages app"
              : "Checked once Linger can control Messages"
        }
      />
    </SettingsGroup>
  );
}

function CheckRow({
  action,
  busy = false,
  description,
  done,
  title,
}: {
  action?: ReactNode;
  busy?: boolean;
  description: string;
  done: boolean;
  title: string;
}) {
  return (
    <SettingsRow
      icon={
        busy ? (
          <Spinner size={14} />
        ) : (
          <Icon icon={done ? Tick02Icon : Alert02Icon} size={14} />
        )
      }
    >
      <SettingsRowText description={description} title={title} />
      {action}
    </SettingsRow>
  );
}
