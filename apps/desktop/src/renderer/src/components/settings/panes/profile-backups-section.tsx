import * as React from "react";
import { BackupRestore } from "./backup-restore";
import { DatabaseIcon } from "@phosphor-icons/react/dist/csr/Database";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { errorMessage, type ProfileBackupStatus } from "@volli/shared";
import { PrefRow, PrefSection, SectionAction } from "@renderer/components/settings/kit";
import { Button } from "@renderer/components/ui/button";
import { LoadingLabel } from "@renderer/components/ui/loading-label";
import { Notice } from "@renderer/components/ui/notice";
import { formatFileSize } from "@renderer/components/attachments/attachment-model";
import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";
import { toastError } from "@renderer/lib/toast";

/** How often the section re-reads the backup projection while it is on screen. */
const BACKUP_POLL_MS = 5000;

/**
 * The machine's daily profile backups: when the last one ran, a manual run,
 * and the restore flow beside them.
 *
 * A failed read is drawn as a failure with its retry, never as "No backup
 * yet": that sentence is what makes it safe to forget about backups, so it
 * may only appear when the host actually said so.
 */
export function ProfileBackupsSection() {
  const [status, setStatus] = React.useState<ProfileBackupStatus | null>(null);
  const [requested, setRequested] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  const active = React.useRef(true);

  const load = React.useCallback(async () => {
    try {
      const result = await sessionRpcClient().backups.status.query();
      if (active.current) {
        setStatus(result);
        setFailure(null);
      }
    } catch (error) {
      if (active.current) setFailure(errorMessage(error));
    }
  }, []);

  React.useEffect(() => {
    active.current = true;
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, BACKUP_POLL_MS);
    return () => {
      active.current = false;
      window.clearInterval(timer);
    };
  }, [load]);

  async function run() {
    if (!status || requested) return;
    setRequested(true);
    try {
      setStatus(await sessionRpcClient().backups.run.mutate({ expectedRevision: status.revision }));
    } catch (error) {
      toastError(`Couldn't back up: ${errorMessage(error)}`);
    } finally {
      setRequested(false);
    }
  }
  const busy = requested || status?.running === true;
  const last = status?.lastBackup;
  return (
    <PrefSection
      title="Backups"
      icon={DatabaseIcon}
      action={
        <SectionAction label="Show in Finder" icon={FolderOpenIcon} onAct={() => void reveal()} />
      }
    >
      <PrefRow label="Last backup">
        <span className="text-ui text-muted-foreground">
          {status === null ? (
            failure ? (
              "Unavailable"
            ) : (
              <LoadingLabel>Loading</LoadingLabel>
            )
          ) : last ? (
            `${new Date(last.createdAt).toLocaleString()} · ${formatFileSize(last.sizeBytes)}`
          ) : (
            "No backup yet"
          )}
        </span>
        <Button
          size="xs"
          variant="outline"
          disabled={busy || status === null}
          onClick={() => void run()}
        >
          {busy ? <LoadingLabel>Backing up</LoadingLabel> : "Back up now"}
        </Button>
      </PrefRow>
      {failure ? (
        <Notice
          tone="error"
          title="Couldn't read backups"
          detail={failure}
          announce
          className="m-4"
          actions={
            <Button size="xs" variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          }
        />
      ) : status?.notice ? (
        // A skipped or paused attempt: the host's own sentence, which names
        // its recovery ("Free disk space, then Back up now.").
        <Notice tone="warning" title={status.notice} announce className="m-4" />
      ) : null}
      <BackupRestore />
    </PrefSection>
  );
}

async function reveal() {
  try {
    await sessionRpcClient().backups.reveal.mutate();
  } catch (error) {
    toastError(`Couldn't show backups: ${errorMessage(error)}`);
  }
}
