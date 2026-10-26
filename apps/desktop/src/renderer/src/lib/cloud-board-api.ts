/**
 * The board's per-surface door in a cloud launch (VC-889): a ticket's
 * history, body and comments read from Volli Cloud through the window's
 * client, in the legacy channels' shapes (`board-api.ts`), and its comments
 * written through the board source (gated, with their optimistic paint).
 *
 * Each read is one query; while the open ticket's own watch on the same
 * query is live (`stores/cloud-board/source.ts`), the client answers it from
 * its cache. Session facts arrive with cloud Sessions: until then the
 * sidebar's signals and status entries answer empty, which their readers
 * already treat as "nothing to say" (a ticket missing there keeps its
 * Sessions). Project settings are not on Volli Cloud yet, and refuse.
 */
import type { TicketComment } from "@volli/shared";

import { cloudBoardSource } from "../stores/board-source";
import { CLOUD_WRITES_UNAVAILABLE, cloudFailure } from "../stores/cloud-board/source";
import {
  projectComments,
  projectEvents,
  type CloudCommentRow,
  type CloudEventRow,
} from "../stores/cloud-board/projection";
import type { BoardApi } from "./board-api";
import { cloudSession, type CloudSession } from "./cloud-client";

/** What a write is told when the window has no Volli Cloud client yet. */
export const NOT_CONNECTED = "Volli Cloud isn’t connected yet.";

/** How many comments the door remembers (for an edit's ticket): oldest first out. */
export const KNOWN_COMMENTS_MAX = 10_000;

/** The comments this window has listed or written, by id: what an edit or removal is placed by. */
const known = new Map<string, TicketComment>();

function note(comment: TicketComment): TicketComment {
  known.delete(comment.id);
  known.set(comment.id, comment);
  if (known.size > KNOWN_COMMENTS_MAX) known.delete(known.keys().next().value!);
  return comment;
}

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
const notConnected = () => ({ ok: false as const, error: NOT_CONNECTED });

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
          ? {
              ok: true,
              comments: projectComments(result.answer as CloudCommentRow[]).map(note),
            }
          : result;
      },
      create: async ({ ticketId, body }) => {
        const source = cloudBoardSource();
        if (source === null) return notConnected();
        const result = await source.createComment(ticketId, body);
        return result.ok ? { ok: true, comment: note(result.comment) } : result;
      },
      update: async ({ commentId, body }) => {
        const source = cloudBoardSource();
        const comment = known.get(commentId);
        if (source === null || comment === undefined) return notConnected();
        const result = await source.updateComment(comment.ticketId, commentId, body);
        return result.ok
          ? { ok: true, comment: note({ ...comment, body, updatedAt: Date.now() }) }
          : result;
      },
      remove: async ({ commentId }) => {
        const source = cloudBoardSource();
        const comment = known.get(commentId);
        if (source === null || comment === undefined) return notConnected();
        const result = await source.removeComment(comment.ticketId, commentId);
        if (result.ok) known.delete(commentId);
        return result;
      },
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
