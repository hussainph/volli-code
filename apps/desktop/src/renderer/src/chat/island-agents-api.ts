import { sessionRpcClient, type SessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";

/** The stop door the island mount can replace for a non-Electron client. */
export interface IslandAgentsApi {
  stop(input: {
    sessionId: string;
    reason?: string;
  }): Promise<
    | { ok: true; interrupted: boolean; released: boolean; failures: readonly string[] }
    | { ok: false; error: string }
  >;
}

/** `session.command` as the router types it: its input and its answer. */
type CommandDoor = (
  input: Parameters<SessionRpcClient["session"]["command"]["mutate"]>[0],
) => ReturnType<SessionRpcClient["session"]["command"]["mutate"]>;

/** UI compatibility shape over the shared host protocol, not a preload verb. */
export function islandAgentsApi(command: CommandDoor, newCommandId: () => string): IslandAgentsApi {
  return {
    stop: async (input) => {
      const result = await command({
        commandId: newCommandId(),
        sessionId: input.sessionId,
        command: {
          kind: "session.stop",
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
      });
      if (result.stop === undefined) throw new Error("Session stop returned no runtime outcome.");
      return {
        ok: true,
        interrupted: result.stop.interrupted,
        released: result.stop.released,
        failures: result.stop.failures,
      };
    },
  };
}

export function browserIslandAgentsApi(): IslandAgentsApi | undefined {
  if (typeof window === "undefined" || window.api?.sessionRpc === undefined) return undefined;
  return islandAgentsApi(
    (input) => sessionRpcClient().session.command.mutate(input),
    () => crypto.randomUUID(),
  );
}
