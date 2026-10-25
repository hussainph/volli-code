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
import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";
import { toastError } from "@renderer/lib/toast";

/** The two commands the restart takes. */
export interface SignOutRestartRpc {
  readonly account: { readonly signOut: { mutate(): Promise<unknown> } };
  readonly cloud: { readonly relaunch: { mutate(): Promise<unknown> } };
}

/** Signs out, then asks for the restart; a failure says what main said. */
export async function signOutAndRestart(
  rpc: SignOutRestartRpc = sessionRpcClient(),
): Promise<void> {
  try {
    await rpc.account.signOut.mutate();
    await rpc.cloud.relaunch.mutate();
  } catch (error) {
    toastError(error instanceof Error && error.message !== "" ? error.message : "Sign out failed.");
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
