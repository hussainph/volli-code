import * as React from "react";
import { DatabaseIcon } from "@phosphor-icons/react/dist/csr/Database";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { errorMessage, type ProfileBackupStatus } from "@volli/shared";
import { PrefRow, PrefSection, SectionAction } from "@renderer/components/settings/kit";
import { Button } from "@renderer/components/ui/button";
import { formatFileSize } from "@renderer/components/attachments/attachment-model";
import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";
import { toastError } from "@renderer/lib/toast";

export function ProfileBackupsSection() {
  const [status, setStatus] = React.useState<ProfileBackupStatus | null>(null);
  const [requested, setRequested] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  React.useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const result = await sessionRpcClient().backups.status.query();
        if (active) {
          setStatus(result);
          setFailure(null);
        }
      } catch (error) {
        if (active) setFailure(errorMessage(error));
      }
    };
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  async function run() {
    setRequested(true);
    try {
      setStatus(await sessionRpcClient().backups.run.mutate());
    } catch (error) {
      toastError(`Couldn't back up: ${errorMessage(error)}`);
    } finally {
      setRequested(false);
    }
  }
  const busy = requested || status?.running;
  const last = status?.lastBackup;
  return (
    <PrefSection
      title="Local profile backups"
      icon={DatabaseIcon}
      action={
        <SectionAction label="Show in Finder" icon={FolderOpenIcon} onAct={() => void reveal()} />
      }
    >
      <PrefRow label="Last backup">
        <span className="text-ui text-muted-foreground">
          {status === null
            ? failure
              ? "Unavailable"
              : "Loading…"
            : last
              ? `${new Date(last.createdAt).toLocaleString()} · ${formatFileSize(last.sizeBytes)}`
              : "No backup yet"}
        </span>
        <Button
          size="xs"
          variant="outline"
          disabled={!!busy || status === null}
          onClick={() => void run()}
        >
          {busy ? "Backing up…" : "Back up now"}
        </Button>
      </PrefRow>
      {failure || status?.notice ? (
        <PrefRow label="Backup notice">
          <span role="status" className="text-ui text-muted-foreground">
            {failure ?? status?.notice}
          </span>
        </PrefRow>
      ) : null}
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
