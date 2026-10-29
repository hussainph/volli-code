import type {
  CloudMoveSnapshot,
  CloudMovePreflightInput,
  CloudMovePreflight,
  CloudMoveStartInput,
  CloudMoveCommand,
} from "@volli/shared";

/** The renderer's view/controller boundary over the typed desktop RPC client. */
export interface CloudMovesClient {
  snapshot(): Promise<CloudMoveSnapshot>;
  preflight(input: CloudMovePreflightInput): Promise<CloudMovePreflight>;
  start(input: CloudMoveStartInput): Promise<void>;
  command(input: CloudMoveCommand): Promise<void>;
  report(moveId: string): Promise<string>;
  onChanged(listener: () => void, failed?: () => void): () => void;
}
import { sessionRpcClient } from "./session-rpc-ipc-link";

/** The same admitted handler map as other desktop operations; no bespoke IPC door. */
export function desktopCloudMovesApi(): CloudMovesClient {
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
