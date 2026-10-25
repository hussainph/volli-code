import { convexTest } from "convex-test";
import type { GenericMutationCtx } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import {
  PACKED_STAGING_TTL_MS,
  artifactSpillKey,
  newId,
  piLogSegmentKey,
  transcriptPackKey,
} from "@volli/shared/cloud";

import { api, internal } from "../functions/_generated/api";
import type { DataModel } from "../functions/_generated/dataModel.js";
import schema from "../functions/schema";

const modules = import.meta.glob("../functions/**/*.ts");

type Ctx = GenericMutationCtx<DataModel>;
type T = ReturnType<typeof convexTest>;

const ALICE = { subject: "user:alice", issuer: "https://issuer.test" };
const BOB = { subject: "user:bob", issuer: "https://issuer.test" };

const hex = (char: string) => char.repeat(64);
const digest = (char: string) => `sha256:${hex(char)}`;

function code(value: string) {
  return expect.objectContaining({ data: expect.objectContaining({ code: value }) });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** Alice owns a claimed Session; Bob is a fellow member who does not. */
async function world(options: { acceptedThrough?: number; intake?: boolean } = {}) {
  const t = convexTest(schema, modules);
  const alice = (await t.withIdentity(ALICE).mutation(api.accounts.ensureViewer, {})).userId;
  const bob = (await t.withIdentity(BOB).mutation(api.accounts.ensureViewer, {})).userId;
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
      visibility: "shared",
      visibilityReason: "ticket",
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
    if (options.intake !== false) {
      await ctx.db.insert("sessionIntake", {
        sessionId,
        claim: { runnerId, generation: 3 },
        acceptedThrough: options.acceptedThrough ?? 100,
        lastEventId: null,
        lastAcceptedAt: null,
        state: "active",
      });
    }
    return { projectId, sessionId };
  });
  const claim = { runnerId, generation: 3 };
  return { t, asAlice: t.withIdentity(ALICE), asBob: t.withIdentity(BOB), claim, ...ids };
}

type World = Awaited<ReturnType<typeof world>>;

function segment(w: World, firstSequence: number, lastSequence: number, extra: object = {}) {
  return {
    sessionId: w.sessionId,
    claim: w.claim,
    segmentId: newId("transcriptSegment"),
    firstSequence,
    lastSequence,
    turnIds: [],
    key: transcriptPackKey({
      projectId: w.projectId,
      sessionId: w.sessionId,
      firstSequence,
      lastSequence,
    }),
    bytes: 10,
    sha256: hex("1"),
    artifactCount: 0,
    digests: [] as string[],
    ...extra,
  };
}

function staged(char: string, sequence: number | null, body = "{}") {
  return {
    digest: digest(char),
    mediaType: "application/x",
    bytes: body.length,
    body,
    spillKey: null,
    sequence,
  };
}

async function stagingRows(t: T) {
  return t.run(async (ctx: Ctx) => ctx.db.query("transcriptArtifacts").collect());
}

describe("the producer fence", () => {
  test("only the owner presenting the current claim may write or read the head", async () => {
    const w = await world();
    const head = { sessionId: w.sessionId, claim: w.claim, piFileIds: [] };
    await expect(w.asAlice.query(api.transcripts.head, head)).resolves.toEqual({
      transcriptThrough: 0,
      piLogs: {},
    });
    await expect(w.t.query(api.transcripts.head, head)).rejects.toThrow(code("unauthenticated"));
    await expect(w.asBob.query(api.transcripts.head, head)).rejects.toThrow(code("forbidden"));
    await expect(
      w.asAlice.query(api.transcripts.head, { ...head, claim: { ...w.claim, generation: 2 } }),
    ).rejects.toThrow(code("stale_claim"));
    await expect(
      w.asAlice.query(api.transcripts.head, { ...head, sessionId: "nope" }),
    ).rejects.toThrow(code("invalid_argument"));
  });

  test("a Session nobody holds, or one being released, refuses writes", async () => {
    const w = await world({ intake: false });
    await expect(
      w.asAlice.mutation(api.transcripts.stageArtifacts, {
        sessionId: w.sessionId,
        claim: w.claim,
        artifacts: [],
      }),
    ).rejects.toThrow(code("not_claimed"));
    const v = await world();
    await v.t.run(async (ctx: Ctx) => {
      const intake = await ctx.db.query("sessionIntake").first();
      await ctx.db.patch(intake!._id, { state: "releasing" });
    });
    await expect(
      v.asAlice.mutation(api.transcripts.commitSegment, segment(v, 1, 1)),
    ).rejects.toThrow(code("not_claimed"));
  });
});

describe("stageArtifacts", () => {
  test("stages inline and spilled bodies once, keeping the earliest referencing sequence", async () => {
    const w = await world();
    const spillKey = artifactSpillKey({
      projectId: w.projectId,
      sessionId: w.sessionId,
      sha256: hex("b"),
    });
    const first = await w.asAlice.mutation(api.transcripts.stageArtifacts, {
      sessionId: w.sessionId,
      claim: w.claim,
      artifacts: [
        staged("a", 7, '{"x":"é"}'.replace("é", "e")),
        {
          digest: digest("b"),
          mediaType: "application/x",
          bytes: 90_000,
          body: null,
          spillKey,
          sequence: null,
        },
      ],
    });
    expect(first).toEqual({ staged: 2, skipped: 0 });
    const again = await w.asAlice.mutation(api.transcripts.stageArtifacts, {
      sessionId: w.sessionId,
      claim: w.claim,
      artifacts: [
        staged("a", 9),
        staged("a", 4),
        {
          digest: digest("b"),
          mediaType: "application/x",
          bytes: 90_000,
          body: null,
          spillKey,
          sequence: 5,
        },
      ],
    });
    expect(again).toEqual({ staged: 0, skipped: 3 });
    const rows = await stagingRows(w.t);
    expect(rows.map((r) => [r.digest, r.firstSequence, r.uploadedBy, r.spillKey !== null])).toEqual(
      [
        [digest("a"), 4, "runner", false],
        [digest("b"), 5, "runner", true],
      ],
    );
  });

  test("refuses malformed artifacts", async () => {
    const w = await world();
    const call = (artifact: object) =>
      w.asAlice.mutation(api.transcripts.stageArtifacts, {
        sessionId: w.sessionId,
        claim: w.claim,
        artifacts: [{ ...staged("a", 1), ...artifact }],
      });
    for (const bad of [
      { digest: "sha256:xyz" },
      { mediaType: "" },
      { bytes: -1 },
      { sequence: 0 },
      { spillKey: "v1/x" },
      { body: null },
      { bytes: 3 },
      { body: "x".repeat(64 * 1024 + 1), bytes: 64 * 1024 + 1 },
      { body: null, spillKey: "v1/p/elsewhere" },
    ]) {
      await expect(call(bad)).rejects.toThrow(code("invalid_argument"));
    }
    await expect(
      w.asAlice.mutation(api.transcripts.stageArtifacts, {
        sessionId: w.sessionId,
        claim: w.claim,
        artifacts: Array.from({ length: 65 }, () => staged("a", 1)),
      }),
    ).rejects.toThrow(code("invalid_argument"));
  });

  test("a body whose event a committed segment covers is already packed, so not staged", async () => {
    const w = await world();
    await w.asAlice.mutation(api.transcripts.commitSegment, segment(w, 1, 10));
    const result = await w.asAlice.mutation(api.transcripts.stageArtifacts, {
      sessionId: w.sessionId,
      claim: w.claim,
      artifacts: [staged("a", 10), staged("b", 11)],
    });
    expect(result).toEqual({ staged: 1, skipped: 1 });
    expect((await stagingRows(w.t)).map((r) => r.digest)).toEqual([digest("b")]);
  });
});

describe("commitSegment", () => {
  test("segments tile the accepted range from 1 and expire the staging rows they pack", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const w = await world({ acceptedThrough: 20 });
    await w.asAlice.mutation(api.transcripts.stageArtifacts, {
      sessionId: w.sessionId,
      claim: w.claim,
      artifacts: [staged("a", 2), staged("b", 3), staged("c", 4)],
    });
    await w.t.run(async (ctx: Ctx) => {
      await ctx.db.insert("sessionTurns", {
        sessionId: w.sessionId,
        turnId: "turn-1",
        attachmentId: "att",
        startedSequence: 1,
        endedSequence: 5,
        outcome: null,
        origin: null,
        startedAt: 0,
        endedAt: null,
        usage: null,
        segmentId: null,
      });
    });
    const first = segment(w, 1, 5, {
      turnIds: ["turn-1", "turn-unknown"],
      artifactCount: 2,
      digests: [digest("a"), digest("b")],
    });
    await expect(w.asAlice.mutation(api.transcripts.commitSegment, first)).resolves.toEqual({
      status: "committed",
    });
    // `c` was missing from the pack: its staging row stays readable and does not expire.
    const rows = await stagingRows(w.t);
    const committed = await w.t.run(async (ctx: Ctx) => ctx.db.query("transcriptSegments").first());
    const expiresAt = committed!.createdAt + PACKED_STAGING_TTL_MS;
    expect(rows.map((r) => [r.digest, r.packedSegmentId, r.expiresAt])).toEqual([
      [digest("a"), first.segmentId, expiresAt],
      [digest("b"), first.segmentId, expiresAt],
      [digest("c"), null, null],
    ]);
    expect(committed).toMatchObject({
      id: first.segmentId,
      projectId: w.projectId,
      key: first.key,
      format: "volli.transcript-pack/1",
      turnIds: ["turn-1", "turn-unknown"],
    });
    const turn = await w.t.run(async (ctx: Ctx) => ctx.db.query("sessionTurns").first());
    expect(turn?.segmentId).toBe(first.segmentId);

    // The same object again is a duplicate; the next range must start at 6.
    await expect(w.asAlice.mutation(api.transcripts.commitSegment, first)).resolves.toEqual({
      status: "duplicate",
    });
    await expect(
      w.asAlice.mutation(api.transcripts.commitSegment, { ...first, sha256: hex("2") }),
    ).rejects.toThrow(code("conflict"));
    await expect(
      w.asAlice.mutation(api.transcripts.commitSegment, segment(w, 7, 9)),
    ).rejects.toThrow(code("gap"));
    await expect(
      w.asAlice.mutation(api.transcripts.commitSegment, segment(w, 6, 21)),
    ).rejects.toThrow(code("beyond_accepted"));
    await expect(
      w.asAlice.mutation(api.transcripts.commitSegment, segment(w, 6, 20)),
    ).resolves.toEqual({ status: "committed" });
    await expect(
      w.asAlice.query(api.transcripts.head, {
        sessionId: w.sessionId,
        claim: w.claim,
        piFileIds: [],
      }),
    ).resolves.toMatchObject({ transcriptThrough: 20 });
  });

  test("refuses a malformed commit", async () => {
    const w = await world();
    const good = segment(w, 1, 2);
    for (const bad of [
      { segmentId: "x" },
      { firstSequence: 0 },
      { lastSequence: 1.5 },
      {
        firstSequence: 3,
        key: transcriptPackKey({
          projectId: w.projectId,
          sessionId: w.sessionId,
          firstSequence: 1,
          lastSequence: 1,
        }),
      },
      { bytes: 0 },
      { bytes: 65 * 1024 * 1024 },
      { sha256: "abc" },
      { artifactCount: -1 },
      { artifactCount: 3000 },
      { artifactCount: 1 },
      { artifactCount: 2, digests: [digest("a"), digest("a")] },
      { artifactCount: 1, digests: ["sha256:x"] },
      { turnIds: [""] },
      { key: "v1/p/other" },
    ]) {
      await expect(
        w.asAlice.mutation(api.transcripts.commitSegment, { ...good, ...bad }),
      ).rejects.toThrow(code("invalid_argument"));
    }
  });
});

describe("commitPiLogSegment", () => {
  function piSegment(w: World, startOffset: number, endOffset: number, extra: object = {}) {
    return {
      sessionId: w.sessionId,
      claim: w.claim,
      attachmentId: "att-1",
      piFileId: "2026-10-25T01-02-03-004Z_abc",
      startOffset,
      endOffset,
      key: piLogSegmentKey({
        projectId: w.projectId,
        sessionId: w.sessionId,
        attachmentId: "att-1",
        piFileId: "2026-10-25T01-02-03-004Z_abc",
        offset: startOffset,
      }),
      bytes: 10,
      sha256: hex("3"),
      ...extra,
    };
  }

  test("ranges are contiguous per Pi file from 0, idempotent, and reported by the head", async () => {
    const w = await world();
    const commit = (input: object) =>
      w.asAlice.mutation(api.transcripts.commitPiLogSegment, input as never);
    await expect(commit(piSegment(w, 5, 9))).rejects.toThrow(code("gap"));
    await expect(commit(piSegment(w, 0, 100))).resolves.toEqual({ status: "committed" });
    await expect(commit(piSegment(w, 0, 100))).resolves.toEqual({ status: "duplicate" });
    await expect(commit(piSegment(w, 0, 101))).rejects.toThrow(code("conflict"));
    await expect(
      commit(
        piSegment(w, 100, 150, {
          attachmentId: "att-2",
          key: piLogSegmentKey({
            projectId: w.projectId,
            sessionId: w.sessionId,
            attachmentId: "att-2",
            piFileId: "2026-10-25T01-02-03-004Z_abc",
            offset: 100,
          }),
        }),
      ),
    ).rejects.toThrow(code("conflict"));
    await expect(commit(piSegment(w, 100, 150))).resolves.toEqual({ status: "committed" });
    await expect(
      w.asAlice.query(api.transcripts.head, {
        sessionId: w.sessionId,
        claim: w.claim,
        piFileIds: ["2026-10-25T01-02-03-004Z_abc", "other", "other"],
      }),
    ).resolves.toEqual({
      transcriptThrough: 0,
      piLogs: { "2026-10-25T01-02-03-004Z_abc": 150, other: 0 },
    });
  });

  test("refuses a malformed commit", async () => {
    const w = await world();
    for (const bad of [
      { startOffset: -1 },
      { endOffset: 0 },
      { bytes: 0 },
      { bytes: 65 * 1024 * 1024 },
      { sha256: "x" },
      { piFileId: "../up" },
      { key: "v1/other" },
    ]) {
      await expect(
        w.asAlice.mutation(api.transcripts.commitPiLogSegment, { ...piSegment(w, 0, 10), ...bad }),
      ).rejects.toThrow(code("invalid_argument"));
    }
    await expect(
      w.asAlice.query(api.transcripts.head, {
        sessionId: w.sessionId,
        claim: w.claim,
        piFileIds: Array.from({ length: 65 }, (_, i) => `f${i}`),
      }),
    ).rejects.toThrow(code("invalid_argument"));
    await expect(
      w.asAlice.query(api.transcripts.head, {
        sessionId: w.sessionId,
        claim: w.claim,
        piFileIds: [""],
      }),
    ).rejects.toThrow(code("invalid_argument"));
  });
});

describe("sweepPacked", () => {
  test("drops only expired staging rows, in batches", async () => {
    vi.useFakeTimers({ now: 10_000 });
    const w = await world();
    await w.t.run(async (ctx: Ctx) => {
      for (let index = 0; index < 300; index += 1) {
        await ctx.db.insert("transcriptArtifacts", {
          sessionId: w.sessionId,
          digest: `sha256:${index.toString(16).padStart(64, "0")}`,
          mediaType: "application/x",
          bytes: 2,
          body: "{}",
          spillKey: null,
          firstSequence: null,
          uploadedBy: "runner",
          packedSegmentId: index < 298 ? newId("transcriptSegment") : null,
          // Two rows are unpacked (no expiry); one packed row has not expired yet.
          expiresAt: index < 297 ? 5_000 : index === 297 ? 20_000 : null,
          createdAt: 0,
        });
      }
    });
    await expect(w.t.mutation(internal.transcripts.sweepPacked, {})).resolves.toEqual({
      deleted: 256,
    });
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    const left = await stagingRows(w.t);
    expect(left.map((row) => row.expiresAt)).toEqual([20_000, null, null]);
  });
});

describe("files.presignPut", () => {
  test("signs one exact upload under the Session's own prefix", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 25) });
    const w = await world();
    const key = transcriptPackKey({
      projectId: w.projectId,
      sessionId: w.sessionId,
      firstSequence: 1,
      lastSequence: 4,
    });
    const args = { sessionId: w.sessionId, claim: w.claim, key, bytes: 42, sha256: hex("a") };
    await expect(w.asAlice.action(api.files.presignPut, args)).rejects.toThrow(
      code("storage_unconfigured"),
    );

    vi.stubEnv("VOLLI_S3_ENDPOINT", "https://acct.r2.cloudflarestorage.com");
    vi.stubEnv("VOLLI_S3_BUCKET", "volli-history");
    vi.stubEnv("VOLLI_S3_ACCESS_KEY_ID", "AKID");
    vi.stubEnv("VOLLI_S3_SECRET_ACCESS_KEY", "secret");
    const signed = await w.asAlice.action(api.files.presignPut, args);
    const url = new URL(signed.url);
    expect(url.host).toBe("acct.r2.cloudflarestorage.com");
    expect(url.pathname).toBe(`/volli-history/${key}`);
    expect(url.searchParams.get("X-Amz-Credential")).toBe("AKID/20261025/auto/s3/aws4_request");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;host;x-amz-checksum-sha256",
    );
    expect(signed).toMatchObject({
      method: "PUT",
      headers: { "content-length": "42", "x-amz-checksum-sha256": expect.any(String) },
      expiresAt: Date.UTC(2026, 9, 25) + 300_000,
    });

    for (const bad of [
      { key: `${key}x` },
      { key: key.replace(w.sessionId, newId("session")) },
      { key: key.replace("tx/", "ev/") },
      { bytes: 0 },
      { bytes: 65 * 1024 * 1024 },
      { sha256: "x" },
    ]) {
      await expect(w.asAlice.action(api.files.presignPut, { ...args, ...bad })).rejects.toThrow(
        code("invalid_argument"),
      );
    }
    await expect(w.asBob.action(api.files.presignPut, args)).rejects.toThrow(code("forbidden"));
  });
});
