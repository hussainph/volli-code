import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { attachBlob } from "./blob-attach";
import { collectUnlinkedBlobs } from "./blob-collect";
import { blobExists } from "./blob-store";
import { deleteBlobLink, getBlob, listTicketLinks } from "./db/blobs-repo";
import { insertProject } from "./db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "./db/test-helpers";
import { insertTicket } from "./db/tickets-repo";

let ctx: TestDb;
let root: string;
let ticketId: string;
let otherProjectId: string;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const OTHER = new Uint8Array([0x01, 0x02, 0x03]);

beforeEach(() => {
  ctx = openTestDb();
  root = mkdtempSync(join(tmpdir(), "volli-blob-collect-"));
  const project = testProject();
  insertProject(ctx.db, project);
  const ticket = testTicket(project.id);
  insertTicket(ctx.db, ticket);
  ticketId = ticket.id;
  otherProjectId = project.id;
});

afterEach(() => {
  ctx.cleanup();
  rmSync(root, { recursive: true, force: true });
});

async function attach(bytes: Uint8Array, owner: Parameters<typeof attachBlob>[2]["owner"]) {
  const outcome = await attachBlob(ctx.db, root, { fileName: "a.png", bytes, owner }, 1);
  if (outcome.kind !== "blob") throw new Error(`expected blob, got ${outcome.kind}`);
  return outcome.blob;
}

describe("collectUnlinkedBlobs", () => {
  it("reclaims an abandoned composer draft", async () => {
    const draft = await attach(PNG, { unowned: true });
    expect(blobExists(root, draft.blobHash)).toBe(true);

    const report = collectUnlinkedBlobs(ctx.db, root);

    expect(report.collected).toEqual([draft.blobHash]);
    expect(blobExists(root, draft.blobHash)).toBe(false);
    expect(getBlob(ctx.db, draft.blobHash)).toBeUndefined();
  });

  it("leaves an attached Blob alone", async () => {
    const attached = await attach(PNG, { ticketId });

    expect(collectUnlinkedBlobs(ctx.db, root).collected).toEqual([]);
    expect(blobExists(root, attached.blobHash)).toBe(true);
    expect(listTicketLinks(ctx.db, ticketId)).toHaveLength(1);
  });

  it("reclaims a Blob only once its last link goes away", async () => {
    const attached = await attach(PNG, { ticketId });
    // The same bytes on a second Ticket are one Blob with two links: collection
    // must wait for both, or the other Ticket loses its file.
    const otherTicket = testTicket(otherProjectId);
    insertTicket(ctx.db, otherTicket);
    const shared = await attach(PNG, { ticketId: otherTicket.id });
    expect(shared.blobHash).toBe(attached.blobHash);

    deleteBlobLink(ctx.db, attached.linkId!, 2);
    expect(collectUnlinkedBlobs(ctx.db, root).collected).toEqual([]);
    expect(blobExists(root, attached.blobHash)).toBe(true);

    deleteBlobLink(ctx.db, shared.linkId!, 3);
    expect(collectUnlinkedBlobs(ctx.db, root).collected).toEqual([attached.blobHash]);
    expect(blobExists(root, attached.blobHash)).toBe(false);
  });

  it("treats a second attach of the same file to the same place as a no-op", async () => {
    const first = await attach(PNG, { ticketId });
    const again = await attach(PNG, { ticketId });

    expect(again.linkId).toBe(first.linkId);
    expect(listTicketLinks(ctx.db, ticketId)).toHaveLength(1);
  });

  it("collects several at once and leaves the linked one standing", async () => {
    const keep = await attach(PNG, { ticketId });
    const dropA = await attach(OTHER, { unowned: true });
    const dropB = await attach(new Uint8Array([9, 9]), { unowned: true });

    const report = collectUnlinkedBlobs(ctx.db, root);

    expect(report.collected.toSorted()).toEqual([dropA.blobHash, dropB.blobHash].toSorted());
    expect(blobExists(root, keep.blobHash)).toBe(true);
  });

  it("is safe to run when there is nothing to collect", () => {
    expect(collectUnlinkedBlobs(ctx.db, root)).toEqual({ collected: [] });
  });

  // A stored new-Ticket draft's attachments are unowned Blobs by construction
  // (no Ticket exists yet to link them) — the exact shape collection reclaims.
  // Without this exception, a relaunch would eat a draft's persisted strip
  // the moment it swept (VC-137).
  it("spares an unlinked Blob a caller names as retained", async () => {
    const draft = await attach(PNG, { unowned: true });

    const report = collectUnlinkedBlobs(ctx.db, root, new Set([draft.blobHash]));

    expect(report.collected).toEqual([]);
    expect(blobExists(root, draft.blobHash)).toBe(true);
    expect(getBlob(ctx.db, draft.blobHash)).toBeDefined();
  });

  it("collects a retained hash's neighbors normally, and releases it once retention lifts", async () => {
    const keep = await attach(PNG, { unowned: true });
    const drop = await attach(OTHER, { unowned: true });

    const guarded = collectUnlinkedBlobs(ctx.db, root, new Set([keep.blobHash]));
    expect(guarded.collected).toEqual([drop.blobHash]);
    expect(blobExists(root, keep.blobHash)).toBe(true);

    // The draft was cleared (create, or erasing the fields) — nothing retains
    // this hash on the next boot, so the ordinary sweep reclaims it.
    const released = collectUnlinkedBlobs(ctx.db, root);
    expect(released.collected).toEqual([keep.blobHash]);
  });
});
