import * as React from "react";
import type { ProfileRestoreStatus } from "@volli/shared";
import { errorMessage } from "@volli/shared";
import { ItemRow, PrefRow } from "@renderer/components/settings/kit";
import { Button } from "@renderer/components/ui/button";
import { Badge } from "@renderer/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { formatFileSize } from "@renderer/components/attachments/attachment-model";
import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";
import { toastError } from "@renderer/lib/toast";

export function BackupRestore() {
  const [status, setStatus] = React.useState<ProfileRestoreStatus | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  const [paths, setPaths] = React.useState<Record<string, string>>({});
  const [pending, setPending] = React.useState(false);
  const epoch = React.useRef(0);
  const mutating = React.useRef(false);
  React.useEffect(() => {
    let active = true;
    const load = async () => {
      if (mutating.current) return;
      const token = epoch.current;
      try {
        const next = await sessionRpcClient().backups.restoreStatus.query();
        if (active && token === epoch.current) {
          setStatus(next);
          setFailure(null);
        }
      } catch (error) {
        if (active && token === epoch.current) setFailure(errorMessage(error));
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  const mappingRevision = React.useRef<string | null>(null);
  const revision = status?.revision;
  const phase = status?.phase;
  React.useEffect(() => {
    if (phase !== "mapping" || !revision || mappingRevision.current === revision) return;
    mappingRevision.current = revision;
    setPaths(
      Object.fromEntries(
        (status?.projects ?? []).map((project) => [project.id, project.directory ?? ""]),
      ),
    );
  }, [revision, phase, status?.projects]);
  async function mutate(work: () => Promise<ProfileRestoreStatus>) {
    if (mutating.current) return;
    mutating.current = true;
    setPending(true);
    ++epoch.current;
    try {
      setStatus(await work());
      setFailure(null);
    } catch (error) {
      toastError(`Couldn't restore: ${errorMessage(error)}`);
    } finally {
      mutating.current = false;
      setPending(false);
    }
  }
  async function choose(fileName?: string) {
    setOpen(true);
    await mutate(() =>
      sessionRpcClient().backups.restoreChoose.mutate(fileName === undefined ? {} : { fileName }),
    );
  }
  const busy = phase === "checking" || phase === "staging";
  const activeRestore = busy || phase === "mapping" || phase === "ready" || phase === "restarting";
  return (
    <>
      <PrefRow label="Restore">
        <Button
          size="xs"
          variant="outline"
          disabled={pending || status === null}
          onClick={() => {
            if (activeRestore) setOpen(true);
            else void choose();
          }}
        >
          Restore…
        </Button>
      </PrefRow>
      {failure ? (
        <p role="status" className="text-ui text-muted-foreground">
          {failure}
        </p>
      ) : null}
      {status?.bundles.map((bundle) => (
        <ItemRow
          key={bundle.fileName}
          name={new Date(bundle.createdAt).toLocaleString()}
          meta={`${formatFileSize(bundle.sizeBytes)} · ${bundle.fileName}`}
          badges={
            <>
              <Badge variant="secondary">
                {bundle.verification === "verified"
                  ? "Verified"
                  : bundle.verification === "failed"
                    ? "Failed"
                    : "Not checked"}
              </Badge>
              {bundle.keptForMove ? <Badge variant="secondary">Kept for move</Badge> : null}
            </>
          }
        >
          <Button
            size="xs"
            variant="ghost"
            disabled={pending || activeRestore}
            aria-label={`Restore ${bundle.fileName}`}
            onClick={() => void choose(bundle.fileName)}
          >
            Restore…
          </Button>
        </ItemRow>
      ))}
      {status?.previousProfile && phase !== "ready" && phase !== "restarting" ? (
        <ItemRow name="Previous profile" meta={status.previousProfile}>
          <Button
            size="xs"
            variant="outline"
            aria-label="Show previous profile in Finder"
            onClick={() => {
              void sessionRpcClient()
                .backups.restoreRevealPrevious.mutate()
                .catch((error: unknown) =>
                  toastError(`Couldn't show previous profile: ${errorMessage(error)}`),
                );
            }}
          >
            Show in Finder
          </Button>
        </ItemRow>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore backup</DialogTitle>
            <DialogDescription>
              Restarting replaces local history with this backup, including changes made while
              preparing the restore. The previous profile is kept. Project files are not changed.
            </DialogDescription>
          </DialogHeader>
          {status?.selectedFile ? <p className="text-ui break-all">{status.selectedFile}</p> : null}
          {phase === "restarting" ? (
            <p role="status" className="text-ui">
              Restarting…
            </p>
          ) : null}
          {busy ? (
            <div role="status" aria-live="polite">
              <progress aria-label="Restore progress" />
              <p className="text-ui">
                {status?.paused
                  ? "Restore paused while memory is under pressure."
                  : phase === "checking"
                    ? "Checking backup…"
                    : "Preparing restore…"}{" "}
                {status?.checkpoints ?? 0} checkpoints
              </p>
            </div>
          ) : null}
          {phase === "mapping" ? (
            <div className="max-h-72 overflow-y-auto">
              {status?.projects.map((project) => (
                <ItemRow
                  key={project.id}
                  name={project.name}
                  meta={paths[project.id] || "Choose a local directory"}
                >
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={pending}
                    aria-label={`Directory for ${project.name}`}
                    onClick={() => {
                      void sessionRpcClient()
                        .backups.restoreDirectory.mutate()
                        .then(
                          (path) => {
                            if (path) setPaths((old) => ({ ...old, [project.id]: path }));
                          },
                          (error: unknown) =>
                            toastError(`Couldn't choose directory: ${errorMessage(error)}`),
                        );
                    }}
                  >
                    Choose…
                  </Button>
                </ItemRow>
              ))}
            </div>
          ) : null}
          {status?.problems.length ? (
            <div role="alert">
              {status.problems.map((problem) => (
                <p key={`${problem.kind}:${problem.message}`} className="text-ui">
                  {problem.kind}: {problem.message}
                </p>
              ))}
            </div>
          ) : null}
          {phase === "cancelled" ? (
            <p role="status" className="text-ui">
              Restore cancelled. The current profile is unchanged.
            </p>
          ) : null}
          {phase === "ready" ? (
            <div role="status" className="space-y-2 text-ui">
              <p>Ready to restore on restart.</p>
              <p>{status?.credentialsMessage}</p>
              <p className="break-all">Previous profile backup: {status?.previousProfile}</p>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={pending || phase === "restarting"}
              onClick={() => {
                if (status && activeRestore)
                  void mutate(() =>
                    sessionRpcClient().backups.restoreCancel.mutate({
                      expectedRevision: status.revision,
                    }),
                  );
                else setOpen(false);
              }}
            >
              {activeRestore ? "Cancel restore" : "Close"}
            </Button>
            {phase === "mapping" ? (
              <Button
                disabled={pending || !status?.projects.every((project) => !!paths[project.id])}
                onClick={() => {
                  if (status)
                    void mutate(() =>
                      sessionRpcClient().backups.restoreStart.mutate({
                        expectedRevision: status.revision,
                        projectPaths: paths,
                      }),
                    );
                }}
              >
                Prepare restore
              </Button>
            ) : null}
            {phase === "ready" ? (
              <Button
                disabled={pending}
                onClick={() => {
                  if (status) {
                    setStatus({ ...status, phase: "restarting" });
                    void sessionRpcClient()
                      .backups.restoreRestart.mutate({ expectedRevision: status.revision })
                      .catch((error: unknown) => {
                        setStatus(status);
                        toastError(`Couldn't restart: ${errorMessage(error)}`);
                      });
                  }
                }}
              >
                Restart and restore
              </Button>
            ) : null}
            {phase === "failed" || phase === "cancelled" ? (
              <Button disabled={pending} onClick={() => void choose()}>
                Choose backup…
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
