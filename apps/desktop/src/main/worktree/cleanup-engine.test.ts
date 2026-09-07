import { describe, expect, it } from "vitest";
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
  retentionDays: 14,
  preservation: ["branches", "active"],
};

describe("cleanup command core", () => {
  it("records the plan and answers with an acceptance receipt before any change", async () => {
    const { engine, ledger } = engineWith();
    const accepted = await engine.accept({
      commandId: "cmd-1",
      ...ACCEPT,
      items: [planItem(), planItem({ id: "rev1:metadata:0", kind: "metadata", gitReason: "gitdir file points to non-existent location" })],
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
      code: "unknown-items",
      error: "no such items",
    });
    const retry = await engine.accept({ commandId: "cmd-9", ...ACCEPT, items: [planItem()] });
    expect(retry.ok).toBe(false);
    if (retry.ok) return;
    expect(retry.code).toBe("conflict");
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

  it("survives facts whose payloads are not the shapes it expects", () => {
    const run = foldCleanupRun([
      { id: "f1", commandId: "c", kind: "cleanup.accepted", payload: null, createdAt: 1 },
      { id: "f2", commandId: "c", kind: "cleanup.accepted", payload: { intent: 7 }, createdAt: 2 },
      {
        id: "f3",
        commandId: "c",
        kind: "cleanup.accepted",
        payload: { intent: { items: [7, null], source: "startup" } },
        createdAt: 3,
      },
      {
        id: "f4",
        commandId: "c",
        kind: "cleanup.item.settled",
        payload: { itemId: "nope", state: "completed" },
        createdAt: 4,
      },
      { id: "f5", commandId: "c", kind: "cleanup.run.finished", payload: {}, createdAt: 5 },
    ]);
    expect(run).not.toBeNull();
    expect(run?.source).toBe("startup");
    expect(run?.scanRevision).toBe("");
    expect(run?.retentionDays).toBe(0);
    expect(run?.preservation).toEqual([]);
    expect(run?.items).toEqual([]);
    expect(run?.finishedAt).toBe(5);
  });

  it("reads an unrecognised outcome as indeterminate rather than inventing one", () => {
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
            preservation: ["branches", 7],
            items: [
              {
                id: "i1",
                kind: "worktree",
                path: "/wt",
                projectId: "p",
                projectName: "P",
                projectPath: "/p",
                branch: null,
                gitReason: null,
              },
            ],
          },
        },
        createdAt: 1,
      },
      {
        id: "f2",
        commandId: "c",
        kind: "cleanup.item.settled",
        payload: { itemId: "i1", state: "from-the-future", detail: 9 },
        createdAt: 2,
      },
      { id: "f3", commandId: "c", kind: "cleanup.run.interrupted", payload: {}, createdAt: 3 },
    ]);
    expect(run?.preservation).toEqual(["branches"]);
    expect(run?.items[0]?.state).toBe("indeterminate");
    expect(run?.items[0]?.detail).toBeNull();
    expect(run?.interruptedAt).toBe(3);
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
