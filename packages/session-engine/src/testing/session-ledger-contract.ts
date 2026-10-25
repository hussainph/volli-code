/**
 * What every {@link SessionLedger} adapter must do, as one suite.
 *
 * Run it once per adapter: session-engine runs it against the in-memory twin,
 * host-core against `SqliteSessionLedger`, and a backend ledger joins by
 * calling it with its own factory. Each case is a guarantee some caller relies
 * on — acceptance order, contiguous immutable sequences, rollback, referential
 * integrity, idempotent receipts, usage scoped by attribution, checkpoint
 * monotonicity — so a divergence between two adapters fails here on the side
 * that drifted rather than surfacing later as a production-only bug.
 *
 * The cases speak only through the port (and the Engine built on it). Storage
 * details — corrupt rows, prepared-statement reuse, migrations, whether the
 * slim fold read really omits provenance — stay in each adapter's own tests.
 *
 * Deliberate pins beyond the port's prose. Referential integrity: a write
 * naming a command, attachment or Session the store does not hold — or another
 * Session's — is refused, and a receipt commits only with its receipt event,
 * because every reader of receipts and attachments trusts those links. Orders,
 * because every caller today reads them and a second adapter that answered
 * differently would reorder what a person sees: equal `listSessions` stamps tie-break on the id's UTF-8 bytes
 * (SQLite's BINARY collation), `listAttachedSessions` uses the `listSessions`
 * order, and `listLatestTicketSignals` is sorted by ticket id in the same byte
 * order.
 */
import { LOCAL_RUNNER } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";
import {
  createSessionProjectionCheckpoint,
  type CommandReceipt,
  type SessionAttachment,
  type SessionCommand,
  type SessionEvent,
  type SessionLedger,
  type SessionLedgerTransaction,
  type SessionUsageAttribution,
} from "@volli/shared";
import {
  asStored,
  contractCreateRequest,
  contractEngine,
  contractProvenance as provenance,
  contractSession,
  contractUsage,
  provenanceWithOrigin,
  storePerCase,
} from "./contract-fixtures";

/** One fresh, empty store, as a case sees it. */
export interface SessionLedgerContractStore {
  ledger: SessionLedger;
  /**
   * Make `projectId`, and each of `ticketIds` under it, something this store
   * accepts Sessions under. A store without referential checks does nothing.
   */
  seedProject(projectId: string, ticketIds?: readonly string[]): void | Promise<void>;
  /** Release the store. Called once after each case. */
  dispose(): void | Promise<void>;
}

export type SessionLedgerContractFactory = () =>
  | SessionLedgerContractStore
  | Promise<SessionLedgerContractStore>;

const PROJECT = "project-contract";
const OTHER_PROJECT = "project-contract-other";
const ticketA: SessionUsageAttribution = { projectId: PROJECT, ticketId: "ticket-a" };
// The attribution is frozen on the fact and never re-derived from the
// Session row, so one fact here deliberately disagrees with its row.
const stray: SessionUsageAttribution = { projectId: OTHER_PROJECT, ticketId: "ticket-other" };

export function describeSessionLedgerContract(
  adapter: string,
  open: SessionLedgerContractFactory,
): void {
  describe(`SessionLedger contract: ${adapter}`, () => {
    const openStore = storePerCase(open);
    async function fresh() {
      const store = await openStore();
      await store.seedProject(PROJECT, ["ticket-a", "ticket-b", "Ticket-c", "ticket-d"]);
      await store.seedProject(OTHER_PROJECT, ["ticket-other"]);
      const { engine, clock } = contractEngine(store.ledger);
      const createSession = async (
        name: string,
        options: Parameters<typeof contractCreateRequest>[2] & { projectId?: string } = {},
      ) =>
        (
          await engine.createSession(
            contractCreateRequest(name, options.projectId ?? PROJECT, options),
          )
        ).session;
      const head = (sessionId: string) =>
        store.ledger.transaction((transaction) => transaction.latestEventSequence(sessionId));
      return { ledger: store.ledger, engine, clock, createSession, head };
    }

    describe("transactions", () => {
      it("runs transactions one at a time, in the order they were asked for", async () => {
        const { ledger } = await fresh();
        const order: string[] = [];
        // Called back to back without awaiting: the second must still see the first.
        const write = ledger.transaction((transaction) => {
          order.push("write");
          transaction.insertSession(contractSession("session-ordered", PROJECT));
        });
        const read = ledger.transaction((transaction) => {
          order.push("read");
          return transaction.getSession("session-ordered");
        });
        const last = ledger.transaction(() => {
          order.push("last");
        });
        await Promise.all([write, last]);
        expect(await read).toEqual(contractSession("session-ordered", PROJECT));
        expect(order).toEqual(["write", "read", "last"]);
      });

      it("resolves with the work's value, and rolls every write back when the work throws", async () => {
        const { ledger, createSession, head } = await fresh();
        const session = await createSession("session-rollback");
        const before = await head(session.id);
        await expect(
          ledger.transaction((transaction) => {
            transaction.insertSession(contractSession("session-never", PROJECT));
            transaction.saveCommand(retitleCommand(session.id, "command-never"));
            transaction.appendEvent(archived(session.id, before + 1, "event-never"));
            transaction.appendEvent(attachmentOpened(session.id, before + 2, "attachment-never"));
            transaction.appendEvent(
              usageEvent(session.id, before + 3, { projectId: PROJECT, ticketId: null }),
            );
            transaction.saveProjectionCheckpoint(
              createSessionProjectionCheckpoint(
                session,
                transaction.listEvents({ sessionId: session.id }),
              ),
            );
            throw new Error("rollback");
          }),
        ).rejects.toThrow("rollback");

        await expect(
          ledger.transaction((transaction) => ({
            session: transaction.getSession("session-never"),
            command: transaction.getCommand("command-never"),
            event: transaction.getEvent("event-never"),
            latest: transaction.latestEventSequence(session.id),
            checkpoint: transaction.getProjectionCheckpoint(session.id),
            usage: transaction.listUsage({ scope: { kind: "all" } }),
            attached: transaction.listAttachedSessions(),
          })),
        ).resolves.toEqual({
          session: null,
          command: null,
          event: null,
          latest: before,
          checkpoint: null,
          usage: [],
          attached: [],
        });
        // Nothing of the rolled-back attachment survived: its id opens again.
        await expect(
          ledger.transaction((transaction) => {
            transaction.appendEvent(attachmentOpened(session.id, before + 1, "attachment-never"));
            return "value";
          }),
        ).resolves.toBe("value");
      });

      it("closes the transaction handle once the work returns or throws", async () => {
        const { ledger } = await fresh();
        let returned: SessionLedgerTransaction | undefined;
        let threw: SessionLedgerTransaction | undefined;
        await ledger.transaction((transaction) => {
          returned = transaction;
        });
        await expect(
          ledger.transaction((transaction) => {
            threw = transaction;
            throw new Error("rollback");
          }),
        ).rejects.toThrow("rollback");
        for (const leaked of [returned!, threw!]) {
          expect(() => leaked.getSession("session-any")).toThrow();
          expect(() => leaked.listEvents({ sessionId: "session-any" })).toThrow();
          expect(() => leaked.insertSession(contractSession("session-late", PROJECT))).toThrow();
        }
      });
    });

    describe("Sessions", () => {
      it("stores a Session exactly as inserted and refuses an id any record already uses", async () => {
        const { ledger, engine } = await fresh();
        const parent = contractSession("session-parent", PROJECT, { createdAt: 50 });
        const child = contractSession("session-child", PROJECT, {
          ticketId: "ticket-a",
          role: "subagent",
          parentSessionId: parent.id,
          title: null,
          createdAt: 60,
        });
        await ledger.transaction((transaction) => {
          transaction.insertSession(parent);
          transaction.insertSession(child);
        });
        await expect(
          ledger.transaction((transaction) => [
            transaction.getSession(parent.id),
            transaction.getSession(child.id),
            transaction.getSession("session-missing"),
          ]),
        ).resolves.toEqual([parent, child, null]);

        // One id space across Sessions, events, commands and receipts; no new record
        // may take an id an attachment already holds.
        const created = await engine.createSession(contractCreateRequest("session-ids", PROJECT));
        const sessionId = created.session.id;
        const next = created.receipt.sequence + 1;
        await ledger.transaction((transaction) =>
          transaction.appendEvent(attachmentOpened(sessionId, next, "attachment-ids")),
        );
        const reuses: Array<(transaction: SessionLedgerTransaction) => void> = [
          (transaction) => transaction.insertSession({ ...parent, title: "Again" }),
          (transaction) => transaction.insertSession(contractSession(created.event.id, PROJECT)),
          (transaction) =>
            transaction.appendEvent(archived(sessionId, next + 1, created.command.id)),
          (transaction) => transaction.saveCommand(retitleCommand(sessionId, created.receipt.id)),
          (transaction) => transaction.saveCommand(retitleCommand(sessionId, "attachment-ids")),
          (transaction) => transaction.appendEvent(archived(sessionId, next + 1, "attachment-ids")),
        ];
        for (const reuse of reuses) {
          await expect(ledger.transaction(reuse)).rejects.toThrow();
        }
      });

      it("lists and counts base Sessions by scope, newest first, then by id in byte order", async () => {
        const { ledger } = await fresh();
        // Equal stamps tie-break on the id's UTF-8 bytes, descending — F0 (😀),
        // EE (U+E000), E4 (中), C3 (é), 61 (a), then "S" (53) below "s" (73) —
        // where neither a locale nor a UTF-16 comparison agrees: in UTF-16 the
        // emoji's surrogate (D83D) sorts below U+E000.
        const rows = [
          contractSession("s-\uE000", PROJECT, { createdAt: 200 }),
          contractSession("s-é", PROJECT, { createdAt: 200 }),
          contractSession("S-z", PROJECT, { createdAt: 200 }),
          contractSession("s-😀", PROJECT, { createdAt: 200 }),
          contractSession("s-a", PROJECT, { createdAt: 200 }),
          contractSession("s-中", PROJECT, { createdAt: 200 }),
          contractSession("t-1", PROJECT, { ticketId: "ticket-a", role: "ticket", createdAt: 300 }),
          contractSession("t-2", PROJECT, { ticketId: "ticket-b", role: "ticket", createdAt: 100 }),
          contractSession("o-1", OTHER_PROJECT, { createdAt: 400 }),
        ];
        await ledger.transaction((transaction) => {
          for (const row of rows) transaction.insertSession(row);
        });

        const read = await ledger.transaction((transaction) => ({
          all: transaction.listSessions({ projectId: PROJECT, scope: "all" }),
          project: transaction.listSessions({ projectId: PROJECT, scope: "project" }),
          ticket: transaction.listSessions({
            projectId: PROJECT,
            scope: "ticket",
            ticketId: "ticket-a",
          }),
          counts: [
            transaction.countSessions({ projectId: PROJECT, scope: "all" }),
            transaction.countSessions({ projectId: PROJECT, scope: "project" }),
            transaction.countSessions({
              projectId: PROJECT,
              scope: "ticket",
              ticketId: "ticket-a",
            }),
            transaction.countSessions({ projectId: "project-unknown", scope: "all" }),
          ],
        }));
        const tied = ["s-😀", "s-\uE000", "s-中", "s-é", "s-a", "S-z"];
        expect(read.all.map(({ id }) => id)).toEqual(["t-1", ...tied, "t-2"]);
        expect(read.project.map(({ id }) => id)).toEqual(tied);
        expect(read.ticket).toEqual([rows[6]]);
        expect(read.counts).toEqual([8, 6, 1, 0]);
      });

      it("reads Session start stamps across every project, ascending, from an inclusive edge", async () => {
        const { ledger } = await fresh();
        await ledger.transaction((transaction) => {
          transaction.insertSession(contractSession("start-c", PROJECT, { createdAt: 300 }));
          transaction.insertSession(contractSession("start-a", OTHER_PROJECT, { createdAt: 100 }));
          transaction.insertSession(contractSession("start-b", PROJECT, { createdAt: 200 }));
        });
        await expect(
          ledger.transaction((transaction) => [
            transaction.listSessionStarts({ sinceMs: 0 }),
            transaction.listSessionStarts({ sinceMs: 200 }),
            transaction.listSessionStarts({ sinceMs: 301 }),
          ]),
        ).resolves.toEqual([[100, 200, 300], [200, 300], []]);
      });

      it("hands every read its own copy of Sessions, commands, receipts and checkpoints", async () => {
        const { ledger, engine } = await fresh();
        const created = await engine.createSession(contractCreateRequest("session-copy", PROJECT));
        const sessionId = created.session.id;
        await ledger.transaction((transaction) =>
          transaction.saveProjectionCheckpoint(
            createSessionProjectionCheckpoint(
              created.session,
              transaction.listEvents({ sessionId }),
            ),
          ),
        );
        const read = (transaction: SessionLedgerTransaction) => ({
          session: transaction.getSession(sessionId),
          listed: transaction.listSessions({ projectId: PROJECT, scope: "all" }),
          command: transaction.getCommand(created.command.id),
          receipt: transaction.getReceipt(created.receipt.id),
          receipts: transaction.listReceipts(created.command.id),
          checkpoint: transaction.getProjectionCheckpoint(sessionId),
        });
        const first = await ledger.transaction(read);
        const snapshot = structuredClone(first);
        scribble(first.session);
        scribble(first.listed[0]);
        scribble(first.command);
        scribble(first.receipt);
        scribble(first.receipts[0]);
        Object.assign(first.checkpoint!, { throughSequence: -1 });
        await expect(ledger.transaction(read)).resolves.toEqual(snapshot);
      });
    });

    describe("events", () => {
      it("appends only the next contiguous sequence of a Session it holds", async () => {
        const { ledger, engine, createSession, head } = await fresh();
        const session = await createSession("session-append");
        const latest = await head(session.id);
        expect(latest).toBeGreaterThan(0);
        for (const refused of [
          archived(session.id, latest + 2), // a gap
          archived(session.id, latest), // a sequence already taken
          archived(session.id, 0),
          archived("session-unknown", 1), // a Session the store does not hold
        ]) {
          await expect(
            ledger.transaction((transaction) => transaction.appendEvent(refused)),
          ).rejects.toThrow();
        }
        // A reused event id is refused even at the right sequence.
        const [first] = await engine.listEvents({ sessionId: session.id });
        await expect(
          ledger.transaction((transaction) =>
            transaction.appendEvent(archived(session.id, latest + 1, first!.id)),
          ),
        ).rejects.toThrow();
        await ledger.transaction((transaction) =>
          transaction.appendEvent(archived(session.id, latest + 1)),
        );
        await expect(head(session.id)).resolves.toBe(latest + 1);
      });

      it("refuses an event this build could not read back", async () => {
        const { ledger, createSession, head } = await fresh();
        const session = await createSession("session-unreadable");
        const latest = await head(session.id);
        await expect(
          ledger.transaction((transaction) =>
            transaction.appendEvent({
              ...archived(session.id, latest + 1),
              payload: { kind: "capabilities.retired" },
            } as unknown as SessionEvent),
          ),
        ).rejects.toThrow();
        await expect(head(session.id)).resolves.toBe(latest);
      });

      it("refuses a write that names a record it does not hold, or another Session's", async () => {
        const { ledger, engine, createSession, head } = await fresh();
        const session = await createSession("session-references");
        const other = await engine.createSession(
          contractCreateRequest("session-references-other", PROJECT),
        );
        const latest = await head(session.id);
        await ledger.transaction((transaction) =>
          transaction.appendEvent(attachmentOpened(session.id, latest + 1, "attachment-held")),
        );
        const otherHead = await head(other.session.id);
        await ledger.transaction((transaction) =>
          transaction.appendEvent(
            attachmentOpened(other.session.id, otherHead + 1, "attachment-other"),
          ),
        );
        const next = latest + 2;
        const command = retitleCommand(session.id, "command-references");
        const receipt: CommandReceipt = {
          id: "receipt-references",
          commandId: command.id,
          status: "completed",
          result: { kind: "session.retitled", sessionId: session.id },
          recordedAt: next * 10,
          sequence: next,
        };
        const refusals: Record<string, (transaction: SessionLedgerTransaction) => void> = {
          "a command for no Session": (transaction) =>
            transaction.saveCommand(retitleCommand("session-unknown", "command-orphan")),
          "a fact naming a command nobody stored": (transaction) =>
            transaction.appendEvent({ ...archived(session.id, next), commandId: "command-none" }),
          "a fact naming another Session's command": (transaction) =>
            transaction.appendEvent({
              ...archived(session.id, next),
              commandId: other.command.id,
            }),
          "a fact naming an attachment nobody opened": (transaction) =>
            transaction.appendEvent({
              ...archived(session.id, next),
              attachmentId: "attachment-none",
            }),
          "an attachment opened for another Session": (transaction) =>
            transaction.appendEvent({
              ...attachmentOpened(session.id, next, "attachment-foreign"),
              payload: {
                kind: "attachment.opened",
                attachment: attachment(other.session.id, "attachment-foreign"),
              },
            }),
          "a fact naming another Session's attachment": (transaction) =>
            transaction.appendEvent({
              ...archived(session.id, next),
              attachmentId: "attachment-other",
            }),
          "an attachment opened twice": (transaction) =>
            transaction.appendEvent({
              ...attachmentOpened(session.id, next, "attachment-held"),
              id: "attachment-held-again",
            }),
          "a receipt with no receipt event": (transaction) => {
            transaction.saveCommand(command);
            transaction.appendReceipt(receipt);
          },
          "a receipt event for a receipt nobody stored": (transaction) => {
            transaction.saveCommand(command);
            transaction.appendEvent({
              ...archived(session.id, next),
              commandId: command.id,
              payload: { kind: "command.receipt.recorded", receipt },
            });
          },
          "a receipt for no command": (transaction) =>
            transaction.appendReceipt({ ...receipt, commandId: "command-none" }),
        };
        for (const [refusal, write] of Object.entries(refusals)) {
          await expect(ledger.transaction(write), refusal).rejects.toThrow();
        }
        await expect(
          ledger.transaction((transaction) => ({
            latest: transaction.latestEventSequence(session.id),
            command: transaction.getCommand(command.id),
            receipt: transaction.getReceipt(receipt.id),
          })),
        ).resolves.toEqual({ latest: latest + 1, command: null, receipt: null });
      });

      it("reads the events after sequence N in ascending order, bounded by a limit", async () => {
        const { ledger, createSession, head } = await fresh();
        const session = await createSession("session-read");
        const latest = await head(session.id);
        const appended = [1, 2, 3, 4, 5].map((step) => archived(session.id, latest + step));
        await ledger.transaction((transaction) => {
          for (const event of appended) transaction.appendEvent(event);
        });

        const read = await ledger.transaction((transaction) => ({
          all: transaction.listEvents({ sessionId: session.id }),
          after: transaction.listEvents({ sessionId: session.id, afterSequence: latest }),
          page: transaction.listEvents({ sessionId: session.id, afterSequence: latest, limit: 2 }),
          empty: transaction.listEvents({ sessionId: session.id, limit: 0 }),
          end: transaction.listEvents({ sessionId: session.id, afterSequence: latest + 5 }),
          unknown: transaction.listEvents({ sessionId: "session-unknown" }),
          one: transaction.getEvent(appended[2]!.id),
          missing: transaction.getEvent("event-missing"),
          latest: transaction.latestEventSequence(session.id),
          latestUnknown: transaction.latestEventSequence("session-unknown"),
        }));
        expect(read.all.map(({ sequence }) => sequence)).toEqual(
          Array.from({ length: latest + 5 }, (_, index) => index + 1),
        );
        expect(read.after.map(asStored)).toEqual(appended);
        expect(read.page.map(asStored)).toEqual(appended.slice(0, 2));
        expect(read.empty).toEqual([]);
        expect(read.end).toEqual([]);
        expect(read.unknown).toEqual([]);
        expect(asStored(read.one!)).toEqual(appended[2]);
        expect(read.missing).toBeNull();
        expect(read.latest).toBe(latest + 5);
        expect(read.latestUnknown).toBe(0);
      });

      it("refuses a negative or fractional cursor or limit", async () => {
        const { ledger, createSession } = await fresh();
        const session = await createSession("session-cursor");
        for (const query of [{ afterSequence: -1 }, { afterSequence: 1.5 }, { limit: -1 }]) {
          await expect(
            ledger.transaction((transaction) =>
              transaction.listEvents({ sessionId: session.id, ...query }),
            ),
          ).rejects.toThrow();
          await expect(
            ledger.transaction((transaction) =>
              transaction.listProjectionEvents({ sessionId: session.id, ...query }),
            ),
          ).rejects.toThrow();
        }
      });

      // The drain contract: a reader holding a cursor can trust that what it
      // read stays true, and that what follows its cursor is everything new.
      it("keeps what it returned immutable: a reader's copy, a stable prefix, nothing rewritten", async () => {
        const { ledger, engine, createSession } = await fresh();
        const session = await createSession("session-immutable");
        const first = await ledger.transaction((transaction) =>
          transaction.listEvents({ sessionId: session.id }),
        );
        const snapshot = structuredClone(first);
        first[0]!.payload = { kind: "session.archived" };
        (first as SessionEvent[]).pop();
        const one = await ledger.transaction((transaction) =>
          transaction.getEvent(snapshot[0]!.id),
        );
        one!.sequence = 99;

        await engine.submit({
          commandId: "retitle-immutable",
          sessionId: session.id,
          intent: { kind: "session.retitle", title: "Renamed" },
          provenance,
        });
        const later = await ledger.transaction((transaction) => ({
          all: transaction.listEvents({ sessionId: session.id }),
          prefix: transaction.listEvents({ sessionId: session.id, limit: snapshot.length }),
          one: transaction.getEvent(snapshot[0]!.id),
        }));
        expect(later.prefix).toEqual(snapshot);
        expect(later.all.slice(0, snapshot.length)).toEqual(snapshot);
        expect(later.all.length).toBeGreaterThan(snapshot.length);
        expect(later.one).toEqual(snapshot[0]);
      });

      it("holds every event a write appended after its cursor, including those submit does not return", async () => {
        const { ledger, engine, createSession, head } = await fresh();
        const session = await createSession("session-unreturned");
        for (const [commandId, intent] of [
          ["retitle-unreturned", { kind: "session.retitle", title: "Renamed" }],
          ["signal-unreturned", { kind: "session.signal", signal: "done", reason: "Finished" }],
        ] as const) {
          const cursor = await head(session.id);
          const result = await engine.submit({
            commandId,
            sessionId: session.id,
            intent,
            provenance,
          });
          const after = await ledger.transaction((transaction) =>
            transaction.listEvents({ sessionId: session.id, afterSequence: cursor }),
          );
          const returned = [result.commandEvent, result.receiptEvent].filter(
            (event): event is SessionEvent => event !== null,
          );
          expect(after.map(({ sequence }) => sequence)).toEqual(
            after.map((_, index) => cursor + index + 1),
          );
          expect(after.map(({ id }) => id)).toEqual(
            expect.arrayContaining(returned.map(({ id }) => id)),
          );
          // The fact itself rides beside the receipt and is not in the result.
          expect(after.length).toBeGreaterThan(returned.length);
          expect(after.map(({ payload }) => payload.kind)).toContain(
            intent.kind === "session.retitle" ? "session.retitled" : "session.signaled",
          );
        }
      });

      it("hands a fold the same facts in the same order, folding to the same state, origins included", async () => {
        const { ledger, engine, createSession } = await fresh();
        const origin = {
          kind: "automation",
          automationRunId: "run-contract",
          automationName: "Review",
        } as const;
        const session = await createSession("session-fold", { origin });
        const start = await engine.submit({
          commandId: "start-fold",
          sessionId: session.id,
          intent: { kind: "executor.start", adapterId: "terminal", continuity: "fresh" },
          provenance: provenanceWithOrigin(origin),
        });
        await engine.observe({
          id: "opened-fold",
          kind: "attachment.opened",
          sessionId: session.id,
          commandId: start.command.id,
          occurredAt: 200,
          provenance,
          attachment: attachment(session.id, "attachment-fold"),
        });
        await engine.submit({
          commandId: "retitle-fold",
          sessionId: session.id,
          intent: { kind: "session.retitle", title: "Renamed" },
          provenance,
        });
        const { audit, fold, page } = await ledger.transaction((transaction) => ({
          audit: transaction.listEvents({ sessionId: session.id }),
          fold: transaction.listProjectionEvents({ sessionId: session.id }),
          page: transaction.listProjectionEvents({
            sessionId: session.id,
            afterSequence: 1,
            limit: 2,
          }),
        }));
        // The port lets an adapter that cannot separate the two hand back full
        // events, so only the facts are compared, never which extras ride along.
        expect(factsOf(fold)).toEqual(factsOf(audit));
        expect(page.map(({ sequence }) => sequence)).toEqual([2, 3]);
        const folded = createSessionProjectionCheckpoint(session, fold).projection;
        expect(folded).toEqual(createSessionProjectionCheckpoint(session, audit).projection);
        // The origin a trusted door recorded reaches the fold.
        expect(folded.attachments.map(({ id, origin: opened }) => [id, opened])).toEqual([
          ["attachment-fold", origin],
        ]);
      });
    });

    describe("projection checkpoints", () => {
      it("keeps the furthest valid checkpoint and refuses one ahead of the log or for no Session", async () => {
        const { ledger, engine, createSession } = await fresh();
        const session = await createSession("session-checkpoint");
        const events = await engine.listEvents({ sessionId: session.id });
        const latest = createSessionProjectionCheckpoint(session, events);
        const earlier = createSessionProjectionCheckpoint(session, events.slice(0, 1));
        expect(earlier.throughSequence).toBeLessThan(latest.throughSequence);

        await expect(
          ledger.transaction((transaction) => transaction.getProjectionCheckpoint(session.id)),
        ).resolves.toBeNull();
        await ledger.transaction((transaction) => transaction.saveProjectionCheckpoint(latest));
        await ledger.transaction((transaction) => transaction.saveProjectionCheckpoint(earlier));
        await expect(
          ledger.transaction((transaction) => transaction.getProjectionCheckpoint(session.id)),
        ).resolves.toEqual(latest);

        for (const refused of [
          { ...latest, throughSequence: latest.throughSequence + 1 },
          // Well formed, for a Session this store does not hold.
          createSessionProjectionCheckpoint(contractSession("session-ghost", PROJECT), []),
        ]) {
          await expect(
            ledger.transaction((transaction) => transaction.saveProjectionCheckpoint(refused)),
          ).rejects.toThrow();
        }
        await expect(
          ledger.transaction((transaction) => [
            transaction.getProjectionCheckpoint(session.id),
            transaction.getProjectionCheckpoint("session-ghost"),
          ]),
        ).resolves.toEqual([latest, null]);
      });
    });

    describe("commands and receipts", () => {
      it("answers a replayed create or command with the first result, appending nothing", async () => {
        const { ledger, engine, head } = await fresh();
        const request = contractCreateRequest("session-replayed", PROJECT);
        const created = await engine.createSession(request);
        const sessionId = created.session.id;
        const afterCreate = await head(sessionId);
        await expect(engine.createSession(request)).resolves.toEqual(created);
        await expect(head(sessionId)).resolves.toBe(afterCreate);
        const retitle = {
          commandId: "retitle-replayed",
          sessionId,
          intent: { kind: "session.retitle", title: "Renamed" },
          provenance,
        } as const;
        const first = await engine.submit(retitle);
        const afterSubmit = await head(sessionId);
        await expect(engine.submit(retitle)).resolves.toEqual(first);
        await expect(head(sessionId)).resolves.toBe(afterSubmit);

        await expect(
          ledger.transaction((transaction) => ({
            command: transaction.getCommand(retitle.commandId),
            receipts: transaction.listReceipts(retitle.commandId),
            receipt: transaction.getReceipt(first.receipt!.id),
            missingCommand: transaction.getCommand("command-missing"),
            missingReceipts: transaction.listReceipts("command-missing"),
            missingReceipt: transaction.getReceipt("receipt-missing"),
          })),
        ).resolves.toEqual({
          command: first.command,
          receipts: [first.receipt],
          receipt: first.receipt,
          missingCommand: null,
          missingReceipts: [],
          missingReceipt: null,
        });
      });

      it("lists a command's receipts in sequence order, each carried by its own event", async () => {
        const { ledger, createSession, head } = await fresh();
        const session = await createSession("session-receipts");
        const command = retitleCommand(session.id, "command-receipts");
        const latest = await head(session.id);
        const receipts: CommandReceipt[] = [
          {
            id: "receipt-accepted",
            commandId: command.id,
            status: "accepted",
            acceptedAt: 500,
            result: { kind: "session.retitled", sessionId: session.id },
            recordedAt: 500,
            sequence: latest + 2,
          },
          {
            id: "receipt-completed",
            commandId: command.id,
            status: "completed",
            result: { kind: "session.retitled", sessionId: session.id },
            recordedAt: 600,
            sequence: latest + 3,
          },
        ];
        await ledger.transaction((transaction) => {
          transaction.saveCommand(command);
          transaction.appendEvent({
            ...archived(session.id, latest + 1, "command-receipts-recorded"),
            commandId: command.id,
            payload: { kind: "command.recorded", command },
          });
          // Appended newest first; the read still answers in sequence order.
          for (const receipt of receipts.toReversed()) transaction.appendReceipt(receipt);
          for (const receipt of receipts) {
            transaction.appendEvent({
              id: `${receipt.id}-recorded`,
              sessionId: session.id,
              sequence: receipt.sequence,
              occurredAt: receipt.recordedAt,
              recordedAt: receipt.recordedAt,
              provenance,
              commandId: command.id,
              payload: { kind: "command.receipt.recorded", receipt },
            });
          }
        });
        await expect(
          ledger.transaction((transaction) => ({
            command: transaction.getCommand(command.id),
            receipts: transaction.listReceipts(command.id),
          })),
        ).resolves.toEqual({ command, receipts });
        await expect(
          ledger.transaction((transaction) => transaction.saveCommand(command)),
        ).rejects.toThrow();
      });
    });

    describe("attached Sessions", () => {
      it("lists every Session holding an open attachment, across projects, newest first", async () => {
        const { ledger, engine, clock, createSession } = await fresh();
        async function attach(name: string, projectId: string) {
          clock.now += 10;
          const session = await createSession(name, { projectId });
          const start = await engine.submit({
            commandId: `start-${name}`,
            sessionId: session.id,
            intent: { kind: "executor.start", adapterId: "terminal", continuity: "fresh" },
            provenance,
          });
          return { session, commandId: start.command.id, attachmentId: `attachment-${name}` };
        }
        const live = await attach("session-open", PROJECT);
        const elsewhere = await attach("session-elsewhere", OTHER_PROJECT);
        const closed = await attach("session-closed", PROJECT);
        const failed = await attach("session-failed", PROJECT);
        await createSession("session-bare");
        for (const { session, commandId, attachmentId } of [live, elsewhere, closed]) {
          await engine.observe({
            id: `opened-${session.id}`,
            kind: "attachment.opened",
            sessionId: session.id,
            commandId,
            occurredAt: clock.now,
            provenance,
            attachment: attachment(session.id, attachmentId),
          });
        }
        await engine.observe({
          id: `failed-${failed.session.id}`,
          kind: "attachment.failed",
          sessionId: failed.session.id,
          commandId: failed.commandId,
          occurredAt: clock.now,
          provenance,
          attachment: attachment(failed.session.id, failed.attachmentId),
          failure: { code: "terminal_start_failed", detail: "no pty", diagnostic: null },
        });
        await engine.observe({
          id: `closed-${closed.session.id}`,
          kind: "attachment.closed",
          sessionId: closed.session.id,
          occurredAt: clock.now,
          provenance,
          attachmentId: closed.attachmentId,
          outcome: "completed",
        });

        await expect(
          ledger.transaction((transaction) => transaction.listAttachedSessions()),
        ).resolves.toEqual([elsewhere.session, live.session]);
      });
    });

    describe("latest ticket signals", () => {
      it("names each ticket's signal by acceptance order, never by its clock or its Session id", async () => {
        const { engine, clock, createSession } = await fresh();
        async function signal(
          sessionId: string,
          ticketId: string | null,
          value: "done" | "blocked",
          at: number,
          projectId = PROJECT,
        ) {
          clock.now = at;
          if ((await engine.getBaseSession({ sessionId })) === null) {
            await createSession(sessionId, { projectId, ticketId });
          }
          await engine.submit({
            commandId: `signal-${sessionId}-${value}-${at}`,
            sessionId,
            intent: { kind: "session.signal", signal: value, reason: `${sessionId} at ${at}` },
            provenance,
          });
        }
        // ticket-a: the clock moves backwards between two accepted signals (VC-512).
        await signal("session-z", "ticket-a", "blocked", 200);
        await signal("session-a", "ticket-a", "done", 100);
        // ticket-b and ticket-d: two signals share a millisecond. The one
        // accepted second sorts first in one pair and last in the other, so no
        // id order can stand in for acceptance order.
        await signal("session-y", "ticket-b", "done", 150);
        await signal("session-b", "ticket-b", "blocked", 150);
        await signal("session-d-a", "ticket-d", "blocked", 150);
        await signal("session-d-z", "ticket-d", "done", 150);
        // Ticket-c: one Session changes its mind.
        await signal("session-c", "Ticket-c", "blocked", 160);
        await signal("session-c", "Ticket-c", "done", 170);
        // Neither a ticketless Session nor another project's ticket is in scope.
        await signal("session-loose", null, "done", 400);
        await signal("session-other", "ticket-other", "done", 400, OTHER_PROJECT);

        await expect(engine.listLatestTicketSignals({ projectId: PROJECT })).resolves.toEqual([
          // Byte order: "T" sorts before "t".
          latestSignal("Ticket-c", "session-c", "done", 170),
          latestSignal("ticket-a", "session-a", "done", 100),
          latestSignal("ticket-b", "session-b", "blocked", 150),
          latestSignal("ticket-d", "session-d-z", "done", 150),
        ]);
      });
    });

    describe("usage", () => {
      async function spend() {
        const context = await fresh();
        const { ledger, engine, createSession, head } = context;
        const ticketed = await createSession("session-ticketed", { ticketId: "ticket-a" });
        const ticketedToo = await createSession("session-ticketed-too", { ticketId: "ticket-a" });
        const loose = await createSession("session-loose");
        const elsewhere = await createSession("session-elsewhere", { projectId: OTHER_PROJECT });
        const observed = [
          { session: ticketed, at: 1_000, costUsd: 1 },
          { session: loose, at: 2_000, costUsd: 2 },
          { session: ticketedToo, at: 2_500, costUsd: 16 },
          { session: elsewhere, at: 3_000, costUsd: 4 },
          { session: ticketed, at: 4_000, costUsd: 8 },
        ];
        for (const [index, { session, at, costUsd }] of observed.entries()) {
          await engine.observe({
            id: `usage-${index}`,
            kind: "usage.recorded",
            sessionId: session.id,
            occurredAt: at,
            provenance,
            attachmentId: null,
            turnId: null,
            usage: contractUsage({ costUsd }),
          });
        }
        const sequence = (await head(loose.id)) + 1;
        await ledger.transaction((transaction) =>
          transaction.appendEvent(usageEvent(loose.id, sequence, stray)),
        );
        return { ...context, ticketed, loose };
      }
      it("selects usage by the attribution on the fact, newest first, in a half-open window", async () => {
        const { ledger, ticketed, loose } = await spend();
        const read = await ledger.transaction((transaction) => ({
          scopes: scopes(transaction, loose.id),
          ticketed: transaction.listUsage({ scope: { kind: "session", sessionId: ticketed.id } }),
          loose: transaction.listUsage({ scope: { kind: "session", sessionId: loose.id } }),
          meteredFrom: transaction.usageMeteredFrom(),
        }));
        expect(read.scopes).toEqual(expectedScopes);
        expect(read.ticketed).toEqual([
          { ...contractUsage({ costUsd: 8 }), ...usageEntry(ticketed.id, ticketA, 4_000) },
          { ...contractUsage({ costUsd: 1 }), ...usageEntry(ticketed.id, ticketA, 1_000) },
        ]);
        expect(read.loose).toEqual([
          { ...contractUsage({ costUsd: 32 }), ...usageEntry(loose.id, stray, 5_000) },
          {
            ...contractUsage({ costUsd: 2 }),
            ...usageEntry(loose.id, { projectId: PROJECT, ticketId: null }, 2_000),
          },
        ]);
        // A fresh store has no history that predates metering.
        expect(read.meteredFrom).toBe(0);
      });

      it("rebuilds the usage read from the facts alone, to the same answer", async () => {
        const { ledger, loose } = await spend();
        const live = await ledger.transaction((transaction) => ({
          rows: transaction.listUsage({ scope: { kind: "all" } }),
          scopes: scopes(transaction, loose.id),
        }));
        expect(live.scopes).toEqual(expectedScopes);
        await ledger.transaction((transaction) => transaction.rebuildUsageProjection());
        await expect(
          ledger.transaction((transaction) => ({
            rows: transaction.listUsage({ scope: { kind: "all" } }),
            scopes: scopes(transaction, loose.id),
          })),
        ).resolves.toEqual(live);
      });
    });
  });
}

function retitleCommand(sessionId: string, id: string): SessionCommand {
  return {
    id,
    sessionId,
    createdAt: 400,
    intent: { kind: "session.retitle", title: "Contract" },
    route: null,
  };
}

function archived(sessionId: string, sequence: number, id = `${sessionId}-${sequence}`) {
  return {
    id,
    sessionId,
    sequence,
    occurredAt: sequence * 10,
    recordedAt: sequence * 10,
    provenance,
    payload: { kind: "session.archived" },
  } satisfies SessionEvent;
}

function attachment(sessionId: string, attachmentId: string): SessionAttachment {
  return {
    id: attachmentId,
    sessionId,
    adapterId: "terminal",
    venue: LOCAL_RUNNER,
    continuity: "fresh",
    native: null,
    authority: null,
  };
}

function attachmentOpened(sessionId: string, sequence: number, attachmentId: string): SessionEvent {
  return {
    ...archived(sessionId, sequence, `${attachmentId}-opened`),
    payload: { kind: "attachment.opened", attachment: attachment(sessionId, attachmentId) },
  };
}

/** A metered operation written straight to the ledger, attributed as given. */
function usageEvent(
  sessionId: string,
  sequence: number,
  attribution: SessionUsageAttribution,
): SessionEvent {
  return {
    ...archived(sessionId, sequence, `${sessionId}-usage-${sequence}`),
    occurredAt: 5_000,
    payload: {
      kind: "usage.recorded",
      attachmentId: null,
      turnId: null,
      attribution,
      usage: contractUsage({ costUsd: 32 }),
    },
  };
}

function scopes(transaction: SessionLedgerTransaction, looseId: string) {
  const at = (query: Parameters<typeof transaction.listUsage>[0]) =>
    transaction.listUsage(query).map(({ occurredAt }) => occurredAt);
  return {
    all: at({ scope: { kind: "all" } }),
    project: at({ scope: { kind: "project", projectId: PROJECT } }),
    otherProject: at({ scope: { kind: "project", projectId: OTHER_PROJECT } }),
    ticket: at({ scope: { kind: "ticket", ticketId: "ticket-a" } }),
    strayTicket: at({ scope: { kind: "ticket", ticketId: "ticket-other" } }),
    session: at({ scope: { kind: "session", sessionId: looseId } }),
    since: at({ scope: { kind: "all" }, since: 2_000 }),
    until: at({ scope: { kind: "all" }, until: 2_000 }),
    window: at({ scope: { kind: "all" }, since: 2_000, until: 4_000 }),
  };
}

const expectedScopes = {
  all: [5_000, 4_000, 3_000, 2_500, 2_000, 1_000],
  project: [4_000, 2_500, 2_000, 1_000],
  otherProject: [5_000, 3_000],
  ticket: [4_000, 2_500, 1_000],
  strayTicket: [5_000],
  session: [5_000, 2_000],
  since: [5_000, 4_000, 3_000, 2_500, 2_000],
  until: [1_000],
  window: [3_000, 2_500, 2_000],
};

const scribble = (value: unknown) => Object.assign(value as object, { id: "scribbled" });

const factsOf = (events: readonly object[]) =>
  events.map((event) => {
    const {
      provenance: _provenance,
      commandOrigin: _origin,
      ...rest
    } = event as SessionEvent & { commandOrigin?: unknown };
    return asStored(rest);
  });

const latestSignal = (ticketId: string, sessionId: string, value: string, at: number) => ({
  ticketId,
  sessionId,
  signal: value,
  reason: `${sessionId} at ${at}`,
  createdAt: at,
});

const usageEntry = (sessionId: string, attribution: SessionUsageAttribution, at: number) => ({
  sessionId,
  ...attribution,
  occurredAt: at,
});
