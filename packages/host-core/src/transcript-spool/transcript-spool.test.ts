import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import { canonicalJson, type SessionTranscriptArtifact } from "@volli/session-engine";
import { ExactValueByteRedactor, type CredentialStreamStepper } from "@volli/shared";
import {
  INLINE_ARTIFACT_MAX_BYTES,
  TRANSCRIPT_PACK_FORMAT,
  artifactSpillKey,
  piLogSegmentKey,
  transcriptPackKey,
  type PiLogSegmentCommit,
  type SegmentCommitResult,
  type StageTranscriptArtifactsInput,
  type TranscriptSegmentCommit,
} from "@volli/shared/cloud";

import { SpoolTranscriptArtifactStore } from "./artifact-spool";
import { LocalObjectStore } from "./object-store";
import {
  TranscriptSpool,
  piFileIdOf,
  type SpoolEvent,
  type SpoolSession,
  type TranscriptSpoolBackend,
  type TranscriptSpoolLimits,
} from "./transcript-spool";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const SECRET = "sk-live-0123456789";
const PEM = "-----BEGIN KEY-----\nMIIabc\n-----END KEY-----";

const session: SpoolSession = {
  sessionId: SESSION,
  projectId: PROJECT,
  claim: { runnerId: "33333333-3333-4333-8333-333333333333", generation: 1 },
};

function redactor(): CredentialStreamStepper {
  const values = new ExactValueByteRedactor([
    [SECRET, "‹secret:API_KEY›"],
    [PEM, "‹secret:PEM›"],
  ]);
  return (window, from, final) => values.step(window, from, final);
}

/**
 * The backend's commit rules (`convex/functions/transcripts.ts`), in memory:
 * segments tile from 1, a commit of the same object is a duplicate, a
 * different one a conflict, Pi ranges are contiguous from 0.
 */
class FakeBackend implements TranscriptSpoolBackend {
  segments: TranscriptSegmentCommit[] = [];
  pi: PiLogSegmentCommit[] = [];
  staged: StageTranscriptArtifactsInput[] = [];
  /** Fail the next commit: `before` it lands, or `after` (the response is lost). */
  failNextCommit: "before" | "after" | null = null;

  async head(input: { piFileIds: readonly string[] }) {
    const piLogs: Record<string, number> = {};
    for (const id of input.piFileIds) {
      piLogs[id] = Math.max(0, ...this.pi.filter((s) => s.piFileId === id).map((s) => s.endOffset));
    }
    return { transcriptThrough: this.segments.at(-1)?.lastSequence ?? 0, piLogs };
  }

  async stageArtifacts(input: StageTranscriptArtifactsInput) {
    this.staged.push(structuredClone(input));
  }

  async commitSegment(input: TranscriptSegmentCommit): Promise<SegmentCommitResult> {
    const failure = this.failNextCommit;
    this.failNextCommit = null;
    if (failure === "before") throw new Error("connection lost");
    const same = this.segments.find((s) => s.firstSequence === input.firstSequence);
    let result: SegmentCommitResult;
    if (same !== undefined) {
      if (same.lastSequence !== input.lastSequence || same.sha256 !== input.sha256) {
        throw new Error("conflict");
      }
      result = { status: "duplicate" };
    } else {
      expect(input.firstSequence).toBe((this.segments.at(-1)?.lastSequence ?? 0) + 1);
      this.segments.push(structuredClone(input));
      result = { status: "committed" };
    }
    if (failure === "after") throw new Error("response lost");
    return result;
  }

  async commitPiLogSegment(input: PiLogSegmentCommit): Promise<SegmentCommitResult> {
    const same = this.pi.find(
      (s) => s.piFileId === input.piFileId && s.startOffset === input.startOffset,
    );
    if (same !== undefined) {
      if (same.sha256 !== input.sha256 || same.endOffset !== input.endOffset) {
        throw new Error("conflict");
      }
      return { status: "duplicate" };
    }
    const end = Math.max(
      0,
      ...this.pi.filter((s) => s.piFileId === input.piFileId).map((s) => s.endOffset),
    );
    expect(input.startOffset).toBe(end);
    this.pi.push(structuredClone(input));
    return { status: "committed" };
  }
}

/** The runner's ledger as the spool reads it, plus the drain's accepted cursor. */
class Ledger {
  events: SpoolEvent[] = [];
  accepted = 0;

  acceptedThrough() {
    return this.accepted;
  }

  eventsAfter(_sessionId: string, after: number, limit: number) {
    return this.events.filter((event) => event.sequence > after).slice(0, limit);
  }

  push(payload: Record<string, unknown>): number {
    const sequence = this.events.length + 1;
    this.events.push({
      sequence,
      recordedAt: 1_000 + sequence,
      payload: payload as unknown as SpoolEvent["payload"],
    });
    return sequence;
  }
}

let root: string;
let artifacts: SpoolTranscriptArtifactStore;
let objects: LocalObjectStore;
let backend: FakeBackend;
let ledger: Ledger;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "volli-transcript-spool-"));
  artifacts = new SpoolTranscriptArtifactStore(join(root, "spool"));
  objects = new LocalObjectStore(join(root, "bucket"));
  backend = new FakeBackend();
  ledger = new Ledger();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

let segmentCounter = 0;
function spool(limits: Partial<TranscriptSpoolLimits> = {}) {
  return new TranscriptSpool({
    artifacts,
    objects,
    backend,
    events: ledger,
    redact: redactor(),
    newSegmentId: () => `segment-${++segmentCounter}`,
    limits,
  });
}

function artifact(text: string, turnId = "turn-1"): SessionTranscriptArtifact {
  return {
    version: 1,
    threadId: "thread",
    branchId: "branch",
    attemptId: "attempt",
    turnId,
    message: { id: `m-${text.slice(0, 16)}`, role: "assistant", parts: [{ type: "text", text }] },
  };
}

/** A turn: started, one message per text, ended. Returns the message references. */
async function turn(turnId: string, texts: readonly string[]) {
  ledger.push({ kind: "turn.started", turnId });
  const references = [];
  for (const text of texts) {
    const reference = await artifacts.write(artifact(text, turnId));
    references.push(reference);
    ledger.push({ kind: "transcript.referenced", attachmentId: "att", turnId, reference });
  }
  ledger.push({ kind: "turn.completed", turnId });
  return references;
}

async function readPack(first: number, last: number) {
  const key = transcriptPackKey({
    projectId: PROJECT,
    sessionId: SESSION,
    firstSequence: first,
    lastSequence: last,
  });
  const bytes = await readFile(objects.pathOf(key));
  const lines = zstdDecompressSync(bytes).toString("utf8").split("\n");
  expect(lines.pop()).toBe("");
  const [header, ...entries] = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { bytes, header: header!, entries, key };
}

describe("packTranscript", () => {
  test("packs the bodies an accepted range references into one object and commits it", async () => {
    const references = await turn("turn-1", ["first reply", "second reply"]);
    ledger.accepted = ledger.events.length;
    const packed = await spool().packTranscript(session);
    expect(packed).toEqual([
      {
        firstSequence: 1,
        lastSequence: 4,
        artifactCount: 2,
        missing: [],
        bytes: expect.any(Number),
        status: "committed",
      },
    ]);
    const { header, entries, key, bytes } = await readPack(1, 4);
    expect(header).toEqual({
      format: TRANSCRIPT_PACK_FORMAT,
      sessionId: SESSION,
      firstSequence: 1,
      lastSequence: 4,
      turnIds: ["turn-1"],
      createdAt: 1_004,
      artifactCount: 2,
      enc: null,
    });
    // Each line's body is the artifact's canonical JSON; the digest is over exactly it.
    for (const [index, entry] of entries.entries()) {
      const canonical = canonicalJson(entry.body);
      expect(entry).toMatchObject({
        digest: references[index]!.id,
        bytes: Buffer.byteLength(canonical),
      });
      expect(entry).not.toHaveProperty("redacted");
      expect(`sha256:${createHash("sha256").update(canonical).digest("hex")}`).toBe(entry.digest);
    }
    expect(backend.segments).toEqual([
      {
        sessionId: SESSION,
        claim: session.claim,
        segmentId: expect.any(String),
        firstSequence: 1,
        lastSequence: 4,
        turnIds: ["turn-1"],
        key,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        artifactCount: 2,
        digests: references.map((reference) => reference.id),
      },
    ]);
    // Nothing new: nothing to pack.
    await expect(spool().packTranscript(session)).resolves.toEqual([]);
  });

  test("covers only what is accepted, and the next pass starts right after", async () => {
    await turn("turn-1", ["a"]);
    await turn("turn-2", ["b"]);
    ledger.accepted = 2;
    const packer = spool();
    await expect(packer.packTranscript(session)).resolves.toMatchObject([
      { firstSequence: 1, lastSequence: 2 },
    ]);
    ledger.accepted = 6;
    await expect(packer.packTranscript(session)).resolves.toMatchObject([
      { firstSequence: 3, lastSequence: 6, artifactCount: 1 },
    ]);
    expect((await readPack(3, 6)).header.turnIds).toEqual(["turn-1", "turn-2"]);
    expect(backend.segments.map((s) => [s.firstSequence, s.lastSequence])).toEqual([
      [1, 2],
      [3, 6],
    ]);
  });

  test("cuts at event boundaries by bytes, artifacts and turns; ranges tile with no gaps", async () => {
    await turn("turn-1", ["x".repeat(400), "y".repeat(400), "z".repeat(5_000)]);
    ledger.accepted = ledger.events.length;
    const bySize = await spool({ packMaxBytes: 1_000 }).packTranscript(session);
    // The 5 KB body is larger than a pack: it is a pack of its own.
    expect(bySize.map((s) => [s.firstSequence, s.lastSequence, s.artifactCount])).toEqual([
      [1, 2, 1],
      [3, 3, 1],
      [4, 5, 1],
    ]);

    backend = new FakeBackend();
    const byCount = await spool({ packMaxArtifacts: 2 }).packTranscript(session);
    expect(byCount.map((s) => [s.firstSequence, s.lastSequence, s.artifactCount])).toEqual([
      [1, 3, 2],
      [4, 5, 1],
    ]);

    backend = new FakeBackend();
    ledger = new Ledger();
    for (const id of ["t1", "t2", "t3"]) await turn(id, [id]);
    ledger.accepted = ledger.events.length;
    const byTurns = await spool({ packMaxTurns: 2 }).packTranscript(session);
    expect(byTurns.map((s) => [s.firstSequence, s.lastSequence])).toEqual([
      [1, 6],
      [7, 9],
    ]);
  });

  test("a body referenced twice in a range is packed once", async () => {
    const [reference] = await turn("turn-1", ["same"]);
    ledger.push({
      kind: "transcript.referenced",
      attachmentId: "att",
      turnId: "turn-1",
      reference,
    });
    ledger.accepted = ledger.events.length;
    await expect(spool().packTranscript(session)).resolves.toMatchObject([{ artifactCount: 1 }]);
  });

  test("a crash between the upload and the commit re-uploads identical bytes to the same key", async () => {
    await turn("turn-1", ["survives a crash"]);
    ledger.accepted = ledger.events.length;
    backend.failNextCommit = "before";
    await expect(spool().packTranscript(session)).rejects.toThrow("connection lost");
    const before = await readPack(1, 3);
    expect(backend.segments).toEqual([]);

    // A new process: nothing local remembers the first attempt.
    await expect(spool().packTranscript(session)).resolves.toMatchObject([{ status: "committed" }]);
    const after = await readPack(1, 3);
    expect(after.bytes.equals(before.bytes)).toBe(true);
    expect(backend.segments).toHaveLength(1);
    expect(backend.segments[0]!.sha256).toBe(
      createHash("sha256").update(before.bytes).digest("hex"),
    );
  });

  test("a commit that landed but whose answer was lost is not packed again", async () => {
    await turn("turn-1", ["committed once"]);
    ledger.accepted = ledger.events.length;
    backend.failNextCommit = "after";
    await expect(spool().packTranscript(session)).rejects.toThrow("response lost");
    await expect(spool().packTranscript(session)).resolves.toEqual([]);
    expect(backend.segments).toHaveLength(1);
  });

  test("the same object committed again is a duplicate, not a second segment", async () => {
    await turn("turn-1", ["twice"]);
    ledger.accepted = ledger.events.length;
    await spool().packTranscript(session);
    // A head that lags (another replica, a stale read): the pass rebuilds the same pack.
    const lagging = Object.assign(Object.create(backend) as FakeBackend, {
      head: async () => ({ transcriptThrough: 0, piLogs: {} }),
    });
    const again = new TranscriptSpool({
      artifacts,
      objects,
      backend: lagging,
      events: ledger,
      redact: redactor(),
    });
    await expect(again.packTranscript(session)).resolves.toMatchObject([{ status: "duplicate" }]);
    expect(backend.segments).toHaveLength(1);
  });

  test("redacts every body before it leaves the machine, including values JSON escapes", async () => {
    const [plain, secret] = await turn("turn-1", ["nothing to hide", `key=${SECRET}; pem=${PEM}`]);
    ledger.accepted = ledger.events.length;
    await spool().packTranscript(session);
    const { entries, bytes } = await readPack(1, 4);
    const text = zstdDecompressSync(bytes).toString("utf8");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("MIIabc");
    expect(entries[0]).toMatchObject({ digest: plain!.id });
    expect(entries[0]).not.toHaveProperty("redacted");
    // The digest stays the artifact's identity; the body is the redacted one.
    expect(entries[1]).toMatchObject({ digest: secret!.id, redacted: true });
    expect(JSON.stringify(entries[1]!.body)).toContain("key=‹secret:API_KEY›; pem=‹secret:PEM›");
    // The local spool still holds the original.
    expect((await artifacts.read(secret!)).message.parts).toEqual([
      { type: "text", text: `key=${SECRET}; pem=${PEM}` },
    ]);
  });

  test("a body lost on this machine is named missing, and its staged copy is not expired", async () => {
    const [kept, lost] = await turn("turn-1", ["kept", "lost"]);
    ledger.accepted = ledger.events.length;
    await rm(join(root, "spool", `${lost!.id.slice(7)}.spool`));
    await expect(spool().packTranscript(session)).resolves.toMatchObject([
      { artifactCount: 1, missing: [lost!.id] },
    ]);
    expect((await readPack(1, 4)).header).toMatchObject({ artifactCount: 1, missing: [lost!.id] });
    expect(backend.segments[0]!.digests).toEqual([kept!.id]);
  });

  test("a ledger that cannot produce an accepted event fails the pass", async () => {
    await turn("turn-1", ["a"]);
    ledger.accepted = 5;
    await expect(spool().packTranscript(session)).rejects.toThrow(/no event 4/);
    ledger.events.splice(1, 1);
    ledger.accepted = 3;
    await expect(spool().packTranscript(session)).rejects.toThrow(/skips from 1 to 3/);
  });

  test("passes for one Session run one at a time", async () => {
    await turn("turn-1", ["a", "b"]);
    ledger.accepted = ledger.events.length;
    const s = spool();
    const [first, second] = await Promise.all([
      s.packTranscript(session),
      s.packTranscript(session),
    ]);
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    // A failed pass does not wedge the next one.
    backend.failNextCommit = "before";
    ledger.push({ kind: "turn.started", turnId: "turn-2" });
    ledger.accepted = ledger.events.length;
    const failing = s.packTranscript(session);
    const next = s.packTranscript(session);
    await expect(failing).rejects.toThrow();
    await expect(next).resolves.toMatchObject([{ artifactCount: 0 }]);
  });
});

describe("stage", () => {
  test("stages each referenced body once, inline when small, spilled to its own object when large", async () => {
    const big = "w".repeat(INLINE_ARTIFACT_MAX_BYTES);
    const [small, large] = await turn("turn-1", [`small ${SECRET}`, big]);
    const references = await Promise.all(
      Array.from({ length: 70 }, (_, index) => artifacts.write(artifact(`m${index}`))),
    );
    for (const reference of references) {
      ledger.push({
        kind: "transcript.referenced",
        attachmentId: "att",
        turnId: "turn-1",
        reference,
      });
    }
    ledger.push({
      kind: "transcript.referenced",
      attachmentId: "att",
      turnId: "turn-1",
      reference: small,
    });
    const report = await spool().stage(session, ledger.events);
    expect(report).toEqual({ staged: 72, missing: [] });
    // Batched by the backend's per-call limit.
    expect(backend.staged.map((call) => call.artifacts.length)).toEqual([64, 8]);
    const all = backend.staged.flatMap((call) => call.artifacts);
    const smallRow = all.find((row) => row.digest === small!.id)!;
    expect(smallRow).toMatchObject({ sequence: 2, spillKey: null });
    expect(smallRow.body).toContain("small ‹secret:API_KEY›");
    expect(smallRow.bytes).toBe(Buffer.byteLength(smallRow.body!));

    const largeRow = all.find((row) => row.digest === large!.id)!;
    const spillKey = artifactSpillKey({
      projectId: PROJECT,
      sessionId: SESSION,
      sha256: large!.id.slice(7),
    });
    expect(largeRow).toMatchObject({ body: null, spillKey, sequence: 3 });
    const spilled = zstdDecompressSync(await readFile(objects.pathOf(spillKey))).toString("utf8");
    expect(spilled).toBe(canonicalJson(artifact(big)));
    expect(largeRow.bytes).toBe(Buffer.byteLength(spilled));
  });

  test("reports bodies it cannot read and stages the rest", async () => {
    const [lost, kept] = await turn("turn-1", ["lost", "kept"]);
    await rm(join(root, "spool", `${lost!.id.slice(7)}.spool`));
    await expect(spool().stage(session, ledger.events)).resolves.toEqual({
      staged: 1,
      missing: [lost!.id],
    });
    expect(backend.staged[0]!.artifacts.map((row) => row.digest)).toEqual([kept!.id]);
    await expect(spool().stage(session, [])).resolves.toEqual({ staged: 0, missing: [] });
  });
});

function jsonLine(value: object): string {
  return `${JSON.stringify(value)}\n`;
}

describe("packPiLogs", () => {
  const file = () => ({
    attachmentId: "att-1",
    path: join(root, "2026-10-25T01-02-03-004Z_abc.jsonl"),
  });
  const piFileId = "2026-10-25T01-02-03-004Z_abc";
  async function readSegment(offset: number) {
    const key = piLogSegmentKey({
      projectId: PROJECT,
      sessionId: SESSION,
      attachmentId: "att-1",
      piFileId,
      offset,
    });
    return zstdDecompressSync(await readFile(objects.pathOf(key))).toString("utf8");
  }

  test("uploads complete lines since the committed offset, redacted, and waits for a partial one", async () => {
    const first = jsonLine({ type: "session", id: "abc" });
    const secret = jsonLine({ type: "message", content: `use ${SECRET}\nand ${PEM}` });
    await writeFile(file().path, `${first}${secret}{"type":"mess`);
    const packer = spool();
    const report = await packer.packPiLogs(session, [file()]);
    const end = Buffer.byteLength(first + secret);
    expect(report).toEqual({
      segments: [
        {
          piFileId,
          startOffset: 0,
          endOffset: end,
          bytes: expect.any(Number),
          status: "committed",
        },
      ],
      truncated: [],
    });
    const uploaded = await readSegment(0);
    expect(uploaded.startsWith(first)).toBe(true);
    expect(uploaded).not.toContain(SECRET);
    expect(uploaded).not.toContain("MIIabc");
    expect(JSON.parse(uploaded.split("\n")[1]!)).toEqual({
      type: "message",
      content: "use ‹secret:API_KEY›\nand ‹secret:PEM›",
    });

    // Nothing complete since: nothing uploaded.
    await expect(packer.packPiLogs(session, [file()])).resolves.toEqual({
      segments: [],
      truncated: [],
    });
    // The partial line completes; a non-JSON line is redacted as bytes; a blank line stays.
    await appendFile(file().path, `age","n":1}\nraw ${SECRET} text\n\n`);
    const next = await packer.packPiLogs(session, [file()]);
    expect(next.segments).toMatchObject([{ startOffset: end }]);
    expect(await readSegment(end)).toBe(`{"type":"message","n":1}\nraw ‹secret:API_KEY› text\n\n`);
    expect(backend.pi.map((s) => [s.startOffset, s.endOffset])).toEqual([
      [0, end],
      [end, (await readFile(file().path)).length],
    ]);
  });

  test("splits at line boundaries under the cap; one longer line is a segment of its own", async () => {
    const lines = [jsonLine({ n: 1 }), jsonLine({ n: 2, pad: "p".repeat(100) }), jsonLine({ n: 3 })];
    await writeFile(file().path, lines.join(""));
    const report = await spool({ piSegmentMaxBytes: 32 }).packPiLogs(session, [file()]);
    const sizes = lines.map((text) => Buffer.byteLength(text));
    expect(report.segments.map((s) => [s.startOffset, s.endOffset])).toEqual([
      [0, sizes[0]],
      [sizes[0], sizes[0]! + sizes[1]!],
      [sizes[0]! + sizes[1]!, sizes[0]! + sizes[1]! + sizes[2]!],
    ]);
  });

  test("a file shorter than what was uploaded is reported and left alone; no files is no call", async () => {
    await writeFile(file().path, jsonLine({ n: 1 }) + jsonLine({ n: 2 }));
    const s = spool();
    await s.packPiLogs(session, [file()]);
    await truncate(file().path, 3);
    await expect(s.packPiLogs(session, [file()])).resolves.toEqual({
      segments: [],
      truncated: [piFileId],
    });
    await expect(s.packPiLogs(session, [])).resolves.toEqual({ segments: [], truncated: [] });
  });

  test("a crash before the commit re-uploads the same range", async () => {
    await writeFile(file().path, jsonLine({ n: 1 }));
    const failing = Object.assign(Object.create(backend) as FakeBackend, {
      commitPiLogSegment: async () => {
        throw new Error("connection lost");
      },
    });
    const crashed = new TranscriptSpool({
      artifacts,
      objects,
      backend: failing,
      events: ledger,
      redact: redactor(),
    });
    await expect(crashed.packPiLogs(session, [file()])).rejects.toThrow("connection lost");
    const before = await readSegment(0);
    await expect(spool().packPiLogs(session, [file()])).resolves.toMatchObject({
      segments: [{ startOffset: 0, status: "committed" }],
    });
    expect(await readSegment(0)).toBe(before);
  });

  test("piFileIdOf is the file name, and refuses one that cannot name an object", () => {
    expect(piFileIdOf("/data/pi-sessions/--ws--/2026-10-25T01-02-03-004Z_abc.jsonl")).toBe(
      piFileId,
    );
    expect(() => piFileIdOf("/x/.hidden.jsonl")).toThrow();
    expect(() => piFileIdOf("/x/a..b.jsonl")).toThrow();
  });
});

describe("packTurn", () => {
  test("flushes the spool, then packs the transcript and the Pi logs", async () => {
    await turn("turn-1", ["done"]);
    ledger.accepted = ledger.events.length;
    const path = join(root, "2026-10-25T01-02-03-004Z_abc.jsonl");
    await writeFile(path, '{"n":1}\n');
    const result = await spool().packTurn(session, [{ attachmentId: "att-1", path }]);
    expect(result.transcript).toMatchObject([{ firstSequence: 1, lastSequence: 3 }]);
    expect(result.piLogs.segments).toMatchObject([{ startOffset: 0, endOffset: 8 }]);
  });
});
