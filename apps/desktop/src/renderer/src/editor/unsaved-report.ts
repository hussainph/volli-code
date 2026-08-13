/**
 * Tells main which open documents hold unsaved drafts, so ⌘Q can stop and ask
 * instead of discarding them.
 *
 * Main cannot ask the renderer at quit time: `before-quit` needs a synchronous
 * verdict and the renderer may already be tearing down (see `main/quit-gate.ts`).
 * So the renderer pushes, and it pushes from the document registry rather than
 * from any one workbench — the registry is where a draft actually lives, it
 * outlives the view that made it, and it is the same flag the tab dot is drawn
 * from, so the dot and the question ⌘Q asks can never disagree.
 */

import { baseNameOf } from "@volli/shared";
import type { UnsavedDocumentsReport } from "@volli/shared";

import type { DocumentIdentity } from "./document-identity";

/** The registry surface this needs — narrowed so a test can hand it a fake. */
export interface UnsavedDocumentSource {
  unsavedDocuments(): DocumentIdentity[];
  observeUnsaved(listener: () => void): { dispose(): void };
}

/**
 * What each unsaved document is called in the quit dialog. Basenames, because
 * the sentence being built is "train.py has unsaved changes" — and because a
 * full path would put more of the user's filesystem into the main process than
 * the question needs. Duplicates are kept: two files of the same name in
 * different checkouts really are two pieces of work at risk, and the count in
 * the dialog has to say so.
 */
export function unsavedDocumentLabels(documents: readonly DocumentIdentity[]): string[] {
  return documents.map((identity) =>
    identity.kind === "ticket-body" ? "Ticket description" : baseNameOf(identity.relPath),
  );
}

/**
 * The default sink. Guarded on `window` because two surfaces mount these
 * components with no preload bridge behind them — the node-environment renderer
 * tests and the UI lab in a plain browser — and neither has an Electron app
 * whose quit there would be anything to stop.
 */
function reportToMain(report: UnsavedDocumentsReport): void {
  if (typeof window === "undefined") return;
  window.api.files.reportUnsaved(report);
}

/**
 * Starts reporting, and reports once immediately.
 *
 * The immediate report matters after a renderer reload: main keeps the last
 * thing it heard, so a stale non-empty report would otherwise outlive the drafts
 * it described. Staleness in the other direction — main believing there is
 * unsaved work when there is none — only costs one extra confirm, which is the
 * side of this to be wrong on.
 */
export function startUnsavedDocumentReporting(
  source: UnsavedDocumentSource,
  send: (report: UnsavedDocumentsReport) => void = reportToMain,
): { dispose(): void } {
  const report = () => {
    send({ names: unsavedDocumentLabels(source.unsavedDocuments()) });
  };
  const subscription = source.observeUnsaved(report);
  report();
  return subscription;
}
