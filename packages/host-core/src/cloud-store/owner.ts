/** Account scoping over the one host writer; cursors and durable birth ownership must agree. */
import type Database from "better-sqlite3";
import type { CreateSessionRequest, SessionEngine } from "@volli/session-engine";
import {
  reportSessionUsage,
  type SessionLedger,
  type Session,
  type SessionProjection,
} from "@volli/shared";
import { setImmediate } from "node:timers/promises";
import { prepared } from "../db/prepared";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import { localSessionRow, sessionBirthOwnerCompatible } from "../db/local-product";

/** Defense in depth for runner jobs as well as in-process Session commands. */
export class SessionOwnerError extends Error {
  readonly code = "not_your_runner";
  readonly retryable = false;
  constructor() {
    super("This Session does not belong to this runner's owner.");
    this.name = "SessionOwnerError";
  }
}

interface OwnerOptions {
  db: Database.Database;
  /** The composed, wake-bus-decorated host writer, never a second writer. */
  engine: SessionEngine;
}

function cloudOwnerPredicate(idColumn: string): string {
  return `EXISTS (SELECT 1 FROM session_drain_cursors
    WHERE session_id = ${idColumn} AND owner_user_id = @scopeOwner)
    AND ${sessionBirthOwnerCompatible(idColumn, "@scopeOwner")}`;
}

/**
 * The signed-in owner's view, including offline births. `adopt` is S2's
 * createFactDrain.adopt: it must synchronously persist through the SAME db.
 * The engine invokes it inside the birth transaction, before post-commit wakes
 * or an attachment can see the Session. LOCAL_RUNNER provenance is untouched.
 */
export function createCloudSessionOwner(
  options: OwnerOptions & {
    ownerUserId: string;
    adopt(sessionId: string): void;
    /** Atomic machine-state birth association, before the drain can be nudged. */
    onCreated?(session: Session): void;
  },
) {
  if (options.ownerUserId.length === 0) throw new Error("A cloud Session needs an owner");
  const { db, ownerUserId } = options;
  const owns = (sessionId: string): boolean =>
    prepared(
      db,
      `SELECT 1 FROM sessions WHERE id = @scopeSessionId AND ${cloudOwnerPredicate("sessions.id")}`,
    ).get({ scopeSessionId: sessionId, scopeOwner: ownerUserId }) !== undefined;
  const reader = sessionReader(
    options.engine,
    createSqliteSessionLedger(db, {
      predicate: cloudOwnerPredicate,
      bindings: { scopeOwner: ownerUserId },
    }),
  );
  return {
    owns,
    projectIds: (): string[] =>
      (
        prepared(
          db,
          `SELECT DISTINCT s.project_id FROM sessions s WHERE ${cloudOwnerPredicate("s.id")}`,
        ).all({ scopeOwner: ownerUserId }) as { project_id: string }[]
      ).map((row) => row.project_id),
    engine: scopedEngine(options.engine, reader, owns, ownerUserId, (request) => {
      const replay = prepared(db, "SELECT session_id FROM session_commands WHERE id = ?").get(
        request.commandId,
      ) as { session_id: string } | undefined;
      if (replay !== undefined && !owns(replay.session_id)) throw new SessionOwnerError();
      if (request.ownerUserId !== undefined && request.ownerUserId !== ownerUserId) {
        throw new SessionOwnerError();
      }
      return {
        ...request,
        ownerUserId,
        onCreated(session) {
          // A stale cursor cannot silently be adopted by a different account.
          const cursor = prepared(
            db,
            "SELECT owner_user_id FROM session_drain_cursors WHERE session_id = ?",
          ).get(session.id) as { owner_user_id: string } | undefined;
          if (cursor !== undefined && cursor.owner_user_id !== ownerUserId)
            throw new SessionOwnerError();
          synchronousBirthHook(request.onCreated, session);
          synchronousBirthHook(options.onCreated, session);
          options.adopt(session.id);
          if (!owns(session.id)) throw new Error("Session birth did not persist its owner cursor");
        },
      };
    }),
  };
}

/** Frozen signed-out consumers never reinterpret a stamped cloud birth as local, even after restore. */
export function createLocalSessionEngine(options: OwnerOptions): SessionEngine {
  const owns = (sessionId: string): boolean =>
    prepared(
      options.db,
      `SELECT 1 FROM sessions WHERE id = ? AND ${localSessionRow("sessions.id")}`,
    ).get(sessionId) !== undefined;
  const reader = sessionReader(
    options.engine,
    createSqliteSessionLedger(options.db, { predicate: localSessionRow }),
  );
  return scopedEngine(options.engine, reader, owns, undefined, (request) => {
    if (request.ownerUserId !== undefined) throw new SessionOwnerError();
    return request;
  });
}

function scopedEngine(
  writer: SessionEngine,
  reader: SessionReader,
  owns: (sessionId: string) => boolean,
  ownerUserId: string | undefined,
  birth: (request: CreateSessionRequest) => CreateSessionRequest,
): SessionEngine {
  const visible = async (sessionId: string): Promise<boolean> => {
    if (!owns(sessionId)) return false;
    const session = await reader.getBaseSession({ sessionId });
    return (
      session !== null && (session.ownerUserId === undefined || session.ownerUserId === ownerUserId)
    );
  };
  const assertOwner = async (sessionId: string): Promise<void> => {
    if (!(await visible(sessionId))) throw new SessionOwnerError();
  };
  // Enumerated so a new engine verb requires an explicit scoping decision.
  return {
    async createSession(request) {
      if (request.parentSessionId !== null) await assertOwner(request.parentSessionId);
      // Requested-id replay must not reach an existing Session through another scope.
      if (request.requestedSessionId) {
        const existing = await writer.getBaseSession({ sessionId: request.requestedSessionId });
        if (existing !== null) await assertOwner(existing.id);
      }
      return writer.createSession(birth(request));
    },
    async getOrRecordSessionInput(request) {
      await assertOwner(request.sessionId);
      return writer.getOrRecordSessionInput(request);
    },
    async recordToolRefresh(request) {
      await assertOwner(request.sessionId);
      return writer.recordToolRefresh(request);
    },
    async observe(observation) {
      await assertOwner(observation.sessionId);
      return writer.observe(observation);
    },
    async submit(request) {
      await assertOwner(request.sessionId);
      return writer.submit(request);
    },
    async completeModelSelection(request) {
      await assertOwner(request.sessionId);
      return writer.completeModelSelection(request);
    },
    getSession: async (query) =>
      (await visible(query.sessionId)) ? reader.getSession(query) : null,
    getBaseSession: async (query) =>
      (await visible(query.sessionId)) ? reader.getBaseSession(query) : null,
    listSessions: (query) => reader.listSessions(query),
    countSessions: (query) => reader.countSessions(query),
    listAttachedSessions: () => reader.listAttachedSessions(),
    listSessionStarts: (query) => reader.listSessionStarts(query),
    listLatestTicketSignals: (query) => reader.listLatestTicketSignals(query),
    listEvents: async (query) => ((await visible(query.sessionId)) ? reader.listEvents(query) : []),
    latestEventSequence: async (query) =>
      (await visible(query.sessionId)) ? reader.latestEventSequence(query) : 0,
    getProjectionCheckpoint: async (query) =>
      (await visible(query.sessionId)) ? reader.getProjectionCheckpoint(query) : null,
    async saveProjectionCheckpoint(checkpoint) {
      await assertOwner(checkpoint.sessionId);
      return writer.saveProjectionCheckpoint(checkpoint);
    },
    reportUsage: (query) => reader.reportUsage(query),
  };
}

/** No commands or writer methods: selection happens before asking the sole engine to fold. */
type SessionReader = Pick<
  SessionEngine,
  | "getBaseSession"
  | "getSession"
  | "listSessions"
  | "countSessions"
  | "listAttachedSessions"
  | "listSessionStarts"
  | "listLatestTicketSignals"
  | "listEvents"
  | "latestEventSequence"
  | "getProjectionCheckpoint"
  | "reportUsage"
>;

function sessionReader(engine: SessionEngine, ledger: SessionLedger): SessionReader {
  const project = async (sessions: readonly Session[]): Promise<SessionProjection[]> => {
    const projections: SessionProjection[] = [];
    for (let index = 0; index < sessions.length; index += 1) {
      if (index > 0 && index % 32 === 0) await setImmediate();
      const projection = await engine.getSession({ sessionId: sessions[index]!.id });
      if (projection !== null) projections.push(projection);
    }
    return projections;
  };
  return {
    getBaseSession: (query) => ledger.transaction((tx) => tx.getSession(query.sessionId)),
    getSession: (query) => engine.getSession(query),
    listSessions: async (query) =>
      project(await ledger.transaction((tx) => tx.listSessions(query))),
    countSessions: (query) => ledger.transaction((tx) => tx.countSessions(query)),
    listAttachedSessions: async () =>
      project(await ledger.transaction((tx) => tx.listAttachedSessions())),
    listSessionStarts: (query) => ledger.transaction((tx) => tx.listSessionStarts(query)),
    listLatestTicketSignals: (query) =>
      ledger.transaction((tx) => tx.listLatestTicketSignals(query)),
    listEvents: (query) => engine.listEvents(query),
    latestEventSequence: (query) => engine.latestEventSequence(query),
    getProjectionCheckpoint: (query) => engine.getProjectionCheckpoint(query),
    reportUsage: (query) =>
      ledger.transaction((tx) =>
        reportSessionUsage(tx.listUsage(query), {
          ...query,
          meteredFrom: tx.usageMeteredFrom(),
        }),
      ),
  };
}

function synchronousBirthHook(
  hook: ((session: Session) => void) | undefined,
  session: Session,
): void {
  const result: unknown = hook?.(session);
  if (result !== null && typeof result === "object" && "then" in result) {
    throw new Error("Session birth hook must be synchronous");
  }
}
