/**
 * A moved project's Session history, readable in Volli Cloud (VC-990): a
 * local project's Sessions moved in through the person-authorized import,
 * then read back through the window's own cloud Session transport on the
 * pinned local backend. No Electron, no IPC; only the object store is a
 * stand-in (a loopback S3 the backend really signs for).
 *
 * The local history is written by the real Session Engine with real
 * transcript bodies on disk (`createFileTranscriptArtifactStore`) and a Pi
 * session file. The move then does what the move engine does with it:
 *
 * 1. every event sent as `sessionEventImportRecord` makes it (JSON text, so a
 *    `$schema` or non-ASCII key and a fact larger than an accept takes need
 *    no spill), through `projectImports.begin` / `importRows`;
 * 2. every Session's transcript packed and its Pi log tailed by the runner's
 *    own spool over the import's doors (`createMoveHistoryUploader`), PUT
 *    through `projectImportHistory.presignPut`, all while the project is hidden;
 * 3. `projectImports.commit`, then `projectImportHistory.foldProgress` until
 *    every moved Session is folded to its head;
 * 4. the person's window opens each Session through `cloudChatTransport`
 *    and pages its whole history: every fact must arrive, and every message
 *    body must draw, the 50 MB transcript's thousands included.
 *
 * Runs only under the fixture, like `cloud-sessions.live.test.ts`; CI's
 * `Convex (codegen + backend)` lane runs it with
 * `VOLLI_CLOUD_SESSION_LIVE_REQUIRED=1` (it then fails rather than skips).
 *
 *   pnpm -C convex with-backend --deploy -- \
 *     sh -c 'cd ../apps/desktop && vp test run src/main/cloud-move-history.live.test.ts'
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ConvexHttpClient } from "convex/browser";
import { ConvexReactClient } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { api } from "@volli/convex/api";
import {
  createMoveHistoryUploader,
  createRunnerLinkClient,
  linkWithInstallToken,
  piLogFilesOf,
  runnerHostFacts,
  sessionEventImportRecord,
  type MoveBackend,
  type RunnerLink,
  type RunnerLinkStore,
} from "@volli/host-core/cloud-runner";
import { createFileTranscriptArtifactStore } from "@volli/host-core/session-runtime";
import {
  createSessionEngine,
  TRANSCRIPT_ARTIFACT_MEDIA_TYPE,
  type SessionTranscriptArtifact,
} from "@volli/session-engine";
import { createInMemorySessionLedger } from "@volli/session-engine/testing";
import {
  ExactValueByteRedactor,
  PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
  type SessionAttachment,
  type SessionEvent,
  type SessionEventProvenance,
  type TranscriptReference,
} from "@volli/shared";
import {
  MIGRATION_IMPORT_STREAMS,
  MIGRATION_PLACEHOLDERS,
  MigrationDigest,
  migrationDocument,
  migrationRowDigest,
  sessionVisibilityAtCreation,
  type MigrationImportStream,
  type MigrationTarget,
} from "@volli/shared/cloud";
import type { UIMessage } from "ai";

import { DEV_AUDIENCE, DEV_ISSUER, DEV_KEY_ID } from "./account/dev-issuer";
import { signEs256Jwt } from "./account/jwt";
import { inviteTestEmail } from "./test-helpers/preview";
import type { CloudSession } from "@renderer/lib/cloud-client";
import { cloudChatTransport } from "@renderer/lib/cloud-session-transport";

const url = process.env["VOLLI_CONVEX_URL"];
const siteUrl = process.env["VOLLI_CONVEX_SITE_URL"];
const privateKeyPem = process.env["VOLLI_CONVEX_TEST_PRIVATE_KEY"];
const adminKey = process.env["VOLLI_CONVEX_ADMIN_KEY"];
const fixture =
  url !== undefined &&
  siteUrl !== undefined &&
  privateKeyPem !== undefined &&
  adminKey !== undefined;

if (process.env["VOLLI_CLOUD_SESSION_LIVE_REQUIRED"] === "1" && !fixture) {
  throw new Error(
    "The live moved-history test needs the fixture: run it under `with-backend --deploy`.",
  );
}

/** The large Session: this many message bodies of {@link LARGE_BODY_CHARS}, about 50 MB. */
const LARGE_BODIES = 1_600;
const LARGE_BODY_CHARS = 32 * 1024;
/** Larger than one fact `sessions.accept` takes (256 KB). */
const OVERSIZED_TEXT = "o".repeat(300 * 1024);
const BATCH_MAX_ROWS = 200;
const BATCH_MAX_BYTES = 3 * 1024 * 1024;

function token(subject: string): string {
  const now = Math.floor(Date.now() / 1000);
  return signEs256Jwt(privateKeyPem!, DEV_KEY_ID, {
    iss: DEV_ISSUER,
    aud: DEV_AUDIENCE,
    sub: subject,
    iat: now,
    exp: now + 3600,
    name: "Moving Mo",
    email: `${subject}@example.com`,
    email_verified: true,
  });
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** Sets the fixture deployment's variables with its throwaway admin key. */
async function deploymentEnv(values: Record<string, string>) {
  const response = await fetch(`${url}/api/update_environment_variables`, {
    method: "POST",
    headers: { authorization: `Convex ${adminKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      changes: Object.entries(values).map(([name, value]) => ({ name, value })),
    }),
  });
  if (!response.ok) throw new Error(`Setting fixture storage env: ${response.status}`);
}

/**
 * A loopback, path-style S3 bucket: GETs, and PUTs that must carry their
 * signed length and checksum, write-once when they ask (`If-None-Match: *`).
 * Signatures are the backend suite's to verify (`convex/fixture/s3-boundary.ts`).
 */
async function startObjectStore() {
  const bucket = "moved-history";
  const objects = new Map<string, Buffer>();
  const failures: string[] = [];
  let puts = 0;
  const server: Server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url!, "http://store").pathname;
      if (!path.startsWith(`/${bucket}/`)) throw new Error("Wrong bucket");
      const key = decodeURIComponent(path.slice(bucket.length + 2));
      if (req.method === "GET") {
        const object = objects.get(key);
        res.writeHead(object === undefined ? 404 : 200);
        res.end(object);
        return;
      }
      if (req.method !== "PUT") throw new Error(`Unexpected ${req.method}`);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      if (req.headers["content-length"] !== String(body.length)) throw new Error("Wrong length");
      const checksum = Buffer.from(sha256(body), "hex").toString("base64");
      if (req.headers["x-amz-checksum-sha256"] !== checksum) throw new Error("Wrong checksum");
      puts += 1;
      if (req.headers["if-none-match"] === "*") {
        if (objects.has(key)) {
          res.writeHead(412);
          res.end();
          return;
        }
      }
      objects.set(key, body);
      res.end();
    } catch (error) {
      failures.push(String(error));
      res.writeHead(400);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env = {
    VOLLI_S3_ENDPOINT: origin,
    VOLLI_S3_BUCKET: bucket,
    VOLLI_S3_ACCESS_KEY_ID: "moved-history-access",
    VOLLI_S3_SECRET_ACCESS_KEY: "moved-history-secret",
    VOLLI_S3_REGION: "auto",
  };
  await deploymentEnv(env);
  return {
    objects,
    failures,
    get puts() {
      return puts;
    },
    async close() {
      try {
        await deploymentEnv(Object.fromEntries(Object.keys(env).map((name) => [name, ""])));
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
}

async function linkRunner(person: ConvexHttpClient): Promise<string> {
  const { installToken } = await person.action(api.runners.createInstallToken, {
    nameHint: "moving-mac",
    defaultWorkspaceId: null,
  });
  let saved: RunnerLink | null = null;
  const store: RunnerLinkStore = {
    load: async () => saved,
    save: async (link) => {
      saved = { ...link };
    },
    clear: async () => {
      saved = null;
    },
  };
  const link = await linkWithInstallToken({
    client: createRunnerLinkClient({ siteUrl: siteUrl! }),
    store,
    host: runnerHostFacts("user"),
    installToken,
  });
  return link.runnerId;
}

const venue = { id: "local", kind: "local" } as const;
const userProvenance: SessionEventProvenance = {
  source: { kind: "user", id: "desktop", detail: { sessionOrigin: { kind: "user" } } },
  venue,
};
const adapterProvenance: SessionEventProvenance = {
  source: { kind: "adapter", id: "pi", detail: { channel: "rpc" } },
  venue,
};

/** A Session of the local project: the real Engine over an in-memory ledger. */
function localSession(projectId: string, title: string) {
  const sessionId = randomUUID();
  let now = Date.now() - 86_400_000;
  const engine = createSessionEngine({
    ledger: createInMemorySessionLedger(),
    clock: { now: () => now++ },
    ids: { next: () => randomUUID() },
  });
  return {
    sessionId,
    engine,
    create: () =>
      engine.createSession({
        commandId: randomUUID(),
        requestedSessionId: sessionId,
        projectId,
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title,
        provenance: userProvenance,
      }),
    observe: (fields: Record<string, unknown>) =>
      engine.observe({
        id: randomUUID(),
        sessionId,
        occurredAt: now++,
        provenance: adapterProvenance,
        ...fields,
      } as never),
    events: async () => [...(await engine.listEvents({ sessionId }))],
  };
}

function textOf(message: UIMessage | undefined): string | null {
  if (message === undefined) return null;
  return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

describe.skipIf(!fixture)(
  "a moved project's Session history through the window's transport",
  () => {
    it("imports, packs and folds every moved Session, and draws every message, 50 MB included", async () => {
      const subject = `moved-history-${randomUUID()}`;
      const person = new ConvexHttpClient(url!);
      person.setAuth(token(subject));
      await inviteTestEmail(url!, `${subject}@example.com`);
      const { userId } = await person.mutation(api.accounts.ensureViewer, {
        acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
      });
      const [workspace] = await person.query(api.workspaces.listMine, {});
      const workspaceId = workspace!.workspaceId;
      const runnerId = await linkRunner(person);
      const store = await startObjectStore();
      cleanups.push(() => store.close());
      const root = await mkdtemp(join(tmpdir(), "volli-moved-history-"));
      cleanups.push(() => rm(root, { recursive: true, force: true }));

      // ── the local project, as this Mac holds it ──────────────────────────────
      const projectId = randomUUID();
      const artifacts = createFileTranscriptArtifactStore(join(root, "session-transcripts"));
      const bodies = new Map<string, string>(); // reference id → text
      const write = async (role: "user" | "assistant", text: string, turnId: string) => {
        const artifact: SessionTranscriptArtifact = {
          version: 1,
          threadId: "thread-1",
          branchId: "branch-1",
          attemptId: "attempt-1",
          turnId,
          message: { id: `${role}-${randomUUID()}`, role, parts: [{ type: "text", text }] },
        };
        const reference = await artifacts.write(artifact);
        bodies.set(reference.id, text);
        return reference;
      };

      // A chat: turns of messages, a `$schema`- and non-ASCII-keyed diagnostic,
      // a fact larger than an accept takes, and a Pi session log.
      const chat = localSession(projectId, "Moved chat");
      await chat.create();
      const piDirectory = join(root, "pi-sessions");
      const piSessionId = randomUUID();
      const piPath = join(
        piDirectory,
        "--workspace--",
        `2026-10-28T00-00-00-000Z_${piSessionId}.jsonl`,
      );
      await mkdir(join(piDirectory, "--workspace--"), { recursive: true });
      await writeFile(
        piPath,
        `${JSON.stringify({ type: "session", id: piSessionId })}\n${JSON.stringify({ type: "message", text: "ü" })}\n`,
      );
      const start = await chat.engine.submit({
        commandId: randomUUID(),
        sessionId: chat.sessionId,
        intent: { kind: "executor.start", adapterId: "pi", continuity: "fresh" },
        provenance: userProvenance,
      });
      const attachment: SessionAttachment = {
        id: randomUUID(),
        sessionId: chat.sessionId,
        adapterId: "pi",
        venue,
        continuity: "fresh",
        native: {
          id: piSessionId,
          detail: {
            kind: "volli.native-binding.v1",
            locator: { runtime: "pi", sessionId: piSessionId, sessionFilePath: piPath },
          },
        },
        authority: null,
      };
      await chat.observe({ kind: "attachment.opened", commandId: start.command.id, attachment });
      for (let turn = 0; turn < 3; turn += 1) {
        const turnId = randomUUID();
        await chat.engine.submit({
          commandId: randomUUID(),
          sessionId: chat.sessionId,
          intent: {
            kind: "message.submit",
            reference: await write("user", `Question ${turn}: what moved?`, turnId),
          },
          provenance: userProvenance,
        });
        await chat.observe({ kind: "turn.started", attachmentId: attachment.id, turnId });
        await chat.observe({
          kind: "attention.raised",
          attachmentId: attachment.id,
          attention: {
            id: `attention-${turn}`,
            kind: "input_required",
            attachmentId: attachment.id,
            detail: "Which branch?",
            diagnostic: { $schema: "https://json-schema.org/draft/2020-12/schema", ключ: turn },
          },
        });
        await chat.observe({
          kind: "attention.cleared",
          attachmentId: attachment.id,
          attentionId: `attention-${turn}`,
        });
        await chat.observe({
          kind: "transcript.referenced",
          attachmentId: attachment.id,
          turnId,
          reference: await write("assistant", `Answer ${turn}: everything, verbatim. ✓`, turnId),
          digest: { role: "assistant", reply: true },
        });
        await chat.observe({ kind: "turn.completed", attachmentId: attachment.id, turnId });
      }
      await chat.engine.getOrRecordSessionInput({
        sessionId: chat.sessionId,
        input: {
          kind: "prompt-resources",
          resources: [{ name: "AGENTS.md", text: OVERSIZED_TEXT }],
        },
        provenance: userProvenance,
      });

      // The 50 MB transcript: thousands of message bodies.
      const large = localSession(projectId, "Moved long history");
      await large.create();
      for (let index = 0; index < LARGE_BODIES; index += 1) {
        const text = `${index}:${randomBytes((LARGE_BODY_CHARS * 3) / 4).toString("base64")}`;
        await large.observe({
          kind: "transcript.referenced",
          attachmentId: null,
          turnId: null,
          reference: await write("assistant", text, `turn-${Math.floor(index / 8)}`),
        });
      }

      const sessions = [chat, large];
      const histories = new Map<string, SessionEvent[]>();
      for (const session of sessions) histories.set(session.sessionId, await session.events());

      // ── the export records and the manifest's promise ───────────────────────
      const USER = MIGRATION_PLACEHOLDERS.userId;
      const RUNNER = MIGRATION_PLACEHOLDERS.runnerId;
      const records = Object.fromEntries(
        MIGRATION_IMPORT_STREAMS.map((stream) => [stream, [] as Record<string, unknown>[]]),
      ) as Record<MigrationImportStream, Record<string, unknown>[]>;
      records.projects.push({
        id: projectId,
        workspaceId: MIGRATION_PLACEHOLDERS.workspaceId,
        name: "Moved project",
        colorIndex: 1,
        ticketPrefix: "MOVD",
        origin: "migrated",
        countsTowardCap: false,
        createdByUserId: USER,
        createdAt: 1,
        updatedAt: 2,
        archivedAt: null,
        removedAt: null,
      });
      records.projectCounters.push({ projectId, nextTicketNumber: 1, boardSeq: 0 });
      for (const session of sessions) {
        const events = histories.get(session.sessionId)!;
        const created = events.find(({ payload }) => payload.kind === "session.created")!;
        const born = (created.payload as { session: { createdAt: number; title: string | null } })
          .session;
        const createdAt = born.createdAt;
        records.sessions.push({
          id: session.sessionId,
          projectId,
          ticketId: null,
          role: "project",
          parentSessionId: null,
          ownerUserId: USER,
          title: born.title,
          ...sessionVisibilityAtCreation({ role: "project" }, createdAt),
          placeRunnerId: RUNNER,
          createdAt,
          lastActivityAt: events.at(-1)!.occurredAt,
          lastSequence: events.length,
          eventCount: events.length,
        });
        for (const event of events) {
          records.sessionEvents.push(
            sessionEventImportRecord(event as unknown as Record<string, unknown>),
          );
        }
        records.sessionIntake.push({
          sessionId: session.sessionId,
          acceptedThrough: events.length,
          lastEventId: events.at(-1)!.id,
        });
      }
      const target: MigrationTarget = { userId, workspaceId, runnerId };
      const expected = MIGRATION_IMPORT_STREAMS.map((stream) => {
        const digest = new MigrationDigest();
        for (const record of records[stream]) {
          digest.add(migrationRowDigest(stream, migrationDocument(stream, record, target, 0)));
        }
        return { stream, count: digest.count, digest: digest.value };
      });

      // ── the move: rows, history objects, commit ──────────────────────────────
      const moveId = randomUUID();
      const manifestSha256 = sha256(JSON.stringify(expected));
      await person.mutation(api.projectImports.begin, {
        moveId,
        projectId,
        workspaceId,
        runnerId,
        manifestSha256,
        expected,
      });
      for (const stream of MIGRATION_IMPORT_STREAMS) {
        let batch: Record<string, unknown>[] = [];
        let bytes = 0;
        const send = async () => {
          if (batch.length === 0) return;
          const result = await person.mutation(api.projectImports.importRows, {
            moveId,
            stream,
            rows: batch,
          });
          expect(result, stream).toMatchObject({
            inserted: batch.length,
            conflicts: [],
            rejected: [],
          });
          batch = [];
          bytes = 0;
        };
        for (const record of records[stream]) {
          const size = Buffer.byteLength(JSON.stringify(record));
          if (
            batch.length >= BATCH_MAX_ROWS ||
            (batch.length > 0 && bytes + size > BATCH_MAX_BYTES)
          )
            await send();
          batch.push(record);
          bytes += size;
        }
        await send();
      }

      const backend: MoveBackend = {
        query: (path, args) => person.query(makeFunctionReference<"query">(path), args),
        mutation: (path, args) => person.mutation(makeFunctionReference<"mutation">(path), args),
        action: (path, args) => person.action(makeFunctionReference<"action">(path), args),
      };
      const uploader = createMoveHistoryUploader({
        moveId,
        runnerId,
        backend,
        artifacts,
        redaction: {
          step: (window, from, final) => new ExactValueByteRedactor([]).step(window, from, final),
          complete: () => true,
        },
      });
      for (const session of sessions) {
        const events = histories.get(session.sessionId)!;
        const report = await uploader.upload({
          sessionId: session.sessionId,
          projectId,
          lastSequence: events.length,
          generation: 1,
          eventsAfter: (after, limit) =>
            events.filter(({ sequence }) => sequence > after).slice(0, limit),
          piFiles:
            session === chat ? await piLogFilesOf([attachment], { runnerId, piDirectory }) : [],
        });
        expect(report.missing, session.sessionId).toEqual([]);
        const head = await person.query(api.projectImportHistory.uploadHead, {
          moveId,
          sessionId: session.sessionId,
          claim: { runnerId, generation: 1 },
          piFileIds: session === chat ? [`2026-10-28T00-00-00-000Z_${piSessionId}`] : [],
        });
        expect(head.transcriptThrough, session.sessionId).toBe(events.length);
        if (session === chat) {
          expect(Object.values(head.piLogs)).toEqual([(await stat(piPath)).size]);
        } else {
          // About 50 MB of bodies: several packs, cut at the pack limits.
          expect(report.transcript.length).toBeGreaterThan(8);
        }
      }
      expect(store.failures).toEqual([]);
      expect(store.puts).toBeGreaterThan(LARGE_BODIES / 200);

      await person.mutation(api.projectImports.commit, { moveId, manifestSha256 });
      await vi.waitFor(
        async () => {
          const progress = await person.query(api.projectImportHistory.foldProgress, {
            moveId,
            cursor: null,
          });
          expect(progress).toMatchObject({ sessions: 2, folded: 2, behind: [], isDone: true });
        },
        { timeout: 60_000, interval: 250 },
      );

      // ── the read-back, through the window's own transport ────────────────────
      const window = new ConvexReactClient(url!, { unsavedChangesWarning: false });
      window.setAuth(async () => token(subject));
      cleanups.push(() => window.close());
      const cloud: CloudSession = { client: window, api };
      vi.stubGlobal("window", {
        requestAnimationFrame: (callback: () => void) => setTimeout(callback, 16),
        cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
        setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
        clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
      });
      const transport = cloudChatTransport(cloud);
      vi.unstubAllGlobals();
      for (const session of sessions) {
        const events = histories.get(session.sessionId)!;
        const snapshot = await transport.rpc.session.snapshot.query({
          sessionId: session.sessionId,
        });
        expect(snapshot.throughSequence).toBe(events.length);
        // The fold drawn beside it is the moved Session's own.
        expect(snapshot.projection).toMatchObject({
          session: {
            id: session.sessionId,
            projectId,
            title: session === chat ? "Moved chat" : "Moved long history",
          },
          turnActive: false,
        });
        type Frame = { sequence: number; transcript: { message: UIMessage } | null };
        const frames = new Map<number, Frame>();
        for (const frame of snapshot.frames as Frame[]) frames.set(frame.sequence, frame);
        for (let before = snapshot.before ?? null; before !== null;) {
          const page = await transport.rpc.session.history.query({
            sessionId: session.sessionId,
            before,
          });
          for (const frame of page.frames as Frame[]) frames.set(frame.sequence, frame);
          before = page.before ?? null;
        }
        // Every fact arrives, readable.
        expect([...frames.keys()].toSorted((a, b) => a - b)).toEqual(
          events.map(({ sequence }) => sequence),
        );
        // Every message draws, in its own words.
        const references = events.flatMap((event) => {
          const payload = event.payload as {
            kind: string;
            reference?: TranscriptReference;
            command?: { intent?: { kind: string; reference?: TranscriptReference } };
          };
          const reference =
            payload.kind === "transcript.referenced"
              ? payload.reference
              : payload.kind === "command.recorded" &&
                  payload.command?.intent?.kind === "message.submit"
                ? payload.command.intent.reference
                : undefined;
          return reference === undefined ? [] : [{ sequence: event.sequence, reference }];
        });
        expect(references.length).toBeGreaterThan(0);
        const drawn = references.filter(
          ({ sequence, reference }) =>
            textOf(frames.get(sequence)?.transcript?.message) === bodies.get(reference.id),
        );
        expect(drawn.length, session.sessionId).toBe(references.length);
        expect(
          references.every(
            ({ reference }) => reference.mediaType === TRANSCRIPT_ARTIFACT_MEDIA_TYPE,
          ),
        ).toBe(true);
      }
      expect(store.failures).toEqual([]);
    }, 300_000);
  },
);
