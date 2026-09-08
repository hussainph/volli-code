import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { insertProject } from "./db/projects-repo";
import { openTestDb, testProject, testSession, type TestDb } from "./db/test-helpers";
import { insertSession } from "./session-control/test-support";
import {
  PiSessionOrphanService,
  piSessionDirectoryName,
  piSessionFilename,
} from "./pi-session-orphans";

let ctx: TestDb;
let root: string;

beforeEach(async () => {
  ctx = openTestDb();
  root = await mkdtemp(join(tmpdir(), "volli-pi-orphans-"));
});

afterEach(() => {
  ctx.cleanup();
  rmSync(root, { recursive: true, force: true });
});

const createdAt = "2025-01-02T03:04:05.678Z";
const cwd = "/Users/test/code/project";

function writePiSession(id: string, options: { body?: string; cwd?: string } = {}): string {
  const sessionCwd = options.cwd ?? cwd;
  const directory = join(root, piSessionDirectoryName(sessionCwd));
  mkdirSync(directory, { recursive: true });
  const path = join(directory, piSessionFilename(createdAt, id));
  const header = { kind: "header", v: 4, id, createdAt, cwd: sessionCwd };
  writeFileSync(path, `${JSON.stringify(header)}\n${options.body ?? '{"kind":"message"}'}\n`);
  return path;
}

function bindPi(nativeId: string | null, locatorId: string | null = nativeId): void {
  const project = testProject();
  insertProject(ctx.db, project);
  const session = testSession(project.id);
  insertSession(ctx.db, session);
  ctx.db
    .prepare(
      `UPDATE session_attachments
          SET adapter_id = 'pi', native_id = ?, native_detail = ?
        WHERE session_id = ?`,
    )
    .run(
      nativeId,
      JSON.stringify({
        kind: "volli.native-binding.v1",
        directory: cwd,
        runtime: { path: "pi", version: "1", fingerprint: "sha256:test" },
        locator:
          locatorId === null
            ? null
            : { runtime: "pi", sessionId: locatorId, sessionFilePath: "/fixture/session.jsonl" },
      }),
      session.id,
    );
}

describe("PiSessionOrphanService inventory", () => {
  it("lists exact unreferenced sidecars and protects native and locator ids", async () => {
    const nativePath = writePiSession("native-protected");
    const locatorPath = writePiSession("locator-protected");
    const orphanPath = writePiSession("orphan", { body: '{"payload":"some bytes"}' });
    bindPi("native-protected", "locator-protected");
    const service = new PiSessionOrphanService(ctx.db, root, {
      now: () => 1_700_000_000_000,
      nextId: () => "scan-1",
    });

    const report = await service.scan();

    expect(report.candidates).toEqual([
      expect.objectContaining({ path: orphanPath, sessionId: "orphan" }),
    ]);
    expect(report.candidateCount).toBe(1);
    expect(report.candidateBytes).toBeGreaterThan(0);
    expect(report.candidates.map((candidate) => candidate.path)).not.toContain(nativePath);
    expect(report.candidates.map((candidate) => candidate.path)).not.toContain(locatorPath);
  });

  it("reports symlinks, malformed headers, and unrelated jsonl without proposing them", async () => {
    const directory = join(root, piSessionDirectoryName(cwd));
    mkdirSync(directory, { recursive: true });
    const malformed = join(directory, "malformed.jsonl");
    const unrelated = join(directory, "unrelated.jsonl");
    const external = join(root, "external.jsonl");
    const rootLevel = join(root, "root-level.jsonl");
    const linked = join(directory, piSessionFilename(createdAt, "linked"));
    writeFileSync(malformed, "not-json\n");
    writeFileSync(
      unrelated,
      `${JSON.stringify({ kind: "header", v: 3, id: "old", createdAt, cwd })}\n`,
    );
    writeFileSync(external, "external");
    writeFileSync(rootLevel, "not in an encoded cwd directory");
    symlinkSync(external, linked);

    const report = await new PiSessionOrphanService(ctx.db, root).scan();

    expect(report.candidates).toEqual([]);
    expect(report.skipped.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([malformed, unrelated, linked, external, rootLevel]),
    );
    expect(existsSync(linked)).toBe(true);
  });

  it("fails closed when a Pi attachment locator is malformed", async () => {
    writePiSession("would-look-orphaned");
    bindPi("known", "known");
    ctx.db.prepare("UPDATE session_attachments SET native_detail = ? WHERE adapter_id = 'pi'").run(
      JSON.stringify({
        kind: "volli.native-binding.v1",
        locator: { runtime: "pi", sessionFilePath: "/missing/id.jsonl" },
      }),
    );

    await expect(new PiSessionOrphanService(ctx.db, root).scan()).rejects.toThrow(
      /malformed Pi attachment/i,
    );
  });
});

describe("PiSessionOrphanService explicit reclaim", () => {
  it("removes only the exact confirmed inventory after re-checking each file", async () => {
    const firstPath = writePiSession("orphan-one");
    const secondPath = writePiSession("orphan-two");
    const service = new PiSessionOrphanService(ctx.db, root, { nextId: () => "scan-1" });
    const scan = await service.scan();

    const result = await service.reclaim({
      scanRevision: scan.revision,
      itemIds: scan.candidates.map((candidate) => candidate.itemId),
    });

    expect(result.removedCount).toBe(2);
    expect(result.removedBytes).toBe(scan.candidateBytes);
    expect(result.kept).toEqual([]);
    expect(existsSync(firstPath)).toBe(false);
    expect(existsSync(secondPath)).toBe(false);
  });

  it("protects a session attached after scan and leaves its file", async () => {
    const path = writePiSession("attached-during-confirmation");
    const service = new PiSessionOrphanService(ctx.db, root, { nextId: () => "scan-1" });
    const scan = await service.scan();
    bindPi("attached-during-confirmation");

    const result = await service.reclaim({
      scanRevision: scan.revision,
      itemIds: [scan.candidates[0]!.itemId],
    });

    expect(result.removedCount).toBe(0);
    expect(result.kept[0]?.reason).toMatch(/referenced/i);
    expect(existsSync(path)).toBe(true);
  });

  it("does not delete a path whose file identity changed after inventory", async () => {
    const path = writePiSession("replaced");
    const service = new PiSessionOrphanService(ctx.db, root, { nextId: () => "scan-1" });
    const scan = await service.scan();
    rmSync(path);
    writePiSession("replaced", { body: '{"different":true}' });

    const result = await service.reclaim({
      scanRevision: scan.revision,
      itemIds: [scan.candidates[0]!.itemId],
    });

    expect(result.removedCount).toBe(0);
    expect(result.kept[0]?.reason).toMatch(/changed/i);
    expect(existsSync(path)).toBe(true);
  });

  it("refuses a reclaim that does not name the current reviewed scan", async () => {
    writePiSession("orphan");
    const service = new PiSessionOrphanService(ctx.db, root, { nextId: () => "scan-1" });
    const scan = await service.scan();

    await expect(
      service.reclaim({ scanRevision: "stale", itemIds: [scan.candidates[0]!.itemId] }),
    ).rejects.toThrow(/scan again/i);
  });
});
