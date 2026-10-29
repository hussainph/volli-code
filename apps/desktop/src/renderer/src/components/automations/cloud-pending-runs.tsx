import * as React from "react";
import { Button } from "@renderer/components/ui/button";
import { useCanWrite } from "@renderer/components/hosts/use-hosts";
import { requireCloudAutomationSource } from "@renderer/stores/automation-source";
import {
  useCloudAutomationsStore,
  waitingForRunner,
  type CloudPending,
} from "@renderer/stores/cloud-automations/state";
import { selectAutomations, useAutomationsStore } from "@renderer/stores/automations";
import { toastError } from "@renderer/lib/toast";
import { useBoardStore } from "@renderer/stores/board";

export function CloudPendingRuns() {
  const byProject = useCloudAutomationsStore((state) => state.pending);
  const entries = Object.entries(byProject);
  const counting = entries.some(([, rows]) =>
    rows.pending.some((row) => row.availableAt > Date.now()),
  );
  const [now, setNow] = React.useState(Date.now);
  React.useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [counting]);
  if (!entries.some(([, rows]) => rows.pending.length + rows.failures.length > 0)) return null;
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2"
      role="status"
      aria-live="polite"
      data-native-plane-overlay=""
    >
      {entries.map(([projectId, rows]) => (
        <React.Fragment key={projectId}>
          {rows.pending.map((row) => (
            <PendingRow
              key={row.jobId}
              projectId={projectId}
              row={row}
              now={counting ? now : Date.now()}
            />
          ))}
          {rows.failures.map((row) => (
            <FailedRow key={row.runId} projectId={projectId} row={row} />
          ))}
        </React.Fragment>
      ))}
    </div>
  );
}
function PendingRow({
  projectId,
  row,
  now,
}: {
  projectId: string;
  row: CloudPending["pending"][number];
  now: number;
}) {
  const canWrite = useCanWrite(projectId);
  const name = useAutomationsStore(
    (state) =>
      selectAutomations(state, projectId).find((a) => a.id === row.automationId)?.name ??
      "Automation",
  );
  const title = useBoardStore(
    (state) => state.ticketsByProject[projectId]?.find((t) => t.id === row.ticketId)?.title,
  );
  const seconds = Math.max(0, Math.ceil((row.availableAt - now) / 1000));
  const [saving, setSaving] = React.useState(false);
  const label = row.leased
    ? "Starting…"
    : seconds > 0
      ? `Starts in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
      : waitingForRunner(row.runner.name, row.runner.status, row.runner.statusChangedAt);
  return (
    <div
      data-armed-run-window={row.ticketId}
      className="pointer-events-auto flex w-96 items-center gap-2 rounded-container border border-border bg-popover px-4 py-2 shadow-overlay"
    >
      <span className="min-w-0 flex-1 text-ui">
        {name}
        {title === undefined ? "" : ` · ${title}`}
        <span className="block text-label text-muted-foreground">{label}</span>
      </span>
      <Button
        variant="ghost"
        disabled={!canWrite || saving || row.leased}
        onClick={() => {
          setSaving(true);
          void Promise.resolve()
            .then(() => requireCloudAutomationSource().cancel(projectId, row.jobId))
            .catch((error) => toastError(error instanceof Error ? error.message : String(error)))
            .finally(() => setSaving(false));
        }}
      >
        Cancel
      </Button>
    </div>
  );
}
function FailedRow({
  projectId,
  row,
}: {
  projectId: string;
  row: CloudPending["failures"][number];
}) {
  const canWrite = useCanWrite(projectId);
  const [saving, setSaving] = React.useState(false);
  return (
    <div className="pointer-events-auto flex w-96 items-center gap-2 rounded-container border border-border bg-popover px-4 py-2 shadow-overlay">
      <span className="min-w-0 flex-1 text-ui">
        {row.automationName ?? "Automation"}
        <span className="block text-label text-muted-foreground">
          Failed · {row.error ?? "Couldn’t start"}
        </span>
      </span>
      <Button
        variant="ghost"
        disabled={!canWrite || saving}
        onClick={() => {
          setSaving(true);
          void Promise.resolve()
            .then(() =>
              requireCloudAutomationSource().retry({
                projectId,
                runId: row.runId,
                retryCommandId: row.retryCommandId,
              }),
            )
            .catch((error) => toastError(error instanceof Error ? error.message : String(error)))
            .finally(() => setSaving(false));
        }}
      >
        Retry
      </Button>
    </div>
  );
}
