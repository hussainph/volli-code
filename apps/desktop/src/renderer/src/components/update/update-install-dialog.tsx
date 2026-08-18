/**
 * The explicit install prompt (VC-59) — the ONE dialog on the update path.
 *
 * Everything the native quit gates would have asked is asked here instead:
 * confirming runs `volli:update-install`, which raises the quit latch those
 * gates stand down for, so the restart proceeds through the normal teardown
 * without a second modal. That is why this dialog fetches and NAMES the live
 * work (busy terminals, open agent Sessions, unsaved drafts) before offering
 * the button — see `live-work-copy.ts`.
 *
 * Opens itself once per downloaded version (the store's rule), dismissible;
 * a dismissal leaves the sidebar badge lit and the badged icon re-opens it.
 * Mounted once at the app shell, beside the other global dialogs, so it
 * survives the sidebar panel collapsing to zero.
 */
import * as React from "react";
import { errorMessage } from "@volli/shared";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import { liveWorkLines, type LiveWork } from "@renderer/components/update/live-work-copy";
import { toastError } from "@renderer/lib/toast";
import { useUpdateStore } from "@renderer/stores/update";

export function UpdateInstallDialog() {
  const state = useUpdateStore((store) => store.state);
  const dialogOpen = useUpdateStore((store) => store.dialogOpen);
  const dismissDialog = useUpdateStore((store) => store.dismissDialog);

  // Fetched per open, not cached: what is running changes between opens, and
  // a stale count here would promise a gentler restart than the one delivered.
  const [liveWork, setLiveWork] = React.useState<LiveWork | null>(null);
  const [installing, setInstalling] = React.useState(false);

  React.useEffect(() => {
    if (!dialogOpen) {
      setLiveWork(null);
      setInstalling(false);
      return;
    }
    let cancelled = false;
    window.api.updates
      .liveWork()
      .then((result) => {
        if (cancelled || !result.ok) return;
        setLiveWork({
          busyCommands: result.busyCommands,
          openAgentSessions: result.openAgentSessions,
          unsavedDrafts: result.unsavedDrafts,
        });
      })
      .catch(() => {
        // A failed read leaves the "Checking…" line — the dialog still warns
        // that a restart stops live work, it just cannot enumerate it.
      });
    return () => {
      cancelled = true;
    };
  }, [dialogOpen]);

  const confirmInstall = () => {
    setInstalling(true);
    window.api.updates
      .install()
      .then((result) => {
        // ok: true means the app is already restarting — nothing to render.
        if (result.ok) return;
        setInstalling(false);
        toastError(`Couldn't install the update: ${result.error}`);
      })
      .catch((error: unknown) => {
        setInstalling(false);
        toastError(`Couldn't install the update: ${errorMessage(error)}`);
      });
  };

  const lines = liveWork === null ? null : liveWorkLines(liveWork);
  const version = state?.targetVersion;

  return (
    <AlertDialog
      open={dialogOpen}
      onOpenChange={(next) => {
        if (!next) dismissDialog();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {version === null || version === undefined
              ? "Install update and restart?"
              : `Update to Volli Code ${version}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            The update is downloaded. Installing it restarts the app.
            {lines === null
              ? " Checking what is running…"
              : lines.length === 0
                ? " A restart will not interrupt active work."
                : " A restart will stop:"}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {lines !== null && lines.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={dismissDialog}>Not Now</AlertDialogCancel>
          <AlertDialogAction
            variant={lines !== null && lines.length > 0 ? "destructive" : "default"}
            disabled={installing}
            onClick={(event) => {
              // Keep the dialog mounted while the install round-trips — a
              // failure has to come back HERE, not to a dismissed surface.
              event.preventDefault();
              confirmInstall();
            }}
          >
            {installing ? "Restarting…" : "Restart & Install"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
