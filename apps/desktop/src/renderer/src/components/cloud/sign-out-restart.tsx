/**
 * Signing out of a cloud launch (VC-889): one confirm, then main signs out
 * and restarts Volli into this Mac's projects through the normal quit gates.
 * A gate that cancels the restart leaves the window on the blocked "Signed
 * out of Volli Cloud · Restart Volli" state, never a half-cloud board.
 */
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import { closeCloudClient } from "@renderer/lib/cloud-client";
import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";
import { toastError } from "@renderer/lib/toast";

/** The two commands the restart takes. */
export interface SignOutRestartRpc {
  readonly account: { readonly signOut: { mutate(): Promise<unknown> } };
  readonly cloud: { readonly relaunch: { mutate(): Promise<unknown> } };
}

function failed(error: unknown, fallback: string): void {
  toastError(error instanceof Error && error.message !== "" ? error.message : fallback);
}

/**
 * Signs out, closes this window's Volli Cloud client (its cache and token go
 * now, before the restart), then asks for the restart. A failure says what
 * main said.
 */
export async function signOutAndRestart(
  rpc: SignOutRestartRpc = sessionRpcClient(),
): Promise<void> {
  try {
    await rpc.account.signOut.mutate();
  } catch (error) {
    failed(error, "Sign out failed.");
    return;
  }
  closeCloudClient();
  try {
    await rpc.cloud.relaunch.mutate();
  } catch (error) {
    failed(error, "Couldn’t restart Volli.");
  }
}

export function SignOutRestartDialog({
  open,
  onOpenChange,
  rpc,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  rpc?: SignOutRestartRpc;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Sign out and restart Volli?</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
          <AlertDialogAction size="sm" onClick={() => void signOutAndRestart(rpc)}>
            Sign out and restart
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
