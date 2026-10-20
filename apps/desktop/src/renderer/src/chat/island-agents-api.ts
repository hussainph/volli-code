import { sessionCommandFor, type SessionCommandDoor } from "@renderer/chat/transport";
import { projectOfSession } from "@renderer/lib/session-project";

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
type CommandDoor = SessionCommandDoor;

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

/**
 * The window's Stop door. A subagent's Stop goes where the subagent lives
 * (VC-713, B2): its host's Workspace for a Session on a remote host — its own
 * project, else the parent's (`parentProjectId`), since a child absent from
 * every listing lives where its parent does — and This Mac's IPC only for a Session of This Mac.
 */
export function browserIslandAgentsApi(parentProjectId?: string): IslandAgentsApi | undefined {
  if (typeof window === "undefined" || window.api?.sessionRpc === undefined) return undefined;
  return islandAgentsApi(
    (input) => {
      const own = input.sessionId === undefined ? null : projectOfSession(input.sessionId);
      return sessionCommandFor(own ?? parentProjectId ?? null)(input);
    },
    () => crypto.randomUUID(),
  );
}
