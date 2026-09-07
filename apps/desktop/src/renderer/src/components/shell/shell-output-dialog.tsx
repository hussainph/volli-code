/**
 * Where a background shell's tail opens from the Activity Island (VC-268,
 * for VC-270's `openShell`).
 *
 * A modal over the chat, and deliberately not a workspace tab: no tab kind
 * registers `ShellOutputView`, the tail is read-only, and a person opening
 * one wants to glance at the output and go back to the chat that started it
 * — the overlay closes on Escape and the chat is exactly where it was. If a
 * tail ever earns a persistent home, the island's verb does not change; the
 * mount hands `openShellOutput` a different destination.
 *
 * The view is MOUNTED ONLY WHILE OPEN, and that is load-bearing rather than
 * tidy: `ShellOutputView` re-reads a running shell's whole retained buffer
 * every 500ms for as long as it exists, so a view kept mounted-but-hidden
 * would pay for output nobody is reading. Closing the dialog unmounts the
 * view, and the poll with it.
 *
 * A Radix portal, so a pinned Browser preview under it freezes onto pixels
 * for as long as it is open — the same rule every menu obeys.
 */
import { ShellOutputView } from "@renderer/components/shell/shell-output-view";
import { Dialog, DialogContent, DialogTitle } from "@renderer/components/ui/dialog";
import type { ShellsApi } from "@renderer/stores/background-shells";

export interface ShellOutputDialogProps {
  /** The shell whose tail is open, or `null` for none. */
  shellId: string | null;
  api: Pick<ShellsApi, "tail">;
  onClose(): void;
}

export function ShellOutputDialog({ shellId, api, onClose }: ShellOutputDialogProps) {
  return (
    <Dialog
      open={shellId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-shell-output-dialog=""
        className="flex h-[70vh] max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
      >
        {/* A title row of the dialog's own, tall enough that the content's
            close button (top-4 right-4) lands inside it rather than over the
            view's header, which names the command and its standing below. */}
        <div className="flex h-10 shrink-0 items-center border-b border-border px-4">
          <DialogTitle className="text-ui font-medium">Shell output</DialogTitle>
        </div>
        {shellId === null ? null : (
          <ShellOutputView shellId={shellId} api={api} className="min-h-0 flex-1" />
        )}
      </DialogContent>
    </Dialog>
  );
}
