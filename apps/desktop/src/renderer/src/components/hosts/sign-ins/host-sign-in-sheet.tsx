/**
 * The host sign-in sheet (VC-702 PR 2): one remote host's sign-ins, opened
 * from the host chip ("Sign-ins on <host>…", or "Sign in" on an expired
 * sign-in, which also starts that provider's sign-in once the host answers
 * main's preflight). The rows, their confirm and their flows are
 * {@link HostSignInRows}; this is the frame and the controller's lifetime.
 */
import * as React from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";

import { HostSignInController, type HostSignInSource } from "./host-sign-in-controller";
import { HostSignInRows, useHostSignIns } from "./host-sign-in-rows";
import {
  remoteHostSignInSource,
  useHostSignInSheet,
  type HostSignInSheetTarget,
  type HostSignInsRpc,
} from "./remote-host-sign-in-source";

/**
 * A device code's page opens in this Mac's browser through the app's one
 * external-open seam: main's `setWindowOpenHandler` denies the window and
 * hands the url to `shell.openExternal`.
 */
function openInBrowser(url: string): void {
  window.open(url, "_blank", "noopener");
}

let defaultSource: HostSignInSource | null = null;
/* v8 ignore next 5 -- the real tier client exists only in the app; tests pass a source. */
function appSource(): HostSignInSource {
  defaultSource ??= remoteHostSignInSource(
    sessionRpcClient() as unknown as HostSignInsRpc,
    openInBrowser,
  );
  return defaultSource;
}

export function HostSignInSheet({ source }: { source?: HostSignInSource }) {
  const target = useHostSignInSheet((state) => state.target);
  const close = useHostSignInSheet((state) => state.close);
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && close()}>
      {target !== null && (
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-xl">
          <HostSignInSheetBody
            key={`${target.hostId}:${target.providerId ?? ""}`}
            target={target}
            source={source ?? appSource()}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}

function HostSignInSheetBody({
  target,
  source,
}: {
  target: HostSignInSheetTarget;
  source: HostSignInSource;
}) {
  const controller = React.useMemo(
    () => new HostSignInController(source, target.hostId),
    [source, target.hostId],
  );
  const snapshot = useHostSignIns(controller);
  // "Sign in again": that provider's sign-in starts once, as the sheet opens.
  React.useEffect(() => {
    if (target.providerId !== null) controller.beginSignIn(target.providerId);
  }, [controller, target.providerId]);
  // Closing the sheet cancels what still runs; the host keeps what finished.
  React.useEffect(() => () => controller.dispose(), [controller]);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Sign-ins on {target.hostName}</DialogTitle>
        <DialogDescription>
          Agents on {target.hostName} use these. Keys and tokens are stored on that host.
        </DialogDescription>
      </DialogHeader>
      <HostSignInRows hostName={target.hostName} snapshot={snapshot} controller={controller} />
    </>
  );
}
