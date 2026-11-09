/** Real runner/cloud-store fixtures; only the object-storage service is fake. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

import type { LiveHostCore } from "@volli/host-core";
import { createMachinePaths } from "../../packages/host-core/src/machine-paths";
import {
  convexBackendConnection,
  createBackendLink,
  createCloudProductStore,
  createMutationGate,
  createRunnerLinkClient,
  createRunnerPresence,
  createRunnerTokenSource,
  linkWithInstallToken,
  runnerHostFacts,
  runnerPresenceBackend,
  type BackendLink,
  type CloudProductStore,
  type CloudRunnerSyncConnection,
  type RunnerLink,
  type RunnerLinkStore,
} from "@volli/host-core/cloud-runner";
import { insertProject, openVolliDb, throwTransactionViolation } from "@volli/host-core/db";
import { fileSecretKey, SecretStore } from "@volli/host-core/secrets";
import { createFileTranscriptArtifactStore } from "@volli/host-core/session-runtime";
import { createSessionWakeBus } from "@volli/host-core/sessions";
import { createTestSessionEngine, testProject } from "@volli/host-core/testing";

import { api, internal } from "../functions/_generated/api";
import { verifyS3Request } from "../fixture/s3-boundary.ts";
import { scopeDeploymentEnv } from "../fixture/deployment-env.ts";
import { connectBackend } from "../fixture/testing";
import { enrollBackendPreview } from "./preview-fixtures";

export const CANARY = 'packing-canary-"escaped"-é-950';
export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

export async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export interface StoredObject {
  key: string;
  body: Buffer;
  sha256: string;
}

const header = (req: IncomingMessage, name: string) => {
  const value = req.headers[name];
  if (typeof value !== "string") throw new Error(`Missing signed header ${name}`);
  return value.trim().replace(/\s+/gu, " ");
};

/**
 * A loopback S3 boundary, not a fetch mock. Independently verifies SigV4 with
 * node:crypto and rejects a changed key, checksum, length, method or signature.
 * The deployed backend really signs; the production runner really PUTs.
 */
export async function startHistoryS3() {
  const bucket = "transcript-packing";
  const accessKeyId = `history-${randomUUID()}`;
  const secretAccessKey = "fixture-history-secret";
  const region = "auto";
  const objects = new Map<string, StoredObject>();
  const puts: StoredObject[] = [];
  const failures: string[] = [];
  let lostReplies = 0;
  let loseNext: RegExp | null = null;
  let hold: {
    match: RegExp;
    uploaded: PromiseWithResolvers<StoredObject>;
    release: PromiseWithResolvers<void>;
  } | null = null;
  const releases = new Set<() => void>();
  let origin = "";

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, origin);
      const key = verifyS3Request(req, url, {
        endpoint: origin,
        bucket,
        accessKeyId,
        secretAccessKey,
        region,
      });
      if (req.method === "GET") {
        const object = objects.get(key);
        res.writeHead(object ? 200 : 404);
        res.end(object?.body);
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const digest = sha256(body);
      if (header(req, "content-length") !== String(body.length))
        throw new Error("Wrong object length");
      if (header(req, "x-amz-checksum-sha256") !== Buffer.from(digest, "hex").toString("base64"))
        throw new Error("Wrong object checksum");
      const object = { key, body, sha256: digest };
      objects.set(key, object);
      puts.push(object);
      if (hold?.match.test(key)) {
        const pending = hold;
        hold = null;
        pending.uploaded.resolve(object);
        await pending.release.promise;
      }
      // Simulate a lost acknowledgement after the store already persisted it.
      if (loseNext?.test(key)) {
        loseNext = null;
        lostReplies += 1;
        res.writeHead(503);
      }
      res.end();
    } catch (error) {
      failures.push(String(error));
      res.writeHead(400);
      res.end("Invalid object request");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env = {
    VOLLI_S3_ENDPOINT: origin,
    VOLLI_S3_BUCKET: bucket,
    VOLLI_S3_ACCESS_KEY_ID: accessKeyId,
    VOLLI_S3_SECRET_ACCESS_KEY: secretAccessKey,
    VOLLI_S3_REGION: region,
  };
  async function closeServer() {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
  let deployment: Awaited<ReturnType<typeof scopeDeploymentEnv>>;
  try {
    deployment = await scopeDeploymentEnv(env);
  } catch (error) {
    await closeServer();
    throw error;
  }
  return {
    objects,
    puts,
    failures,
    get lostReplies() {
      return lostReplies;
    },
    loseNextPut(match: RegExp) {
      loseNext = match;
    },
    holdNextPut(match: RegExp) {
      if (hold !== null) throw new Error("Already holding an upload");
      const pending = {
        match,
        uploaded: Promise.withResolvers<StoredObject>(),
        release: Promise.withResolvers<void>(),
      };
      hold = pending;
      const release = () => {
        pending.release.resolve();
        releases.delete(release);
      };
      releases.add(release);
      return { uploaded: pending.uploaded.promise, release };
    },
    async close() {
      for (const release of releases) release();
      try {
        await deployment.restore();
      } finally {
        await closeServer();
      }
    },
  };
}

export async function linkHistoryRunner(person: ConvexHttpClient) {
  const backend = connectBackend();
  const client = createRunnerLinkClient({ siteUrl: backend.siteUrl });
  const { installToken } = await person.action(api.runners.createInstallToken, {
    nameHint: "history-packer",
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
  const linked = await linkWithInstallToken({
    client,
    store,
    installToken,
    host: runnerHostFacts("user"),
  });
  const tokens = createRunnerTokenSource({ client, store });
  const token = await tokens.token();
  if (token === null) throw new Error("No runner token");
  const http = new ConvexHttpClient(backend.url);
  http.setAuth(token);
  return { id: linked.runnerId, tokens, http };
}

/** A disk-backed engine and artifacts, composed through the production store. */
export async function historyWorld() {
  const backend = connectBackend();
  const person = backend.client(`user:${randomUUID()}`);
  const { userId } = await person.mutation(api.accounts.ensureViewer, {});
  // The linked runner is only as good as its owner's preview grant.
  await enrollBackendPreview(backend, person, userId);
  const { projectId } = await backend.admin(internal.testSeed.seedWorld, {
    ownerUserId: userId,
    runners: 0,
  });
  const runner = await linkHistoryRunner(person);
  const root = await mkdtemp(join(tmpdir(), "volli-history-packing-"));
  const dbPath = join(root, "volli.db");
  const piDirectory = join(root, "pi-sessions", "--workspace--");
  await mkdir(piDirectory, { recursive: true });
  let db = openVolliDb(dbPath, { onTransactionViolation: throwTransactionViolation });
  insertProject(db, testProject({ id: projectId, path: root }));
  const secretPath = join(root, "secrets.enc");
  const key = () => fileSecretKey({ path: join(root, "secret-key") });
  let secrets = new SecretStore(secretPath, key());
  secrets.put({ name: "PACKING_CANARY", value: CANARY, scope: "always" });
  const artifactPath = join(root, "transcripts");
  let artifacts = createFileTranscriptArtifactStore(artifactPath);
  let wake = createSessionWakeBus(createTestSessionEngine(db), { db });
  function productStore() {
    return createCloudProductStore({
      host: {
        dataDir: root,
        machinePaths: createMachinePaths(db),
        database: { ok: true, db },
        sessionEngine: wake.engine,
        sessionWakeBus: wake,
        secretStore: secrets,
      } as LiveHostCore,
      ownerUserId: userId,
      backendUrl: backend.url,
      runnerId: () => runner.id,
      home: root,
      busySites: async () => [],
    });
  }
  let cloud: CloudProductStore = productStore();
  let connection: CloudRunnerSyncConnection | null = null;
  let link: BackendLink | null = null;
  let connections = 0;
  async function disconnect() {
    if (connection !== null) await connection.close();
    else await link?.close();
    connection = null;
    link = null;
  }
  return {
    person,
    runner,
    userId,
    projectId,
    root,
    artifactPath,
    piDirectory,
    get db() {
      return db;
    },
    get artifacts() {
      return artifacts;
    },
    get cloud() {
      return cloud;
    },
    get link() {
      return link;
    },
    get connections() {
      return connections;
    },
    async connect() {
      if (connection !== null) throw new Error("Already connected");
      const connect = convexBackendConnection(backend.url, { ConvexClient, makeFunctionReference });
      link = createBackendLink({
        connect: (token) => {
          connections += 1;
          return connect(token);
        },
        token: (options) => runner.tokens.token(options),
        gate: createMutationGate(),
      });
      await until(() => link?.status.state === "connected", "runner WebSocket");
      const bootId = randomUUID();
      const presence = createRunnerPresence({
        backend: runnerPresenceBackend(link.call),
        bootId,
        readLoad: () => ({
          activeSessions: 0,
          activeTurns: 0,
          queueDepth: 0,
          freeDiskMb: 1,
          freeMemMb: 1,
        }),
        readCapabilities: () => ({
          version: "0.3.0-history-test",
          platform: { os: "linux", distro: null, kernel: null, arch: "x64", glibc: null },
          installMode: "user",
          capabilities: {
            v: 1,
            nodeVersion: process.versions.node,
            cpuCount: 1,
            memTotalMb: 1,
            git: null,
            docker: false,
            terminals: "unavailable",
            browser: { state: "unavailable", reason: "test" },
            maxConcurrentSessions: 1,
            tools: [],
          },
          localCredentials: [],
        }),
        timers: { setInterval: () => 0, clearInterval: () => {} },
      });
      connection = cloud.connect({
        link,
        presence,
        bootId,
        runnerId: runner.id,
        runnerToken: () => runner.tokens.token(),
      });
      connection.start();
      // No model is needed: the actual engine writes runtime-shaped facts.
      // Bind after connect, as desktop assembly is allowed to do.
      cloud.bindRuntime(null, artifacts);
    },
    disconnect,
    async restart() {
      await disconnect();
      cloud.dispose();
      db.close();
      db = openVolliDb(dbPath, { onTransactionViolation: throwTransactionViolation });
      secrets = new SecretStore(secretPath, key());
      artifacts = createFileTranscriptArtifactStore(artifactPath);
      wake = createSessionWakeBus(createTestSessionEngine(db), { db });
      cloud = productStore();
    },
    async close() {
      try {
        await disconnect();
      } finally {
        cloud.dispose();
        db.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

export type HistoryWorld = Awaited<ReturnType<typeof historyWorld>>;
export type HistoryS3 = Awaited<ReturnType<typeof startHistoryS3>>;
