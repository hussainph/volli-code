import * as React from "react";

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
import {
  brokenHarnessMessage,
  harnessCommandLine,
  loadPendingHarnesses,
  recordTrustVerdict,
  type HarnessTrustApi,
} from "@renderer/components/harness/trust-prompt-model";
import { Badge } from "@renderer/components/ui/badge";
import { toastError } from "@renderer/lib/toast";
import type { HarnessTrustVerdict, PendingHarnessManifest } from "@volli/shared";

/**
 * The confirmation a registered harness manifest is inert without
 * (docs/plans/harness-events.md §Trust).
 *
 * One manifest at a time, head of the queue, mounted app-wide because the
 * question is about the app and not about whatever page is open. The model
 * re-reads the queue after every verdict, so a manifest edited while this was
 * on screen comes straight back with its new command line rather than
 * inheriting an answer given about the old one.
 *
 * Esc and the overlay defer rather than answer: an unanswered question is asked
 * again next launch, which is a different thing from "don't run this".
 */
export function HarnessTrustDialog() {
  const [queue, setQueue] = React.useState<PendingHarnessManifest[]>([]);
  const [busy, setBusy] = React.useState(false);
  const api: HarnessTrustApi = window.api.harness;

  React.useEffect(() => {
    let cancelled = false;
    void loadPendingHarnesses(api).then((result) => {
      if (cancelled) return;
      if (result.error !== null) toastError(`Couldn't check registered harnesses: ${result.error}`);
      // Once, at this mount — not after every verdict. A broken manifest has
      // no dialog and no row anywhere, so this toast is the entire difference
      // between "Volli rejected my manifest" and "Volli never saw it".
      for (const manifest of result.broken) toastError(brokenHarnessMessage(manifest));
      setQueue(result.pending);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const manifest = queue[0];

  async function answer(decision: HarnessTrustVerdict): Promise<void> {
    if (manifest === undefined || busy) return;
    setBusy(true);
    try {
      const result = await recordTrustVerdict(api, manifest, decision);
      if (result.error !== null) toastError(result.error);
      setQueue(result.pending);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog
      open={manifest !== undefined}
      // Esc defers: the manifest leaves this launch's queue with no verdict
      // recorded, so main asks again next boot. Deferring and refusing are
      // different answers and must not collapse into one.
      onOpenChange={(open) => {
        if (!open && !busy) setQueue((waiting) => waiting.slice(1));
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Trust {manifest?.label}?</AlertDialogTitle>
          {/* The one line CLAUDE.md's UI-copy rule leaves room for: a trust
              boundary, stated once. The command line below is the subject of
              the sentence, not an illustration of it. */}
          <AlertDialogDescription>
            Volli will run this command every time a session starts this harness.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-2">
          <pre className="overflow-x-auto rounded-md border border-border bg-background/30 px-4 py-2 font-mono text-ui text-foreground">
            {manifest === undefined ? "" : harnessCommandLine(manifest)}
          </pre>
          <p className="truncate font-mono text-ui text-muted-foreground">
            {manifest?.manifestPath}
          </p>
          {manifest !== undefined && manifest.claimedEvents.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {/* The one badge in the app that keeps `text-ui`: these are the
                  same literal strings as the command line and manifest path
                  above them, and this whole block is one quotation of what the
                  harness declared about itself. */}
              {manifest.claimedEvents.map((event) => (
                <Badge key={event} mono className="text-ui">
                  {event}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>
        <AlertDialogFooter>
          {/* preventDefault on both: the queue is what closes this dialog, and
              it only moves once main has actually recorded the answer. Letting
              Radix close it first would hide a refused write behind a dialog
              that had already gone. */}
          <AlertDialogCancel
            disabled={busy}
            onClick={(event) => {
              event.preventDefault();
              void answer("blocked");
            }}
          >
            Don't run
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(event) => {
              event.preventDefault();
              void answer("trusted");
            }}
          >
            Trust
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
