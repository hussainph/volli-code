/**
 * The transcript reader against a scripted backend and object store. Packs
 * are built with the shared encoder the runner uploads with, and read back
 * through the reader's own decoder, so the two halves of the format meet here.
 */
import { encodeTranscriptPack, TRANSCRIPT_PACK_FORMAT } from "@volli/shared/cloud";
import { describe, expect, it } from "vite-plus/test";

import {
  createCloudTranscriptReader,
  readTranscriptPack,
  type CloudSessionObject,
  type CloudTranscriptRequest,
  type CloudTranscriptSource,
} from "./cloud-transcript-reader";
import { SESSION_ID, artifactOf, digestOf, messageOf } from "./cloud-session.test-support";

const encoder = new TextEncoder();

function request(sequence: number, body: number | null = sequence): CloudTranscriptRequest {
  return {
    sequence,
    reference: {
      id: `artifact-${sequence}`,
      mediaType: null,
      digest: body === null ? null : digestOf(body),
    },
  };
}

function bodyText(n: number): string {
  return JSON.stringify(artifactOf(messageOf(`m${n}`, `body ${n}`)));
}

interface Segment {
  segmentId: string;
  firstSequence: number;
  lastSequence: number;
  /** Bodies by digest number. */
  bodies: number[];
  sha256?: string | null;
  text?: string;
}

/** The pack object's bytes ("compressed" is the identity here). */
function packBytes(segment: Segment): Uint8Array {
  return encoder.encode(
    segment.text ??
      encodeTranscriptPack(
        {
          sessionId: SESSION_ID,
          firstSequence: segment.firstSequence,
          lastSequence: segment.lastSequence,
          turnIds: ["turn-1"],
          createdAt: 1,
        },
        segment.bodies.map((n) => ({
          digest: digestOf(n),
          mediaType: "application/vnd.volli.ui-message+json",
          body: bodyText(n),
          redacted: false,
        })),
      ),
  );
}

interface Script {
  inline?: Map<number, string | unknown>;
  spilled?: Map<number, string>;
  /** Spills whose grant answers absent (packed since). */
  spillGone?: Set<number>;
  segments?: Segment[];
  artifactsAnswer?: (digests: readonly string[]) => unknown;
  segmentsAnswer?: (beforeSequence: number) => unknown;
  grant?: (object: CloudSessionObject) => unknown;
  hash?: (bytes: Uint8Array) => string;
}

function scripted(script: Script) {
  const calls = {
    artifacts: [] as string[][],
    segments: [] as number[],
    grants: [] as CloudSessionObject[],
    downloads: [] as string[],
    warnings: [] as string[],
  };
  const segments = script.segments ?? [];
  const source: CloudTranscriptSource = {
    async artifacts(sessionId, digests) {
      expect(sessionId).toBe(SESSION_ID);
      calls.artifacts.push([...digests]);
      if (script.artifactsAnswer) return script.artifactsAnswer(digests);
      return digests.map((digest) => {
        const n = Number.parseInt(digest.slice("sha256:".length), 16);
        if (script.inline?.has(n)) {
          return { digest, status: "inline", mediaType: "x", bytes: 1, body: script.inline.get(n) };
        }
        if (script.spilled?.has(n)) return { digest, status: "spilled", mediaType: "x", bytes: 1 };
        return { digest, status: "absent" };
      });
    },
    async segments(_sessionId, beforeSequence, limit) {
      calls.segments.push(beforeSequence);
      expect(limit).toBe(16);
      if (script.segmentsAnswer) return script.segmentsAnswer(beforeSequence);
      return {
        segments: segments
          .filter((segment) => segment.firstSequence < beforeSequence)
          .map((segment) => ({
            segmentId: segment.segmentId,
            firstSequence: segment.firstSequence,
            lastSequence: segment.lastSequence,
            turnIds: [],
            format: TRANSCRIPT_PACK_FORMAT,
            bytes: 1,
            sha256: segment.sha256 === undefined ? `hash:${segment.segmentId}` : segment.sha256,
            artifactCount: segment.bodies.length,
          })),
        hasMore: false,
        packedThrough: 0,
      };
    },
    async presignGet(_sessionId, object) {
      calls.grants.push(object);
      if (script.grant) return script.grant(object);
      if (object.kind === "spill") {
        const n = Number.parseInt(object.digest.slice("sha256:".length), 16);
        if (script.spillGone?.has(n)) return { status: "absent" };
        return { status: "sign", request: { url: `spill:${n}`, headers: {} }, bytes: null };
      }
      return {
        status: "sign",
        request: { url: `pack:${object.segmentId}`, headers: { "x-a": "b" } },
        bytes: 1,
        sha256: null,
      };
    },
    async download({ url }) {
      calls.downloads.push(url);
      const [kind, id] = url.split(":") as [string, string];
      if (kind === "spill") return encoder.encode(script.spilled!.get(Number(id))!);
      return packBytes(segments.find((segment) => segment.segmentId === id)!);
    },
    decompress: (bytes) => bytes,
    async sha256Hex(bytes) {
      if (script.hash) return script.hash(bytes);
      const segment = segments.find(
        (candidate) =>
          new TextDecoder().decode(packBytes(candidate)) === new TextDecoder().decode(bytes),
      );
      return `hash:${segment?.segmentId}`;
    },
    warn: (message) => calls.warnings.push(message),
  };
  return { reader: createCloudTranscriptReader(source), calls };
}

function texts(read: ReadonlyMap<number, { parts: readonly unknown[] }>): Record<number, string> {
  return Object.fromEntries(
    [...read].map(([sequence, message]) => [sequence, (message.parts[0] as { text: string }).text]),
  );
}

describe("createCloudTranscriptReader", () => {
  it("reads staged inline bodies in one query and keeps them", async () => {
    const { reader, calls } = scripted({
      inline: new Map([
        [1, bodyText(1)],
        [2, bodyText(2)],
      ]),
    });
    const read = await reader(SESSION_ID, [request(1), request(2), request(3, 1)]);
    expect(texts(read)).toEqual({ 1: "body 1", 2: "body 2", 3: "body 1" });
    expect(calls.artifacts).toEqual([[digestOf(1), digestOf(2)]]);
    // A second window over the same bodies asks nothing.
    const again = await reader(SESSION_ID, [request(1)]);
    expect(texts(again)).toEqual({ 1: "body 1" });
    expect(calls.artifacts).toHaveLength(1);
    expect(calls.warnings).toEqual([]);
  });

  it("asks staging 64 digests at a time", async () => {
    const inline = new Map(Array.from({ length: 70 }, (_, n) => [n + 1, bodyText(n + 1)] as const));
    const { reader, calls } = scripted({ inline });
    const read = await reader(
      SESSION_ID,
      Array.from({ length: 70 }, (_, n) => request(n + 1)),
    );
    expect(read.size).toBe(70);
    expect(calls.artifacts.map((batch) => batch.length)).toEqual([64, 6]);
  });

  it("reads a spilled body through one signed GET", async () => {
    const { reader, calls } = scripted({ spilled: new Map([[4, bodyText(4)]]) });
    expect(texts(await reader(SESSION_ID, [request(4)]))).toEqual({ 4: "body 4" });
    expect(calls.grants).toEqual([{ kind: "spill", digest: digestOf(4) }]);
    expect(calls.downloads).toEqual(["spill:4"]);
  });

  it("reads what staging no longer holds from the pack covering its fact", async () => {
    const segment: Segment = {
      segmentId: "seg-a",
      firstSequence: 1,
      lastSequence: 10,
      bodies: [3, 5],
    };
    const { reader, calls } = scripted({
      spilled: new Map([[5, bodyText(5)]]),
      spillGone: new Set([5]),
      segments: [segment],
    });
    const read = await reader(SESSION_ID, [request(3), request(5)]);
    expect(texts(read)).toEqual({ 3: "body 3", 5: "body 5" });
    // One segment read covers both facts; the pack is fetched once.
    expect(calls.segments).toEqual([6]);
    expect(calls.downloads).toEqual(["pack:seg-a"]);
    expect(calls.warnings).toEqual([]);
  });

  it("keeps the last two packs, so paging within one fetches it once", async () => {
    const segments: Segment[] = [
      { segmentId: "seg-a", firstSequence: 1, lastSequence: 2, bodies: [1, 2, 7] },
      { segmentId: "seg-b", firstSequence: 3, lastSequence: 4, bodies: [3, 4] },
      { segmentId: "seg-c", firstSequence: 5, lastSequence: 6, bodies: [5, 6] },
    ];
    const { reader, calls } = scripted({ segments });
    await reader(SESSION_ID, [request(1)]);
    await reader(SESSION_ID, [request(2)]);
    expect(calls.downloads).toEqual(["pack:seg-a"]);
    await reader(SESSION_ID, [request(3)]);
    await reader(SESSION_ID, [request(5)]);
    expect(calls.downloads).toEqual(["pack:seg-a", "pack:seg-b", "pack:seg-c"]);
    // seg-a fell out of the two-pack cache: a body of it not read yet fetches it again.
    expect(texts(await reader(SESSION_ID, [request(1, 7)]))).toEqual({ 1: "body 7" });
    expect(calls.downloads).toEqual(["pack:seg-a", "pack:seg-b", "pack:seg-c", "pack:seg-a"]);
    // A body already read is kept by itself, whatever became of its pack.
    expect(texts(await reader(SESSION_ID, [request(9, 2)]))).toEqual({ 9: "body 2" });
  });

  it("reports bodies none of the places holds, and keeps the facts' other bodies", async () => {
    const { reader, calls } = scripted({
      inline: new Map<number, unknown>([
        [1, bodyText(1)],
        [2, JSON.stringify({ message: { id: "bad" } })],
      ]),
      segments: [{ segmentId: "seg-a", firstSequence: 1, lastSequence: 3, bodies: [1] }],
    });
    const read = await reader(SESSION_ID, [request(1), request(2), request(3, null), request(7)]);
    expect(texts(read)).toEqual({ 1: "body 1" });
    // 2: a malformed body (and the pack does not hold it); 3: no digest; 7: no pack covers it.
    expect(calls.warnings).toEqual([
      `[cloud-session] 3 transcript bodies of ${SESSION_ID} are unreadable`,
    ]);
  });

  it("stops looking for packs after its segment-read budget", async () => {
    const { reader, calls } = scripted({ segments: [] });
    const read = await reader(
      SESSION_ID,
      Array.from({ length: 9 }, (_, n) => request(n + 1)),
    );
    expect(read.size).toBe(0);
    expect(calls.segments).toEqual([10, 9, 8, 7, 6, 5, 4, 3]);
    expect(calls.warnings).toEqual([
      `[cloud-session] 9 transcript bodies of ${SESSION_ID} are unreadable`,
    ]);
  });

  it("skips staging answers it did not ask about, and reads a non-text inline body from its pack", async () => {
    const { reader } = scripted({
      artifactsAnswer: () => [
        null,
        { digest: 7 },
        { digest: digestOf(99), status: "inline", body: bodyText(99) },
        { digest: digestOf(1), status: "inline", body: 42 },
      ],
      segments: [{ segmentId: "seg-a", firstSequence: 1, lastSequence: 1, bodies: [1] }],
    });
    expect(texts(await reader(SESSION_ID, [request(1)]))).toEqual({ 1: "body 1" });
  });

  it("asks nothing for an empty window", async () => {
    const { reader, calls } = scripted({});
    expect((await reader(SESSION_ID, [])).size).toBe(0);
    expect(calls.artifacts).toEqual([]);
  });

  it("fails on answers it cannot read", async () => {
    await expect(
      scripted({ artifactsAnswer: () => ({}) }).reader(SESSION_ID, [request(1)]),
    ).rejects.toThrow(/artifacts are malformed/u);
    await expect(
      scripted({ inline: new Map([[1, "{"]]) }).reader(SESSION_ID, [request(1)]),
    ).rejects.toThrow(/not JSON/u);
    await expect(
      scripted({ segmentsAnswer: () => null }).reader(SESSION_ID, [request(1)]),
    ).rejects.toThrow(/segments are malformed/u);
    await expect(
      scripted({
        segmentsAnswer: () => ({
          segments: [{ segmentId: "s", firstSequence: 3, lastSequence: 2 }],
        }),
      }).reader(SESSION_ID, [request(1)]),
    ).rejects.toThrow(/segments are malformed/u);
    const segments = [{ segmentId: "seg-a", firstSequence: 1, lastSequence: 1, bodies: [1] }];
    await expect(
      scripted({ segments, grant: () => null }).reader(SESSION_ID, [request(1)]),
    ).rejects.toThrow(/grant for a transcript pack is malformed/u);
    await expect(
      scripted({ segments, grant: () => ({ status: "sign", request: { url: 1 } }) }).reader(
        SESSION_ID,
        [request(1)],
      ),
    ).rejects.toThrow(/grant for a transcript pack is malformed/u);
    await expect(
      scripted({
        segments,
        grant: () => ({ status: "sign", request: { url: "pack:seg-a", headers: { a: 1 } } }),
      }).reader(SESSION_ID, [request(1)]),
    ).rejects.toThrow(/malformed/u);
    await expect(
      scripted({ segments, grant: () => ({ status: "absent" }) }).reader(SESSION_ID, [request(1)]),
    ).rejects.toThrow(/not readable/u);
  });

  it("refuses a pack that fails its checksum, and asks again next time", async () => {
    let hash = "wrong";
    const { reader, calls } = scripted({
      segments: [{ segmentId: "seg-a", firstSequence: 1, lastSequence: 1, bodies: [1] }],
      hash: () => hash,
    });
    await expect(reader(SESSION_ID, [request(1)])).rejects.toThrow(/checksum/u);
    hash = "hash:seg-a";
    expect(texts(await reader(SESSION_ID, [request(1)]))).toEqual({ 1: "body 1" });
    expect(calls.downloads).toEqual(["pack:seg-a", "pack:seg-a"]);
  });

  it("reads a pack the backend recorded no checksum for", async () => {
    const { reader } = scripted({
      segments: [
        { segmentId: "seg-a", firstSequence: 1, lastSequence: 1, bodies: [1], sha256: null },
      ],
      hash: () => {
        throw new Error("no checksum to compare");
      },
    });
    expect(texts(await reader(SESSION_ID, [request(1)]))).toEqual({ 1: "body 1" });
  });
});

function header(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: TRANSCRIPT_PACK_FORMAT,
    sessionId: SESSION_ID,
    firstSequence: 1,
    lastSequence: 2,
    ...overrides,
  });
}

describe("readTranscriptPack", () => {
  const range = { firstSequence: 1, lastSequence: 2 };

  it("reads each entry's body by digest", () => {
    const bodies = readTranscriptPack(
      `${header({ artifactCount: 1 })}\n{"digest":"d1","body":{"a":1}}\n`,
      SESSION_ID,
      range,
    );
    expect([...bodies]).toEqual([["d1", { a: 1 }]]);
    // A header without a count is read for what it holds.
    expect(readTranscriptPack(`${header()}\n`, SESSION_ID, range).size).toBe(0);
  });

  it("refuses a pack that is not the segment's, or not whole", () => {
    expect(() => readTranscriptPack("", SESSION_ID, range)).toThrow(/not JSON/u);
    expect(() => readTranscriptPack("[]\n", SESSION_ID, range)).toThrow(/does not match/u);
    expect(() => readTranscriptPack(header({ format: "x" }), SESSION_ID, range)).toThrow(
      /does not match/u,
    );
    expect(() => readTranscriptPack(header(), "other", range)).toThrow(/does not match/u);
    expect(() =>
      readTranscriptPack(header(), SESSION_ID, { firstSequence: 2, lastSequence: 2 }),
    ).toThrow(/does not match/u);
    expect(() =>
      readTranscriptPack(header(), SESSION_ID, { firstSequence: 1, lastSequence: 3 }),
    ).toThrow(/does not match/u);
    expect(() => readTranscriptPack(`${header()}\n{"digest":"d1"}`, SESSION_ID, range)).toThrow(
      /malformed entry/u,
    );
    expect(() => readTranscriptPack(`${header()}\n[1]`, SESSION_ID, range)).toThrow(
      /malformed entry/u,
    );
    expect(() =>
      readTranscriptPack(`${header()}\n{"digest":2,"body":1}`, SESSION_ID, range),
    ).toThrow(/malformed entry/u);
    expect(() => readTranscriptPack(header({ artifactCount: 2 }), SESSION_ID, range)).toThrow(
      /incomplete/u,
    );
  });
});
