/**
 * What a committed Session stream must do, as one suite: the ordering the
 * runtime's open chat streams rely on (VC-790).
 *
 * A committed stream is an Engine that announces each event it commits.
 * session-engine runs this against {@link createCommittedSessionStream};
 * host-core runs it against its wake bus. Anything that replaces the wake bus —
 * a runner's retry buffer in front of a backend ledger — must pass it too, or
 * replace the "announced before the write settles" rule with an explicit
 * own-write marker the runtime can read.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { SessionEvent } from "@volli/shared";
import type { SessionEngine } from "../session-engine";
import { contractProvenance as provenance } from "./contract-fixtures";

export interface CommittedSessionStreamContractStore {
  /** The Engine every write goes through; its writes are what is announced. */
  engine: SessionEngine;
  subscribe(listener: (event: SessionEvent) => void): () => void;
  /** Make `projectId` something the ledger behind `engine` accepts Sessions under. */
  seedProject(projectId: string): void | Promise<void>;
  dispose(): void | Promise<void>;
}

export type CommittedSessionStreamContractFactory = () =>
  | CommittedSessionStreamContractStore
  | Promise<CommittedSessionStreamContractStore>;

const PROJECT = "project-stream-contract";

export function describeCommittedSessionStreamContract(
  adapter: string,
  open: CommittedSessionStreamContractFactory,
): void {
  describe(`committed Session stream contract: ${adapter}`, () => {
    let opened: CommittedSessionStreamContractStore[] = [];
    afterEach(async () => {
      const stores = opened;
      opened = [];
      for (const store of stores) await store.dispose();
    });
    async function fresh() {
      const store = await open();
      opened.push(store);
      await store.seedProject(PROJECT);
      const heard: SessionEvent[] = [];
      const stop = store.subscribe((event) => heard.push(event));
      return { ...store, heard, stop };
    }
    function create(engine: SessionEngine, name: string) {
      return engine.createSession({
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

    it("announces every committed event once, in ledger order, including those submit does not return", async () => {
      const { engine, heard } = await fresh();
      await create(engine, "session-heard");
      const result = await engine.submit({
        commandId: "retitle-heard",
        sessionId: "session-heard",
        intent: { kind: "session.retitle", title: "Renamed" },
        provenance,
      });
      const ledger = await engine.listEvents({ sessionId: "session-heard" });
      expect(heard.map(({ id }) => id)).toEqual(ledger.map(({ id }) => id));
      // The retitle fact rides beside the receipt and is not in the result.
      const retitled = ledger.find(({ payload }) => payload.kind === "session.retitled");
      expect(retitled).toBeDefined();
      expect([result.commandEvent.id, result.receiptEvent?.id]).not.toContain(retitled!.id);
    });

    it("announces a write's events before that write's promise settles", async () => {
      const { engine, heard } = await fresh();
      await create(engine, "session-before");
      let heardAtSettle: string[] = [];
      await engine
        .submit({
          commandId: "retitle-before",
          sessionId: "session-before",
          intent: { kind: "session.retitle", title: "Renamed" },
          provenance,
        })
        .then(() => {
          heardAtSettle = heard.map(({ payload }) => payload.kind);
        });
      expect(heardAtSettle).toContain("session.retitled");
      await engine
        .observe({
          id: "usage-before",
          kind: "usage.recorded",
          sessionId: "session-before",
          occurredAt: 500,
          provenance,
          attachmentId: null,
          turnId: null,
          usage: {
            cause: "assistant",
            providerId: "p",
            modelId: "m",
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            costUsd: null,
            costBasis: "unavailable",
          },
        })
        .then((event) => {
          expect(heard.at(-1)?.id).toBe(event.id);
        });
    });

    it("announces the Session input and tool-refresh writes too", async () => {
      const { engine, heard } = await fresh();
      await create(engine, "session-input");
      const kinds = () => heard.map(({ payload }) => payload.kind);
      await engine
        .getOrRecordSessionInput({
          sessionId: "session-input",
          input: { kind: "tool-surface", tools: ["read"] },
          provenance,
        })
        .then(() => expect(kinds()).toContain("session.input.recorded"));
      await engine
        .recordToolRefresh({
          sessionId: "session-input",
          provenance,
          surface: { kind: "tool-surface", tools: ["read", "write"] },
          added: ["write"],
          changed: [],
          trigger: "cold-turn",
        })
        .then(() => expect(kinds()).toContain("session.tools.refreshed"));
    });

    it("announces each event exactly once when writes overlap", async () => {
      const { engine, heard } = await fresh();
      await Promise.all([create(engine, "session-one"), create(engine, "session-two")]);
      await Promise.all(
        ["session-one", "session-two", "session-one"].map((sessionId, index) =>
          engine.submit({
            commandId: `retitle-overlap-${index}`,
            sessionId,
            intent: { kind: "session.retitle", title: `Title ${index}` },
            provenance,
          }),
        ),
      );
      const ledger = [
        ...(await engine.listEvents({ sessionId: "session-one" })),
        ...(await engine.listEvents({ sessionId: "session-two" })),
      ];
      expect(heard.map(({ id }) => id).toSorted()).toEqual(ledger.map(({ id }) => id).toSorted());
      for (const sessionId of ["session-one", "session-two"]) {
        const sequences = heard
          .filter((event) => event.sessionId === sessionId)
          .map(({ sequence }) => sequence);
        expect(sequences).toEqual(sequences.toSorted((left, right) => left - right));
      }
    });

    it("stops announcing to a listener once it unsubscribes", async () => {
      const { engine, heard, stop } = await fresh();
      await create(engine, "session-stop");
      const count = heard.length;
      stop();
      await engine.submit({
        commandId: "retitle-stop",
        sessionId: "session-stop",
        intent: { kind: "session.retitle", title: "Unheard" },
        provenance,
      });
      expect(heard).toHaveLength(count);
    });
  });
}
