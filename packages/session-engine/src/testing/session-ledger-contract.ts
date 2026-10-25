/**
 * What every {@link SessionLedger} adapter must do, as one suite.
 *
 * Run it once per adapter: session-engine runs it against the in-memory twin,
 * host-core against `SqliteSessionLedger`, and a backend ledger joins by
 * calling it with its own factory. Each case is a guarantee some caller relies
 * on — acceptance order, contiguous immutable sequences, rollback, idempotent
 * receipts, usage scoped by attribution, checkpoint monotonicity — so a
 * divergence between two adapters fails here on the side that drifted rather
 * than surfacing later as a production-only bug.
 *
 * The cases speak only through the port (and the Engine built on it). Storage
 * details — corrupt rows, prepared-statement reuse, migrations — stay in each
 * adapter's own tests.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  createSessionProjectionCheckpoint,
  type CommandReceipt,
  type SessionCommand,
  type SessionEvent,
  type SessionLedger,
  type SessionOrigin,
} from "@volli/shared";
import {
  asStored,
  contractEngine,
  contractProvenance as provenance,
  contractSession,
  contractUsage,
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

export function describeSessionLedgerContract(
  adapter: string,
  open: SessionLedgerContractFactory,
): void {
  describe(`SessionLedger contract: ${adapter}`, () => {
    let opened: SessionLedgerContractStore[] = [];
    afterEach(async () => {
      const stores = opened;
      opened = [];
      for (const store of stores) await store.dispose();
    });
    async function fresh(): Promise<
      SessionLedgerContractStore & ReturnType<typeof contractEngine>
    > {
      const store = await open();
      opened.push(store);
      await store.seedProject(PROJECT, ["ticket-a", "ticket-b", "Ticket-c"]);
      await store.seedProject(OTHER_PROJECT, ["ticket-other"]);
      return { ...store, ...contractEngine(store.ledger) };
    }
    async function createSession(
      engine: ReturnType<typeof contractEngine>["engine"],
      name: string,
      options: { projectId?: string; ticketId?: string | null; origin?: SessionOrigin } = {},
    ) {
      const ticketId = options.ticketId ?? null;
      const created = await engine.createSession({
        commandId: `create-${name}`,
        requestedSessionId: name,
        projectId: options.projectId ?? PROJECT,
        ticketId,
        role: ticketId === null ? "project" : "ticket",
        parentSessionId: null,
        title: name,
        provenance:
          options.origin === undefined
            ? provenance
            : {
                ...provenance,
                source: { ...provenance.source, detail: { sessionOrigin: options.origin } },
              },
      });
      return created.session;
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
        const { ledger, engine } = await fresh();
        const session = await createSession(engine, "session-rollback");
        const before = await ledger.transaction((transaction) =>
          transaction.listEvents({ sessionId: session.id }),
        );
        await expect(
          ledger.transaction((transaction) => {
            transaction.insertSession(contractSession("session-never", PROJECT));
            transaction.saveCommand(retitleCommand(session.id, "command-never"));
            transaction.appendEvent(archived(session.id, before.length + 1, "event-never"));
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
          })),
        ).resolves.toEqual({
          session: null,
          command: null,
          event: null,
          latest: before.length,
          checkpoint: null,
        });
        await expect(ledger.transaction(() => "value")).resolves.toBe("value");
      });

      it("closes the transaction handle once the work returns", async () => {
        const { ledger } = await fresh();
        let leaked: Parameters<Parameters<SessionLedger["transaction"]>[0]>[0] | undefined;
        await ledger.transaction((transaction) => {
          leaked = transaction;
        });
        expect(() => leaked!.getSession("session-any")).toThrow(/closed/);
        expect(() => leaked!.insertSession(contractSession("session-late", PROJECT))).toThrow(
          /closed/,
        );
      });
    });

    describe("Sessions", () => {
      it("stores a Session exactly as inserted and refuses an id already used by any record", async () => {
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

        await expect(
          ledger.transaction((transaction) =>
            transaction.insertSession({ ...parent, title: "Again" }),
          ),
        ).rejects.toThrow();
        // One id space across records: an event id cannot become a Session id.
        const created = await createSession(engine, "session-with-events");
        const [firstEvent] = await engine.listEvents({ sessionId: created.id });
        await expect(
          ledger.transaction((transaction) =>
            transaction.insertSession(contractSession(firstEvent!.id, PROJECT)),
          ),
        ).rejects.toThrow();
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
    });

    describe("events", () => {
      it("appends only the next contiguous sequence of a Session it holds", async () => {
        const { ledger, engine } = await fresh();
        const session = await createSession(engine, "session-append");
        const head = await ledger.transaction((transaction) =>
          transaction.latestEventSequence(session.id),
        );
        expect(head).toBeGreaterThan(0);
        for (const refused of [
          archived(session.id, head + 2), // a gap
          archived(session.id, head), // a sequence already taken
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
            transaction.appendEvent(archived(session.id, head + 1, first!.id)),
          ),
        ).rejects.toThrow();
        await ledger.transaction((transaction) =>
          transaction.appendEvent(archived(session.id, head + 1)),
        );
        await expect(
          ledger.transaction((transaction) => transaction.latestEventSequence(session.id)),
        ).resolves.toBe(head + 1);
      });

      it("refuses an event this build could not read back", async () => {
        const { ledger, engine } = await fresh();
        const session = await createSession(engine, "session-unreadable");
        const head = await engine.latestEventSequence({ sessionId: session.id });
        await expect(
          ledger.transaction((transaction) =>
            transaction.appendEvent({
              ...archived(session.id, head + 1),
              payload: { kind: "capabilities.retired" },
            } as unknown as SessionEvent),
          ),
        ).rejects.toThrow();
        await expect(engine.latestEventSequence({ sessionId: session.id })).resolves.toBe(head);
      });

      it("reads the events after sequence N in ascending order, bounded by a limit", async () => {
        const { ledger, engine } = await fresh();
        const session = await createSession(engine, "session-read");
        const head = await engine.latestEventSequence({ sessionId: session.id });
        const appended = [1, 2, 3, 4, 5].map((step) => archived(session.id, head + step));
        await ledger.transaction((transaction) => {
          for (const event of appended) transaction.appendEvent(event);
        });

        const read = await ledger.transaction((transaction) => ({
          all: transaction.listEvents({ sessionId: session.id }),
          after: transaction.listEvents({ sessionId: session.id, afterSequence: head }),
          page: transaction.listEvents({ sessionId: session.id, afterSequence: head, limit: 2 }),
          empty: transaction.listEvents({ sessionId: session.id, limit: 0 }),
          end: transaction.listEvents({ sessionId: session.id, afterSequence: head + 5 }),
          unknown: transaction.listEvents({ sessionId: "session-unknown" }),
          one: transaction.getEvent(appended[2]!.id),
          missing: transaction.getEvent("event-missing"),
          latest: transaction.latestEventSequence(session.id),
          latestUnknown: transaction.latestEventSequence("session-unknown"),
        }));
        expect(read.all.map(({ sequence }) => sequence)).toEqual(
          Array.from({ length: head + 5 }, (_, index) => index + 1),
        );
        expect(read.after.map(asStored)).toEqual(appended);
        expect(read.page.map(asStored)).toEqual(appended.slice(0, 2));
        expect(read.empty).toEqual([]);
        expect(read.end).toEqual([]);
        expect(read.unknown).toEqual([]);
        expect(asStored(read.one!)).toEqual(appended[2]);
        expect(read.missing).toBeNull();
        expect(read.latest).toBe(head + 5);
        expect(read.latestUnknown).toBe(0);
      });

      it("refuses a negative or fractional cursor or limit", async () => {
        const { ledger, engine } = await fresh();
        const session = await createSession(engine, "session-cursor");
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
        const { ledger, engine } = await fresh();
        const session = await createSession(engine, "session-immutable");
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
        const { ledger, engine } = await fresh();
        const session = await createSession(engine, "session-unreturned");
        for (const [commandId, intent] of [
          ["retitle-unreturned", { kind: "session.retitle", title: "Renamed" }],
          ["signal-unreturned", { kind: "session.signal", signal: "done", reason: "Finished" }],
        ] as const) {
          const cursor = await engine.latestEventSequence({ sessionId: session.id });
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

      it("hands a fold the same facts in the same order, without provenance but with each command's origin", async () => {
        const { ledger, engine } = await fresh();
        const origin = {
          kind: "automation",
          automationRunId: "run-contract",
          automationName: "Review",
        } as const;
        const session = await createSession(engine, "session-fold", { origin });
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
        for (const event of fold) expect(event).not.toHaveProperty("provenance");
        expect(fold.map(({ commandOrigin: _origin, ...event }) => asStored(event))).toEqual(
          audit.map(({ provenance: _provenance, ...event }) => asStored(event)),
        );
        expect(page.map(({ sequence }) => sequence)).toEqual([2, 3]);
        // The create command came through a door that named its origin; the
        // retitle did not, which a fold reads as no origin at all.
        const commands = fold.filter(({ payload }) => payload.kind === "command.recorded");
        expect(commands.map(({ commandOrigin }) => commandOrigin ?? null)).toEqual([origin, null]);
        expect(createSessionProjectionCheckpoint(session, fold).projection).toEqual(
          createSessionProjectionCheckpoint(session, audit).projection,
        );
      });
    });

    describe("projection checkpoints", () => {
      it("keeps the furthest valid checkpoint and refuses one ahead of the log", async () => {
        const { ledger, engine } = await fresh();
        const session = await createSession(engine, "session-checkpoint");
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
          { ...latest, sessionId: "session-unknown" },
        ]) {
          await expect(
            ledger.transaction((transaction) => transaction.saveProjectionCheckpoint(refused)),
          ).rejects.toThrow();
        }
        await expect(
          ledger.transaction((transaction) => transaction.getProjectionCheckpoint(session.id)),
        ).resolves.toEqual(latest);
      });
    });

    describe("commands and receipts", () => {
      it("answers a replayed create or command with the first result, appending nothing", async () => {
        const { ledger, engine } = await fresh();
        const request = {
          commandId: "create-replayed",
          projectId: PROJECT,
          ticketId: null,
          role: "project",
          parentSessionId: null,
          title: "Replayed",
          provenance,
        } as const;
        const created = await engine.createSession(request);
        await expect(engine.createSession(request)).resolves.toEqual(created);
        const retitle = {
          commandId: "retitle-replayed",
          sessionId: created.session.id,
          intent: { kind: "session.retitle", title: "Renamed" },
          provenance,
        } as const;
        const first = await engine.submit(retitle);
        const head = await engine.latestEventSequence({ sessionId: created.session.id });
        await expect(engine.submit(retitle)).resolves.toEqual(first);
        await expect(engine.latestEventSequence({ sessionId: created.session.id })).resolves.toBe(
          head,
        );

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

      it("lists a command's receipts in sequence order and refuses a receipt for no command", async () => {
        const { ledger, engine } = await fresh();
        const session = await createSession(engine, "session-receipts");
        const command = retitleCommand(session.id, "command-receipts");
        const head = await engine.latestEventSequence({ sessionId: session.id });
        const receipts: CommandReceipt[] = [
          {
            id: "receipt-accepted",
            commandId: command.id,
            status: "accepted",
            acceptedAt: 500,
            result: { kind: "session.retitled", sessionId: session.id },
            recordedAt: 500,
            sequence: head + 2,
          },
          {
            id: "receipt-completed",
            commandId: command.id,
            status: "completed",
            result: { kind: "session.retitled", sessionId: session.id },
            recordedAt: 600,
            sequence: head + 3,
          },
        ];
        await ledger.transaction((transaction) => {
          transaction.saveCommand(command);
          transaction.appendEvent({
            id: "command-receipts-recorded",
            sessionId: session.id,
            sequence: head + 1,
            occurredAt: 400,
            recordedAt: 400,
            provenance,
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
          ledger.transaction((transaction) =>
            transaction.appendReceipt({ ...receipts[0]!, id: "receipt-orphan", commandId: "nope" }),
          ),
        ).rejects.toThrow();
        await expect(
          ledger.transaction((transaction) => transaction.saveCommand(command)),
        ).rejects.toThrow();
      });
    });

    describe("attached Sessions", () => {
      it("lists every Session holding an open attachment, across projects, newest first", async () => {
        const { ledger, engine, clock } = await fresh();
        async function attach(name: string, projectId: string) {
          clock.now += 10;
          const session = await createSession(engine, name, { projectId });
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
        await createSession(engine, "session-bare");
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
        const { engine, clock } = await fresh();
        async function signal(
          sessionId: string,
          ticketId: string | null,
          value: "done" | "blocked",
          at: number,
          projectId = PROJECT,
        ) {
          clock.now = at;
          if ((await engine.getBaseSession({ sessionId })) === null) {
            await createSession(engine, sessionId, { projectId, ticketId });
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
        // ticket-b: two signals share a millisecond; the one accepted second
        // belongs to the Session whose id sorts first.
        await signal("session-y", "ticket-b", "done", 150);
        await signal("session-b", "ticket-b", "blocked", 150);
        // Ticket-c: one Session changes its mind.
        await signal("session-c", "Ticket-c", "blocked", 160);
        await signal("session-c", "Ticket-c", "done", 170);
        // Neither a ticketless Session nor another project's ticket is in scope.
        await signal("session-loose", null, "done", 400);
        await signal("session-other", "ticket-other", "done", 400, OTHER_PROJECT);

        await expect(engine.listLatestTicketSignals({ projectId: PROJECT })).resolves.toEqual([
          // Byte order: "T" sorts before "t".
          {
            ticketId: "Ticket-c",
            sessionId: "session-c",
            signal: "done",
            reason: "session-c at 170",
            createdAt: 170,
          },
          {
            ticketId: "ticket-a",
            sessionId: "session-a",
            signal: "done",
            reason: "session-a at 100",
            createdAt: 100,
          },
          {
            ticketId: "ticket-b",
            sessionId: "session-b",
            signal: "blocked",
            reason: "session-b at 150",
            createdAt: 150,
          },
        ]);
      });
    });

    describe("usage", () => {
      it("selects usage by the attribution on the fact, newest first, in a half-open window", async () => {
        const { ledger, engine } = await fresh();
        const ticketed = await createSession(engine, "session-ticketed", { ticketId: "ticket-a" });
        const loose = await createSession(engine, "session-loose");
        const elsewhere = await createSession(engine, "session-elsewhere", {
          projectId: OTHER_PROJECT,
        });
        const spend = [
          { session: ticketed, at: 1_000, costUsd: 1 },
          { session: loose, at: 2_000, costUsd: 2 },
          { session: elsewhere, at: 3_000, costUsd: 4 },
          { session: ticketed, at: 4_000, costUsd: 8 },
        ];
        for (const [index, { session, at, costUsd }] of spend.entries()) {
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

        const read = await ledger.transaction((transaction) => {
          const at = (query: Parameters<typeof transaction.listUsage>[0]) =>
            transaction.listUsage(query).map(({ occurredAt }) => occurredAt);
          return {
            all: at({ scope: { kind: "all" } }),
            project: at({ scope: { kind: "project", projectId: PROJECT } }),
            ticket: at({ scope: { kind: "ticket", ticketId: "ticket-a" } }),
            session: at({ scope: { kind: "session", sessionId: loose.id } }),
            since: at({ scope: { kind: "all" }, since: 2_000 }),
            until: at({ scope: { kind: "all" }, until: 2_000 }),
            window: at({ scope: { kind: "all" }, since: 2_000, until: 4_000 }),
            entry: transaction.listUsage({ scope: { kind: "session", sessionId: ticketed.id } }),
            meteredFrom: transaction.usageMeteredFrom(),
          };
        });
        expect(read.all).toEqual([4_000, 3_000, 2_000, 1_000]);
        expect(read.project).toEqual([4_000, 2_000, 1_000]);
        expect(read.ticket).toEqual([4_000, 1_000]);
        expect(read.session).toEqual([2_000]);
        expect(read.since).toEqual([4_000, 3_000, 2_000]);
        expect(read.until).toEqual([1_000]);
        expect(read.window).toEqual([3_000, 2_000]);
        expect(read.entry).toEqual([
          {
            ...contractUsage({ costUsd: 8 }),
            sessionId: ticketed.id,
            projectId: PROJECT,
            ticketId: "ticket-a",
            occurredAt: 4_000,
          },
          {
            ...contractUsage({ costUsd: 1 }),
            sessionId: ticketed.id,
            projectId: PROJECT,
            ticketId: "ticket-a",
            occurredAt: 1_000,
          },
        ]);
        // A fresh store has no history that predates metering.
        expect(read.meteredFrom).toBe(0);
      });

      it("rebuilds the usage read from the facts alone, to the same answer", async () => {
        const { ledger, engine } = await fresh();
        const session = await createSession(engine, "session-rebuild", { ticketId: "ticket-a" });
        for (const [index, at] of [1_000, 2_000].entries()) {
          await engine.observe({
            id: `usage-rebuild-${index}`,
            kind: "usage.recorded",
            sessionId: session.id,
            occurredAt: at,
            provenance,
            attachmentId: null,
            turnId: null,
            usage: contractUsage({ modelId: `model-${index}` }),
          });
        }
        const live = await ledger.transaction((transaction) =>
          transaction.listUsage({ scope: { kind: "all" } }),
        );
        expect(live).toHaveLength(2);
        await ledger.transaction((transaction) => transaction.rebuildUsageProjection());
        await expect(
          ledger.transaction((transaction) => transaction.listUsage({ scope: { kind: "all" } })),
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

function attachment(sessionId: string, attachmentId: string) {
  return {
    id: attachmentId,
    sessionId,
    adapterId: "terminal",
    venue: { id: "local", kind: "local" },
    continuity: "fresh",
    native: null,
    authority: null,
  } as const;
}
