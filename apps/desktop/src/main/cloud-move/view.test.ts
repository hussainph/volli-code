import { describe, expect, it, vi, afterEach } from "vite-plus/test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MoveRow, QueueRow } from "@volli/host-core/cloud-move";
import { openRawDb } from "@volli/host-core/testing";
import { moveChecks, createMoveView } from "./view";

describe("content-free real-engine check projection", () => {
  it("does not invent checks before verification", () => {
    expect(moveChecks(null)).toEqual([]);
    expect(moveChecks({})).toEqual([]);
  });
  it("projects counts and both pre-commit and real-path failures, never arbitrary report text", () => {
    const result = moveChecks({
      verify: {
        ok: false,
        streams: {
          tickets: { expected: 3, accumulated: 3, read: 2, match: false },
          sessions: { expected: 1, read: 1, match: true },
        },
        objects: { missing: 0, damaged: 1 },
        failures: ["private body"],
      },
      realPath: {
        ok: false,
        checks: {
          project: { checked: 1, failed: 0 },
          allSessionsFolded: { checked: 2, failed: 1 },
          private: { checked: 1, failed: 1 },
        },
        failures: ["private body"],
      },
      handover: { collisions: 1 },
    });
    expect(result).toContainEqual({
      label: "Tickets",
      passed: false,
      sourceCount: 3,
      cloudCount: 2,
    });
    expect(result).toContainEqual({
      label: "Sessions",
      passed: true,
      sourceCount: 1,
      cloudCount: 1,
    });
    expect(result).toContainEqual({
      label: "All Session views",
      passed: false,
      sourceCount: 2,
      cloudCount: 1,
    });
    expect(result).toContainEqual({ label: "Files and checksums", passed: false });
    expect(result).toContainEqual({ label: "Working folders", passed: false });
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("shows the passed report without mistaking the existence of a report for success", () => {
    expect(
      moveChecks({
        verify: { ok: true, streams: {}, objects: { checked: 2, missing: 0, damaged: 0 } },
        realPath: { ok: true, checks: { sessionHistory: { checked: 1, failed: 0 } } },
        handover: { collisions: 0 },
      }).every((check) => check.passed),
    ).toBe(true);
    expect(moveChecks({ verify: {}, realPath: {} })).toEqual([]);
    expect(
      moveChecks({ realPath: { checks: { sessionHistory: { checked: 1 } } } }).some(
        (check) => !check.passed,
      ),
    ).toBe(true);
  });
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.restoreAllMocks();
});
function localView() {
  const root = mkdtempSync(join(tmpdir(), "move-view-"));
  const db = openRawDb(":memory:");
  // These are the view's read sources, not a replacement for engine/journal tests.
  db.exec(
    "CREATE TABLE projects(id TEXT,name TEXT); INSERT INTO projects VALUES ('project','Project'); CREATE TABLE cloud_moves(project_id TEXT,state TEXT); INSERT INTO cloud_moves VALUES ('project','checked');",
  );
  const row: MoveRow = {
    moveId: "move",
    queueId: "queue",
    projectId: "project",
    position: 0,
    userId: "person",
    workspaceId: "workspace",
    runnerId: "runner",
    state: "checked",
    paused: null,
    journal: {},
    failure: null,
    report: { ok: true, realPath: { ok: true, checks: {} } },
    appVersion: "0.3.0",
    mapperVersion: 1,
    manifestSha256: null,
    supersedes: null,
    createdAt: 1,
    updatedAt: 2,
    committedAt: 2,
    confirmedAt: null,
    returnedAt: null,
  };
  const queue: QueueRow = {
    queueId: "queue",
    userId: "person",
    workspaceId: "workspace",
    runnerId: "runner",
    stopAtFirstProblem: true,
    includeRemoved: false,
    profileStep: "done",
    state: "done",
    backup: { path: "/backup", bytes: 1, verifiedAt: 1 },
    createdAt: 1,
    updatedAt: 2,
  };
  const names = vi.fn(async () => ["local-key"]);
  const projectView = createMoveView({
    db,
    workRoot: root,
    workspaceName: () => "Workspace",
    credentials: names,
  });
  mkdirSync(join(root, "move"));
  cleanups.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, row, queue, names, describe: projectView };
}
describe("recovery survives optional local-detail failures", () => {
  it.each(["preview.json", "plan.json"])(
    "keeps the journal's checked state, freeze and paths when %s is unreadable",
    async (file) => {
      const f = localView();
      writeFileSync(join(f.root, "move", file), "{broken");
      const view = await f.describe(f.row, f.queue);
      expect(view.state).toBe("check");
      expect(view.localReadOnly).toBe(true);
      expect(view.counts).toBeNull();
      expect(view.checks).toContainEqual({ label: "Opened in Volli Cloud", passed: true });
      expect(view.backupPath).toBe("/backup");
      expect(view.returnExportPath).toBe(join(f.root, "move"));
      expect(view.message).toContain("copy the report");
    },
  );
  it("does not lose recovery when credential names fail, nor expose the exception", async () => {
    const f = localView();
    f.names.mockRejectedValue(new Error("private credential detail"));
    const view = await f.describe(f.row, f.queue);
    expect(view.state).toBe("check");
    expect(view.localReadOnly).toBe(true);
    expect(view.localCredentials).toEqual([]);
    expect(JSON.stringify(view)).not.toContain("private credential detail");
  });
  it("does not re-read sealed credential names on every progress tick", async () => {
    const f = localView();
    await f.describe(f.row, f.queue);
    await f.describe(f.row, f.queue);
    expect(f.names).toHaveBeenCalledOnce();
  });
});
