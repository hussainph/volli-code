import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { newId, projectBlobKey } from "@volli/shared/cloud";
import { api } from "../functions/_generated/api";
import { code, seedSession, signIn } from "./board-helpers";
import { importWorld } from "./projectImport-fixtures";

const HASH = "a".repeat(64);
afterEach(() => vi.unstubAllEnvs());
function store() {
  vi.stubEnv("VOLLI_S3_ENDPOINT", "https://storage.example.org");
  vi.stubEnv("VOLLI_S3_BUCKET", "attachments");
  vi.stubEnv("VOLLI_S3_ACCESS_KEY_ID", "test-key");
  vi.stubEnv("VOLLI_S3_SECRET_ACCESS_KEY", "test-secret");
}
async function world(kind: "ticket" | "session" = "ticket") {
  const w = await importWorld();
  const { projectId, ticketId, sessionId } = w.visible;
  const linkId = crypto.randomUUID();
  await w.t.run(async (ctx) => {
    await ctx.db.insert("blobs", {
      projectId,
      sha256: HASH,
      mime: "image/png",
      sizeBytes: 42,
      originalName: "shot.png",
      width: null,
      height: null,
      key: projectBlobKey(projectId, HASH),
      uploadedBy: { kind: "person", userId: w.alice.userId },
      createdAt: 1,
    });
    await ctx.db.insert("blobLinks", {
      id: linkId,
      projectId,
      sha256: HASH,
      owner: { kind, id: kind === "ticket" ? ticketId : sessionId },
      label: "Screenshot",
      createdAt: 1,
    });
    if (kind === "session") {
      const session = await ctx.db
        .query("sessions")
        .withIndex("by_uuid", (q) => q.eq("id", sessionId))
        .unique();
      await ctx.db.patch(session!._id, { visibility: "private" });
    }
  });
  return { ...w, args: { projectId, sha256: HASH }, linkId };
}

describe("project blob reads", () => {
  test("signs only GET for the canonical project object, with a five-minute lifetime", async () => {
    store();
    const w = await world();
    const start = Date.now();
    const grant = await w.bob.as.action(api.files.presignGet, w.args);
    const url = new URL(grant.request.url);
    expect(url.origin).toBe("https://storage.example.org");
    expect(url.pathname).toBe(`/attachments/${projectBlobKey(w.args.projectId, HASH)}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.has("X-Amz-Signature")).toBe(true);
    expect(grant).toMatchObject({
      request: { method: "GET", headers: {} },
      mime: "image/png",
      bytes: 42,
      sha256: HASH,
    });
    expect(grant.request.expiresAt).toBeGreaterThanOrEqual(start + 300_000);
    const links = await w.bob.as.query(api.files.attachments, {
      projectId: w.args.projectId,
      ticketId: w.visible.ticketId,
    });
    expect(links).toEqual([
      {
        linkId: w.linkId,
        blobHash: HASH,
        label: "Screenshot",
        originalName: "shot.png",
        mime: "image/png",
        sizeBytes: 42,
      },
    ]);
    expect(JSON.stringify(links)).not.toContain("/b/");
  });

  test("requires an enrolled person and current active membership", async () => {
    store();
    const w = await world();
    await expect(w.t.action(api.files.presignGet, w.args)).rejects.toMatchObject(
      code("unauthenticated"),
    );
    const carol = await signIn(w.t, "carol");
    await expect(carol.as.action(api.files.presignGet, w.args)).rejects.toMatchObject(
      code("not_a_member"),
    );
    await w.t.run(async (ctx) => {
      const member = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", w.workspaceId).eq("userId", w.bob.userId),
        )
        .unique();
      await ctx.db.patch(member!._id, { status: "suspended" });
    });
    await expect(w.bob.as.action(api.files.presignGet, w.args)).rejects.toMatchObject(
      code("not_a_member"),
    );
  });

  test("a private Session's hash and link id do not confer access; shareAll is applied on read", async () => {
    store();
    const w = await world("session");
    await expect(w.alice.as.action(api.files.presignGet, w.args)).resolves.toMatchObject({
      bytes: 42,
    });
    await expect(w.bob.as.action(api.files.presignGet, w.args)).rejects.toMatchObject(
      code("not_found"),
    );
    const args = { projectId: w.args.projectId, sessionId: w.visible.sessionId };
    await expect(w.bob.as.query(api.files.attachments, args)).rejects.toMatchObject(
      code("not_found"),
    );
    expect(await w.alice.as.query(api.files.attachments, args)).toHaveLength(1);
    await w.t.run(async (ctx) => {
      const policy = await ctx.db
        .query("workspacePolicies")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", w.workspaceId))
        .unique();
      if (policy !== null) await ctx.db.patch(policy._id, { shareAll: true });
      else
        await ctx.db.insert("workspacePolicies", {
          workspaceId: w.workspaceId,
          shareAll: true,
          whoCanInvite: "admins",
          revision: 1,
          updatedByUserId: w.alice.userId,
          updatedAt: 1,
        });
    });
    await expect(w.bob.as.action(api.files.presignGet, w.args)).resolves.toMatchObject({
      bytes: 42,
    });
  });

  test.each(["importing", "deleted", "workspace-deleted"] as const)(
    "a %s project is not_found even for its owner",
    async (state) => {
      store();
      const w = await world();
      await w.t.run(async (ctx) => {
        const project = await ctx.db
          .query("projects")
          .withIndex("by_uuid", (q) => q.eq("id", w.args.projectId))
          .unique();
        if (state === "workspace-deleted") {
          const workspace = await ctx.db
            .query("workspaces")
            .withIndex("by_uuid", (q) => q.eq("id", w.workspaceId))
            .unique();
          await ctx.db.patch(workspace!._id, { deletedAt: 10 });
        } else
          await ctx.db.patch(
            project!._id,
            state === "importing" ? { moveState: "importing" } : { deletedAt: 10 },
          );
      });
      await expect(w.alice.as.action(api.files.presignGet, w.args)).rejects.toMatchObject(
        code("not_found"),
      );
      await expect(
        w.alice.as.query(api.files.attachments, {
          projectId: w.args.projectId,
          ticketId: w.visible.ticketId,
        }),
      ).rejects.toMatchObject(code("not_found"));
    },
  );

  test("a public link to identical bytes is readable without exposing private links", async () => {
    store();
    const w = await world("session");
    await w.t.run((ctx) =>
      ctx.db.insert("blobLinks", {
        id: crypto.randomUUID(),
        projectId: w.args.projectId,
        sha256: HASH,
        owner: { kind: "ticket", id: w.visible.ticketId },
        label: "Public screenshot",
        createdAt: 2,
      }),
    );
    await expect(w.bob.as.action(api.files.presignGet, w.args)).resolves.toMatchObject({
      sha256: HASH,
    });
    const links = await w.bob.as.query(api.files.attachments, {
      projectId: w.args.projectId,
      ticketId: w.visible.ticketId,
    });
    expect(links.map((link) => link.label)).toEqual(["Public screenshot"]);
  });

  test("rejects wrong projects, missing links, invalid hashes and foreign object keys", async () => {
    store();
    const w = await world();
    await expect(
      w.alice.as.action(api.files.presignGet, { ...w.args, projectId: newId("project") }),
    ).rejects.toMatchObject(code("not_found"));
    await expect(
      w.alice.as.action(api.files.presignGet, { ...w.args, sha256: "../escape" }),
    ).rejects.toMatchObject(code("not_found"));
    await w.t.run(async (ctx) => {
      const blob = await ctx.db
        .query("blobs")
        .withIndex("by_project_sha", (q) => q.eq("projectId", w.args.projectId).eq("sha256", HASH))
        .unique();
      await ctx.db.patch(blob!._id, { key: projectBlobKey(newId("project"), HASH) });
    });
    await expect(w.alice.as.action(api.files.presignGet, w.args)).rejects.toMatchObject(
      code("not_found"),
    );
    await w.t.run(async (ctx) => {
      const link = await ctx.db
        .query("blobLinks")
        .withIndex("by_uuid", (q) => q.eq("id", w.linkId))
        .unique();
      await ctx.db.delete(link!._id);
      const blob = await ctx.db
        .query("blobs")
        .withIndex("by_project_sha", (q) => q.eq("projectId", w.args.projectId).eq("sha256", HASH))
        .unique();
      await ctx.db.patch(blob!._id, { key: projectBlobKey(w.args.projectId, HASH) });
    });
    await expect(w.alice.as.action(api.files.presignGet, w.args)).rejects.toMatchObject(
      code("not_found"),
    );
  });

  test("lists ticket links before Session links, but refuses a mismatched Session/ticket pair", async () => {
    const w = await world();
    const session = await seedSession(
      w.t,
      { projectId: w.args.projectId, ticketId: w.visible.ticketId },
      w.alice.userId,
    );
    await w.t.run((ctx) =>
      ctx.db.insert("blobLinks", {
        id: crypto.randomUUID(),
        projectId: w.args.projectId,
        sha256: HASH,
        owner: { kind: "session", id: session.sessionId },
        label: "Session shot",
        createdAt: 0,
      }),
    );
    const links = await w.alice.as.query(api.files.attachments, {
      projectId: w.args.projectId,
      sessionId: session.sessionId,
    });
    expect(links.map((link) => link.label)).toEqual(["Screenshot", "Session shot"]);
    await expect(
      w.alice.as.query(api.files.attachments, {
        projectId: w.args.projectId,
        sessionId: session.sessionId,
        ticketId: newId("ticket"),
      }),
    ).rejects.toMatchObject(code("not_found"));
  });

  test("preserves the source tie-break for moved links with identical names and timestamps", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      const first = await ctx.db
        .query("blobLinks")
        .withIndex("by_uuid", (q) => q.eq("id", w.linkId))
        .unique();
      await ctx.db.patch(first!._id, { sourceOrder: 20 });
      await ctx.db.insert("blobLinks", {
        id: crypto.randomUUID(),
        projectId: w.args.projectId,
        sha256: HASH,
        owner: { kind: "ticket", id: w.visible.ticketId },
        label: "Earlier source link",
        sourceOrder: 10,
        createdAt: 1,
      });
    });
    const links = await w.alice.as.query(api.files.attachments, {
      projectId: w.args.projectId,
      ticketId: w.visible.ticketId,
    });
    expect(links.map((link) => link.label)).toEqual(["Earlier source link", "Screenshot"]);
  });

  test("comment-owned bytes require a live comment and ticket; attribution alone is not private", async () => {
    store();
    const w = await world();
    const commentId = crypto.randomUUID();
    await w.t.run(async (ctx) => {
      await ctx.db.insert("ticketComments", {
        id: commentId,
        projectId: w.args.projectId,
        ticketId: w.visible.ticketId,
        sessionId: w.visible.sessionId,
        author: { kind: "person", userId: w.alice.userId },
        body: "Image",
        createdAt: 0,
        editedAt: null,
        deletedAt: null,
      });
      const link = await ctx.db
        .query("blobLinks")
        .withIndex("by_uuid", (q) => q.eq("id", w.linkId))
        .unique();
      await ctx.db.patch(link!._id, { owner: { kind: "comment", id: commentId } });
    });
    await expect(w.bob.as.action(api.files.presignGet, w.args)).resolves.toMatchObject({
      sha256: HASH,
    });
    await w.t.run(async (ctx) => {
      const comment = await ctx.db
        .query("ticketComments")
        .withIndex("by_uuid", (q) => q.eq("id", commentId))
        .unique();
      await ctx.db.patch(comment!._id, { deletedAt: 1 });
    });
    await expect(w.bob.as.action(api.files.presignGet, w.args)).rejects.toMatchObject(
      code("not_found"),
    );
  });

  test("deleted link owners and cross-project links cannot authorize bytes", async () => {
    store();
    const w = await world();
    await w.t.run(async (ctx) => {
      const ticket = await ctx.db
        .query("tickets")
        .withIndex("by_uuid", (q) => q.eq("id", w.visible.ticketId))
        .unique();
      await ctx.db.patch(ticket!._id, { deletedAt: 1 });
    });
    await expect(w.bob.as.action(api.files.presignGet, w.args)).rejects.toMatchObject(
      code("not_found"),
    );
    await w.t.run(async (ctx) => {
      const ticket = await ctx.db
        .query("tickets")
        .withIndex("by_uuid", (q) => q.eq("id", w.visible.ticketId))
        .unique();
      await ctx.db.patch(ticket!._id, { deletedAt: null, projectId: newId("project") });
    });
    await expect(w.bob.as.action(api.files.presignGet, w.args)).rejects.toMatchObject(
      code("not_found"),
    );
  });

  test("storage is checked after authorization", async () => {
    const w = await world("session");
    vi.stubEnv("VOLLI_S3_ENDPOINT", "");
    await expect(w.bob.as.action(api.files.presignGet, w.args)).rejects.toMatchObject(
      code("not_found"),
    );
    await expect(w.alice.as.action(api.files.presignGet, w.args)).rejects.toMatchObject(
      code("storage_unconfigured"),
    );
  });
});
