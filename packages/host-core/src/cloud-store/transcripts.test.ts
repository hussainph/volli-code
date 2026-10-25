import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  canonicalJson,
  type HostedSessionRuntime,
  type SessionTranscriptArtifact,
} from "@volli/session-engine";
import { LOCAL_RUNNER, type SessionEvent } from "@volli/shared";
import type { BackendLink } from "../cloud-runner/backend-link";
import type { RunnerPresence } from "../cloud-runner/presence";
import { sqliteDrainCursorStore } from "../cloud-runner/sqlite-stores";
import { sqliteDrainLedger } from "../session-control/sqlite-ledger";
import { createSessionWakeBus } from "../session-control/session-wake";
import { createTestSessionEngine } from "../testing/session-engine";
import { openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { insertProject } from "../db/projects-repo";
import { createFileTranscriptArtifactStore } from "../session-runtime/transcript-artifacts";
import { SecretStore } from "../secrets/store";
import type { LiveHostCore } from "../index";
import { createCloudTranscriptPublisher } from "./transcripts";
import { createCloudProductStore, type CloudProductStore } from "./index";

const PROJECT = "a0000000-0000-4000-8000-000000000001";
const SESSION = "c0000000-0000-4000-8000-000000000001";
const provenance = {
  source: { kind: "system" as const, id: "test", detail: null },
  venue: LOCAL_RUNNER,
};
let db: TestDb;
let cloud: CloudProductStore | undefined;
let connection: ReturnType<CloudProductStore["connect"]> | undefined;
let server: Server | undefined;
afterEach(async () => {
  await connection?.close();
  cloud?.dispose();
  db?.cleanup();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  cloud = undefined;
  connection = undefined;
  server = undefined;
  vi.restoreAllMocks();
});

async function fixture(text = "Reply from the actual local artifact store") {
  db = openTestDb();
  insertProject(db.db, testProject({ id: PROJECT }));
  const wake = createSessionWakeBus(createTestSessionEngine(db.db), { db: db.db });
  const artifacts = createFileTranscriptArtifactStore(join(dirname(db.dbPath), "transcripts"));
  const secretStore = new SecretStore(join(dirname(db.dbPath), "secrets.enc"), {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error("No persistent credentials in this fixture");
    },
    decryptString: () => {
      throw new Error("No persistent credentials in this fixture");
    },
  });
  cloud = createCloudProductStore({
    host: {
      database: { ok: true, db: db.db },
      sessionEngine: wake.engine,
      sessionWakeBus: wake,
      secretStore,
    } as LiveHostCore,
    ownerUserId: "owner",
    backendUrl: "http://127.0.0.1:1",
    runnerId: () => "runner",
    busySites: async () => [],
  });
  await cloud.engine.createSession({
    requestedSessionId: SESSION,
    commandId: "birth",
    projectId: PROJECT,
    ticketId: null,
    role: "project",
    parentSessionId: null,
    title: null,
    provenance,
  });
  const artifact: SessionTranscriptArtifact = {
    version: 1,
    threadId: SESSION,
    branchId: SESSION,
    attemptId: SESSION,
    turnId: null,
    message: { id: "reply", role: "assistant", parts: [{ type: "text", text }] },
  };
  const reference = await artifacts.write(artifact);
  await cloud.engine.observe({
    id: "reply-observation",
    kind: "transcript.referenced",
    sessionId: SESSION,
    occurredAt: 1,
    attachmentId: null,
    turnId: null,
    reference,
    provenance,
  });
  const events = await cloud.engine.listEvents({ sessionId: SESSION });
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const bodies = new Map<string, string>();
  let accepted = 0;
  const listeners = new Map<string, (value: unknown) => void>();
  const offWatched = vi.fn();
  const link = {
    status: { state: "connected" },
    onStatus: () => () => {},
    close: async () => {},
    call: async () => [],
    query: async () => null,
    subscribe: (name: string, _args: unknown, listener: (value: unknown) => void) => {
      listeners.set(name, listener);
      return offWatched;
    },
    async mutate(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (name === "transcripts:stageArtifacts") {
        expect(accepted).toBeGreaterThan(0); // the birth and claim already exist
        expect(args.claim).toEqual({ runnerId: "runner", generation: 1 });
        for (const body of args.artifacts as { digest: string; body: string | null }[]) {
          if (body.body !== null) bodies.set(body.digest, body.body);
        }
        return { staged: 1, skipped: 0 };
      }
      if (name === "sessions:accept") {
        const batch = (args.events as string[]).map((raw) => JSON.parse(raw) as SessionEvent);
        for (const event of batch) {
          if (event.payload.kind === "transcript.referenced") {
            expect(bodies.has(event.payload.reference.id)).toBe(true);
          }
          accepted = Math.max(accepted, event.sequence);
        }
        return { acceptedThrough: accepted, duplicates: 0, quarantined: 0 };
      }
      return null;
    },
  } as unknown as BackendLink;
  let live: { link: BackendLink; runnerId: string; runnerToken(): Promise<string | null> } | null =
    {
      link,
      runnerId: "runner",
      runnerToken: async () => "runner-token",
    };
  let complete = true;
  const publish = (backendUrl = "http://127.0.0.1:1") =>
    createCloudTranscriptPublisher({
      current: () => live,
      artifacts: () => artifacts,
      engine: cloud!.engine,
      ownerUserId: "owner",
      piDirectory: () => join(dirname(db.dbPath), "pi-sessions"),
      ledger: sqliteDrainLedger(db.db),
      cursors: sqliteDrainCursorStore(db.db),
      redaction: {
        step: (window, from, final) => secretStore.redactStreamStep(window, from, final),
        complete: () => complete,
      },
      backendUrl,
    });
  return {
    artifacts,
    artifact,
    reference,
    events,
    calls,
    bodies,
    link,
    listeners,
    offWatched,
    secretStore,
    publish,
    incomplete: () => {
      complete = false;
    },
    complete: () => {
      complete = true;
    },
    disconnect: () => {
      live = null;
    },
    request: {
      sessionId: SESSION,
      generation: 1,
      events: events.map((event) => JSON.stringify(event)),
    },
    callOptions: { priority: "backlog" as const, bytes: 4096 },
  };
}

describe("the runner's transcript producer composition", () => {
  it("stages an offline birth batch's body after registration and before its reference", async () => {
    const f = await fixture();
    const publish = f.publish();
    await expect(publish(f.request, f.callOptions)).resolves.toMatchObject({
      acceptedThrough: f.events.length,
    });
    expect(f.calls.map((call) => call.name)).toEqual([
      "sessions:accept",
      "transcripts:stageArtifacts",
      "sessions:accept",
    ]);
    expect(f.bodies.get(f.reference.id)).toBe(canonicalJson(f.artifact));
    expect(await f.artifacts.read(f.reference)).toEqual(f.artifact);
  });

  it("holds references on incomplete redaction or a failed staging call, then safely replays the prefix", async () => {
    const f = await fixture("Reply includes canary-secret");
    f.secretStore.put({
      name: "CANARY",
      value: "canary-secret",
      scope: "session",
      sessionId: SESSION,
      projectId: PROJECT,
    });
    const publish = f.publish();
    f.incomplete();
    await expect(publish(f.request, f.callOptions)).rejects.toThrow(
      "Secret storage is unavailable",
    );
    expect(f.calls.map((call) => call.name)).toEqual(["sessions:accept"]);
    f.complete();
    const original = f.link.mutate;
    const error = Object.assign(new Error("claim transferred"), { data: { code: "stale_claim" } });
    vi.spyOn(f.link, "mutate").mockImplementation(async (name, args, opts) => {
      if (name === "transcripts:stageArtifacts") throw error;
      return original(name, args, opts);
    });
    await expect(publish(f.request, f.callOptions)).rejects.toMatchObject({
      data: { code: "fenced" },
    });
    expect(f.calls.filter((call) => call.name === "sessions:accept")).toHaveLength(2);
    vi.mocked(f.link.mutate).mockRestore();
    await publish(f.request, f.callOptions);
    expect(f.bodies.get(f.reference.id)).not.toContain("canary-secret");
    expect(await f.artifacts.read(f.reference)).toEqual(f.artifact); // remote redaction never rewrites local bytes
    f.disconnect();
    await expect(publish(f.request, f.callOptions)).rejects.toThrow("offline");
  });

  it("wires the real cloud store drain and live-viewer subscription, even when runtime binds after connect", async () => {
    const f = await fixture();
    const runtime = {
      projection: vi.fn(async () => ({ projection: { latestTurnId: null }, throughSequence: 0 })),
      subscribe: vi.fn(async () => vi.fn()),
    } as unknown as HostedSessionRuntime;
    connection = cloud!.connect({
      link: f.link,
      runnerId: "runner",
      bootId: "boot",
      presence: { start: async () => {}, stop: async () => {} } as unknown as RunnerPresence,
    });
    connection.start();
    expect(f.listeners.has("sessionViewers:watched")).toBe(false);
    cloud!.bindRuntime(runtime, f.artifacts);
    expect(f.listeners.has("sessionViewers:watched")).toBe(true);
    f.listeners.get("sessionViewers:watched")!({ sessionIds: [SESSION] });
    await vi.waitFor(() => expect(runtime.subscribe).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(f.bodies.get(f.reference.id)).toBe(canonicalJson(f.artifact)));
    await connection.close();
    connection = undefined;
    expect(f.offWatched).toHaveBeenCalled();
  });

  it("fails packing closed with incomplete redaction or a foreign local owner", async () => {
    const f = await fixture();
    const query = vi.spyOn(f.link, "query");
    f.incomplete();
    await expect(f.publish().pack(SESSION, new AbortController().signal)).rejects.toThrow(
      "Secret storage is unavailable",
    );
    expect(query).not.toHaveBeenCalled();
    f.complete();
    const cursors = sqliteDrainCursorStore(db.db);
    cursors.save({ ...cursors.get(SESSION)!, ownerUserId: "another-account" });
    await expect(f.publish().pack(SESSION, new AbortController().signal)).rejects.toThrow(
      "local claim",
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("abandons a pending head read on close without reading artifacts or committing after its late answer", async () => {
    const f = await fixture();
    const head = Promise.withResolvers<unknown>();
    const query = vi.spyOn(f.link, "query").mockReturnValue(head.promise);
    const read = vi.spyOn(f.artifacts, "read");
    const controller = new AbortController();
    const packing = f.publish().pack(SESSION, controller.signal);
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
    controller.abort(new Error("closed"));
    await expect(packing).rejects.toThrow("closed");
    head.resolve({ transcriptThrough: 0, piLogs: {} });
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });

  it("uploads bodies over 64KB through runner-authorized presigned storage before accepting their references", async () => {
    const f = await fixture("large reply ".repeat(8000));
    let uploaded: Buffer | undefined;
    let signed: Record<string, unknown> | undefined;
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      if (req.url === "/upload") {
        uploaded = bytes;
        res.end();
        return;
      }
      expect(req.headers.authorization).toBe("Bearer runner-token");
      const body = JSON.parse(bytes.toString("utf8")) as {
        path: string;
        args: Record<string, unknown>;
      };
      expect(body.path).toBe("files:presignPut");
      signed = body.args;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          status: "success",
          value: {
            status: "sign",
            request: {
              url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/upload`,
              headers: {},
            },
          },
        }),
      );
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const original = f.link.mutate;
    vi.spyOn(f.link, "mutate").mockImplementation(async (name, args, opts) => {
      if (name === "transcripts:stageArtifacts") {
        expect(uploaded).toBeDefined();
        const rows = args.artifacts as { digest: string; body: null; spillKey: string }[];
        expect(rows[0]!.body).toBeNull();
        expect(rows[0]!.spillKey).toBe(signed!.key);
        f.bodies.set(rows[0]!.digest, zstdDecompressSync(uploaded!).toString("utf8"));
      }
      return original(name, args, opts);
    });
    await f.publish(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)(
      f.request,
      f.callOptions,
    );
    expect(signed).toMatchObject({
      sessionId: SESSION,
      claim: { runnerId: "runner", generation: 1 },
    });
    expect(f.bodies.get(f.reference.id)).toBe(canonicalJson(f.artifact));
  });
});
