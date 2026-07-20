import * as React from "react";
import { toast } from "sonner";
import { errorMessage, WORKTREE_DIRTY_REFUSAL_PREFIX } from "@volli/shared";

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
import { toastError } from "@renderer/lib/toast";

/**
 * The "Remove worktree…" escape hatch (ticket-context-menu.tsx's non-destructive
 * menu item opens this). Two steps, never silently escalating (T3's silent
 * force-removal is the anti-pattern this exists to avoid):
 *
 * 1. A plain confirm ("the branch is kept") calls `api.worktree.remove(id, false)`.
 *    A clean worktree removes right there — no further prompt.
 * 2. If main refuses because the worktree is dirty, its error names WHY; that
 *    reason replaces the confirm body and the action becomes an explicit
 *    "Discard Uncommitted Work" that re-calls `remove(id, true)`. Only THAT
 *    click ever forces.
 *
 * Open state lives in the opener (the context menu item), not a global store —
 * this component just mirrors it via `open`/`onOpenChange`.
 */
export function RemoveWorktreeDialog({
  ticketId,
  open,
  onOpenChange,
}: {
  ticketId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const [step, setStep] = React.useState<"confirm" | "dirty">("confirm");
  const [dirtyReason, setDirtyReason] = React.useState("");
  const [pending, setPending] = React.useState(false);

  // A fresh open always starts at the plain confirm, regardless of how the last
  // one ended.
  React.useEffect(() => {
    if (open) {
      setStep("confirm");
      setDirtyReason("");
      setPending(false);
    }
  }, [open]);

  async function removeClean() {
    setPending(true);
    try {
      const result = await window.api.worktree.remove(ticketId, false);
      if (result.ok) {
        toast.success("Worktree removed");
        onOpenChange(false);
        return;
      }
      // ONLY main's dirty refusal (the stable shared prefix) may escalate to
      // the force step — any other failure (git broke, path oddity) gets a
      // toast, never a "discard work" offer whose force flag could destroy
      // exactly what the failure left unprotected.
      if (!result.error.startsWith(WORKTREE_DIRTY_REFUSAL_PREFIX)) {
        toastError(`Could not remove worktree: ${result.error}`);
        onOpenChange(false);
        return;
      }
      setDirtyReason(result.error);
      setStep("dirty");
    } catch (error) {
      toastError(`Could not remove worktree: ${errorMessage(error)}`);
      onOpenChange(false);
    } finally {
      setPending(false);
    }
  }

  async function removeForced() {
    setPending(true);
    try {
      const result = await window.api.worktree.remove(ticketId, true);
      if (result.ok) {
        toast.success("Worktree removed");
        onOpenChange(false);
        return;
      }
      toastError(`Could not remove worktree: ${result.error}`);
    } catch (error) {
      toastError(`Could not remove worktree: ${errorMessage(error)}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {step === "confirm" ? "Remove worktree?" : "Worktree has uncommitted work"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {step === "confirm"
              ? "The branch is kept — only the worktree directory is removed."
              : dirtyReason}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => onOpenChange(false)}>Cancel</AlertDialogCancel>
          {step === "confirm" ? (
            <AlertDialogAction
              disabled={pending}
              onClick={(event) => {
                event.preventDefault();
                void removeClean();
              }}
            >
              Remove
            </AlertDialogAction>
          ) : (
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={(event) => {
                event.preventDefault();
                void removeForced();
              }}
            >
              Discard Uncommitted Work
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
