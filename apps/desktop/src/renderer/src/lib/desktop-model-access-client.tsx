import * as React from "react";
import type { ModelAccessSignInType, ModelAccessSignInUpdate } from "@volli/shared";
import type { Result } from "../../../ipc/contract";

import {
  ModelAccessProvider,
  type ModelAccessClient,
  type ModelAccessSignInSession,
} from "@renderer/lib/model-access-client";
import {
  claimSignInUpdates,
  listenForSignInUpdates,
} from "@renderer/lib/model-access-sign-in-channel";
import { sessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";

/**
 * Model Access over the two doors it actually has.
 *
 * Reads go over Session RPC, which already owns the snapshot and its zod
 * schema. Sign-in does not, and the split is deliberate rather than historical:
 * every RPC procedure is wrapped by a diagnostic recorder whose ring buffer a
 * lab subscription can tap, and one argument of a sign-in is an API key. The
 * dedicated `api.modelAccess` channels record nothing.
 */
export function DesktopModelAccessProvider({ children }: React.PropsWithChildren) {
  const client = React.useMemo<ModelAccessClient>(() => {
    const rpc = sessionRpcClient();
    return {
      inspect: (input) => rpc.modelAccess.inspect.query(input),
      defaults: () => rpc.modelAccess.defaults.query(),
      setDefault: (purpose, selection) => rpc.modelAccess.setDefault.mutate({ purpose, selection }),
      hiddenModels: () => rpc.modelAccess.hiddenModels.query(),
      setHiddenModels: (hidden) => rpc.modelAccess.setHiddenModels.mutate([...hidden]),
      compactionPolicy: () => rpc.modelAccess.compactionPolicy.query(),
      setCompactionPolicy: (policy) =>
        rpc.modelAccess.setCompactionPolicy.mutate({ autoCompaction: policy.autoCompaction }),
      beginSignIn: (providerId, type, onUpdate) => beginSignIn(providerId, type, onUpdate),
      signOut: async (providerId) => {
        expect(await window.api.modelAccess.signOut(providerId));
      },
    };
  }, []);
  return <ModelAccessProvider client={client}>{children}</ModelAccessProvider>;
}

/**
 * Subscribes, then starts — never the other way round.
 *
 * {@link listenForSignInUpdates} runs before the `invoke` because main answers
 * an api-key login by prompting inside the same synchronous stretch that
 * handles this call, so the first prompt is queued to this process before the
 * id it belongs to is. Claiming after the await is still correct: the channel
 * holds what arrived early and replays it in order.
 */
async function beginSignIn(
  providerId: string,
  type: ModelAccessSignInType,
  onUpdate: (update: ModelAccessSignInUpdate) => void,
): Promise<ModelAccessSignInSession> {
  listenForSignInUpdates();
  const started = await window.api.modelAccess.beginSignIn(providerId, type);
  if (!started.ok) throw new Error(started.error);
  const { attemptId } = started;
  const release = claimSignInUpdates(attemptId, (update) => {
    onUpdate(update);
    // A settled attempt has nothing more to say, and leaving the route in
    // place would hold the row's closure for the life of the renderer.
    if (update.kind === "settled") release();
  });
  return {
    attemptId,
    respond: async (promptId, value) => {
      expect(await window.api.modelAccess.respondToPrompt(attemptId, promptId, value));
    },
    cancel: async () => {
      expect(await window.api.modelAccess.cancelSignIn(attemptId));
    },
  };
}

/** Turns the IPC surface's `Result` into the rejection every caller here already handles. */
function expect(result: Result): void {
  if (!result.ok) throw new Error(result.error);
}
