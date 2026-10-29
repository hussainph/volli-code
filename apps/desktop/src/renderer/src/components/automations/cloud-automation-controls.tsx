import * as React from "react";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import {
  automationTriggerColumns,
  automationTriggerSchedule,
  TICKET_STATUS_LABELS,
  type Automation,
  type TicketStatus,
} from "@volli/shared";
import { useCloudPlacesStore } from "@renderer/lib/cloud-places";
import { toastError } from "@renderer/lib/toast";
import { guardWrite, useCanWrite } from "@renderer/components/hosts/use-hosts";
import { Button } from "@renderer/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { Switch } from "@renderer/components/ui/switch";
import {
  automationRunners,
  useCloudAutomationsStore,
} from "@renderer/stores/cloud-automations/state";
import {
  selectAutomations,
  selectColumnRank,
  useAutomationsStore,
} from "@renderer/stores/automations";
import { offeredAutomationsForColumn } from "@volli/shared";
import { useProjectUiStore } from "@renderer/stores/project-ui";

/** Only the signed-in person's capable runners, as vouched for by runners.list.
 * This Mac is the default, never the first teammate's/available machine. */
export function AutomationRunnerPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: string | null;
  onChange(value: string): void;
  disabled?: boolean;
}) {
  const all = useCloudAutomationsStore((state) => state.runners);
  const thisMac = useCloudPlacesStore((state) => state.thisRunnerId);
  const runners = automationRunners(all);
  const current = all.find((row) => row.id === (value ?? thisMac));
  const selected = runners.some((row) => row.id === value) ? value : null;
  return (
    <Select
      value={selected ?? ""}
      onValueChange={onChange}
      disabled={disabled || runners.length === 0}
    >
      <SelectTrigger aria-label="Automation runner" className="w-auto min-w-32 max-w-64 text-label">
        <SelectValue
          placeholder={
            selected === null &&
            current !== undefined &&
            !runners.some((row) => row.id === current.id)
              ? `Update Volli on ${current.name}`
              : "Choose a runner"
          }
        />
      </SelectTrigger>
      <SelectContent>
        {runners.map((row) => (
          <SelectItem
            key={row.id}
            value={row.id}
            disabled={row.status !== "online" && row.status !== "degraded"}
          >
            on {row.name}
            {row.id === thisMac ? " (this Mac)" : ""}
            {row.status === "online" ? "" : ` · ${row.status}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function CloudColumnArming({
  projectId,
  status,
}: {
  projectId: string;
  status: TicketStatus;
}) {
  const rows = useCloudAutomationsStore((state) => state.armings[projectId]);
  const arming = rows?.find((row) => row.status === status);
  const automations = useAutomationsStore((state) => selectAutomations(state, projectId));
  const rank = useAutomationsStore((state) => selectColumnRank(state, projectId, status));
  const offered = React.useMemo(
    () => offeredAutomationsForColumn(automations, status, rank),
    [automations, status, rank],
  );
  const thisMac = useCloudPlacesStore((state) => state.thisRunnerId);
  const [runner, setRunner] = React.useState<string | null>(null);
  const runnerId = runner ?? thisMac;
  const canWrite = useCanWrite(projectId);
  const [saving, setSaving] = React.useState(false);
  const paused = arming?.pausedAt != null;
  const name = automations.find((row) => row.id === arming?.automationId)?.name;
  const label =
    arming === undefined
      ? `Arm ${TICKET_STATUS_LABELS[status]}`
      : paused
        ? `${TICKET_STATUS_LABELS[status]} · Paused · Re-arm`
        : `${TICKET_STATUS_LABELS[status]} runs ${name ?? "Automation"} on ${arming.runnerName} · Armed by ${arming.armedByDisplayName}`;
  async function arm(automationId: string | null, onRunner = runnerId) {
    if (!guardWrite(projectId)) return;
    setSaving(true);
    try {
      const refusal = await useAutomationsStore.getState().arm({
        projectId,
        status,
        automationId,
        ...(onRunner === null ? {} : { runnerId: onRunner }),
      });
      if (refusal !== null) toastError(`Couldn’t arm this column: ${refusal}`);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="flex min-w-0 items-center gap-1">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!canWrite || saving}
            aria-label={label}
            data-column-arming={status}
            data-armed={arming?.automationId}
            data-arming-state={paused ? "paused" : arming === undefined ? "unarmed" : "ready"}
          >
            <LightningIcon weight={arming === undefined ? "regular" : "fill"} />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="flex w-64 flex-col gap-2">
          <span className="text-ui font-medium">Arrives in {TICKET_STATUS_LABELS[status]}</span>
          {arming === undefined ? null : (
            <span className="text-label text-muted-foreground">
              {paused ? "Paused · " : ""}Armed by {arming.armedByDisplayName} · on{" "}
              {arming.runnerName}
            </span>
          )}
          <AutomationRunnerPicker
            value={runnerId}
            onChange={setRunner}
            disabled={!canWrite || saving}
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={!canWrite || saving || arming === undefined}
            onClick={() => void arm(null)}
          >
            No Automation
          </Button>
          {offered.length === 0 ? (
            <span className="text-label text-muted-foreground">No automation is offered here</span>
          ) : (
            offered.map((row) => (
              <Button
                key={row.id}
                variant="ghost"
                size="sm"
                disabled={!canWrite || saving || runnerId === null}
                onClick={() => void arm(row.id)}
              >
                {paused && row.id === arming?.automationId ? "Re-arm " : ""}
                {row.name}
              </Button>
            ))
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => useProjectUiStore.getState().setNav(projectId, "automations")}
          >
            <LightningIcon />
            Automations
          </Button>
        </PopoverContent>
      </Popover>
      {arming === undefined ? null : (
        <span className="max-w-40 truncate text-label text-muted-foreground">
          {paused
            ? "Paused · Re-arm"
            : `on ${arming.runnerName} · Armed by ${arming.armedByDisplayName}`}
        </span>
      )}
    </div>
  );
}

export function CloudAutomationControls({
  projectId,
  automation,
}: {
  projectId: string;
  automation: Automation;
}) {
  const schedule = useCloudAutomationsStore((state) =>
    state.schedules[projectId]?.find((row) => row.automationId === automation.id),
  );
  const thisMac = useCloudPlacesStore((state) => state.thisRunnerId);
  const [runner, setRunner] = React.useState<string | null>(null);
  const canWrite = useCanWrite(projectId);
  const [saving, setSaving] = React.useState(false);
  const paused = schedule?.pausedAt != null;
  const armed = schedule !== undefined && !paused;
  async function change(enabled: boolean, runnerId = runner ?? thisMac) {
    if (!guardWrite(projectId)) return;
    setSaving(true);
    try {
      await useAutomationsStore
        .getState()
        .setEnabled(automation.id, enabled, runnerId ?? undefined);
    } finally {
      setSaving(false);
    }
  }
  if (automationTriggerSchedule(automation.trigger) === null)
    return (
      <div className="flex items-center gap-1">
        {automationTriggerColumns(automation.trigger).map((status) => (
          <span key={status} className="flex items-center gap-1 text-label text-muted-foreground">
            {TICKET_STATUS_LABELS[status]}
            <CloudColumnArming projectId={projectId} status={status} />
          </span>
        ))}
      </div>
    );
  return (
    <div className="flex items-center gap-2">
      {schedule === undefined ? null : (
        <span className="text-label text-muted-foreground">
          {paused ? "Paused · " : ""}Armed by {schedule.armedByDisplayName} · on{" "}
          {schedule.runnerName}
        </span>
      )}
      <AutomationRunnerPicker
        value={runner ?? (armed ? schedule.runnerId : thisMac)}
        disabled={!canWrite || saving}
        onChange={(id) => {
          setRunner(id);
          if (armed) void change(true, id);
        }}
      />
      {paused ? (
        <Button
          size="sm"
          variant="outline"
          disabled={!canWrite || saving}
          onClick={() => void change(true)}
        >
          Re-arm
        </Button>
      ) : null}
      <label className="flex items-center gap-2 text-ui text-muted-foreground">
        Armed
        <Switch
          checked={armed}
          disabled={!canWrite || saving}
          aria-label={`Armed: ${automation.name}`}
          onCheckedChange={(enabled) => void change(enabled)}
        />
      </label>
    </div>
  );
}

export function CloudNextScheduledRun({
  projectId,
  automationId,
}: {
  projectId: string;
  automationId: string;
}) {
  const schedule = useCloudAutomationsStore((state) =>
    state.schedules[projectId]?.find((row) => row.automationId === automationId),
  );
  if (schedule === undefined || schedule.pausedAt !== null) return null;
  return (
    <p className="text-ui text-foreground tabular-nums">
      Next:{" "}
      {new Date(schedule.nextFireAt).toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: schedule.timezone,
        timeZoneName: "short",
      })}
    </p>
  );
}
