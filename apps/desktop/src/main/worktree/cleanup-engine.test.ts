import { describe, expect, it } from "vite-plus/test";
import type { OrphanCleanupPlanItem } from "@volli/shared";

import { createOrphanCleanupEngine, foldCleanupRun } from "./cleanup-engine";
import { createMemoryOrphanCleanupLedger } from "./cleanup-ledger-memory";

function planItem(overrides: Partial<OrphanCleanupPlanItem> = {}): OrphanCleanupPlanItem {
  return {
    id: "rev1:worktree:0",
    kind: "worktree",
    path: "/root/wt/VC-1",
    projectId: "p1",
    projectName: "Volli",
    projectPath: "/root/project",
    branch: "volli/VC-1",
    gitReason: null,
    ...overrides,
  };
}

function engineWith(now: () => number = () => 1000) {
  const ledger = createMemoryOrphanCleanupLedger();
  let minted = 0;
  const engine = createOrphanCleanupEngine({
    ledger,
    now,
    nextId: () => `id-${(minted += 1)}`,
  });
  return { engine, ledger };
}

const ACCEPT = {
  source: "settings" as const,
  scanRevision: "rev1",
  requestedItemIds: ["rev1:worktree:0"],
  retentionDays: 14,
  preservation: ["branches", "active"],
};

describe("cleanup command core", () => {
  it("records the plan and answers with an acceptance receipt before any change", async () => {
    const { engine, ledger } = engineWith();
    const accepted = await engine.accept({
      commandId: "cmd-1",
      ...ACCEPT,
      items: [
        planItem(),
        planItem({
          id: "rev1:metadata:0",
          kind: "metadata",
          gitReason: "gitdir file points to non-existent location",
        }),
      ],
    });

    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.receipt.status).toBe("accepted");
    expect(accepted.receipt.commandId).toBe("cmd-1");
    expect(accepted.replayed).toBe(false);
    expect(accepted.run.id).toBe("cmd-1");
    expect(accepted.run.scanRevision).toBe("rev1");
    expect(accepted.run.retentionDays).toBe(14);
    expect(accepted.run.preservation).toEqual(["branches", "active"]);
    // Every item starts as work nobody has attempted.
    expect(accepted.run.items.map((item) => item.state)).toEqual(["pending", "pending"]);
    // The accepted plan is durable BEFORE the first mutation fact.
    expect(ledger.facts().map((fact) => fact.kind)).toEqual([
      "command.recorded",
      "cleanup.accepted",
      "command.receipt.recorded",
    ]);
  });

  it("replays the same command id instead of running it twice", async () => {
    const { engine } = engineWith();
    const first = await engine.accept({ commandId: "cmd-1", ...ACCEPT, items: [planItem()] });
    expect(first.ok).toBe(true);
    await engine.beginItem({ commandId: "cmd-1", itemId: "rev1:worktree:0" });
    await engine.settleItem({
      commandId: "cmd-1",
      itemId: "rev1:worktree:0",
      state: "completed",
      detail: "Removed the folder.",
    });

    const replay = await engine.accept({ commandId: "cmd-1", ...ACCEPT, items: [planItem()] });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.replayed).toBe(true);
    // The replay reports the FIRST run's outcome; nothing is queued again.
    expect(replay.run.items[0]?.state).toBe("completed");
  });

  it("refuses a command id reused for different intent", async () => {
    const { engine } = engineWith();
    await engine.accept({ commandId: "cmd-1", ...ACCEPT, items: [planItem()] });
    const conflict = await engine.accept({
      commandId: "cmd-1",
      ...ACCEPT,
      items: [planItem({ path: "/root/wt/VC-2" })],
    });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.code).toBe("conflict");
    expect(conflict.run?.items[0]?.path).toBe("/root/wt/VC-1");
  });

  it("keeps a refused request as history without inventing a run", async () => {
    const { engine } = engineWith();
    const receipt = await engine.reject({
      commandId: "cmd-9",
      scanRevision: "gone",
      requestedItemIds: ["gone:worktree:0"],
      code: "scan-superseded",
      error: "That scan has been superseded.",
    });
    expect(receipt.status).toBe("rejected");
    expect(receipt.code).toBe("scan-superseded");
    // A refusal is not an attempt: it never appears as a run in history.
    expect(await engine.run("cmd-9")).toBeNull();
    expect(await engine.recentRuns()).toEqual([]);
  });

  it("refuses to re-run a command id that was previously rejected", async () => {
    const { engine } = engineWith();
    await engine.reject({
      commandId: "cmd-9",
      scanRevision: "rev1",
      requestedItemIds: ["rev1:worktree:0"],
      code: "unknown-items",
      error: "no such items",
    });
    const retry = await engine.accept({ commandId: "cmd-9", ...ACCEPT, items: [planItem()] });
    expect(retry.ok).toBe(false);
    if (retry.ok) return;
    expect(retry.code).toBe("conflict");
  });

  // The gateway rule (re-review S1): a used command id answers from the durable
  // record BEFORE anything live is consulted, and the answer needs no scan.
  describe("replay", () => {
    it("says nothing about an id it has never seen", async () => {
      const { engine } = engineWith();
      expect(await engine.hasCommand("cmd-1")).toBe(false);
      expect(
        await engine.replay({
          commandId: "cmd-1",
          scanRevision: "rev1",
          itemIds: ["rev1:worktree:0"],
        }),
      ).toBeNull();
    });

    it("replays the recorded run for the same request, in any id order", async () => {
      const { engine } = engineWith();
      await engine.accept({
        commandId: "cmd-1",
        ...ACCEPT,
        requestedItemIds: ["rev1:worktree:0", "rev1:metadata:0"],
        items: [planItem(), planItem({ id: "rev1:metadata:0", kind: "metadata" })],
      });
      await engine.settleItem({
        commandId: "cmd-1",
        itemId: "rev1:worktree:0",
        state: "completed",
        detail: "Removed the folder.",
      });
      await engine.finish({ commandId: "cmd-1" });

      expect(await engine.hasCommand("cmd-1")).toBe(true);
      const replayed = await engine.replay({
        commandId: "cmd-1",
        scanRevision: "rev1",
        // Same set, different order, and repeated — a retry is a retry.
        itemIds: ["rev1:metadata:0", "rev1:worktree:0", "rev1:worktree:0"],
      });
      expect(replayed?.ok).toBe(true);
      if (replayed?.ok !== true) return;
      expect(replayed.run.items[0]?.state).toBe("completed");
      expect(replayed.receipt.status).toBe("completed");
    });

    it("calls a different request under a used id a conflict, and writes nothing", async () => {
      const { engine, ledger } = engineWith();
      await engine.accept({ commandId: "cmd-1", ...ACCEPT, items: [planItem()] });
      const before = ledger.facts().length;

      const other = await engine.replay({
        commandId: "cmd-1",
        scanRevision: "rev2",
        itemIds: ["rev2:worktree:0"],
      });

      expect(other?.ok).toBe(false);
      if (other?.ok !== false) return;
      expect(other.code).toBe("conflict");
      expect(ledger.facts()).toHaveLength(before);
    });

    it("repeats a refusal for the same refused request", async () => {
      const { engine } = engineWith();
      await engine.reject({
        commandId: "cmd-9",
        scanRevision: "gone",
        requestedItemIds: ["gone:worktree:0"],
        code: "scan-superseded",
        error: "That scan has been superseded.",
      });

      const again = await engine.replay({
        commandId: "cmd-9",
        scanRevision: "gone",
        itemIds: ["gone:worktree:0"],
      });

      expect(again?.ok).toBe(false);
      if (again?.ok !== false) return;
      expect(again.code).toBe("scan-superseded");
      expect(again.run).toBeNull();
    });
  });

  // A completed deletion that later grows a `rejected` receipt reads, to
  // whoever takes the last receipt, as a command that never ran (re-review S1).
  it("never records a refusal over a command id that was accepted", async () => {
    const { engine, ledger } = engineWith();
    await engine.accept({ commandId: "cmd-1", ...ACCEPT, items: [planItem()] });
    await engine.finish({ commandId: "cmd-1" });
    const before = ledger.facts().length;

    const receipt = await engine.reject({
      commandId: "cmd-1",
      scanRevision: "rev-stale",
      requestedItemIds: ["rev-stale:worktree:0"],
      code: "scan-superseded",
      error: "That scan has been superseded.",
    });

    // The command keeps the answer it already had.
    expect(receipt.status).toBe("completed");
    expect(ledger.facts()).toHaveLength(before);
    expect((await engine.run("cmd-1"))?.finishedAt).not.toBeNull();
  });

  it("repeats one refusal rather than stacking a receipt per retry", async () => {
    const { engine, ledger } = engineWith();
    const reject = {
      commandId: "cmd-9",
      scanRevision: "gone",
      requestedItemIds: ["gone:worktree:0"],
      code: "scan-superseded" as const,
      error: "That scan has been superseded.",
    };
    const first = await engine.reject(reject);
    const after = ledger.facts().length;
    const second = await engine.reject(reject);

    expect(second).toEqual(first);
    expect(ledger.facts()).toHaveLength(after);
  });

  it("records a refusal for a command row that somehow has no receipt", async () => {
    const { engine, ledger } = engineWith();
    // Not a state this core writes — reachable only from outside — but the
    // refusal path must still be able to answer for it.
    await ledger.transaction(async (tx) => {
      await tx.insertCommand({
        id: "cmd-orphaned",
        intent: {
          kind: "orphan.cleanup",
          source: "settings",
          scanRevision: "rev1",
          requestedItemIds: [],
          retentionDays: 14,
          preservation: [],
          items: [],
        },
        createdAt: 1,
      });
    });

    const receipt = await engine.reject({
      commandId: "cmd-orphaned",
      scanRevision: "rev1",
      requestedItemIds: [],
      code: "unknown-items",
      error: "nothing to do",
    });

    expect(receipt.status).toBe("rejected");
  });

  it("shows an announced-but-unsettled item as executing, never as pending", async () => {
    const { engine } = engineWith();
    await engine.accept({
      commandId: "cmd-1",
      ...ACCEPT,
      items: [planItem(), planItem({ id: "rev1:worktree:1", path: "/root/wt/VC-2" })],
    });
    await engine.beginItem({ commandId: "cmd-1", itemId: "rev1:worktree:0" });

    const run = await engine.run("cmd-1");
    expect(run?.items[0]?.state).toBe("executing");
    expect(run?.items[0]?.startedAt).toBe(1000);
    expect(run?.items[1]?.state).toBe("pending");
  });

  it("never relabels a settled item, whatever is appended afterwards", async () => {
    const { engine } = engineWith();
    await engine.accept({ commandId: "cmd-1", ...ACCEPT, items: [planItem()] });
    await engine.beginItem({ commandId: "cmd-1", itemId: "rev1:worktree:0" });
    await engine.settleItem({
      commandId: "cmd-1",
      itemId: "rev1:worktree:0",
      state: "completed",
      detail: "Removed the folder. Branch volli/VC-1 is still in git.",
      branch: "volli/VC-1",
    });
    // A later reconcile, a retry, a duplicated write: none of them may rewrite
    // a completed deletion into something that reads as un-attempted.
    await engine.settleItem({
      commandId: "cmd-1",
      itemId: "rev1:worktree:0",
      state: "failed",
      detail: "should be ignored",
    });
    await engine.beginItem({ commandId: "cmd-1", itemId: "rev1:worktree:0" });

    const run = await engine.run("cmd-1");
    expect(run?.items[0]?.state).toBe("completed");
    expect(run?.items[0]?.detail).toContain("Branch volli/VC-1 is still in git");
  });

  it("closes a run with a completed receipt", async () => {
    const { engine } = engineWith();
    await engine.accept({ commandId: "cmd-1", ...ACCEPT, items: [planItem()] });
    const { run, receipt } = await engine.finish({ commandId: "cmd-1" });
    expect(receipt.status).toBe("completed");
    expect(run.finishedAt).toBe(1000);
    expect(await engine.openRuns()).toEqual([]);
  });

  it("lists a run the app never closed as open, and stamps it once", async () => {
    let clock = 1000;
    const { engine } = engineWith(() => clock);
    await engine.accept({ commandId: "cmd-1", ...ACCEPT, items: [planItem()] });
    await engine.beginItem({ commandId: "cmd-1", itemId: "rev1:worktree:0" });

    const open = await engine.openRuns();
    expect(open.map((run) => run.id)).toEqual(["cmd-1"]);

    clock = 5000;
    const stamped = await engine.markInterrupted({ commandId: "cmd-1" });
    expect(stamped?.interruptedAt).toBe(5000);
    // Once stamped it is no longer open, and a second launch cannot re-stamp it.
    expect(await engine.openRuns()).toEqual([]);
    clock = 9000;
    const again = await engine.markInterrupted({ commandId: "cmd-1" });
    expect(again?.interruptedAt).toBe(5000);
  });

  it("does not stamp a run that finished normally", async () => {
    const { engine } = engineWith();
    await engine.accept({ commandId: "cmd-1", ...ACCEPT, items: [planItem()] });
    await engine.finish({ commandId: "cmd-1" });
    const stamped = await engine.markInterrupted({ commandId: "cmd-1" });
    expect(stamped?.interruptedAt).toBeNull();
  });

  it("ignores facts for a command it never accepted", async () => {
    const { engine, ledger } = engineWith();
    await engine.beginItem({ commandId: "ghost", itemId: "x" });
    await engine.settleItem({ commandId: "ghost", itemId: "x", state: "failed", detail: null });
    expect(ledger.facts()).toEqual([]);
    expect(await engine.markInterrupted({ commandId: "ghost" })).toBeNull();
  });

  it("throws rather than closing a run for an unknown command", async () => {
    const { engine } = engineWith();
    await expect(engine.finish({ commandId: "ghost" })).rejects.toThrow("Unknown cleanup command");
  });

  it("reads recent runs newest first", async () => {
    const { engine } = engineWith();
    await engine.accept({ commandId: "cmd-1", ...ACCEPT, items: [planItem()] });
    await engine.accept({ commandId: "cmd-2", ...ACCEPT, items: [planItem()] });
    expect((await engine.recentRuns()).map((run) => run.id)).toEqual(["cmd-2", "cmd-1"]);
    expect((await engine.recentRuns(1)).map((run) => run.id)).toEqual(["cmd-2"]);
  });
});

describe("foldCleanupRun", () => {
  it("has no run for facts that never accepted anything", () => {
    expect(
      foldCleanupRun([
        { id: "f1", commandId: "c", kind: "command.recorded", payload: {}, createdAt: 1 },
        {
          id: "f2",
          commandId: "c",
          kind: "cleanup.rejected",
          payload: { code: "unknown-items" },
          createdAt: 2,
        },
      ]),
    ).toBeNull();
  });

  // The re-review's C3: JSON that parses but does not MEAN anything used to be
  // defaulted away — a damaged accepted plan folded into "an empty finished
  // run", which is a deletion history disappearing without anybody being told.
  // Every one of these shapes is now a named fault.
  it("refuses a damaged accepted plan instead of quietly emptying the run", () => {
    const accepted = (intent: unknown) => [
      { id: "f1", commandId: "c", kind: "cleanup.accepted" as const, payload: intent, createdAt: 1 },
      { id: "f2", commandId: "c", kind: "cleanup.run.finished" as const, payload: {}, createdAt: 2 },
    ];
    const good = {
      source: "settings",
      scanRevision: "rev1",
      retentionDays: 14,
      preservation: ["branches"],
      items: [planItem()],
    };
    for (const damaged of [
      null,
      { intent: 7 },
      { intent: { ...good, source: "cron" } },
      { intent: { ...good, scanRevision: 7 } },
      { intent: { ...good, retentionDays: "14" } },
      { intent: { ...good, preservation: "branches" } },
      { intent: { ...good, preservation: ["branches", 7] } },
      { intent: { ...good, items: "none" } },
      { intent: { ...good, items: [7, null] } },
      { intent: { ...good, items: [{ ...planItem(), path: 3 }] } },
    ]) {
      expect(() => foldCleanupRun(accepted(damaged))).toThrow(/damaged accepted plan/);
    }
    // And the undamaged one still folds.
    expect(foldCleanupRun(accepted({ intent: good }))?.items[0]?.id).toBe("rev1:worktree:0");
  });

  it("refuses an unreadable item fact rather than calling it indeterminate", () => {
    const accepted = {
      id: "f1",
      commandId: "c",
      kind: "cleanup.accepted" as const,
      payload: {
        intent: {
          source: "settings",
          scanRevision: "rev1",
          retentionDays: 14,
          preservation: ["branches"],
          items: [planItem({ id: "i1" })],
        },
      },
      createdAt: 1,
    };
    // `indeterminate` is a thing this app WRITES about a mutation it watched.
    // A row nobody can read is not that; it is a broken row, and it says so.
    expect(() =>
      foldCleanupRun([
        accepted,
        {
          id: "f2",
          commandId: "c",
          kind: "cleanup.item.settled",
          payload: { itemId: "i1", state: "from-the-future" },
          createdAt: 2,
        },
      ]),
    ).toThrow(/damaged item outcome/);
    expect(() =>
      foldCleanupRun([
        accepted,
        {
          id: "f2",
          commandId: "c",
          kind: "cleanup.item.settled",
          payload: { state: "completed" },
          createdAt: 2,
        },
      ]),
    ).toThrow(/damaged item outcome/);
    expect(() =>
      foldCleanupRun([
        accepted,
        { id: "f2", commandId: "c", kind: "cleanup.item.started", payload: {}, createdAt: 2 },
      ]),
    ).toThrow(/damaged item start/);
  });

  it("reads a reconciled outcome as established after the fact, with its own instant", () => {
    const run = foldCleanupRun([
      {
        id: "f1",
        commandId: "c",
        kind: "cleanup.accepted",
        payload: {
          intent: {
            source: "settings",
            scanRevision: "rev1",
            retentionDays: 14,
            preservation: [],
            items: [planItem({ id: "i1" }), planItem({ id: "i2", path: "/root/wt/VC-2" })],
          },
        },
        createdAt: 1,
      },
      {
        id: "f2",
        commandId: "c",
        kind: "cleanup.item.settled",
        payload: { itemId: "i1", state: "completed", detail: "gone", reconciled: true },
        createdAt: 900,
      },
      {
        id: "f3",
        commandId: "c",
        kind: "cleanup.item.settled",
        payload: { itemId: "i2", state: "completed", detail: "gone" },
        createdAt: 950,
      },
    ]);
    expect(run?.items[0]?.reconciledAt).toBe(900);
    // An outcome the run itself recorded carries no reconciliation instant: it
    // happened when it says it happened.
    expect(run?.items[1]?.reconciledAt).toBeNull();
  });

  it("ignores a run-level fact that arrives with no accepted plan", () => {
    expect(
      foldCleanupRun([
        { id: "f1", commandId: "c", kind: "cleanup.run.finished", payload: {}, createdAt: 1 },
        { id: "f2", commandId: "c", kind: "cleanup.run.interrupted", payload: {}, createdAt: 2 },
      ]),
    ).toBeNull();
  });
});
