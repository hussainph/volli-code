import type { CloudMovesApi } from "@volli/shared";
import { sessionRpcClient } from "./session-rpc-ipc-link";

/** The same admitted handler map as other desktop operations; no bespoke IPC door. */
export function desktopCloudMovesApi(): CloudMovesApi {
  const rpc = sessionRpcClient().moves;
  return {
    snapshot: () => rpc.snapshot.query(),
    preflight: (input) => rpc.preflight.query(input),
    start: async (input) => {
      await rpc.start.mutate(input);
    },
    command: async (input) => {
      await rpc.command.mutate(input);
    },
    report: (moveId) => rpc.report.query({ moveId }),
    onChanged: (listener, failed) => {
      const subscription = rpc.subscribe.subscribe(undefined, {
        onData: listener,
        onError: failed ?? listener,
      });
      return () => subscription.unsubscribe();
    },
  };
}
