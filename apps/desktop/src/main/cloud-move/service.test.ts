import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createMoveEngine, type MoveEnginePorts, type MoveRow } from "@volli/host-core/cloud-move";
import { insertProject, openVolliDb } from "@volli/host-core/db";
import {
  isOperationCancelled,
  isOperationUnavailable,
  type AccountSnapshot,
  type CloudMovePreflightInput,
  type CloudMovePreflightProgress,
  type CloudMoveStatus,
} from "@volli/shared";
import {
  createDesktopMovesService,
  type DesktopMovesService,
  type MoveDesktopOptions,
} from "./service";
import { describeMove } from "./presentation";
import type { PreparedLocalMoves } from "./preflight";

const PROJECT = "00000000-0000-4000-8000-000000000001";
const WORKSPACE = "00000000-0000-4000-8000-000000000002";
const USER = "00000000-0000-4000-8000-000000000003";
const RUNNER = "00000000-0000-4000-8000-000000000004";
const counts = {
  tickets: 2,
  sessions: 1,
  events: 5,
  attachments: 0,
  attachmentBytes: 0,
  transcriptBytes: 0,
  piLogBytes: 0,
};
const signedIn: AccountSnapshot = {
  state: "signed-in",
  provider: "dev",
  signingInWith: null,
  failure: null,
  account: {
    userId: USER,
    displayName: "Person",
    email: null,
    backend: "synced",
    deletionPurgeAfter: null,
  },
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const work of cleanup.splice(0)) await work();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const nope = async (): Promise<never> => {
  throw new Error("Unexpected boundary");
};
function setup(rearm?: MoveDesktopOptions["rearm"]) {
  const root = mkdtempSync(join(tmpdir(), "move-service-"));
  const db = openVolliDb(join(root, "volli.db"));
  insertProject(db, {
    id: PROJECT,
    name: "Project",
    path: join(root, "repo"),
    ticketPrefix: "PRO",
    colorIndex: 0,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  });
  let enabled = true;
  let account = signedIn;
  const listeners = new Set<(next: AccountSnapshot) => void>();
  const identity = vi.fn(async () => ({ userId: USER, runnerId: RUNNER }));
  const query = vi.fn(async () => [{ workspaceId: WORKSPACE, name: "Workspace", role: "owner" }]);
  let clock = 1;
  const ports: MoveEnginePorts = {
    db,
    profilePath: join(root, "volli.db"),
    workRoot: root,
    stores: { blobsDir: root, transcriptsDir: root, piLogsDir: root },
    homeDir: root,
    appVersion: "0.3.0",
    now: () => ++clock,
    backend: { query, mutation: nope, action: nope },
    objects: { put: nope, head: nope, digest: nope },
    history: {
      eventRecord: (row) => row,
      upload: nope,
      seedCursors: () => {},
    },
    backup: { write: nope },
    identity: { current: identity },
    liveWork: { busySessionIds: () => new Set() },
    realPath: { check: nope },
    exportProject: nope,
  };
  const engine = createMoveEngine(ports);
  const run = vi.spyOn(engine, "run").mockImplementation(async (queueId) => {
    engine.journal.setQueue(queueId, { state: "done" });
    return { kind: "done" };
  });
  const view = async (row: MoveRow): Promise<Omit<CloudMoveStatus, "actions">> => ({
    ...describeMove(row),
    moveId: row.moveId,
    queueId: row.queueId,
    projectId: row.projectId,
    projectName: "Project",
    workspaceName: "Workspace",
    progress: null,
    estimateSeconds: null,
    localReadOnly: row.state !== "returned" && row.state !== "rolled_back",
    confirmedAt: row.confirmedAt,
    backupPath: "/backup",
    returnExportPath: "/changes",
    rollback: null,
    checks: [],
    counts,
    pausedAutomations: [],
    localCredentials: [],
  });
  const prepared = (input: CloudMovePreflightInput): PreparedLocalMoves => ({
    input,
    estimatedExportBytes: 10,
    summaries: {},
    failures: {},
    preflight: {
      id: "preview",
      projects: [
        {
          id: PROJECT,
          name: "Project",
          removed: false,
          counts,
          estimateSeconds: 120,
          blockers: [],
          exclusions: [],
          warnings: [],
        },
      ],
      backupDirectory: root,
      disk: { requiredBytes: 10, freeBytes: 100 },
      stopAtFirstProblem: true,
      exclusions: [],
    },
  });
  const prepare = vi.fn(
    async (
      input: CloudMovePreflightInput,
      _signal: AbortSignal,
      _onProgress?: (progress: CloudMovePreflightProgress) => void,
    ) => prepared(input),
  );
  const assertIdle = vi.fn();
  const releaseIdentity = vi.fn(async () => {});
  const service = createDesktopMovesService({
    enabled: () => enabled,
    engine,
    backend: ports.backend,
    account: {
      snapshot: () => account,
      subscribe: (listener) => {
        listeners.add(listener);
        listener(account);
        return () => listeners.delete(listener);
      },
    },
    identity,
    describe: view,
    prepare,
    remember: async () => {},
    setExportBudget: async () => {},
    assertIdle,
    openCloud: async () => {},
    ...(rearm === undefined ? {} : { rearm }),
    releaseIdentity,
  });
  cleanup.push(async () => {
    await service.dispose();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const enqueue = () =>
    engine.enqueue({
      projectIds: [PROJECT],
      target: { userId: USER, workspaceId: WORKSPACE, runnerId: RUNNER },
    }).moves[0]!;
  const toState = (row: MoveRow, state: MoveRow["state"], report: MoveRow["report"] = null) =>
    engine.journal.advance(row.moveId, row.state, state, { report });
  const input = { projectIds: [PROJECT], workspaceId: WORKSPACE, includeRemoved: false };
  return {
    service,
    engine,
    run,
    identity,
    prepare,
    prepared,
    input,
    query,
    enqueue,
    toState,
    assertIdle,
    releaseIdentity,
    flagOff: () => {
      enabled = false;
    },
    publish(next: AccountSnapshot) {
      account = next;
      for (const listener of listeners) listener(next);
    },
  };
}
const start = (service: DesktopMovesService) =>
  service.start({
    preflightId: "preview",
    projectIds: [PROJECT],
    workspaceId: WORKSPACE,
    stopAtFirstProblem: true,
  });

describe("desktop move coordinator over the real SQLite journal", () => {
  it("exposes re-arm only for a verified result and dispatches an explicit target without registering a runner", async () => {
    const details = {
      columns: [{ automationId: "auto", name: "Review", status: "doing" as const }],
      schedules: [],
      inertGlobals: [],
      canRearmOnThisMac: true,
      unavailable: null,
      retryable: false,
    };
    const rearm = { read: vi.fn(async () => details), perform: vi.fn(async () => {}) };
    const f = setup(rearm);
    const row = f.enqueue();
    await f.service.snapshot();
    expect(rearm.read).not.toHaveBeenCalled();
    f.toState(row, "checked", { ok: false });
    expect((await f.service.snapshot()).moves[0]?.automationRearm).toBeUndefined();
    f.engine.journal.patch(row.moveId, { report: { ok: true } });
    await vi.waitFor(async () =>
      expect((await f.service.snapshot()).moves[0]?.automationRearm?.unavailable).toContain(
        "Finish the move",
      ),
    );
    const target = { kind: "column", automationId: "auto", status: "doing" } as const;
    await expect(
      f.service.command({ moveId: row.moveId, action: "re-arm", rearm: target }),
    ).rejects.toThrow("no longer available");
    expect(rearm.perform).not.toHaveBeenCalled();
    const checked = f.engine.journal.move(row.moveId)!;
    f.toState(checked, "confirmed", { ok: true });
    expect((await f.service.snapshot()).moves[0]?.actions).toContain("re-arm");
    await f.service.command({ moveId: row.moveId, action: "re-arm", rearm: target });
    expect(rearm.perform).toHaveBeenCalledWith(
      expect.objectContaining({ moveId: row.moveId }),
      target,
    );
    expect(f.assertIdle).not.toHaveBeenCalled();
    expect(f.identity).not.toHaveBeenCalled();
    await expect(f.service.command({ moveId: row.moveId, action: "re-arm" })).rejects.toThrow(
      "Choose a paused Automation",
    );
  });
  it("keeps re-arm unavailable without interrupting another active move", async () => {
    const rearm = {
      read: vi.fn(async () => ({
        columns: [],
        schedules: [{ automationId: "auto", name: "Nightly" }],
        inertGlobals: [],
        canRearmOnThisMac: true,
        unavailable: null,
        retryable: false,
      })),
      perform: vi.fn(async () => {}),
    };
    const f = setup(rearm);
    const moved = f.toState(f.enqueue(), "confirmed", { ok: true });
    f.engine.journal.setQueue(moved.queueId, { state: "done" });
    const other = f.engine.enqueue({
      projectIds: ["other-project"],
      target: { userId: USER, workspaceId: WORKSPACE, runnerId: RUNNER },
    }).moves[0]!;
    let interrupted = false;
    f.run.mockImplementation(async (_id, signal) => {
      await new Promise<void>((resolve) =>
        signal!.addEventListener(
          "abort",
          () => {
            interrupted = true;
            resolve();
          },
          { once: true },
        ),
      );
      return { kind: "waiting", moveId: other.moveId, reason: "paused" };
    });
    await f.service.resume();
    await vi.waitFor(() => expect(f.run).toHaveBeenCalled());
    await vi.waitFor(async () =>
      expect(
        (await f.service.snapshot()).moves.find((item) => item.moveId === moved.moveId)
          ?.automationRearm?.unavailable,
      ).toContain("Wait for the running move"),
    );
    const status = (await f.service.snapshot()).moves.find((item) => item.moveId === moved.moveId)!;
    expect(status.actions).not.toContain("re-arm");
    await expect(
      f.service.command({
        moveId: moved.moveId,
        action: "re-arm",
        rearm: { kind: "schedule", automationId: "auto" },
      }),
    ).rejects.toThrow("Wait for the running move");
    expect(interrupted).toBe(false);
    expect(rearm.perform).not.toHaveBeenCalled();
    await f.service.dispose();
  });
  it("never leaks late personal Automation names after the sign-in changes", async () => {
    let finish!: (value: import("@volli/shared").CloudMoveAutomationRearm) => void;
    const rearm = {
      read: vi.fn(
        () =>
          new Promise<import("@volli/shared").CloudMoveAutomationRearm>((resolve) => {
            finish = resolve;
          }),
      ),
      perform: vi.fn(async () => {}),
    };
    const f = setup(rearm);
    f.toState(f.enqueue(), "confirmed", { ok: true });
    const reading = f.service.snapshot();
    await vi.waitFor(() => expect(rearm.read).toHaveBeenCalledOnce());
    f.publish({ ...signedIn, account: { ...signedIn.account!, userId: "other" } });
    finish({
      columns: [],
      schedules: [],
      inertGlobals: [{ id: "private", name: "Private personal Automation" }],
      canRearmOnThisMac: false,
      unavailable: null,
      retryable: false,
    });
    expect((await reading).moves[0]?.automationRearm?.inertGlobals ?? []).toEqual([]);
    expect((await f.service.snapshot()).moves[0]?.automationRearm).toBeUndefined();
    expect(rearm.perform).not.toHaveBeenCalled();
  });
  it("never blocks the journal, Finish or Open cloud on optional Automation reads", async () => {
    const rearm = {
      read: vi.fn(() => new Promise<import("@volli/shared").CloudMoveAutomationRearm>(() => {})),
      perform: vi.fn(async () => {}),
    };
    const f = setup(rearm);
    const row = f.toState(f.enqueue(), "checked", { ok: true });
    const snapshot = await f.service.snapshot();
    expect(snapshot.moves[0]?.actions).toContain("finish");
    expect(snapshot.moves[0]?.automationRearm).toBeUndefined();
    await vi.waitFor(() => expect(rearm.read).toHaveBeenCalledOnce());
    await f.service.command({ moveId: row.moveId, action: "open-cloud" });
    const confirm = vi.spyOn(f.engine, "confirm").mockResolvedValue(row);
    await f.service.command({ moveId: row.moveId, action: "finish" });
    expect(confirm).toHaveBeenCalledOnce();
    const back = vi
      .spyOn(f.engine, "goBackToLocal")
      .mockResolvedValue({ ...row, state: "returned" });
    await f.service.command({ moveId: row.moveId, action: "go-back" });
    expect(back).toHaveBeenCalledOnce();
    expect(rearm.perform).not.toHaveBeenCalled();
    expect(rearm.read).toHaveBeenCalledOnce();
  });
  it("bypasses the metadata throttle on a refreshed watch and coalesces an existing read", async () => {
    const ready = {
      columns: [],
      schedules: [{ automationId: "auto", name: "Nightly" }],
      inertGlobals: [],
      canRearmOnThisMac: true,
      unavailable: null,
      retryable: false,
    };
    let finish!: (value: import("@volli/shared").CloudMoveAutomationRearm) => void;
    const read = vi.fn(
      async (
        _row: MoveRow,
        _fresh?: boolean,
      ): Promise<import("@volli/shared").CloudMoveAutomationRearm> => ready,
    );
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const f = setup({ read, perform: vi.fn(async () => {}) });
    f.toState(f.enqueue(), "confirmed", { ok: true });
    await f.service.snapshot();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    const stop = f.service.onChanged(
      () => {},
      () => {},
    );
    await f.service.snapshot();
    expect(read).toHaveBeenCalledOnce();
    finish(ready);
    await vi.waitFor(async () => {
      await f.service.snapshot();
      expect(read).toHaveBeenCalledTimes(2);
    });
    expect(read.mock.calls[1]?.[1]).toBe(true);
    stop();
  });
  it("keeps accepted re-arm results and personal names visible while refreshing", async () => {
    let accepted = false;
    const details = {
      columns: [{ automationId: "auto", name: "Review", status: "doing" as const }],
      schedules: [{ automationId: "schedule", name: "Nightly" }],
      inertGlobals: [{ id: "global", name: "Personal helper" }],
      canRearmOnThisMac: true,
      unavailable: null,
      retryable: false,
    };
    const read = vi.fn(() =>
      accepted
        ? new Promise<import("@volli/shared").CloudMoveAutomationRearm>(() => {})
        : Promise.resolve(details),
    );
    const f = setup({
      read,
      perform: vi.fn(async () => {
        accepted = true;
      }),
    });
    const row = f.toState(f.enqueue(), "confirmed", { ok: true });
    await vi.waitFor(async () =>
      expect((await f.service.snapshot()).moves[0]?.actions).toContain("re-arm"),
    );
    await f.service.command({
      moveId: row.moveId,
      action: "re-arm",
      rearm: { kind: "column", automationId: "auto", status: "doing" },
    });
    const view = (await f.service.snapshot()).moves[0]?.automationRearm;
    expect(view?.columns).toEqual([]);
    expect(view?.schedules).toEqual(details.schedules);
    expect(view?.inertGlobals).toEqual(details.inertGlobals);
  });
  it("does nothing behind the flag and rejects commands before any outside call", async () => {
    const f = setup();
    f.flagOff();
    await expect(f.service.snapshot()).rejects.toThrow("unavailable");
    await expect(f.service.preflight(f.input)).rejects.toThrow("unavailable");
    expect(f.query).not.toHaveBeenCalled();
    expect(f.identity).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });
  it("binds a dry run to its person, starts once into a Workspace and rejects changed replay", async () => {
    const f = setup();
    await f.service.preflight(f.input);
    await start(f.service);
    await start(f.service);
    expect(f.engine.journal.movesIn(["queued"])).toHaveLength(1);
    await expect(
      f.service.start({
        preflightId: "preview",
        projectIds: [PROJECT],
        workspaceId: WORKSPACE,
        stopAtFirstProblem: false,
      }),
    ).rejects.toThrow("different selection");
    expect(f.assertIdle).toHaveBeenCalledWith(PROJECT);
    expect(f.identity).toHaveBeenCalledOnce();
  });
  it("refuses stale sign-in, a blocked project, low disk and a lost runner", async () => {
    const f = setup();
    await f.service.preflight(f.input);
    f.publish({ ...signedIn, account: { ...signedIn.account!, userId: "other" } });
    await expect(start(f.service)).rejects.toThrow("fresh dry run");
    f.publish(signedIn);
    const preview = f.prepared(f.input);
    preview.preflight.disk.freeBytes = 0;
    f.prepare.mockResolvedValue(preview);
    await f.service.preflight(f.input);
    await expect(start(f.service)).rejects.toThrow("disk space");
    preview.preflight.disk.freeBytes = 100;
    preview.preflight.projects[0]!.blockers.push({ message: "busy" });
    await f.service.preflight(f.input);
    await expect(start(f.service)).rejects.toThrow("passed the dry run");
    preview.preflight.projects[0]!.blockers = [];
    f.identity.mockResolvedValue(null as never);
    await f.service.preflight(f.input);
    await expect(start(f.service)).rejects.toThrow("registered");
    expect(f.engine.journal.movesIn(["queued"])).toEqual([]);
  });
  it("does not offer Finish until checked and every real-path check passed", async () => {
    const f = setup();
    const row = f.enqueue();
    f.toState(row, "checked", { ok: false });
    expect((await f.service.snapshot()).moves[0]!.actions).not.toContain("finish");
    await expect(f.service.command({ moveId: row.moveId, action: "finish" })).rejects.toThrow(
      "no longer available",
    );
    f.engine.journal.patch(row.moveId, { report: { ok: true } });
    await f.service.command({ moveId: row.moveId, action: "finish" });
    expect(f.engine.journal.move(row.moveId)!.state).toBe("confirmed");
    expect((await f.service.snapshot()).moves[0]!.actions).not.toContain("remove-local");
    await expect(
      f.service.command({ moveId: row.moveId, action: "remove-local", confirmation: "Project" }),
    ).rejects.toThrow("no longer available");
    expect(f.engine.journal.move(row.moveId)!.state).toBe("confirmed");
  });
  it("retries the same durable post-commit move, never enqueues a second import", async () => {
    const f = setup();
    const row = f.toState(f.enqueue(), "handed_over");
    await f.service.command({ moveId: row.moveId, action: "retry" });
    await vi.waitFor(() => expect(f.run).toHaveBeenCalled());
    expect(f.engine.journal.movesIn(["handed_over"])).toHaveLength(1);
    expect(f.engine.journal.movesIn(["queued"])).toHaveLength(0);
  });
  it("asks for the exact name only after a changed-cloud refusal; preserves Roll back vs Go back", async () => {
    const f = setup();
    const row = f.toState(f.enqueue(), "checked", { ok: true });
    const rollback = vi
      .spyOn(f.engine, "rollBack")
      .mockRejectedValueOnce({
        code: "changed_since_commit",
        detail: { boardChanges: 2, sessionActive: true, body: "private" },
      })
      .mockResolvedValue(row);
    await expect(f.service.command({ moveId: row.moveId, action: "roll-back" })).rejects.toThrow(
      "type its name",
    );
    const view = (await f.service.snapshot()).moves[0]!;
    expect(view.rollback).toEqual({
      changes: ["2 board changes", "Session history changed"],
      requiresConfirmation: true,
    });
    expect(JSON.stringify(view)).not.toContain("private");
    await expect(
      f.service.command({ moveId: row.moveId, action: "roll-back", confirmation: "wrong" }),
    ).rejects.toThrow("Type the project name");
    expect(rollback).toHaveBeenCalledOnce();
    await f.service.command({ moveId: row.moveId, action: "roll-back", confirmation: "Project" });
    expect(rollback).toHaveBeenLastCalledWith(
      row.moveId,
      expect.objectContaining({ confirmChanged: true, signal: expect.any(AbortSignal) }),
    );
    const back = vi.spyOn(f.engine, "goBackToLocal").mockResolvedValue(row);
    await f.service.command({ moveId: row.moveId, action: "go-back" });
    expect(back).toHaveBeenCalledWith(row.moveId, expect.any(AbortSignal));
  });
  it("ignores obsolete attempts when offering retry or read-only controls", async () => {
    const f = setup();
    const old = f.toState(f.enqueue(), "rolled_back");
    f.enqueue();
    expect(
      (await f.service.snapshot()).moves.find((row) => row.moveId === old.moveId)!.actions,
    ).toEqual([]);
    await expect(f.service.command({ moveId: old.moveId, action: "retry" })).rejects.toThrow(
      "no longer available",
    );
  });
  it("durably stops a paused queue before aborting its worker, and shutdown joins it", async () => {
    const f = setup();
    const row = f.enqueue();
    f.run.mockImplementation(async (_, signal) => {
      await new Promise<void>((resolve) =>
        signal!.addEventListener(
          "abort",
          () => {
            expect(f.engine.journal.queue(row.queueId)!.state).toBe("stopped");
            resolve();
          },
          { once: true },
        ),
      );
      return { kind: "waiting", moveId: row.moveId, reason: "paused" };
    });
    await f.service.resume();
    await vi.waitFor(() => expect(f.run).toHaveBeenCalled());
    await f.service.command({ moveId: row.moveId, action: "pause" });
    expect(f.engine.journal.move(row.moveId)!.paused).toBe("paused");
    await f.service.dispose();
  });
  it("does not pause an active move for another dry run", async () => {
    const f = setup();
    const row = f.enqueue();
    let interrupted = false;
    f.run.mockImplementation(async (_id, signal) => {
      await new Promise<void>((resolve) =>
        signal!.addEventListener(
          "abort",
          () => {
            interrupted = true;
            resolve();
          },
          { once: true },
        ),
      );
      return { kind: "waiting", moveId: row.moveId, reason: "paused" };
    });
    await f.service.resume();
    await vi.waitFor(() => expect(f.run).toHaveBeenCalled());
    await expect(f.service.preflight(f.input)).rejects.toThrow("Wait for the running move");
    expect(interrupted).toBe(false);
    expect(f.prepare).not.toHaveBeenCalled();
    await f.service.dispose();
    expect(interrupted).toBe(true);
  });
  it("lets Cancel interrupt a read-only preflight instead of waiting behind it", async () => {
    const f = setup();
    const row = f.enqueue();
    f.prepare.mockImplementation(async (_input, signal) => {
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Cancelled", "AbortError")),
          { once: true },
        ),
      );
      return f.prepared(f.input);
    });
    const reading = f.service.preflight(f.input).catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
    const rollback = vi.spyOn(f.engine, "rollBack").mockResolvedValue(row);
    await f.service.command({ moveId: row.moveId, action: "cancel" });
    expect(await reading).toMatchObject({ message: "The dry run was cancelled. Run it again." });
    expect(rollback).toHaveBeenCalledOnce();
  });
  it("does not interrupt another project's move to dry-run a retry", async () => {
    const f = setup();
    const old = f.toState(f.enqueue(), "rolled_back");
    f.engine.journal.setQueue(old.queueId, { state: "done" });
    const other = f.engine.enqueue({
      projectIds: ["other-project"],
      target: { userId: USER, workspaceId: WORKSPACE, runnerId: RUNNER },
    }).moves[0]!;
    let interrupted = false;
    f.run.mockImplementation(async (_id, signal) => {
      await new Promise<void>((resolve) =>
        signal!.addEventListener(
          "abort",
          () => {
            interrupted = true;
            resolve();
          },
          { once: true },
        ),
      );
      return { kind: "waiting", moveId: other.moveId, reason: "paused" };
    });
    await f.service.resume();
    await vi.waitFor(() => expect(f.run).toHaveBeenCalled());
    const waiting = (await f.service.snapshot()).moves.find((move) => move.moveId === old.moveId);
    expect(waiting?.actions).toEqual([]);
    expect(waiting?.message).toContain("Retry after the running move finishes.");
    for (const action of ["retry", "skip"] as const)
      await expect(f.service.command({ moveId: old.moveId, action })).rejects.toThrow(
        "Wait for the running move",
      );
    expect(interrupted).toBe(false);
    expect(f.prepare).not.toHaveBeenCalled();
    f.enqueue();
    const superseded = (await f.service.snapshot()).moves.find(
      (move) => move.moveId === old.moveId,
    );
    expect(superseded?.actions).toEqual([]);
    expect(superseded?.message).not.toContain("Retry after the running move finishes.");
    await f.service.dispose();
  });
  it("sanitizes unexpected dry-run errors while preserving named recovery refusals", async () => {
    const f = setup();
    f.prepare.mockRejectedValue(new Error("private source path and content"));
    await expect(f.service.preflight(f.input)).rejects.toThrow("Couldn’t check these projects");
  });
  it("rechecks a rolled-back retry before adding a fresh move", async () => {
    const f = setup();
    const row = f.toState(f.enqueue(), "rolled_back");
    const preview = f.prepared(f.input);
    preview.preflight.projects[0]!.blockers = [{ message: "Finish work first" }];
    f.prepare.mockResolvedValue(preview);
    await expect(f.service.command({ moveId: row.moveId, action: "retry" })).rejects.toThrow(
      "no longer passes",
    );
    expect(f.engine.journal.movesIn(["queued"])).toEqual([]);
    expect(f.identity).not.toHaveBeenCalled();
  });
  it.each(["already_migrated", "preview_waitlisted", "preview_agreement_required"])(
    "offers only the report for %s",
    async (code) => {
      const f = setup();
      const row = f.toState(f.enqueue(), "rolled_back");
      f.engine.journal.patch(row.moveId, {
        failure: { code, message: "private", step: "reserved", at: 1 },
      });
      expect((await f.service.snapshot()).moves[0]!.actions).toEqual([]);
    },
  );
  it("never drives another account's queued work", async () => {
    const f = setup();
    const row = f.enqueue();
    f.publish({ ...signedIn, account: { ...signedIn.account!, userId: "other" } });
    await f.service.resume();
    expect(f.run).not.toHaveBeenCalled();
    expect((await f.service.snapshot()).moves[0]!.actions).toEqual([]);
    await expect(f.service.command({ moveId: row.moveId, action: "cancel" })).rejects.toThrow(
      "belongs",
    );
  });
});

/** A dry run that waits until the test lets it finish, and says when it was aborted. */
function heldDryRun(f: ReturnType<typeof setup>) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const signals: AbortSignal[] = [];
  const progress: ((value: CloudMovePreflightProgress) => void)[] = [];
  f.prepare.mockImplementation(async (input, signal, onProgress) => {
    signals.push(signal);
    if (onProgress !== undefined) progress.push(onProgress);
    await new Promise<void>((resolve, reject) => {
      void released.then(resolve);
      signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), {
        once: true,
      });
    });
    return f.prepared(input);
  });
  return { release: () => release(), signals, progress };
}
const noViewerYet: AccountSnapshot = {
  ...signedIn,
  account: { ...signedIn.account!, userId: null },
};
const signedOut: AccountSnapshot = { ...signedIn, state: "signed-out", account: null };

/** Hold one engine run at a durable boundary; the next run can finish the queue. */
async function heldMove(f: ReturnType<typeof setup>) {
  const row = f.enqueue();
  let release!: () => void;
  let signal!: AbortSignal;
  f.run.mockImplementationOnce(async (queueId, runningSignal) => {
    signal = runningSignal!;
    await new Promise<void>((resolve) => {
      release = () => resolve();
      if (signal.aborted) release();
      else signal.addEventListener("abort", release, { once: true });
    });
    signal.removeEventListener("abort", release);
    if (signal.aborted) {
      f.engine.journal.patch(row.moveId, { paused: "paused" });
      return { kind: "waiting", moveId: row.moveId, reason: "paused" };
    }
    f.engine.journal.setQueue(queueId, { state: "done" });
    return { kind: "done" };
  });
  await f.service.resume();
  await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce());
  return { row, signal, release: () => release() };
}

describe("a running move under a changing sign-in", () => {
  it("survives absent-person flaps and finishes without restarting the engine", async () => {
    const f = setup();
    const held = await heldMove(f);
    vi.useFakeTimers();
    for (const flap of [noViewerYet, signedOut, { ...signedOut, state: "restoring" as const }]) {
      f.publish(flap);
      await vi.advanceTimersByTimeAsync(119_999);
      expect(held.signal.aborted).toBe(false);
      f.publish(signedIn);
    }
    await vi.advanceTimersByTimeAsync(120_000);
    expect(held.signal.aborted).toBe(false);
    held.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.engine.journal.queue(held.row.queueId)?.state).toBe("done");
    expect(f.run).toHaveBeenCalledOnce();
  });

  it("aborts for a different real person and resumes only when the owner returns", async () => {
    const f = setup();
    const held = await heldMove(f);
    f.publish(noViewerYet);
    expect(held.signal.aborted).toBe(false);
    f.publish({ ...signedIn, account: { ...signedIn.account!, userId: "other" } });
    expect(held.signal.aborted).toBe(true);
    await vi.waitFor(() => expect(f.engine.journal.move(held.row.moveId)?.paused).toBe("paused"));
    await f.service.resume();
    expect(f.run).toHaveBeenCalledOnce();
    f.publish(signedIn);
    await vi.waitFor(() => expect(f.engine.journal.queue(held.row.queueId)?.state).toBe("done"));
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it("pauses immediately on the explicit sign-out/backend sign-in-loss path and resumes after sign-in", async () => {
    const f = setup();
    const held = await heldMove(f);
    // The explicit account-port hook and backend 401 use the same stop path.
    f.service.signInLost();
    f.publish(signedOut);
    expect(held.signal.aborted).toBe(true);
    await vi.waitFor(() =>
      expect(f.engine.journal.move(held.row.moveId)?.paused).toBe("signed_out"),
    );
    expect((await f.service.snapshot()).moves[0]?.message).toContain("Sign in");
    await f.service.resume();
    expect(f.run).toHaveBeenCalledOnce();
    f.publish(signedIn);
    await vi.waitFor(() => expect(f.engine.journal.queue(held.row.queueId)?.state).toBe("done"));
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it("pauses after two minutes continuously absent, without extending grace on another blip, and resumes", async () => {
    const f = setup();
    const held = await heldMove(f);
    vi.useFakeTimers();
    f.publish(noViewerYet);
    await vi.advanceTimersByTimeAsync(60_000);
    f.publish(signedOut);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(held.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(held.signal.aborted).toBe(true);
    expect(f.engine.journal.move(held.row.moveId)?.paused).toBe("signed_out");
    expect((await f.service.snapshot()).moves[0]?.message).toContain("Sign in");
    f.publish(signedIn);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.engine.journal.queue(held.row.queueId)?.state).toBe("done");
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it("clears absence grace when a run finishes, so it cannot stop later work", async () => {
    const f = setup();
    const held = await heldMove(f);
    vi.useFakeTimers();
    f.publish(noViewerYet);
    held.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.engine.journal.queue(held.row.queueId)?.state).toBe("done");
    const lost = vi.spyOn(f.service, "signInLost");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(lost).not.toHaveBeenCalled();
  });

  it("clears absence grace on disposal", async () => {
    const f = setup();
    await heldMove(f);
    vi.useFakeTimers();
    f.publish(noViewerYet);
    await f.service.dispose();
    const lost = vi.spyOn(f.service, "signInLost");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(lost).not.toHaveBeenCalled();
  });
});

describe("a long dry run under a changing sign-in (VC-1029)", () => {
  it("survives a sign-in that is briefly absent, and still starts", async () => {
    const f = setup();
    f.service.startWatching();
    const held = heldDryRun(f);
    const reading = f.service.preflight(f.input);
    await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
    // A restore, a refresh or a viewer not yet heard: the same person comes back.
    for (const flap of [noViewerYet, signedOut, signedIn, noViewerYet, signedIn]) f.publish(flap);
    expect(held.signals[0]!.aborted).toBe(false);
    held.release();
    await expect(reading).resolves.toMatchObject({ id: "preview" });
    expect(f.prepare).toHaveBeenCalledOnce();
    await start(f.service);
    expect(f.engine.journal.movesIn(["queued"])).toHaveLength(1);
  });
  it("is adopted by a sign-in that finishes while it runs", async () => {
    const f = setup();
    f.publish(signedOut);
    f.service.startWatching();
    const held = heldDryRun(f);
    const reading = f.service.preflight({ ...f.input, workspaceId: null });
    await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
    f.publish(noViewerYet);
    f.publish(signedIn);
    held.release();
    await expect(reading).resolves.toMatchObject({ id: "preview" });
    await start(f.service);
    expect(f.engine.journal.movesIn(["queued"])).toHaveLength(1);
  });
  it("stops for a different person, as a cancel rather than an unavailable operation", async () => {
    const f = setup();
    f.service.startWatching();
    heldDryRun(f);
    const reading = f.service.preflight(f.input).catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
    f.publish(signedOut);
    f.publish({ ...signedIn, account: { ...signedIn.account!, userId: "other" } });
    const error = await reading;
    expect(isOperationCancelled(error)).toBe(true);
    expect(isOperationUnavailable(error)).toBe(false);
    expect(error).toMatchObject({ message: "The dry run was cancelled. Run it again." });
  });
  it("keeps reading when a backend call loses the sign-in; start waits for it to come back", async () => {
    const f = setup();
    const held = heldDryRun(f);
    const reading = f.service.preflight(f.input);
    await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
    f.service.signInLost();
    expect(held.signals[0]!.aborted).toBe(false);
    held.release();
    await expect(reading).resolves.toMatchObject({ id: "preview" });
  });
  it("never lets the next person start a dry run finished while signed out after someone else", async () => {
    const f = setup();
    f.service.startWatching();
    f.publish(signedOut);
    await f.service.preflight({ ...f.input, workspaceId: null });
    f.publish({ ...signedIn, account: { ...signedIn.account!, userId: "other" } });
    await expect(start(f.service)).rejects.toThrow("fresh dry run");
    await expect(f.service.report("preview")).rejects.toThrow();
  });
  it("joins a repeated dry run for the same selection instead of queueing a second", async () => {
    const f = setup();
    const held = heldDryRun(f);
    const first = f.service.preflight(f.input);
    await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
    // A remounted sheet asks again, for any Workspace: the same dry run answers.
    const again = f.service.preflight({ ...f.input, workspaceId: null });
    held.release();
    expect(await again).toBe(await first);
    expect(f.prepare).toHaveBeenCalledOnce();
  });
  it("replaces a running dry run when the selection changes", async () => {
    const f = setup();
    const held = heldDryRun(f);
    const first = f.service.preflight(f.input).catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
    const second = f.service.preflight({ ...f.input, includeRemoved: true });
    expect(isOperationCancelled(await first)).toBe(true);
    await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(2));
    held.release();
    await expect(second).resolves.toMatchObject({ id: "preview" });
  });
  it("publishes the running dry run's phase and counts, and clears them when it ends", async () => {
    const f = setup();
    const changed = vi.fn();
    f.service.onChanged(changed, () => {});
    const held = heldDryRun(f);
    const reading = f.service.preflight(f.input);
    await vi.waitFor(() => expect(held.progress).toHaveLength(1));
    expect((await f.service.snapshot()).preflight).toBeNull();
    const step: CloudMovePreflightProgress = {
      phase: "exporting",
      projectIndex: 2,
      projectCount: 8,
      projectName: "Project",
      done: 400,
      total: 1000,
      unit: "records",
      startedAt: 1,
    };
    changed.mockClear();
    held.progress[0]!(step);
    expect(changed).toHaveBeenCalledOnce();
    expect((await f.service.snapshot()).preflight).toEqual(step);
    // Counts inside one phase are throttled; a phase change is not.
    held.progress[0]!({ ...step, done: 401 });
    expect(changed).toHaveBeenCalledOnce();
    held.progress[0]!({ ...step, phase: "history", done: null, total: null, unit: null });
    expect(changed).toHaveBeenCalledTimes(2);
    held.release();
    await reading;
    expect((await f.service.snapshot()).preflight).toBeNull();
  });
});
