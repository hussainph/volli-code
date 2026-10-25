import { convexTest } from "convex-test";
import type { GenericMutationCtx } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { artifactSpillKey, newId, transcriptPackKey } from "@volli/shared/cloud";

import { api, internal } from "../functions/_generated/api";
import type { DataModel } from "../functions/_generated/dataModel.js";
import schema from "../functions/schema";

const modules = import.meta.glob("../functions/**/*.ts");

type Ctx = GenericMutationCtx<DataModel>;

const ALICE = { subject: "user:alice", issuer: "https://issuer.test" };
const BOB = { subject: "user:bob", issuer: "https://issuer.test" };
const CAROL = { subject: "user:carol", issuer: "https://issuer.test" };

const hex = (char: string) => char.repeat(64);
const digest = (char: string) => `sha256:${hex(char)}`;

function code(value: string) {
  return expect.objectContaining({ data: expect.objectContaining({ code: value }) });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function stubStore() {
  vi.stubEnv("VOLLI_S3_ENDPOINT", "https://acct.r2.cloudflarestorage.com");
  vi.stubEnv("VOLLI_S3_BUCKET", "volli-history");
  vi.stubEnv("VOLLI_S3_ACCESS_KEY_ID", "AKID");
  vi.stubEnv("VOLLI_S3_SECRET_ACCESS_KEY", "secret");
}

/**
 * Alice owns a shared Session (Bob, a fellow member, sees it) and a private
 * one (he does not); Carol is in no Workspace of theirs. The shared Session
 * is claimed, with 100 events accepted.
 */
async function world() {
  const t = convexTest(schema, modules);
  const alice = (await t.withIdentity(ALICE).mutation(api.accounts.ensureViewer, {})).userId;
  const bob = (await t.withIdentity(BOB).mutation(api.accounts.ensureViewer, {})).userId;
  await t.withIdentity(CAROL).mutation(api.accounts.ensureViewer, {});
  const runnerId = newId("runner");
  const ids = await t.run(async (ctx: Ctx) => {
    const workspaceId = newId("workspace");
    await ctx.db.insert("workspaces", {
      id: workspaceId,
      name: "Acme",
      slug: "acme",
      iconKey: null,
      createdByUserId: alice,
      planKey: "free",
      activeMemberCount: 2,
      createdAt: 0,
      deletedAt: null,
      purgeAfter: null,
    });
    for (const userId of [alice, bob]) {
      await ctx.db.insert("workspaceMembers", {
        id: newId("member"),
        workspaceId,
        userId,
        role: "member",
        status: "active",
        billingTier: "free",
        joinedAt: 0,
        suspendedAt: null,
        leftAt: null,
        invitedByUserId: null,
      });
    }
    const projectId = newId("project");
    await ctx.db.insert("projects", {
      id: projectId,
      workspaceId,
      name: "Volli",
      description: "",
      iconKey: null,
      colorIndex: 0,
      ticketPrefix: "VC",
      origin: "github",
      shipBehaviour: "pr",
      customShipPrompt: null,
      coAuthorDefault: true,
      countsTowardCap: true,
      createdByUserId: alice,
      createdAt: 0,
      updatedAt: 0,
      archivedAt: null,
      deletedAt: null,
      purgeAfter: null,
    });
    const session = async (visibility: "shared" | "private") => {
      const sessionId = newId("session");
      await ctx.db.insert("sessions", {
        id: sessionId,
        projectId,
        ticketId: null,
        role: "ticket",
        parentSessionId: null,
        ownerUserId: alice,
        origin: { kind: "user" },
        title: null,
        visibility,
        visibilityReason: visibility === "shared" ? "ticket" : "adhoc",
        sharedAt: null,
        status: "open",
        turnActive: false,
        lastTurnOutcome: null,
        signal: null,
        stopped: null,
        needsUser: false,
        attentionCount: 0,
        placeRunnerId: runnerId,
        model: null,
        usageTotals: {},
        createdAt: 0,
        lastActivityAt: 0,
        deletedAt: null,
        purgeAfter: null,
      });
      return sessionId;
    };
    const sessionId = await session("shared");
    const privateSessionId = await session("private");
    await ctx.db.insert("sessionIntake", {
      sessionId,
      claim: { runnerId, generation: 3 },
      acceptedThrough: 100,
      lastEventId: null,
      lastAcceptedAt: null,
      state: "active",
    });
    return { projectId, sessionId, privateSessionId };
  });
  return {
    t,
    asAlice: t.withIdentity(ALICE),
    asBob: t.withIdentity(BOB),
    asCarol: t.withIdentity(CAROL),
    claim: { runnerId, generation: 3 },
    ...ids,
  };
}

type World = Awaited<ReturnType<typeof world>>;

/** Commit `[first, last]` through the producer's own mutation, packing `digests`. */
async function commit(w: World, first: number, last: number, digests: string[] = []) {
  const segmentId = newId("transcriptSegment");
  await w.asAlice.mutation(api.transcripts.commitSegment, {
    sessionId: w.sessionId,
    claim: w.claim,
    segmentId,
    firstSequence: first,
    lastSequence: last,
    turnIds: [`turn-${first}`],
    key: transcriptPackKey({
      projectId: w.projectId,
      sessionId: w.sessionId,
      firstSequence: first,
      lastSequence: last,
    }),
    bytes: 100 + first,
    sha256: hex("e"),
    artifactCount: digests.length,
    digests,
  });
  return segmentId;
}

describe("sessionTranscript.segments", () => {
  test("pages committed segments back from a sequence, oldest first, keys withheld", async () => {
    const w = await world();
    const args = { sessionId: w.sessionId };
    await expect(w.asAlice.query(api.sessionTranscript.segments, args)).resolves.toEqual({
      segments: [],
      hasMore: false,
      packedThrough: 0,
    });
    const ids = [
      await commit(w, 1, 10),
      await commit(w, 11, 20),
      await commit(w, 21, 30),
      await commit(w, 31, 40),
    ];

    const all = await w.asBob.query(api.sessionTranscript.segments, args);
    expect(all.hasMore).toBe(false);
    expect(all.packedThrough).toBe(40);
    expect(all.segments.map((s) => s.segmentId)).toEqual(ids);
    expect(all.segments[1]).toEqual({
      segmentId: ids[1],
      firstSequence: 11,
      lastSequence: 20,
      turnIds: ["turn-11"],
      format: "volli.transcript-pack/1",
      bytes: 111,
      sha256: hex("e"),
      artifactCount: 0,
    });

    const page = await w.asBob.query(api.sessionTranscript.segments, {
      ...args,
      beforeSequence: 31,
      limit: 2,
    });
    expect(page.segments.map((s) => s.firstSequence)).toEqual([11, 21]);
    expect(page.hasMore).toBe(true);
    const rest = await w.asBob.query(api.sessionTranscript.segments, {
      ...args,
      beforeSequence: 11,
      limit: 2,
    });
    expect(rest).toMatchObject({ segments: [{ firstSequence: 1 }], hasMore: false });

    // The segment covering event 25 is the newest that starts at or before it.
    const covering = await w.asBob.query(api.sessionTranscript.segments, {
      ...args,
      beforeSequence: 26,
      limit: 1,
    });
    expect(covering.segments.map((s) => [s.firstSequence, s.lastSequence])).toEqual([[21, 30]]);
    await expect(
      w.asBob.query(api.sessionTranscript.segments, { ...args, limit: 0 }),
    ).resolves.toEqual({ segments: [], hasMore: true, packedThrough: 40 });
  });

  test("only a viewer who sees the Session reads it; arguments are checked", async () => {
    const w = await world();
    await expect(
      w.t.query(api.sessionTranscript.segments, { sessionId: w.sessionId }),
    ).rejects.toThrow(code("unauthenticated"));
    await expect(
      w.asCarol.query(api.sessionTranscript.segments, { sessionId: w.sessionId }),
    ).rejects.toThrow(code("not_found"));
    await expect(
      w.asBob.query(api.sessionTranscript.segments, { sessionId: w.privateSessionId }),
    ).rejects.toThrow(code("not_found"));
    await expect(
      w.asAlice.query(api.sessionTranscript.segments, { sessionId: w.privateSessionId }),
    ).resolves.toMatchObject({ segments: [] });
    await expect(
      w.asAlice.query(api.sessionTranscript.segments, { sessionId: "nope" }),
    ).rejects.toThrow(code("invalid_argument"));
    for (const bad of [{ beforeSequence: -1 }, { limit: 1.5 }]) {
      await expect(
        w.asAlice.query(api.sessionTranscript.segments, { sessionId: w.sessionId, ...bad }),
      ).rejects.toThrow(code("invalid_argument"));
    }
  });
});

describe("sessionTranscript.artifacts", () => {
  test("answers staged bodies inline or spilled, and absent once packed and swept", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const w = await world();
    const spillKey = artifactSpillKey({
      projectId: w.projectId,
      sessionId: w.sessionId,
      sha256: hex("b"),
    });
    await w.asAlice.mutation(api.transcripts.stageArtifacts, {
      sessionId: w.sessionId,
      claim: w.claim,
      artifacts: [
        {
          digest: digest("a"),
          mediaType: "application/vnd.volli.ui-message+json",
          bytes: 11,
          body: '{"id":"m1"}',
          spillKey: null,
          sequence: 4,
        },
        {
          digest: digest("b"),
          mediaType: "application/vnd.volli.ui-message+json",
          bytes: 70_000,
          body: null,
          spillKey,
          sequence: 5,
        },
      ],
    });
    const args = { sessionId: w.sessionId, digests: [digest("a"), digest("b"), digest("c")] };
    const expected = [
      {
        digest: digest("a"),
        status: "inline",
        mediaType: "application/vnd.volli.ui-message+json",
        bytes: 11,
        body: '{"id":"m1"}',
      },
      {
        digest: digest("b"),
        status: "spilled",
        mediaType: "application/vnd.volli.ui-message+json",
        bytes: 70_000,
      },
      { digest: digest("c"), status: "absent" },
    ];
    // Exactly the allowlist: no key, staging bookkeeping or Convex id.
    await expect(w.asBob.query(api.sessionTranscript.artifacts, args)).resolves.toEqual(expected);
    await expect(
      w.asBob.query(api.sessionTranscript.artifacts, {
        ...args,
        digests: [digest("c"), digest("a"), digest("c")],
      }),
    ).resolves.toEqual([expected[2], expected[0]]);

    // Packed: still served from staging until the sweep drops the rows.
    await commit(w, 1, 10, [digest("a"), digest("b")]);
    await expect(w.asBob.query(api.sessionTranscript.artifacts, args)).resolves.toEqual(expected);
    vi.setSystemTime(1_000_000 + 2 * 60 * 60 * 1000);
    await w.t.mutation(internal.transcripts.sweepPacked, {});
    await expect(w.asBob.query(api.sessionTranscript.artifacts, args)).resolves.toEqual([
      { digest: digest("a"), status: "absent" },
      { digest: digest("b"), status: "absent" },
      { digest: digest("c"), status: "absent" },
    ]);
  });

  test("checks the viewer and the digests", async () => {
    const w = await world();
    const args = { sessionId: w.sessionId, digests: [digest("a")] };
    await expect(w.asCarol.query(api.sessionTranscript.artifacts, args)).rejects.toThrow(
      code("not_found"),
    );
    await expect(
      w.asBob.query(api.sessionTranscript.artifacts, { ...args, sessionId: w.privateSessionId }),
    ).rejects.toThrow(code("not_found"));
    for (const digests of [
      ["sha256:abc"],
      [hex("a")],
      Array.from({ length: 65 }, (_, i) => `sha256:${i.toString(16).padStart(64, "0")}`),
    ]) {
      await expect(
        w.asAlice.query(api.sessionTranscript.artifacts, { ...args, digests }),
      ).rejects.toThrow(code("invalid_argument"));
    }
  });
});

describe("sessionTranscript.presignGet", () => {
  test("signs one GET for a committed pack or a recorded spill of this Session", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 25) });
    const w = await world();
    const spillKey = artifactSpillKey({
      projectId: w.projectId,
      sessionId: w.sessionId,
      sha256: hex("b"),
    });
    await w.asAlice.mutation(api.transcripts.stageArtifacts, {
      sessionId: w.sessionId,
      claim: w.claim,
      artifacts: [
        {
          digest: digest("b"),
          mediaType: "application/x",
          bytes: 70_000,
          body: null,
          spillKey,
          sequence: 50,
        },
      ],
    });
    const segmentId = await commit(w, 1, 10);
    const pack = { sessionId: w.sessionId, object: { kind: "pack" as const, segmentId } };
    const spill = {
      sessionId: w.sessionId,
      object: { kind: "spill" as const, digest: digest("b") },
    };

    await expect(w.asBob.action(api.sessionTranscript.presignGet, pack)).rejects.toThrow(
      code("storage_unconfigured"),
    );
    stubStore();

    const packGrant = await w.asBob.action(api.sessionTranscript.presignGet, pack);
    if (packGrant.status !== "sign") throw new Error("expected a URL");
    expect(packGrant).toMatchObject({ bytes: 101, sha256: hex("e") });
    expect(packGrant.request).toMatchObject({
      method: "GET",
      headers: {},
      expiresAt: Date.UTC(2026, 9, 25) + 300_000,
    });
    const packKey = transcriptPackKey({
      projectId: w.projectId,
      sessionId: w.sessionId,
      firstSequence: 1,
      lastSequence: 10,
    });
    const url = new URL(packGrant.request.url);
    expect(url.host).toBe("acct.r2.cloudflarestorage.com");
    expect(url.pathname).toBe(`/volli-history/${packKey}`);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");

    const spillGrant = await w.asAlice.action(api.sessionTranscript.presignGet, spill);
    if (spillGrant.status !== "sign") throw new Error("expected a URL");
    expect(spillGrant).toMatchObject({ bytes: null, sha256: null });
    expect(new URL(spillGrant.request.url).pathname).toBe(`/volli-history/${spillKey}`);

    // Nothing else is signed: an unknown segment, an inline or unknown body.
    await w.asAlice.mutation(api.transcripts.stageArtifacts, {
      sessionId: w.sessionId,
      claim: w.claim,
      artifacts: [
        {
          digest: digest("a"),
          mediaType: "application/x",
          bytes: 2,
          body: "{}",
          spillKey: null,
          sequence: 60,
        },
      ],
    });
    for (const object of [
      { kind: "pack" as const, segmentId: newId("transcriptSegment") },
      { kind: "spill" as const, digest: digest("a") },
      { kind: "spill" as const, digest: digest("c") },
    ]) {
      await expect(
        w.asAlice.action(api.sessionTranscript.presignGet, { sessionId: w.sessionId, object }),
      ).resolves.toEqual({ status: "absent" });
    }
  });

  test("never signs another Session's object, nor for a viewer who cannot see it", async () => {
    stubStore();
    const w = await world();
    const segmentId = await commit(w, 1, 10);
    // The private Session is Alice's too, but the segment is not its own.
    await expect(
      w.asAlice.action(api.sessionTranscript.presignGet, {
        sessionId: w.privateSessionId,
        object: { kind: "pack", segmentId },
      }),
    ).resolves.toEqual({ status: "absent" });
    const pack = { sessionId: w.sessionId, object: { kind: "pack" as const, segmentId } };
    await expect(w.asCarol.action(api.sessionTranscript.presignGet, pack)).rejects.toThrow(
      code("not_found"),
    );
    await expect(w.t.action(api.sessionTranscript.presignGet, pack)).rejects.toThrow(
      code("unauthenticated"),
    );
    for (const object of [
      { kind: "pack" as const, segmentId: "nope" },
      { kind: "spill" as const, digest: hex("a") },
    ]) {
      await expect(
        w.asAlice.action(api.sessionTranscript.presignGet, { sessionId: w.sessionId, object }),
      ).rejects.toThrow(code("invalid_argument"));
    }
  });
});
