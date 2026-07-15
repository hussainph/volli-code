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
import { describeBusy, type PendingClose } from "@renderer/terminal/close-guard";

/**
 * The confirm shown before a destructive close when one or more of the affected
 * terminals is still running a foreground process. Controlled purely by a
 * {@link PendingClose} (null = closed) so one instance serves every close
 * surface. Title/confirm-label/verb are overridable: the ticket-archive gate
 * reuses it with "Archive ticket?" / "Archive Anyway" / "Archiving".
 */
export function ConfirmCloseDialog({
  pending,
  onConfirm,
  onCancel,
  title = "Close terminal?",
  confirmLabel = "Close Anyway",
  verb = "Closing",
}: {
  pending: PendingClose | null;
  onConfirm: () => void;
  onCancel: () => void;
  title?: string;
  confirmLabel?: string;
  /** Gerund used in "… still running. {verb} will end it." */
  verb?: string;
}) {
  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            {pending ? describeBusy(pending.processes, `. ${verb} will end`) : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
