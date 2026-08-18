import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { blobUrl, type UIMessageLike } from "@volli/shared";

import { attachBlob } from "./blob-attach";
import { collectUnlinkedBlobs } from "./blob-collect";
import { deleteBlobLink } from "./db/blobs-repo";
import { insertProject } from "./db/projects-repo";
import { openTestDb, testProject, testSession, testTicket, type TestDb } from "./db/test-helpers";
import { insertTicket } from "./db/tickets-repo";
import { insertSession } from "./session-control/test-support";
import { messageBlobHashes, prepareTurnAttachments } from "./turn-attachments";

let ctx: TestDb;
let root: string;
let workspace: string;
let sessionId: string;
let ticketId: string;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

beforeEach(() => {
  ctx = openTestDb();
  root = mkdtempSync(join(tmpdir(), "volli-turn-blobs-"));
  workspace = mkdtempSync(join(tmpdir(), "volli-turn-ws-"));
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

function message(...urls: string[]): UIMessageLike {
  return { parts: [{ type: "text" }, ...urls.map((url) => ({ type: "file", url }))] };
}

const owner = () => ({ sessionId, ticketId, workspacePath: workspace });

async function attach(fileName: string, bytes: Uint8Array) {
  const outcome = await attachBlob(ctx.db, root, { fileName, bytes, owner: { sessionId } }, 1);
  if (outcome.kind !== "blob") throw new Error(`expected blob, got ${outcome.kind}`);
  return outcome.blob;
}

describe("messageBlobHashes", () => {
  it("reads the hashes out of file parts, in order", async () => {
    expect(messageBlobHashes(message(blobUrl("a".repeat(64)), blobUrl("b".repeat(64))))).toEqual([
      "a".repeat(64),
      "b".repeat(64),
    ]);
  });

  it("ignores parts that are not blob file parts", () => {
    expect(
      messageBlobHashes({
        parts: [
          { type: "text" },
          { type: "file", url: "https://example.com/a.png" },
          { type: "file" },
        ],
      }),
    ).toEqual([]);
  });
});

describe("prepareTurnAttachments", () => {
  it("does nothing for a message with no files", async () => {
    expect(await prepareTurnAttachments(ctx.db, root, message(), owner())).toEqual({
      note: "",
      images: [],
    });
  });

  it("materializes an image, names its path, and inlines its bytes", async () => {
    const blob = await attach("shot.png", PNG);

    const prepared = await prepareTurnAttachments(
      ctx.db,
      root,
      message(blobUrl(blob.blobHash)),
      owner(),
    );

    expect(prepared.note).toContain(".volli/attachments/shot.png");
    expect(prepared.images).toHaveLength(1);
    expect(prepared.images[0]).toEqual({
      data: Buffer.from(PNG).toString("base64"),
      mimeType: "image/png",
    });
    // Materialized where the agent can open it, not just described.
    expect(new Uint8Array(readFileSync(join(workspace, ".volli/attachments/shot.png")))).toEqual(
      PNG,
    );
  });

  it("names a document by path but never inlines it, because Pi has no document block", async () => {
    const blob = await attach("spec.pdf", PDF_BYTES);

    const prepared = await prepareTurnAttachments(
      ctx.db,
      root,
      message(blobUrl(blob.blobHash)),
      owner(),
    );

    expect(prepared.note).toContain(".volli/attachments/spec.pdf");
    expect(prepared.images).toEqual([]);
  });

  it("names an SVG by path but never inlines it — the provider would refuse it, and the refusal would replay every turn", async () => {
    const blob = await attach("logo.svg", new TextEncoder().encode("<svg/>"));

    const prepared = await prepareTurnAttachments(
      ctx.db,
      root,
      message(blobUrl(blob.blobHash)),
      owner(),
    );

    // Materialized and named like any file — the agent can open it — but its
    // bytes must never become ImageContent: Pi hands `mimeType` verbatim to
    // the API, image/svg+xml is a guaranteed 400, and an inlined image
    // persists into the sidecar where the failure replays on every later turn.
    expect(prepared.note).toContain(".volli/attachments/logo.svg");
    expect(prepared.images).toEqual([]);
  });

  it("mentions each attachment once even when the message repeats it", async () => {
    const blob = await attach("shot.png", PNG);
    const url = blobUrl(blob.blobHash);

    const prepared = await prepareTurnAttachments(ctx.db, root, message(url, url), owner());

    expect(prepared.images).toHaveLength(1);
    expect(prepared.note.match(/shot\.png/g)).toHaveLength(1);
  });

  it("keeps the prompt path and the on-disk name in step when two files share a basename", async () => {
    const first = await attach("shot.png", PNG);
    const second = await attach("shot.png", new Uint8Array([1, 2, 3, 4]));
    expect(second.blobHash).not.toBe(first.blobHash);

    const prepared = await prepareTurnAttachments(
      ctx.db,
      root,
      message(blobUrl(second.blobHash)),
      owner(),
    );

    // The second file is `shot-2.png`, and the prompt says so rather than
    // naming a path that holds the other file's bytes.
    expect(prepared.note).toContain(".volli/attachments/shot-2.png");
    expect(new Uint8Array(readFileSync(join(workspace, ".volli/attachments/shot-2.png")))).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
  });

  it("names a Blob once when the Ticket and the Session both link it", async () => {
    // Spec material on the Ticket, handed over again mid-chat. One Blob, two
    // links, one file on disk — and one line in the prompt.
    const viaTicket = await attachBlob(
      ctx.db,
      root,
      { fileName: "spec.png", bytes: PNG, owner: { ticketId } },
      1,
    );
    if (viaTicket.kind !== "blob") throw new Error("expected blob");
    const viaSession = await attach("spec.png", PNG);
    expect(viaSession.blobHash).toBe(viaTicket.blob.blobHash);

    const prepared = await prepareTurnAttachments(
      ctx.db,
      root,
      message(blobUrl(viaSession.blobHash)),
      owner(),
    );

    expect(prepared.note.match(/spec/g)).toHaveLength(1);
    expect(prepared.note).toContain(".volli/attachments/spec.png");
  });

  it("says nothing about an attachment that has since been collected", async () => {
    const blob = await attach("gone.png", PNG);
    const url = blobUrl(blob.blobHash);
    deleteBlobLink(ctx.db, blob.linkId!, 2);
    collectUnlinkedBlobs(ctx.db, root);

    // An older turn is re-read after its attachment was removed. Inventing a
    // path here would send the agent after a file that is not there.
    expect(await prepareTurnAttachments(ctx.db, root, message(url), owner())).toEqual({
      note: "",
      images: [],
    });
  });
});
