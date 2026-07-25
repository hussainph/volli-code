/**
 * The view half of the file dirty-close guard — the three answers (Save /
 * Discard / Cancel) offered whenever closing a tab would drop an explicit-save
 * draft. Paired with the pure `close-guard.ts` next to it: that module decides
 * whether to prompt and what the answer means, this one only asks.
 *
 * ONE component for both surfaces (the Project Files workbench and a ticket's
 * file tabs) because closing a tab is the one moment work can be lost for good,
 * and the two surfaces must not drift in what they offer or how it reads.
 *
 * Discard is the destructive answer and is styled as such; Save is the default
 * action. Dismissing by Esc or the overlay is a Cancel — the answer that
 * changes nothing.
 */
import { baseNameOf } from "@volli/shared";

import type { TabCloseResolution } from "@renderer/components/files/close-guard";
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

export function FileSaveGuardDialog({
  relPath,
  onCancel,
  onChoose,
}: {
  /** The tab being asked about, or `null` when no guard is open. */
  relPath: string | null;
  onCancel(): void;
  onChoose(choice: TabCloseResolution["choice"]): void;
}) {
  const name = relPath === null ? "" : baseNameOf(relPath);
  return (
    <AlertDialog
      open={relPath !== null}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent data-testid="file-save-guard">
        <AlertDialogHeader>
          <AlertDialogTitle>Save changes to {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {name} has unsaved changes. Closing it without saving discards them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="file-save-guard-cancel">Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            data-testid="file-save-guard-discard"
            onClick={() => onChoose("discard")}
          >
            Discard
          </AlertDialogAction>
          <AlertDialogAction data-testid="file-save-guard-save" onClick={() => onChoose("save")}>
            Save
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
