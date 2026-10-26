/**
 * "Choose the folder for <project> on this Mac" (VC-895 N2-3), as a project's
 * start surface reads it: whether this Mac knows a Volli Cloud project's
 * folder, and the one recovery when it does not.
 *
 * Both go through main's desktop-only `checkouts.*` entries: only main holds
 * this runner's local path registry and can show the system folder picker.
 * Neither answer carries the path. Outside a Volli Cloud launch (every
 * flag-off one included) this hook asks main nothing and offers nothing.
 */
import * as React from "react";
import type { CloudCheckoutChoice, CloudCheckoutStatus } from "@volli/shared";

import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";
import { toastError } from "@renderer/lib/toast";
import { launchStore } from "@renderer/stores/launch";

/** What the tier client offers this hook: `checkouts.*`, as tRPC types it. */
export interface CloudCheckoutRpc {
  readonly checkouts: {
    readonly status: { query(input: { projectId: string }): Promise<CloudCheckoutStatus> };
    readonly chooseFolder: {
      mutate(input: { projectId: string }): Promise<CloudCheckoutChoice>;
    };
  };
}

/**
 * `none`: nothing to offer (not a cloud launch, the folder is known, this Mac
 * is not a runner yet, or the status could not be read). `missing`: the
 * folder is unknown here; `choose` opens the picker.
 */
export type CloudCheckoutView =
  | { readonly kind: "none" }
  | { readonly kind: "missing"; readonly choosing: boolean; choose(): Promise<void> };

const NONE: CloudCheckoutView = { kind: "none" };

const failureOf = (error: unknown): string =>
  error instanceof Error && error.message !== "" ? error.message : "Couldn’t choose the folder.";

export function useCloudCheckout(
  projectId: string | null,
  {
    rpc,
    cloud = launchStore() === "cloud",
  }: {
    /** The tier client; a test's to replace. Read only in a cloud launch. */
    rpc?: CloudCheckoutRpc;
    /** Whether this launch is a Volli Cloud one; fixed for the process. */
    cloud?: boolean;
  } = {},
): CloudCheckoutView {
  const client = React.useMemo(() => (cloud ? (rpc ?? sessionRpcClient()) : null), [cloud, rpc]);
  const [state, setState] = React.useState<CloudCheckoutStatus["state"] | null>(null);
  const [choosing, setChoosing] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    setState(null);
    if (client === null || projectId === null) return;
    let live = true;
    client.checkouts.status.query({ projectId }).then(
      (status) => {
        if (live) setState(status.state);
      },
      // A status that cannot be read offers nothing: the Session start's own
      // refusal still names the folder, and that is where its failure shows.
      () => {
        if (live) setState(null);
      },
    );
    return () => {
      live = false;
    };
  }, [client, projectId, attempt]);

  const choose = React.useCallback(async () => {
    if (client === null || projectId === null) return;
    setChoosing(true);
    try {
      const choice = await client.checkouts.chooseFolder.mutate({ projectId });
      if (choice.outcome === "chosen") setAttempt((count) => count + 1);
    } catch (error) {
      toastError(failureOf(error));
    } finally {
      setChoosing(false);
    }
  }, [client, projectId]);

  if (client === null || projectId === null || state !== "missing") return NONE;
  return { kind: "missing", choosing, choose };
}
