import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { VOLLI_GITIGNORE_CONTENT } from "@volli/shared";

import { attachmentsRoot, importAttachmentFile } from "./attachment-store";
import { materializeAttachments } from "./attachment-materialize";
import { createAttachment } from "./db/attachments-repo";
import { insertProject } from "./db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "./db/test-helpers";
import { insertTicket } from "./db/tickets-repo";

let ctx: TestDb;
let tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `volli-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  ctx = openTestDb();
  tempDirs = [];
});

afterEach(() => {
  ctx.cleanup();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function seed(): { ticketId: string } {
  const project = testProject();
  insertProject(ctx.db, project);
  const ticket = testTicket(project.id);
  insertTicket(ctx.db, ticket);
  return { ticketId: ticket.id };
}

describe("materializeAttachments", () => {
  it("copies each file attachment's bytes into .volli/attachments and writes the self-gitignore", () => {
    const { ticketId } = seed();
    const root = attachmentsRoot(tempDir("attachments-root"));
    const sessionRoot = tempDir("session-root");

    const a1 = createAttachment(ctx.db, { ticketId, kind: "file", fileName: "spec.png" }, 100);
    const source = join(tempDir("source"), "source.png");
    writeFileSync(source, "bytes-for-spec");
    importAttachmentFile(root, a1.id, source, "spec.png");

    createAttachment(
      ctx.db,
      { ticketId, kind: "url", url: "https://example.com/design", label: "design doc" },
      200,
    );

    const result = materializeAttachments(ctx.db, root, ticketId, sessionRoot);

    const destPath = join(sessionRoot, ".volli", "attachments", "spec.png");
    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath, "utf8")).toBe("bytes-for-spec");

    const gitignorePath = join(sessionRoot, ".volli", ".gitignore");
    expect(existsSync(gitignorePath)).toBe(true);
    expect(readFileSync(gitignorePath, "utf8")).toBe(VOLLI_GITIGNORE_CONTENT);

    expect(result).toEqual({
      files: [{ relPath: ".volli/attachments/spec.png", label: "spec.png" }],
      urls: [{ url: "https://example.com/design", label: "design doc" }],
    });
  });

  it("dedupes two same-basename file attachments using the shared naming rule", () => {
    const { ticketId } = seed();
    const root = attachmentsRoot(tempDir("attachments-root"));
    const sessionRoot = tempDir("session-root");
    const sourceDir = tempDir("source");

    const a1 = createAttachment(ctx.db, { ticketId, kind: "file", fileName: "spec.png" }, 100);
    const source1 = join(sourceDir, "s1.png");
    writeFileSync(source1, "first");
    importAttachmentFile(root, a1.id, source1, "spec.png");

    const a2 = createAttachment(ctx.db, { ticketId, kind: "file", fileName: "spec.png" }, 200);
    const source2 = join(sourceDir, "s2.png");
    writeFileSync(source2, "second");
    importAttachmentFile(root, a2.id, source2, "spec.png");

    const result = materializeAttachments(ctx.db, root, ticketId, sessionRoot);

    expect(result.files).toEqual([
      { relPath: ".volli/attachments/spec.png", label: "spec.png" },
      { relPath: ".volli/attachments/spec-2.png", label: "spec.png" },
    ]);
    expect(readFileSync(join(sessionRoot, ".volli", "attachments", "spec.png"), "utf8")).toBe(
      "first",
    );
    expect(readFileSync(join(sessionRoot, ".volli", "attachments", "spec-2.png"), "utf8")).toBe(
      "second",
    );
  });

  it("never overwrites an already-materialized destination — idempotent across re-boots", () => {
    const { ticketId } = seed();
    const root = attachmentsRoot(tempDir("attachments-root"));
    const sessionRoot = tempDir("session-root");

    const a1 = createAttachment(ctx.db, { ticketId, kind: "file", fileName: "spec.png" }, 100);
    const source = join(tempDir("source"), "source.png");
    writeFileSync(source, "original bytes");
    importAttachmentFile(root, a1.id, source, "spec.png");

    materializeAttachments(ctx.db, root, ticketId, sessionRoot);
    // Simulate the worktree/agent having modified the materialized copy since
    // boot — a re-materialize (session re-open) must never clobber it.
    const destPath = join(sessionRoot, ".volli", "attachments", "spec.png");
    writeFileSync(destPath, "agent-edited bytes");

    const result = materializeAttachments(ctx.db, root, ticketId, sessionRoot);

    expect(readFileSync(destPath, "utf8")).toBe("agent-edited bytes");
    expect(result.files).toEqual([{ relPath: ".volli/attachments/spec.png", label: "spec.png" }]);
  });

  it("throws naming the attachment's label when its stored bytes are missing", () => {
    const { ticketId } = seed();
    const root = attachmentsRoot(tempDir("attachments-root"));
    const sessionRoot = tempDir("session-root");

    createAttachment(
      ctx.db,
      { ticketId, kind: "file", fileName: "spec.png", label: "homepage mock" },
      100,
    );
    // Bytes never imported — the id directory under `root` doesn't exist.

    expect(() => materializeAttachments(ctx.db, root, ticketId, sessionRoot)).toThrow(
      /homepage mock/,
    );
  });

  it("is a cheap no-op that creates nothing for a ticket with no attachments", () => {
    const { ticketId } = seed();
    const root = attachmentsRoot(tempDir("attachments-root"));
    const sessionRoot = tempDir("session-root");

    const result = materializeAttachments(ctx.db, root, ticketId, sessionRoot);

    expect(result).toEqual({ files: [], urls: [] });
    expect(existsSync(join(sessionRoot, ".volli"))).toBe(false);
  });

  it("does not rewrite an existing .volli/.gitignore", () => {
    const { ticketId } = seed();
    const root = attachmentsRoot(tempDir("attachments-root"));
    const sessionRoot = tempDir("session-root");
    mkdirSync(join(sessionRoot, ".volli"), { recursive: true });
    writeFileSync(join(sessionRoot, ".volli", ".gitignore"), "custom\n", "utf8");

    createAttachment(
      ctx.db,
      { ticketId, kind: "url", url: "https://example.com", label: "https://example.com" },
      100,
    );
    materializeAttachments(ctx.db, root, ticketId, sessionRoot);

    expect(readFileSync(join(sessionRoot, ".volli", ".gitignore"), "utf8")).toBe("custom\n");
  });

  it("throws helpfully naming the label even when other attachments materialize fine", () => {
    const { ticketId } = seed();
    const root = attachmentsRoot(tempDir("attachments-root"));
    const sessionRoot = tempDir("session-root");

    const good = createAttachment(ctx.db, { ticketId, kind: "file", fileName: "ok.png" }, 100);
    const source = join(tempDir("source"), "ok.png");
    writeFileSync(source, "ok bytes");
    importAttachmentFile(root, good.id, source, "ok.png");

    createAttachment(
      ctx.db,
      { ticketId, kind: "file", fileName: "missing.png", label: "the missing one" },
      200,
    );

    expect(() => materializeAttachments(ctx.db, root, ticketId, sessionRoot)).toThrow(
      /the missing one/,
    );
  });
});
