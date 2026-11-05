import * as React from "react";
import { AutomationIcon } from "@renderer/components/ui/icon";

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
import { PrefRow } from "@renderer/components/settings/kit/pref-row";
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
      <SelectTrigger aria-label="Runner" className="w-auto min-w-32 max-w-64 text-label">
        <SelectValue
          placeholder={
            selected === null &&
            current !== undefined &&
            !runners.some((row) => row.id === current.id)
              ? `Update Volli on ${current.name}`
              : "Select a runner"
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
            {row.name}
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
  const lock = React.useRef(false);
  const paused = arming?.pausedAt != null;
  const name = automations.find((row) => row.id === arming?.automationId)?.name;
  const label =
    arming === undefined
      ? `Arm ${TICKET_STATUS_LABELS[status]}`
      : paused
        ? `${TICKET_STATUS_LABELS[status]} · Paused · Re-arm`
        : `${TICKET_STATUS_LABELS[status]} runs ${name ?? "Automation"} on ${arming.runnerName} · Armed by ${arming.armedByDisplayName}`;
  async function arm(automationId: string | null, onRunner = runnerId) {
    if (lock.current || !guardWrite(projectId)) return;
    lock.current = true;
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
      lock.current = false;
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
            className={arming !== undefined && paused ? "bg-accent" : undefined}
          >
            <AutomationIcon
              className={
                arming !== undefined && !paused ? "text-primary-text" : "text-muted-foreground"
              }
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="flex w-64 flex-col gap-2">
          <span className="text-ui font-medium">{TICKET_STATUS_LABELS[status]}</span>
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
            No automation
          </Button>
          {offered.length === 0 ? (
            <span className="sr-only">No automations offered</span>
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
            <AutomationIcon />
            Automations
          </Button>
        </PopoverContent>
      </Popover>
      {arming === undefined ? null : (
        <span className="max-w-40 truncate text-label text-muted-foreground">
          {paused ? "Paused · Re-arm" : `${arming.armedByDisplayName} · ${arming.runnerName}`}
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
  const lock = React.useRef(false);
  const paused = schedule?.pausedAt != null;
  const armed = schedule !== undefined && !paused;
  async function change(enabled: boolean, runnerId = runner ?? thisMac) {
    if (lock.current || !guardWrite(projectId)) return;
    lock.current = true;
    setSaving(true);
    try {
      await useAutomationsStore
        .getState()
        .setEnabled(automation.id, enabled, runnerId ?? undefined);
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }
  if (automationTriggerSchedule(automation.trigger) === null)
    return (
      <>
        {automationTriggerColumns(automation.trigger).map((status) => (
          <PrefRow key={status} label={TICKET_STATUS_LABELS[status]}>
            <CloudColumnArming projectId={projectId} status={status} />
          </PrefRow>
        ))}
      </>
    );
  return (
    <>
      <PrefRow label="Runner">
        <AutomationRunnerPicker
          value={runner ?? (armed ? schedule.runnerId : thisMac)}
          disabled={!canWrite || saving}
          onChange={(id) => {
            setRunner(id);
            if (armed) void change(true, id);
          }}
        />
      </PrefRow>
      {schedule !== undefined && (
        <PrefRow label="Armed by">
          <span
            aria-label={`Armed by ${schedule.armedByDisplayName} on ${schedule.runnerName}`}
            className="text-ui wrap-anywhere"
          >
            {schedule.armedByDisplayName} · {schedule.runnerName}
          </span>
        </PrefRow>
      )}
      <PrefRow label="Armed">
        {paused && (
          <>
            <span className="text-ui text-muted-foreground">Paused</span>
            <Button
              size="sm"
              variant="outline"
              disabled={!canWrite || saving}
              onClick={() => void change(true)}
            >
              Re-arm
            </Button>
          </>
        )}
        <Switch
          checked={armed}
          disabled={!canWrite || saving}
          aria-label={`Armed: ${automation.name}`}
          onCheckedChange={(value) => void change(value)}
        />
      </PrefRow>
    </>
  );
}

/** Cloud state names backend arming, never this Mac's local permission. */
export function CloudAutomationState({
  projectId,
  automation,
}: {
  projectId: string;
  automation: Automation;
}) {
  const schedules = useCloudAutomationsStore((s) => s.schedules[projectId]);
  const armings = useCloudAutomationsStore((s) => s.armings[projectId]);
  if (automation.trigger.kind === "none") return <>Manual only</>;
  if (automation.trigger.kind === "schedule") {
    const schedule = schedules?.find((s) => s.automationId === automation.id);
    if (!schedule) return <>Manual only</>;
    if (schedule.pausedAt !== null) return <>Paused</>;
    return <CloudNextScheduledRun projectId={projectId} automationId={automation.id} />;
  }
  const armed =
    armings?.filter((a) => a.automationId === automation.id && a.pausedAt === null) ?? [];
  const paused = armings?.some((a) => a.automationId === automation.id && a.pausedAt !== null);
  return (
    <>
      {paused && armed.length === 0
        ? "Paused"
        : armed.length > 0
          ? `Armed in ${armed.map((a) => TICKET_STATUS_LABELS[a.status]).join(", ")}`
          : `Offered in ${automationTriggerColumns(automation.trigger)
              .map((s) => TICKET_STATUS_LABELS[s])
              .join(", ")}`}
    </>
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
      Next ·{" "}
      {new Date(schedule.nextFireAt).toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: schedule.timezone,
        hour12: false,
      })}{" "}
      · {schedule.timezone}
    </p>
  );
}
