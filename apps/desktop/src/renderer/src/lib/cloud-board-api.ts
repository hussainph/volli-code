/**
 * The board's per-surface door in a cloud launch (VC-889): a ticket's
 * history, body and comments read from Volli Cloud through the window's
 * client, in the legacy channels' shapes (`board-api.ts`).
 *
 * Each read is one query; while the open ticket's own watch on the same
 * query is live (`stores/cloud-board/source.ts`), the client answers it from
 * its cache. Session facts arrive with cloud Sessions: until then the
 * sidebar's signals and status entries answer empty, which their readers
 * already treat as "nothing to say" (a ticket missing there keeps its
 * Sessions). Writes are refused in this release, with the board's words.
 */
import { CLOUD_WRITES_UNAVAILABLE, cloudFailure } from "../stores/cloud-board/source";
import {
  projectComments,
  projectEvents,
  type CloudCommentRow,
  type CloudEventRow,
} from "../stores/cloud-board/projection";
import type { BoardApi } from "./board-api";
import { cloudSession, type CloudSession } from "./cloud-client";

const NOT_CONNECTED = "Volli Cloud isn’t connected yet.";

/** One read through the running client, its failure in the board's words. */
async function read<Answer>(
  run: (session: CloudSession) => Promise<Answer>,
): Promise<{ ok: true; answer: Answer } | { ok: false; error: string }> {
  const session = cloudSession();
  if (session === null) return { ok: false, error: NOT_CONNECTED };
  try {
    return { ok: true, answer: await run(session) };
  } catch (error) {
    return { ok: false, error: cloudFailure(error).message };
  }
}

const refused = async () => ({ ok: false as const, error: CLOUD_WRITES_UNAVAILABLE });

export function cloudBoardApi(): BoardApi {
  return {
    tickets: {
      events: async ({ ticketId }) => {
        const result = await read(({ client, api }) =>
          client.query(api.board.ticketEvents, { ticketId }),
        );
        return result.ok
          ? { ok: true, events: projectEvents(result.answer as CloudEventRow[]) }
          : result;
      },
      body: async ({ ticketId }) => {
        const result = await read(({ client, api }) =>
          client.query(api.board.getTicket, { ticketId }),
        );
        return result.ok ? { ok: true, body: result.answer.body } : result;
      },
      latestSignals: async () => ({ ok: true, signals: [] }),
      statusEntries: async () => ({ ok: true, entries: [] }),
    },
    comments: {
      list: async ({ ticketId }) => {
        const result = await read(({ client, api }) =>
          client.query(api.board.comments, { ticketId }),
        );
        return result.ok
          ? { ok: true, comments: projectComments(result.answer as CloudCommentRow[]) }
          : result;
      },
      create: refused,
      update: refused,
      remove: refused,
    },
    projects: {
      update: refused,
      setSkillModes: refused,
      setSessionDefaults: refused,
      // A cloud project has no folder on this Mac to go missing.
      checkFolder: async () => ({ ok: true, path: "", state: "present" }),
    },
  };
}
