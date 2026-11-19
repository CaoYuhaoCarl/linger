import { useState } from "react";

import { Button } from "@/components/ui/button";
import { FormFeedback } from "@/components/ui/form-feedback";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { sourceCheckClassName } from "@/features/settings/provider-selection-picker";
import { cn } from "@/lib/cn";

import {
  isAgentUsingModel,
  type LocalModelAssignableAgent,
} from "./local-model-agents";
import type { LocalModelsView } from "./local-models-queries";
import {
  agentNames,
  formatGigabytes,
  makeRoomSelection,
  makesRoom,
  poolLabel,
  poolOf,
  type LoadCheck,
  type ModelEntry,
} from "./local-models-rules";

/** The amber notice naming the Agents that stop answering. */
function AffectedAgents({
  entry,
  until,
}: {
  entry: ModelEntry;
  until: string;
}) {
  const count = entry.used_by.length;
  return count ? (
    <FormFeedback tone="warning">
      {agentNames(entry)} {count === 1 ? "uses" : "use"} this model and
      can&apos;t answer until {until}.
    </FormFeedback>
  ) : (
    <p className="text-sm text-muted-foreground">No Agent uses this model.</p>
  );
}

/** Loading would overfill the pool: offer to unload loaded models first. */
export function MakeRoomDialog({
  assignableAgents = [],
  check,
  disabled,
  entry,
  onClose,
  onConfirm,
  primaryAgent,
  view,
}: {
  assignableAgents?: readonly LocalModelAssignableAgent[];
  check: LoadCheck;
  /** The model can no longer be loaded, or its Computer took no actions. */
  disabled: boolean;
  entry: ModelEntry;
  onClose: () => void;
  onConfirm: (unloadIds: string[], switchAgentIds: string[]) => void;
  primaryAgent?: LocalModelAssignableAgent;
  view: LocalModelsView;
}) {
  const [selected, setSelected] = useState(() => makeRoomSelection(check));
  const [switchOverride, setSwitchOverride] = useState<boolean | null>(null);
  const chosen = new Set(selected);
  const enough = makesRoom(check, chosen);
  const computerId = view.computer.computer_id;
  const chosenLoaded = check.loaded.filter((item) => chosen.has(item.model.id));
  const affectedAssignable = assignableAgents.filter(
    (agent) =>
      !agent.busy &&
      chosenLoaded.some(
        (item) =>
          isAgentUsingModel(agent, computerId, item.model.pi_model) ||
          item.used_by.some((user) => user.agent_id === agent.actorId),
      ),
  );
  const affected = [
    ...new Set([
      ...chosenLoaded.flatMap((item) => item.used_by.map((user) => user.name)),
      ...affectedAssignable.map((agent) => agent.name),
    ]),
  ];
  const switchTargets = affectedAssignable.length
    ? affectedAssignable
    : primaryAgent &&
        !primaryAgent.busy &&
        !isAgentUsingModel(primaryAgent, computerId, entry.model.pi_model)
      ? [primaryAgent]
      : [];
  const defaultSwitch = affectedAssignable.length > 0;
  const showSwitchOption =
    check.loaded.length > 0 && selected.length > 0 && switchTargets.length > 0;
  const switchChecked = switchOverride ?? defaultSwitch;
  const switchLabel = switchTargets.map((agent) => agent.name).join(", ");

  return (
    <ModalDialog
      description={`${entry.model.name} needs ${formatGigabytes(check.needBytes)} on ${poolLabel(view, check.pool)}; ${formatGigabytes(check.freeBytes)} is free.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            disabled={disabled || !enough}
            onClick={() =>
              onConfirm(
                selected,
                showSwitchOption && switchChecked
                  ? switchTargets.map((agent) => agent.actorId)
                  : [],
              )
            }
            tone="primary"
          >
            {selected.length ? "Unload and load" : "Load"}
          </Button>
        </>
      }
      onClose={onClose}
      size="md"
      title="Make room to load"
    >
      <div className="grid gap-3 px-5 py-4">
        {check.loaded.length ? (
          <fieldset className="grid gap-0.5">
            <legend className="mb-1.5 text-sm text-muted-foreground">
              Unload these to free memory:
            </legend>
            {check.loaded.map((item) => (
              <label
                className={cn(
                  "flex min-h-10 cursor-pointer items-center gap-2 rounded-sm px-2 text-sm transition-colors duration-150 motion-reduce:transition-none",
                  chosen.has(item.model.id)
                    ? "bg-app-selected text-app-ink"
                    : "text-app-body hover:bg-app-hover",
                )}
                key={item.model.id}
              >
                <input
                  checked={chosen.has(item.model.id)}
                  className={sourceCheckClassName}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, item.model.id]
                        : current.filter((id) => id !== item.model.id),
                    )
                  }
                  type="checkbox"
                />
                <span className="min-w-0 flex-1 truncate">
                  {item.model.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {item.used_by.length
                    ? `Used by ${agentNames(item)}`
                    : "Not used"}
                </span>
                <span className="w-16 text-right text-xs tabular-nums text-muted-foreground">
                  {formatGigabytes(item.model.memory_bytes)}
                </span>
              </label>
            ))}
          </fieldset>
        ) : (
          <FormFeedback tone="danger">
            Nothing else is loaded there. This model doesn&apos;t fit even when
            the memory is empty.
          </FormFeedback>
        )}
        {affected.length ? (
          <FormFeedback tone="warning">
            {affected.join(", ")} can&apos;t answer until their model is loaded
            again.
          </FormFeedback>
        ) : null}
        {showSwitchOption ? (
          <label className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-foreground transition-colors duration-150 hover:bg-muted/70 motion-reduce:transition-none">
            <input
              checked={switchChecked}
              className={sourceCheckClassName}
              onChange={(event) => setSwitchOverride(event.target.checked)}
              type="checkbox"
            />
            <span>
              Switch {switchLabel} to {entry.model.name} once loaded
            </span>
          </label>
        ) : null}
      </div>
    </ModalDialog>
  );
}

/** Unloading a model an Agent uses stops that Agent, so it asks first. */
export function UnloadModelDialog({
  disabled,
  entry,
  onClose,
  onConfirm,
  view,
}: {
  /** The action no longer applies, or its Computer takes no actions. */
  disabled: boolean;
  entry: ModelEntry;
  onClose: () => void;
  onConfirm: () => void;
  view: LocalModelsView;
}) {
  const pool = poolOf(view, entry.model.pool);
  return (
    <ModalDialog
      description={`Frees ${formatGigabytes(entry.model.memory_bytes)} of ${
        pool ? poolLabel(view, pool) : "memory"
      }. It stays on disk, so you can load it again later.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button disabled={disabled} onClick={onConfirm} tone="primary">
            Unload
          </Button>
        </>
      }
      onClose={onClose}
      size="sm"
      title={`Unload ${entry.model.name}?`}
    >
      <div className="px-5 py-4">
        <AffectedAgents entry={entry} until="it is loaded again" />
      </div>
    </ModalDialog>
  );
}

export function RemoveModelDialog({
  disabled,
  entry,
  onClose,
  onConfirm,
  view,
}: {
  /** The action no longer applies, or its Computer takes no actions. */
  disabled: boolean;
  entry: ModelEntry;
  onClose: () => void;
  onConfirm: () => void;
  view: LocalModelsView;
}) {
  return (
    <ModalDialog
      description={`${
        entry.status === "loaded"
          ? "Unloads it, deletes its files"
          : "Deletes its files"
      } and frees ${formatGigabytes(entry.model.download_bytes)} of disk on ${view.computer.display_name}. You can download it again later.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button disabled={disabled} onClick={onConfirm} tone="danger">
            Remove
          </Button>
        </>
      }
      onClose={onClose}
      size="sm"
      title={`Remove ${entry.model.name}?`}
    >
      <div className="px-5 py-4">
        <AffectedAgents
          entry={entry}
          until={`you choose another model for ${entry.used_by.length === 1 ? "it" : "them"}`}
        />
      </div>
    </ModalDialog>
  );
}
