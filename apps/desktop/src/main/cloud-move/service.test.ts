import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createMoveEngine, type MoveEnginePorts, type MoveRow } from "@volli/host-core/cloud-move";
import { insertProject, openVolliDb } from "@volli/host-core/db";
import type { AccountSnapshot, CloudMovePreflightInput, CloudMoveStatus } from "@volli/shared";
import { createDesktopMovesService, type DesktopMovesService } from "./service";
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
  vi.restoreAllMocks();
});
const nope = async (): Promise<never> => {
  throw new Error("Unexpected boundary");
};
function setup() {
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
      releaseCursors: () => [],
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
  const prepare = vi.fn(async (input: CloudMovePreflightInput, _signal: AbortSignal) =>
    prepared(input),
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
  it("does nothing behind the flag and rejects commands before any outside call", async () => {
    const f = setup();
    f.flagOff();
    await expect(f.service.snapshot()).rejects.toThrow("unavailable");
    await expect(f.service.preflight(f.input)).rejects.toThrow("unavailable");
    expect(f.query).not.toHaveBeenCalled();
    expect(f.identity).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });
  it("binds a dry run to person and Workspace, starts once and rejects changed replay", async () => {
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
    await expect(f.service.preflight(f.input)).rejects.toThrow("Pause the running move");
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
    expect(await reading).toMatchObject({ name: "AbortError" });
    expect(rollback).toHaveBeenCalledOnce();
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
