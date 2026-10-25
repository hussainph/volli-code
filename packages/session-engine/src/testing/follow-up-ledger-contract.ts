/**
 * What every {@link SessionFollowUpLedger} adapter must do, as one suite.
 *
 * session-engine runs it against the in-memory queue, host-core against the
 * SQLite queue. The cases are the guarantees the runtime's follow-up release
 * leans on: an atomic synchronous read/modify/write per Session, a private
 * state per transaction, rollback on a throw, serialized transactions, entry
 * order kept as written, and a delivery proof read from the event ledger in the
 * same transaction.
 *
 * Every write here bumps `revision`, as every runtime writer does: a store may
 * skip persisting a state whose revision never moved past zero.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { SessionLedger } from "@volli/shared";
import {
  emptySessionFollowUpState,
  type SessionFollowUpLedger,
  type StoredSessionFollowUp,
} from "../session-follow-ups";
import { contractEngine, contractProvenance as provenance } from "./contract-fixtures";

export interface SessionFollowUpLedgerContractStore {
  /** The event ledger the queue proves delivery against. */
  ledger: SessionLedger;
  followUps: SessionFollowUpLedger;
  /** Make `projectId` something the event ledger accepts Sessions under. */
  seedProject(projectId: string): void | Promise<void>;
  dispose(): void | Promise<void>;
}

export type SessionFollowUpLedgerContractFactory = () =>
  | SessionFollowUpLedgerContractStore
  | Promise<SessionFollowUpLedgerContractStore>;

const PROJECT = "project-follow-up-contract";

function entry(
  index: number,
  overrides: Partial<StoredSessionFollowUp> = {},
): StoredSessionFollowUp {
  return {
    id: `message-${index}`,
    commandId: `queued-${index}`,
    deliveryCommandId: `delivery-${index}`,
    state: "queued",
    message: {
      id: `message-${index}`,
      role: "user",
      parts: [{ type: "text", text: `Follow up ${index}` }],
    },
    ...overrides,
  };
}

export function describeSessionFollowUpLedgerContract(
  adapter: string,
  open: SessionFollowUpLedgerContractFactory,
): void {
  describe(`SessionFollowUpLedger contract: ${adapter}`, () => {
    let opened: SessionFollowUpLedgerContractStore[] = [];
    afterEach(async () => {
      const stores = opened;
      opened = [];
      for (const store of stores) await store.dispose();
    });
    async function fresh(...names: string[]) {
      const store = await open();
      opened.push(store);
      await store.seedProject(PROJECT);
      const { engine } = contractEngine(store.ledger);
      for (const name of names) {
        await engine.createSession({
          commandId: `create-${name}`,
          requestedSessionId: name,
          projectId: PROJECT,
          ticketId: null,
          role: "project",
          parentSessionId: null,
          title: name,
          provenance,
        });
      }
      return { ...store, engine };
    }

    it("answers a Session it never wrote with the empty state, and lists nothing pending", async () => {
      const { followUps } = await fresh("session-quiet");
      await expect(followUps.transaction("session-quiet", (state) => state)).resolves.toEqual(
        emptySessionFollowUpState(),
      );
      await expect(followUps.pendingSessionIds()).resolves.toEqual([]);
    });

    it("commits the work's changes and reads them back in the order written", async () => {
      const { followUps } = await fresh("session-write");
      const entries = [
        entry(3, { origin: { kind: "user" }, model: { providerId: "p", modelId: "m" } }),
        entry(1, { state: "releasing", steer: { signature: "sig", targetTurnId: "turn-1" } }),
        entry(2, { refused: true, refusedDetail: "Held" }),
      ];
      await expect(
        followUps.transaction("session-write", (state) => {
          state.entries.push(...entries);
          state.revision += 1;
          state.releasedBoundary = "idle:turn-1";
          return "written";
        }),
      ).resolves.toBe("written");
      await expect(followUps.transaction("session-write", (state) => state)).resolves.toEqual({
        ...emptySessionFollowUpState(),
        revision: 1,
        entries,
        releasedBoundary: "idle:turn-1",
      });
    });

    it("hands each transaction a private state: a reference kept past commit changes nothing", async () => {
      const { followUps } = await fresh("session-private");
      let kept = emptySessionFollowUpState();
      await followUps.transaction("session-private", (state) => {
        state.entries.push(entry(1));
        state.revision += 1;
        kept = state;
      });
      kept.entries.push(entry(2));
      kept.revision = 99;
      const read = await followUps.transaction("session-private", (state) => state);
      read.entries.length = 0;
      await expect(followUps.transaction("session-private", (state) => state)).resolves.toEqual({
        ...emptySessionFollowUpState(),
        revision: 1,
        entries: [entry(1)],
      });
    });

    it("rolls back work that throws, and refuses asynchronous work without writing", async () => {
      const { followUps } = await fresh("session-rollback");
      await expect(
        followUps.transaction("session-rollback", (state) => {
          state.entries.push(entry(1));
          state.revision += 1;
          throw new Error("crash");
        }),
      ).rejects.toThrow("crash");
      await expect(
        followUps.transaction("session-rollback", ((state: { revision: number }) => {
          state.revision += 1;
          return Promise.resolve("not synchronous");
        }) as never),
      ).rejects.toThrow("must be synchronous");
      await expect(followUps.transaction("session-rollback", (state) => state)).resolves.toEqual(
        emptySessionFollowUpState(),
      );
      await expect(followUps.pendingSessionIds()).resolves.toEqual([]);
    });

    it("runs a Session's transactions one at a time, in the order they were asked for", async () => {
      const { followUps } = await fresh("session-serial");
      await Promise.all(
        [1, 2, 3, 4, 5].map((index) =>
          followUps.transaction("session-serial", (state) => {
            state.entries.push(entry(index));
            state.revision += 1;
          }),
        ),
      );
      const state = await followUps.transaction("session-serial", (current) => current);
      expect(state.revision).toBe(5);
      expect(state.entries.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5].map((i) => `message-${i}`));
    });

    it("keeps Sessions apart and lists the ones with entries until they are emptied", async () => {
      const { followUps } = await fresh("session-b", "session-a", "session-c");
      for (const sessionId of ["session-b", "session-a", "session-c"]) {
        await followUps.transaction(sessionId, (state) => {
          state.entries.push(entry(1));
          state.revision += 1;
        });
      }
      await followUps.transaction("session-c", (state) => {
        state.entries = [];
        state.revision += 1;
      });
      expect([...(await followUps.pendingSessionIds())].toSorted()).toEqual([
        "session-a",
        "session-b",
      ]);
      await expect(followUps.transaction("session-c", (state) => state)).resolves.toEqual({
        ...emptySessionFollowUpState(),
        revision: 2,
      });
      await expect(
        followUps.transaction("session-a", (state) => state.entries.map(({ id }) => id)),
      ).resolves.toEqual(["message-1"]);
    });

    it("proves a delivery from the event ledger, inside the same transaction", async () => {
      const { followUps, engine } = await fresh("session-proof");
      await engine.submit({
        commandId: "delivery-known",
        sessionId: "session-proof",
        intent: { kind: "session.retitle", title: "Delivered" },
        provenance,
      });
      await expect(
        followUps.transaction("session-proof", (_state, deliveryProof) => {
          expect(deliveryProof).toBeTypeOf("function");
          return [deliveryProof!("delivery-known"), deliveryProof!("delivery-unknown")];
        }),
      ).resolves.toEqual([true, false]);
    });
  });
}
