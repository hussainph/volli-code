import * as React from "react";
import { makeFunctionReference } from "convex/server";
import { followCloudSession } from "@renderer/lib/cloud-client";
import { cloudFailure } from "@renderer/stores/cloud-board/source";
import { Button } from "@renderer/components/ui/button";

export interface RunnerStartStatus {
  sessionId: string;
  state: "queued" | "starting" | "started" | "failed";
  runner: {
    id: string;
    name: string;
    kind: string;
    status: string;
    statusChangedAt: number;
  } | null;
  failure: { code: string; detail: string } | null;
}
const statusQuery = makeFunctionReference<"query", { sessionId: string }, RunnerStartStatus | null>(
  "sessionStarts:status",
);

export function useRunnerStartStatus(sessionId: string | undefined) {
  const [result, setResult] = React.useState<{
    id: string;
    status: RunnerStartStatus | null;
    error: string | null;
  } | null>(null);
  React.useEffect(() => {
    if (sessionId === undefined) return;
    let off: (() => void) | undefined;
    const stop = followCloudSession((session) => {
      off?.();
      off = undefined;
      setResult(null);
      if (session === null) return;
      const watch = session.client.watchQuery(statusQuery, { sessionId });
      const read = () => {
        try {
          const status = watch.localQueryResult();
          if (status !== undefined)
            setResult({
              id: sessionId,
              status,
              error: status === null ? "This Session start is no longer available." : null,
            });
        } catch (error) {
          setResult({ id: sessionId, status: null, error: cloudFailure(error).message });
        }
      };
      off = watch.onUpdate(read);
      read();
    });
    return () => {
      off?.();
      stop();
    };
  }, [sessionId]);
  return result?.id === sessionId ? result : null;
}

export function RunnerStartStatusPanel({
  name,
  status,
  error,
  accepted,
  onRetry,
  onEdit,
}: {
  name: string;
  status: RunnerStartStatus | null;
  error: string | null;
  accepted: boolean;
  onRetry(): void;
  onEdit(): void;
}) {
  const failed = status?.state === "failed";
  const label =
    error ??
    (failed
      ? (status.failure?.detail ?? "This Session could not start.")
      : status?.state === "starting" || status?.state === "started"
        ? `Starting on ${name}…`
        : accepted
          ? `Sent — waiting for ${name}`
          : `Confirming start on ${name}…`);
  return (
    <div className="pointer-events-auto flex items-center gap-2 px-4 py-2 text-ui">
      <span
        role={failed || error ? "alert" : "status"}
        className={failed || error ? "text-destructive" : "text-muted-foreground"}
      >
        {label}
      </span>
      {failed ? (
        <Button type="button" size="sm" variant="ghost" onClick={onEdit}>
          Edit and try again
        </Button>
      ) : !accepted ? (
        <Button type="button" size="sm" variant="ghost" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
