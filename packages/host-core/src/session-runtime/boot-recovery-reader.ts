/**
 * Boot recovery's reads over the SQLite ledger: which Sessions the sweep could
 * act on, and when the prior process was last alive, without folding every
 * Session the machine ever had (VC-1095).
 *
 * The sweep used to list every project's whole roster, folded, before
 * readiness. On a long-lived profile that is thousands of folds and hundreds
 * of megabytes to find the handful of Sessions a relaunch actually touches.
 * Here the ledger's indexed facts pick the candidates and only those are
 * folded, through the engine's ordinary `getSession`, which still decides.
 * It is the same pattern as `listAttachedSessions` (VC-403) and
 * `listPossiblyLiveProjectRunsForAutomation` (VC-816): the query decides
 * nothing except which Sessions skip the fold, and every test in it is wider
 * than the fold, never narrower.
 */
import type Database from "better-sqlite3";
import type { SessionEngine } from "@volli/session-engine";
import {
  decodeSessionEventPayload,
  movesSessionActivity,
  UnknownSessionEventKindError,
  type SessionEventPayload,
} from "@volli/shared";

import { prepared } from "../db/prepared";
import type { BootRecoveryEngine } from "./boot-recovery";
import { STRUCTURED_ADAPTER_ID } from "./sessions";

/**
 * What the fold does with a fact of each kind, as far as the three states the
 * sweep acts on go: whether a turn is active, whether an Interaction is still
 * waiting, and whether an attachment is open.
 *
 * Exhaustive over every payload kind, so a new kind fails to compile until
 * someone says what it does here. {@link CANDIDATES_SQL}'s kind lists are
 * built from this map, never typed out beside it: a kind that starts or ends a
 * turn, or opens or ends an Interaction, is in the query the moment it is
 * classified. A kind that opens an attachment cannot be added that way:
 * attachments are read from `session_attachments`, which the ledger writes for
 * `attachment.opened` alone, and the reader's test pins that set.
 *
 * `attachment.closed` and `attachment.failed` end a turn whatever else they
 * do, and are classified by that. A close's other effect is the
 * `closed_sequence` mark the ledger writes beside it.
 */
const KIND_ROLE = {
  "turn.started": "starts-turn",
  "turn.completed": "ends-turn",
  "turn.interrupted": "ends-turn",
  "attachment.closed": "ends-turn",
  "attachment.failed": "ends-turn",
  "interaction.opened": "opens-interaction",
  "interaction.resolved": "ends-interaction",
  "interaction.cancelled": "ends-interaction",
  "attachment.opened": "opens-attachment",
  "adapter.observed": "inert",
  "attention.cleared": "inert",
  "attention.raised": "inert",
  "attachment.exited": "inert",
  "attachment.native_referenced": "inert",
  "command.receipt.recorded": "inert",
  "command.recorded": "inert",
  "context.compacted": "inert",
  "context.compaction_failed": "inert",
  "context.reasoning_dropped": "inert",
  "model.selected": "inert",
  "run.completed": "inert",
  "run.started": "inert",
  "session.archived": "inert",
  "session.created": "inert",
  "session.input.recorded": "inert",
  "session.retitled": "inert",
  "session.signaled": "inert",
  "session.stopped": "inert",
  "session.tools.refreshed": "inert",
  "transcript.referenced": "inert",
  "usage.recorded": "inert",
} as const satisfies Record<SessionEventPayload["kind"], BootRecoveryKindRole>;

type BootRecoveryKindRole =
  | "starts-turn"
  | "ends-turn"
  | "opens-interaction"
  | "ends-interaction"
  | "opens-attachment"
  | "inert";

type KindWith<Role extends BootRecoveryKindRole> = {
  [Kind in keyof typeof KIND_ROLE]: (typeof KIND_ROLE)[Kind] extends Role ? Kind : never;
}[keyof typeof KIND_ROLE];

/** The kinds the fold reads in one role, in the map's order. */
function bootRecoveryKinds<Role extends BootRecoveryKindRole>(
  role: Role,
): readonly KindWith<Role>[] {
  return (Object.keys(KIND_ROLE) as (keyof typeof KIND_ROLE)[]).filter(
    (kind): kind is KindWith<Role> => KIND_ROLE[kind] === role,
  );
}

/** Compiles only when `Actual` is exactly `Expected`. */
type Exactly<Actual, Expected> = [Actual] extends [Expected]
  ? [Expected] extends [Actual]
    ? true
    : never
  : never;
/** Compiles only when every arm of `Payload` carries `Shape`. */
type Carries<Payload, Shape> = [Payload] extends [Shape] ? true : never;

/**
 * What the query reads besides the kind lists, each checked against the map.
 * Attachments come from `session_attachments`, which the ledger writes for
 * `attachment.opened` alone: a second kind that opens one needs the query and
 * the ledger's projection changed with it. An Interaction's id is read at
 * `interaction.id` on an opening and at `interactionId` on an ending.
 */
const QUERY_READS: {
  opensAttachment: Exactly<KindWith<"opens-attachment">, "attachment.opened">;
  openingId: Carries<
    Extract<SessionEventPayload, { kind: KindWith<"opens-interaction"> }>,
    { interaction: { id: string } }
  >;
  endingId: Carries<
    Extract<SessionEventPayload, { kind: KindWith<"ends-interaction"> }>,
    { interactionId: string }
  >;
} = { opensAttachment: true, openingId: true, endingId: true };

/** A kind as an SQL string literal. Kinds are this file's constants, never input. */
function literal(kind: string): string {
  return `'${kind.replaceAll("'", "''")}'`;
}

/** The newest sequence of any of these kinds in Session `s`, 0 when it has none. */
function latestOf(kinds: readonly string[]): string {
  // One index-only MAX seek per kind; the leading 0 keeps MAX scalar for one kind.
  const seeks = kinds.map(
    (kind) => `COALESCE((SELECT MAX(fact.sequence) FROM session_event_sequence fact
                 WHERE fact.session_id = s.id AND fact.kind = ${literal(kind)}), 0)`,
  );
  return `MAX(0, ${seeks.join(", ")})`;
}

const OPENING_ID_PATH = QUERY_READS.openingId && "$.interaction.id";
const ENDING_ID_PATH = QUERY_READS.endingId && "$.interactionId";
const OPENS_INTERACTION = bootRecoveryKinds("opens-interaction").map(literal).join(", ");
const ENDS_INTERACTION = bootRecoveryKinds("ends-interaction").map(literal).join(", ");

/**
 * A project's Sessions the sweep could act on, newest first like a listing.
 *
 * The sweep acts on a Session only through one of its attachments or its
 * Interactions, and each clause below keeps every Session the fold could put
 * in one of those states:
 *
 *  - **An open attachment that is not the structured adapter's** is closed as
 *    not rebuildable. `session_attachments` records every opened attachment
 *    with the adapter its `attachment.opened` named, and `closed_sequence`
 *    (migration 051) is set by the `attachment.closed` that the fold reads as
 *    the close, so an attachment the fold calls open always has a row here
 *    with `closed_sequence IS NULL` — the partial `session_attachments_open`
 *    index.
 *  - **An open structured attachment under an active turn** is reconciled.
 *    The fold sets `turnActive` only on a kind that starts a turn and clears
 *    it on each kind that ends one ({@link KIND_ROLE}), so it can be set only
 *    when the latest start follows every end. Each is an index-only MAX on
 *    `session_event_sequence_match (session_id, kind, sequence)`. That
 *    sequence is the fleet's append order, and within one Session it is the
 *    Session's own order: the ledger appends a Session's event only as its
 *    head plus one, and the trigger numbers the row as it is inserted.
 *  - **An active Interaction** is cancelled, on any structured attachment,
 *    open or not. The fold opens one only on an opening kind and ends it only
 *    on an ending kind for the same id that comes later, and a reopening
 *    replaces it, so an id is active exactly when its latest opening follows
 *    its latest ending. One grouped pass per Session compares the two, reading
 *    JSON only from those few rows.
 *
 * Wider than the fold in two places, on purpose. The venue and adapter of a
 * turn's or an Interaction's attachment are left to the fold: a Session another
 * runner holds is kept and then left alone by the sweep. And an unanswered
 * Interaction from the retired approval gates (`ask:` / `approval-retry:` ids,
 * or an `approval` field) is inert in the fold, which decodes it as legacy
 * evidence, but is kept here: mirroring the codec's retirement rule in SQL
 * would put a second copy of it where it could drift into a narrower test. Such
 * a Session is folded at each boot and left alone.
 */
const CANDIDATES_SQL = `
SELECT s.id FROM sessions s
 WHERE s.project_id = @projectId
   AND (
     EXISTS (
       SELECT 1 FROM session_attachments attachment
        WHERE attachment.session_id = s.id
          AND attachment.closed_sequence IS NULL
          AND attachment.observed_kind = 'opened'
          AND (
            attachment.adapter_id <> @structured
            OR ${latestOf(bootRecoveryKinds("starts-turn"))}
               > ${latestOf(bootRecoveryKinds("ends-turn"))}
          )
     )
     OR EXISTS (
       SELECT 1 FROM (
         SELECT CASE WHEN fact.kind IN (${OPENS_INTERACTION})
                     THEN json_extract(event.payload, '${OPENING_ID_PATH}')
                     ELSE json_extract(event.payload, '${ENDING_ID_PATH}') END AS interaction_id,
                MAX(CASE WHEN fact.kind IN (${OPENS_INTERACTION}) THEN event.sequence END) AS opened,
                MAX(CASE WHEN fact.kind IN (${ENDS_INTERACTION}) THEN event.sequence END) AS ended
           FROM session_event_sequence fact
           JOIN session_events event ON event.id = fact.event_id
          WHERE fact.session_id = s.id
            AND fact.kind IN (${OPENS_INTERACTION}, ${ENDS_INTERACTION})
          GROUP BY interaction_id
       ) interaction
        WHERE interaction.opened > COALESCE(interaction.ended, 0)
     )
   )
 ORDER BY s.created_at DESC, s.id COLLATE BINARY DESC`;

/** The ledger's reads boot recovery needs, over the engine that still folds. */
export function createBootRecoveryEngine(input: {
  db: Database.Database;
  engine: Pick<SessionEngine, "getSession" | "observe">;
  /**
   * The launch's Session scope (a cloud owner's, or the frozen local one):
   * a Session outside it is neither swept nor counted. Absent, every Session.
   */
  owns?(sessionId: string): boolean;
}): BootRecoveryEngine {
  const { db, engine } = input;
  const owns = input.owns ?? (() => true);
  return {
    async listRecoveryCandidates({ projectId }) {
      const rows = prepared<[{ projectId: string; structured: string }], { id: string }>(
        db,
        CANDIDATES_SQL,
      ).all({ projectId, structured: STRUCTURED_ADAPTER_ID });
      const sessions = [];
      for (const { id } of rows) {
        if (!owns(id)) continue;
        const projection = await engine.getSession({ sessionId: id });
        if (projection !== null) sessions.push(projection);
      }
      return sessions;
    },
    async latestActivityAt({ projectIds, excluding }) {
      return latestActivityAt(db, projectIds, excluding, owns);
    },
    getSession: (query) => engine.getSession(query),
    observe: (observation) => engine.observe(observation),
  };
}

/**
 * The newest `lastActivityAt` among these projects' Sessions, by the fold's
 * rule without the fold.
 *
 * The fold seeds a Session's activity from its creation and moves it to the
 * `occurredAt` of each later fact that {@link movesSessionActivity} counts, so
 * its answer is the `occurredAt` of the LAST counted fact by sequence — not
 * the newest one, since a source's clock can run backwards — or the creation
 * time when none counts. That is read from the log's tail, newest first,
 * through the same payload decode the fold's reads use: a retired kind decodes
 * as the inert fact the fold sees, and a kind this build does not know is
 * dropped here as the fold's read drops it. A projection checkpoint changes
 * nothing, because it holds what the same fold made of the same prefix.
 *
 * Ownership is asked only of a Session that would raise the answer, so a
 * scope check is paid by a handful of Sessions, not the roster.
 */
function latestActivityAt(
  db: Database.Database,
  projectIds: readonly string[],
  excluding: ReadonlySet<string>,
  owns: (sessionId: string) => boolean,
): number | null {
  const sessions = prepared<[string], { id: string; created_at: number }>(
    db,
    "SELECT id, created_at FROM sessions WHERE project_id = ?",
  );
  const tail = prepared<[string], { occurred_at: number; payload: string }>(
    db,
    "SELECT occurred_at, payload FROM session_events WHERE session_id = ? ORDER BY sequence DESC",
  );
  let latest: number | null = null;
  for (const projectId of projectIds) {
    for (const session of sessions.all(projectId)) {
      if (excluding.has(session.id)) continue;
      let activity = session.created_at;
      for (const event of tail.iterate(session.id)) {
        const context = `session_events row of ${session.id}`;
        let kind;
        try {
          kind = decodeSessionEventPayload(JSON.parse(event.payload), context).kind;
        } catch (error) {
          if (error instanceof UnknownSessionEventKindError) continue;
          throw error;
        }
        if (!movesSessionActivity(kind)) continue;
        activity = event.occurred_at;
        break;
      }
      if ((latest === null || activity > latest) && owns(session.id)) latest = activity;
    }
  }
  return latest;
}
