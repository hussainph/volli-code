import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { MAX_INLINE_IMAGE_BYTES, MAX_SESSION_INLINE_IMAGE_BYTES } from "@volli/shared";

import { attachBlob, sessionInlineImageBytes, workspaceRelPath } from "./blob-attach";
import { blobExists } from "./blob-store";
import { listSessionLinks, listTicketLinks } from "./db/blobs-repo";
import { insertProject } from "./db/projects-repo";
import { openTestDb, testProject, testSession, testTicket, type TestDb } from "./db/test-helpers";
import { insertTicket } from "./db/tickets-repo";
import { insertSession } from "./session-control/test-support";

let ctx: TestDb;
let root: string;
let workspace: string;
let ticketId: string;
let sessionId: string;

beforeEach(() => {
  ctx = openTestDb();
  root = mkdtempSync(join(tmpdir(), "volli-blob-attach-"));
  workspace = mkdtempSync(join(tmpdir(), "volli-workspace-"));
  const project = testProject();
  insertProject(ctx.db, project);
  const ticket = testTicket(project.id);
  insertTicket(ctx.db, ticket);
  ticketId = ticket.id;
  const session = testSession(project.id, ticket.id);
  insertSession(ctx.db, session);
  sessionId = session.id;
});

afterEach(() => {
  ctx.cleanup();
  rmSync(root, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]);

/** Writes a file inside the workspace and returns its absolute path. */
function inWorkspace(relPath: string, bytes: Uint8Array = PNG): string {
  const absPath = join(workspace, relPath);
  mkdirSync(join(absPath, ".."), { recursive: true });
  writeFileSync(absPath, bytes);
  return absPath;
}

describe("workspaceRelPath", () => {
  it("relativizes a file inside the root", () => {
    expect(workspaceRelPath("/repo", "/repo/src/a.png")).toBe("src/a.png");
  });

  it("has no relative path without both a root and a source", () => {
    expect(workspaceRelPath(undefined, "/repo/a.png")).toBeNull();
    expect(workspaceRelPath("/repo", undefined)).toBeNull();
  });

  it("refuses a file outside the root", () => {
    expect(workspaceRelPath("/repo", "/elsewhere/a.png")).toBeNull();
  });

  it("is not fooled by a sibling whose name extends the root", () => {
    // A prefix test would call this a child of /repo; a relative-path test
    // sees the `../` and does not.
    expect(workspaceRelPath("/repo", "/repo-evil/a.png")).toBeNull();
  });

  it("refuses the root itself, which names no file", () => {
    expect(workspaceRelPath("/repo", "/repo")).toBeNull();
  });

  it("refuses relative inputs, which cannot be compared honestly", () => {
    expect(workspaceRelPath("repo", "/repo/a.png")).toBeNull();
    expect(workspaceRelPath("/repo", "repo/a.png")).toBeNull();
  });
});

describe("attachBlob: where the file came from decides what happens", () => {
  it("names a repo document live and stores no bytes", async () => {
    const sourcePath = inWorkspace("docs/spec.pdf");
    const outcome = await attachBlob(
      ctx.db,
      root,
      { fileName: "spec.pdf", sourcePath, refRoot: workspace, owner: { sessionId } },
      1,
    );
    expect(outcome).toEqual({ kind: "ref", relPath: "docs/spec.pdf" });
    expect(listSessionLinks(ctx.db, sessionId)).toEqual([]);
  });

  it("names a repo image live AND stores it, so the model can see it", async () => {
    const sourcePath = inWorkspace("src/logo.png");
    const outcome = await attachBlob(
      ctx.db,
      root,
      { fileName: "logo.png", sourcePath, refRoot: workspace, owner: { sessionId } },
      1,
    );
    if (outcome.kind !== "ref-and-blob") throw new Error(`expected both, got ${outcome.kind}`);
    expect(outcome.relPath).toBe("src/logo.png");
    expect(blobExists(root, outcome.blob.blobHash)).toBe(true);
    expect(listSessionLinks(ctx.db, sessionId)).toHaveLength(1);
  });

  it("snapshots a file from outside the project", async () => {
    const outside = join(root, "..", "outside.pdf");
    writeFileSync(outside, PNG);
    const outcome = await attachBlob(
      ctx.db,
      root,
      { fileName: "outside.pdf", sourcePath: outside, refRoot: workspace, owner: { sessionId } },
      1,
    );
    expect(outcome.kind).toBe("blob");
    rmSync(outside, { force: true });
  });

  it("snapshots a paste, which has no path at all", async () => {
    const outcome = await attachBlob(
      ctx.db,
      root,
      { fileName: "pasted.png", bytes: PNG, refRoot: workspace, owner: { sessionId } },
      1,
    );
    if (outcome.kind !== "blob") throw new Error(`expected blob, got ${outcome.kind}`);
    expect(outcome.blob.mime).toBe("image/png");
    expect(blobExists(root, outcome.blob.blobHash)).toBe(true);
  });

  it("snapshots a repo file whose path the ref grammar cannot express", async () => {
    const sourcePath = inWorkspace("docs/design notes.pdf");
    const outcome = await attachBlob(
      ctx.db,
      root,
      {
        fileName: "design notes.pdf",
        sourcePath,
        refRoot: workspace,
        owner: { sessionId },
      },
      1,
    );
    expect(outcome.kind).toBe("blob");
  });

  it("reads bytes off disk when the renderer did not supply them", async () => {
    const sourcePath = inWorkspace("shot.png", new Uint8Array([1, 2, 3]));
    const outcome = await attachBlob(
      ctx.db,
      root,
      { fileName: "shot.png", sourcePath, owner: { sessionId } },
      1,
    );
    if (outcome.kind !== "blob") throw new Error(`expected blob, got ${outcome.kind}`);
    expect(outcome.blob.sizeBytes).toBe(3);
  });
});

describe("attachBlob: owners", () => {
  it("links a ticket attachment and reports it back", async () => {
    const outcome = await attachBlob(
      ctx.db,
      root,
      { fileName: "spec.pdf", bytes: PNG, label: "The spec", owner: { ticketId } },
      5,
    );
    if (outcome.kind !== "blob") throw new Error(`expected blob, got ${outcome.kind}`);
    expect(outcome.blob.label).toBe("The spec");
    expect(outcome.blob.originalName).toBe("spec.pdf");
    expect(outcome.blob.linkId).not.toBeNull();
    expect(listTicketLinks(ctx.db, ticketId)).toHaveLength(1);
  });

  it("imports an unowned Blob with no link, for a Ticket that does not exist yet", async () => {
    const outcome = await attachBlob(
      ctx.db,
      root,
      { fileName: "draft.png", bytes: PNG, owner: { unowned: true } },
      5,
    );
    if (outcome.kind !== "blob") throw new Error(`expected blob, got ${outcome.kind}`);
    expect(outcome.blob.linkId).toBeNull();
    // The bytes are real and previewable; only the owner is pending.
    expect(blobExists(root, outcome.blob.blobHash)).toBe(true);
    expect(outcome.blob.label).toBe("draft.png");
  });

  it("labels an unowned Blob with the caller's label when given one", async () => {
    const outcome = await attachBlob(
      ctx.db,
      root,
      { fileName: "draft.png", bytes: PNG, label: "Mock", owner: { unowned: true } },
      5,
    );
    if (outcome.kind !== "blob") throw new Error(`expected blob, got ${outcome.kind}`);
    expect(outcome.blob.label).toBe("Mock");
  });
});

describe("attachBlob: the guards that keep a session usable", () => {
  it("refuses a single image over the per-image ceiling", async () => {
    const huge = new Uint8Array(MAX_INLINE_IMAGE_BYTES + 1);
    await expect(
      attachBlob(ctx.db, root, { fileName: "huge.png", bytes: huge, owner: { sessionId } }, 1),
    ).rejects.toThrow(/under 5 MB/);
  });

  it("does not cap a document, which is never inlined", async () => {
    const huge = new Uint8Array(MAX_INLINE_IMAGE_BYTES + 1);
    const outcome = await attachBlob(
      ctx.db,
      root,
      { fileName: "huge.pdf", bytes: huge, owner: { sessionId } },
      1,
    );
    expect(outcome.kind).toBe("blob");
  });

  it("does not cap an SVG either — an image no provider takes is a path ref, so its size is a disk question", async () => {
    const huge = new Uint8Array(MAX_INLINE_IMAGE_BYTES + 1);
    const outcome = await attachBlob(
      ctx.db,
      root,
      { fileName: "huge.svg", bytes: huge, owner: { sessionId } },
      1,
    );
    expect(outcome.kind).toBe("blob");
  });

  it("refuses the image that would push a session past its cumulative budget", async () => {
    // Four 5 MB images fit in 20 MB; the fifth cannot, even though it is
    // individually legal. This is the guard the per-image ceiling cannot make.
    for (let i = 0; i < 4; i += 1) {
      const image = new Uint8Array(MAX_INLINE_IMAGE_BYTES);
      image[0] = i;
      await attachBlob(
        ctx.db,
        root,
        { fileName: `shot-${i}.png`, bytes: image, owner: { sessionId } },
        1,
      );
    }
    expect(sessionInlineImageBytes(ctx.db, sessionId)).toBe(MAX_SESSION_INLINE_IMAGE_BYTES);

    const overflow = new Uint8Array(1024);
    overflow[0] = 99;
    await expect(
      attachBlob(
        ctx.db,
        root,
        { fileName: "one-more.png", bytes: overflow, owner: { sessionId } },
        1,
      ),
    ).rejects.toThrow(/already holding/);
  });

  it("counts only images toward the session budget", async () => {
    await attachBlob(
      ctx.db,
      root,
      { fileName: "big.pdf", bytes: new Uint8Array(4096), owner: { sessionId } },
      1,
    );
    expect(sessionInlineImageBytes(ctx.db, sessionId)).toBe(0);
  });

  it("does not budget an SVG, which never inlines and so never replays", async () => {
    await attachBlob(
      ctx.db,
      root,
      { fileName: "diagram.svg", bytes: new Uint8Array(4096), owner: { sessionId } },
      1,
    );
    expect(sessionInlineImageBytes(ctx.db, sessionId)).toBe(0);
  });

  it("does not budget a Ticket, which has no conversation to replay", async () => {
    for (let i = 0; i < 5; i += 1) {
      const image = new Uint8Array(MAX_INLINE_IMAGE_BYTES);
      image[0] = i;
      await attachBlob(
        ctx.db,
        root,
        { fileName: `shot-${i}.png`, bytes: image, owner: { ticketId } },
        1,
      );
    }
    expect(listTicketLinks(ctx.db, ticketId)).toHaveLength(5);
  });
});
