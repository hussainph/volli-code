import { useEffect, useRef, useState } from "react";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import type {
  DatabaseRecoveryListResult,
  DatabaseRecoveryRestoreResult,
  DatabaseSafetyCopy,
} from "../../../ipc/contract";

import { ContentColumn } from "./layout/content-column";
import { Button } from "./ui/button";
import { Notice } from "./ui/notice";

interface RecoveryGateway {
  list(): Promise<DatabaseRecoveryListResult>;
  restore(): Promise<DatabaseRecoveryRestoreResult>;
}

const recoveryGateway: RecoveryGateway = {
  list: () => window.api.databaseRecovery.list(),
  restore: () => window.api.databaseRecovery.restore(),
};

const RESTORE_LABEL = "Restore from the last backup that checks clean";
const MANUAL_RECOVERY = "Your database and safety copies are preserved for manual recovery.";
const containsDiagnosticPath = (message: string) =>
  /(?:^|\s|["'(])(?:\/[\w.~]|[A-Za-z]:\\)/.test(message);

type RecoveryState =
  | { kind: "checking" }
  | { kind: "unavailable" }
  | { kind: "available"; backups: DatabaseSafetyCopy[] };

/** Only main can establish degraded DB state. A renderer boot exception alone
 * must never offer to replace an otherwise healthy database. */
export function BootErrorPanel({
  error,
  gateway = recoveryGateway,
}: {
  error: string;
  gateway?: RecoveryGateway;
}) {
  const [recovery, setRecovery] = useState<RecoveryState>({ kind: "checking" });
  const [restoreState, setRestoreState] = useState<"idle" | "pending" | "failed" | "restarting">(
    "idle",
  );
  const [restoreError, setRestoreError] = useState<string | null>(null);
  // Covers a second press before React has committed the disabled button too.
  const restoring = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await gateway.list();
        if (cancelled) return;
        if (result.ok) {
          setRecovery({
            kind: "available",
            backups: result.backups.toSorted((a, b) => b.modifiedAt - a.modifiedAt),
          });
        } else {
          console.warn("[volli] backup recovery unavailable:", result.error);
          setRecovery({ kind: "unavailable" });
        }
      } catch (cause) {
        if (cancelled) return;
        console.warn("[volli] couldn't check backup recovery:", cause);
        setRecovery({ kind: "unavailable" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gateway]);

  const hasCleanBackup =
    recovery.kind === "available" &&
    recovery.backups.some((backup) => backup.integrity === "clean");

  async function restore() {
    if (!hasCleanBackup || restoring.current) return;
    restoring.current = true;
    setRestoreState("pending");
    setRestoreError(null);
    try {
      const result = await gateway.restore();
      if (!result.ok) throw new Error(result.error);
      // Main schedules the relaunch; do not reload this renderer against the
      // still-degraded process or offer another restore while it is quitting.
      setRestoreState("restarting");
    } catch (cause) {
      console.warn("[volli] couldn't restore backup:", cause);
      restoring.current = false;
      const message = cause instanceof Error ? cause.message : "";
      setRestoreError(message && !containsDiagnosticPath(message) ? message : null);
      setRestoreState("failed");
    }
  }

  // DB-open errors can contain native-loader or filesystem diagnostics. Keep
  // those paths in the log, not on this fault surface; retain plain remedies.
  const containsPath = containsDiagnosticPath(error);
  useEffect(() => {
    if (containsPath) console.warn("[volli] boot failure:", error);
  }, [containsPath, error]);

  return (
    <div className="flex min-h-svh w-full items-center bg-background py-8">
      <ContentColumn className="flex flex-col gap-4">
        <div className="flex flex-col items-center gap-2 text-center">
          <WarningCircleIcon aria-hidden className="size-8 text-muted-foreground" />
          <h1 className="text-heading font-semibold text-foreground">
            Volli couldn't load its data
          </h1>
          <p className="text-sm text-muted-foreground">
            {containsPath ? "The failure details are available in the diagnostic log." : error}
          </p>
        </div>

        {recovery.kind === "checking" ? (
          <Notice title="Checking whether backup recovery is available…" announce />
        ) : recovery.kind === "unavailable" ? (
          <Notice title="Backup recovery is unavailable. No files were changed." announce />
        ) : (
          <section aria-labelledby="safety-copies-title" className="flex flex-col gap-4">
            <h2 id="safety-copies-title" className="text-sm font-medium text-foreground">
              Local safety copies
            </h2>
            {recovery.backups.length > 0 ? (
              <ul
                aria-label="Local safety copies"
                className="divide-y divide-border rounded-lg border border-border"
              >
                {recovery.backups.map((backup) => (
                  <li
                    key={backup.name}
                    className="flex flex-wrap items-center justify-between gap-2 p-4 text-ui"
                  >
                    <div className="min-w-0">
                      <p className="break-all text-foreground">{backup.name}</p>
                      <time
                        className="text-muted-foreground"
                        dateTime={new Date(backup.modifiedAt).toISOString()}
                      >
                        {new Date(backup.modifiedAt).toLocaleString()}
                      </time>
                    </div>
                    <span
                      className={
                        backup.integrity === "clean" ? "text-positive" : "text-muted-foreground"
                      }
                    >
                      {backup.integrity}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            <Notice
              title={
                hasCleanBackup
                  ? "Restoring a backup restarts Volli. Changes since that backup won't be included."
                  : "No local backup checks clean. Nothing was restored."
              }
              detail={MANUAL_RECOVERY}
              announce
            />
            <div>
              <Button
                disabled={
                  !hasCleanBackup || restoreState === "pending" || restoreState === "restarting"
                }
                onClick={() => void restore()}
                className="max-w-full"
              >
                <span className="truncate">{RESTORE_LABEL}</span>
              </Button>
            </div>
            {restoreState === "pending" ? (
              <Notice title="Restoring the last backup that checks clean…" announce />
            ) : restoreState === "restarting" ? (
              <Notice tone="positive" title="Backup restored. Volli is restarting…" announce />
            ) : restoreState === "failed" ? (
              <Notice
                tone="error"
                title="Couldn't restore a clean backup. Volli has not restarted."
                detail={restoreError ?? MANUAL_RECOVERY}
                announce
              />
            ) : null}
          </section>
        )}
      </ContentColumn>
    </div>
  );
}
