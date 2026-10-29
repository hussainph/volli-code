import * as React from "react";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import { parseCloudAutomationSkipReason } from "@volli/shared/cloud";
import { Button } from "@renderer/components/ui/button";
import { ListRow } from "@renderer/components/ui/list-row";
import { SectionHeading } from "@renderer/components/ui/section-heading";
import { ResolvedModelName } from "@renderer/components/models/resolved-model-name";
import { toastError } from "@renderer/lib/toast";
import { relativeTime } from "@renderer/lib/relative-time";
import { useAgeNow } from "@renderer/lib/use-age-now";
import { useCanWrite } from "@renderer/components/hosts/use-hosts";
import { automationHistoryKey } from "@renderer/stores/automations";
import { cloudAutomationSource } from "@renderer/stores/automation-source";
import {
  useCloudAutomationsStore,
  waitingForRunner,
  type CloudRun,
} from "@renderer/stores/cloud-automations/state";
import { resolvedRunModel } from "@renderer/stores/cloud-automations/source";
import { openRunSession, runAutomationForProject, runAutomationOnTicket } from "./run-automation";
const EMPTY: readonly CloudRun[] = [];

export function cloudRunLabel(run: CloudRun): string {
  switch (run.status) {
    case "queued":
      return waitingForRunner(run.runner?.name ?? "runner", run.runner?.status ?? "offline");
    case "failed":
      return `Failed · ${run.error ?? "Couldn’t start"}`;
    case "skipped": {
      const reason = parseCloudAutomationSkipReason(run.skipReason);
      const cause =
        reason.kind === "runner-asleep"
          ? `${run.runner?.name ?? "Runner"} was asleep`
          : reason.kind === "runner-unavailable"
            ? "Runner unavailable"
            : reason.kind === "superseded"
              ? "Replaced by the next run"
              : reason.kind === "run-refused"
                ? reason.error
                : reason.kind === "app-closed"
                  ? "Volli wasn’t running"
                  : reason.kind === "not-observed"
                    ? "Volli didn’t wake in time"
                    : "Reason unreadable";
      return `Skipped · ${cause}${(run.missedCount ?? 0) > 0 ? ` (${run.missedCount} missed)` : ""}`;
    }
    case "started":
      return run.sessionAccess === "private"
        ? "Private Session"
        : run.sessionAccess === "gone"
          ? "Session removed"
          : run.sessionAccess === "starting"
            ? "Starting…"
            : run.attendance === "unattended"
              ? "Automatic"
              : "By hand";
  }
}

export function CloudRunHistory({
  projectId,
  automationId,
}: {
  projectId: string;
  automationId: string | null;
}) {
  const key = automationId === null ? projectId : automationHistoryKey(projectId, automationId);
  const rows = useCloudAutomationsStore((state) => state.histories[key] ?? EMPTY);
  const loaded = useCloudAutomationsStore((state) => state.histories[key] !== undefined);
  const now = useAgeNow(rows.map((row) => row.createdAt));
  const source = cloudAutomationSource();
  const [loading, setLoading] = React.useState(false);
  return (
    <section className="flex flex-col gap-1" data-run-history={automationId ?? "project"}>
      <SectionHeading className="h-6 leading-6">
        {automationId === null ? "Project activity" : "Runs"}
      </SectionHeading>
      {loaded && rows.length === 0 ? (
        <p className="py-2 text-ui text-muted-foreground">
          {automationId === null
            ? "Nothing has run in this project yet."
            : "Nothing has run this Automation yet."}
        </p>
      ) : null}
      {rows.map((row) => (
        <CloudRunRow key={row.id} run={row} now={now} />
      ))}
      {source?.hasMore(key) ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            void source
              .loadMore(key)
              .catch((error) => toastError(error instanceof Error ? error.message : String(error)))
              .finally(() => setLoading(false));
          }}
        >
          Load more
        </Button>
      ) : null}
    </section>
  );
}
function CloudRunRow({ run, now }: { run: CloudRun; now: number }) {
  const canWrite = useCanWrite(run.projectId);
  const [retrying, setRetrying] = React.useState(false);
  const model = resolvedRunModel(run.model);
  const ready = run.status === "started" && run.sessionAccess === "ready" && run.sessionId !== null;
  const retry = async () => {
    if (run.ticketId === null || run.retryCommandId === undefined) return;
    setRetrying(true);
    try {
      await cloudAutomationSource()?.retry(run.id);
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error));
    } finally {
      setRetrying(false);
    }
  };
  return (
    <ListRow
      data-run-history-run={run.id}
      onActivate={
        ready
          ? () =>
              openRunSession({
                sessionId: run.sessionId!,
                projectId: run.projectId,
                ticketId: run.ticketId,
              })
          : null
      }
      leading={<LightningIcon className="size-4 text-muted-foreground" />}
      primary={
        <span className="flex min-w-0 flex-wrap items-center gap-1 text-ui">
          <span>{run.automationName ?? "Unbound Run"}</span>
          <span className="text-muted-foreground">· {cloudRunLabel(run)}</span>
          {model === null ? null : (
            <ResolvedModelName
              selection={model}
              className="text-muted-foreground"
              trailing={`${model.reasoningLevel} effort`}
            />
          )}
        </span>
      }
      trailing={
        <span className="text-label text-muted-foreground">
          {relativeTime(run.dueAt ?? run.createdAt, now)}
        </span>
      }
      actions={
        run.status === "failed" && run.retryCommandId !== undefined ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={!canWrite || retrying}
            onClick={() => void retry()}
          >
            Retry
          </Button>
        ) : run.status === "skipped" && run.automationId !== null ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={!canWrite}
            onClick={() => {
              if (run.ticketId === null)
                void runAutomationForProject({
                  automationId: run.automationId!,
                  automationName: run.automationName ?? "Automation",
                  projectId: run.projectId,
                });
              else
                void runAutomationOnTicket({
                  target: { kind: "automation", automationId: run.automationId! },
                  automationName: run.automationName ?? "Automation",
                  ticketId: run.ticketId,
                  ticketDisplayId: "ticket",
                  modelOverride: null,
                });
            }}
          >
            Run now
          </Button>
        ) : undefined
      }
    />
  );
}
