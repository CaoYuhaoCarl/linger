import {
  Cancel01Icon,
  Search01Icon,
  SentIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { useMemo, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { Spinner } from "@/components/ui/spinner";
import { idempotencyHeader, teamHubData } from "@/features/teamhub/teamhub-api";
import {
  createTeamHubIdempotencyKey,
  TeamHubError,
  type TeamHubClient,
} from "@/features/teamhub/teamhub-client";
import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";
import { tenantActorsQueryOptions } from "../room-queries";

type TargetKind = "agent" | "room";

interface ForwardTarget {
  id: string;
  label: string;
}

/** What an empty checklist means: a search that missed, or no one to pick. */
function emptyTargetsCopy(kind: TargetKind, searching: boolean) {
  if (kind === "room") {
    return searching ? "No matching rooms" : "No rooms available";
  }
  return searching ? "No matching agents" : "No agents available";
}

export function MessageForwardDialog({
  client,
  message,
  onClose,
  tenantId,
}: {
  client: TeamHubClient;
  message: TeamHubMessage;
  onClose: () => void;
  tenantId: string;
}) {
  const [kind, setKind] = useState<TargetKind>("agent");
  const [selected, setSelected] = useState<string[]>([]);
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actors = useQuery(tenantActorsQueryOptions(client, tenantId));
  const rooms = useQuery({
    queryFn: () =>
      teamHubData(
        client.api.GET("/v0/tenants/{tenantId}/rooms", {
          params: { path: { tenantId }, query: { limit: 100 } },
        }),
      ),
    queryKey: ["teamhub", tenantId, "message-forward-rooms"],
    staleTime: 60_000,
  });
  // The whole directory names the selected pills; only the checklist follows
  // the search, so a pill never falls back to a raw ID.
  const allTargets = useMemo(() => {
    const values: ForwardTarget[] = [];
    if (kind === "room") {
      for (const room of rooms.data?.items ?? []) {
        values.push({ id: room.id, label: room.name });
      }
    } else {
      for (const actor of actors.data?.items ?? []) {
        if (actor.kind === kind) {
          values.push({ id: actor.id, label: actor.display_name });
        }
      }
    }
    return values;
  }, [actors.data, kind, rooms.data]);
  const needle = query.trim().toLowerCase();
  const filteredTargets = needle
    ? allTargets.filter((target) => target.label.toLowerCase().includes(needle))
    : allTargets;
  const selectedSet = new Set(selected);
  const targetById = new Map(
    allTargets.map((target) => [target.id, target] as const),
  );
  // Only the list in view gates on its own query; a failure in either source
  // still surfaces where the user can retry it.
  const targetsPending = (kind === "room" ? rooms : actors).isPending;
  const targetsError = actors.isError || rooms.isError;

  async function forward() {
    if (!selected.length || sending) return;
    setSending(true);
    setError(null);
    try {
      await Promise.all(
        selected.map((targetId) =>
          teamHubData(
            client.api.POST("/v0/rooms/{roomId}/messages/{messageId}/forward", {
              params: {
                path: { roomId: message.room_id, messageId: message.id },
                header: idempotencyHeader(createTeamHubIdempotencyKey()),
              },
              body: { target: { id: targetId, kind } },
            }),
          ),
        ),
      );
      onClose();
    } catch (forwardError) {
      setError(
        forwardError instanceof TeamHubError && forwardError.status === 409
          ? "A target changed while forwarding. Refresh and try again."
          : "The message could not be forwarded. You may not have permission to share one of its documents.",
      );
    } finally {
      setSending(false);
    }
  }

  function retryTargets() {
    void actors.refetch();
    void rooms.refetch();
  }

  return (
    <ModalDialog
      closeOnBackdrop
      onClose={onClose}
      size="lg"
      title="Forward to"
      footer={
        <>
          <Button onClick={onClose} tone="ghost">
            Cancel
          </Button>
          <Button
            disabled={!selected.length}
            loading={sending}
            onClick={() => void forward()}
            tone="primary"
          >
            <Icon icon={SentIcon} size={16} /> Forward
          </Button>
        </>
      }
    >
      <div className="px-5 py-4">
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(searchInput);
          }}
        >
          <input
            aria-label="Search forward targets"
            className="h-11 min-w-0 flex-1 rounded-md border border-app-border px-3 text-sm outline-none focus:border-app-focus"
            onChange={(event) => setSearchInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") setQuery(searchInput);
            }}
            placeholder="Search"
            value={searchInput}
          />
          <Button
            aria-label="Search"
            size="icon"
            tone="secondary"
            type="submit"
          >
            <Icon icon={Search01Icon} size={16} />
          </Button>
        </form>
        <div
          aria-label="Forward target kind"
          className="mt-3 grid grid-cols-2 gap-2"
          role="group"
        >
          {(["agent", "room"] as const).map((targetKind) => (
            <Button
              aria-pressed={kind === targetKind}
              key={targetKind}
              onClick={() => {
                setKind(targetKind);
                setSelected([]);
              }}
              size="compact"
              tone={kind === targetKind ? "secondary" : "ghost"}
            >
              {targetKind === "agent" ? "Agents" : "Rooms"}
            </Button>
          ))}
        </div>
        {selected.length ? (
          <div
            aria-label="Selected forward targets"
            className="mt-3 flex flex-wrap gap-2"
          >
            {selected.map((targetId) => {
              const target = targetById.get(targetId);
              return (
                <button
                  aria-pressed="true"
                  className="inline-flex items-center gap-1 rounded-full bg-app-selected px-2.5 py-1 text-xs text-app-ink"
                  key={targetId}
                  onClick={() =>
                    setSelected((current) =>
                      current.filter((id) => id !== targetId),
                    )
                  }
                  title="Remove selected target"
                  type="button"
                >
                  <Icon icon={Tick02Icon} size={14} />{" "}
                  {target?.label ?? targetId}
                  <Icon icon={Cancel01Icon} size={14} />
                </button>
              );
            })}
          </div>
        ) : null}
        {targetsError ? (
          <div
            className="mt-3 flex items-center justify-between gap-3 rounded-md border border-app-border px-3 py-2"
            role="alert"
          >
            <p className="min-w-0 text-sm text-app-danger">
              Forward targets could not be loaded.
            </p>
            <Button onClick={retryTargets} size="compact" tone="secondary">
              Retry
            </Button>
          </div>
        ) : null}
        {targetsPending ? (
          <p
            className="mt-3 flex items-center gap-2 px-1 text-sm text-app-muted"
            role="status"
          >
            <Spinner size={16} />
            Loading targets…
          </p>
        ) : (
          <div className="mt-3 divide-y divide-app-border border-y border-app-border">
            {filteredTargets.map((target) => {
              const checked = selectedSet.has(target.id);
              return (
                <button
                  className="flex min-h-14 w-full items-center justify-between px-3 text-left hover:bg-app-hover"
                  key={target.id}
                  onClick={() =>
                    setSelected((current) =>
                      checked
                        ? current.filter((id) => id !== target.id)
                        : [...current, target.id],
                    )
                  }
                  type="button"
                >
                  <span className="text-sm text-app-ink">{target.label}</span>
                  <span className="text-xs text-app-muted">
                    {checked ? "Selected" : "Select"}
                  </span>
                </button>
              );
            })}
            {filteredTargets.length ? null : (
              <p className="px-3 py-6 text-center text-sm text-app-muted">
                {emptyTargetsCopy(kind, Boolean(needle))}
              </p>
            )}
          </div>
        )}
        {error ? (
          <p className="mt-3 text-sm text-app-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </ModalDialog>
  );
}
