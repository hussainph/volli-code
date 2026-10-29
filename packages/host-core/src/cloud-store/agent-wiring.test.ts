import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { LiveHostCore } from "../index";
import { LOCAL_RUNNER, type AgentRequest } from "@volli/shared";
import { openTestDb, testProject, type TestDb } from "../db/test-helpers";
import { insertProject } from "../db/projects-repo";
import { createTestSessionEngine } from "../testing/session-engine";
import { createSessionWakeBus } from "../session-control/session-wake";
import { sqliteDrainCursorStore } from "../cloud-runner/sqlite-stores";
import type { BackendLink } from "../cloud-runner/backend-link";
import type { RunnerPresence } from "../cloud-runner/presence";
import * as sessionJobs from "./session-jobs";
import { createCloudProductStore } from "./index";
import { createMachinePaths } from "../machine-paths";

const PROJECT = "a0000000-0000-4000-8000-000000000001";
const SESSION = "c0000000-0000-4000-8000-000000000001";
let db: TestDb | undefined;
let server: Server | undefined;
let cloud: ReturnType<typeof createCloudProductStore> | undefined;
let connection: ReturnType<ReturnType<typeof createCloudProductStore>["connect"]> | undefined;
afterEach(async () => {
  await connection?.close();
  cloud?.dispose();
  db?.cleanup();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  vi.restoreAllMocks();
  connection = undefined;
  cloud = undefined;
  server = undefined;
  db = undefined;
});

it("composes owner cursor routing, Agent overlays, runner notify and fenced artifact reads", async () => {
  const calls: { path: string; args: Record<string, unknown>; auth: string | undefined }[] = [];
  server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text) as { path: string; args: Record<string, unknown> };
    calls.push({ ...body, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    const value =
      body.path === "attention:raiseFromRunner"
        ? { displayName: "Alice" }
        : body.path === "agentTokens:mint"
          ? { token: "agent-token", serverTime: Date.now(), expiresAt: Date.now() + 900_000 }
          : null;
    res.end(
      JSON.stringify(
        value === null
          ? { status: "error", errorData: { code: "not_found", message: "Remote target absent" } }
          : { status: "success", value },
      ),
    );
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  db = openTestDb();
  insertProject(db.db, testProject({ id: PROJECT }));
  const wake = createSessionWakeBus(createTestSessionEngine(db.db), { db: db.db });
  await wake.engine.createSession({
    requestedSessionId: SESSION,
    commandId: "birth",
    ownerUserId: "owner",
    projectId: PROJECT,
    ticketId: null,
    role: "project",
    parentSessionId: null,
    title: "Cloud",
    provenance: { source: { kind: "system", id: "test", detail: null }, venue: LOCAL_RUNNER },
  });
  const cursors = sqliteDrainCursorStore(db.db);
  const cursor = {
    sessionId: SESSION,
    ownerUserId: "owner",
    generation: 7,
    acceptedThrough: 0,
    blocked: null,
  };
  cursors.save(cursor);
  const host = {
    machinePaths: createMachinePaths(db.db),
    database: { ok: true, db: db.db },
    sessionEngine: wake.engine,
    sessionWakeBus: wake,
  } as LiveHostCore;
  cloud = createCloudProductStore({
    host,
    ownerUserId: "owner",
    backendUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    runnerId: () => "runner",
    busySites: async () => [],
  });
  const query = vi.fn(async () => ({ body: "canonical body" }));
  const link = {
    status: { state: "connected" },
    onStatus: () => () => {},
    query,
    close: async () => {},
  } as unknown as BackendLink;
  const presence = { stop: async () => {} } as unknown as RunnerPresence;
  const register = vi.spyOn(sessionJobs, "registerSessionCommandJob");
  connection = cloud.connect({
    link,
    presence,
    bootId: "boot",
    runnerId: "runner",
    runnerToken: async () => "runner-token",
  });
  expect(cloud.agentCommands.projects().map((p) => p.id)).toEqual([PROJECT]);
  expect(cloud.agentCommands.cloudSessionVerbs).toBe(cloud.cloudSessionVerbs);
  const read: AgentRequest = {
    v: 1,
    cmd: "session.show",
    args: { id: SESSION.slice(0, 8) },
    ctx: { cwd: "/", env: {} },
  };
  expect(await cloud.cloudSessionVerbs.socket({ sessionId: SESSION, request: read })).toBeNull();
  expect(calls).toEqual([]);
  const notify: AgentRequest = {
    ...read,
    cmd: "notify",
    args: { message: "Ready", title: "Build" },
  };
  expect(
    await cloud.cloudSessionVerbs.socket({ sessionId: SESSION, request: notify }),
  ).toMatchObject({ ok: true, data: { queued: true, queuedFor: "Alice" } });
  expect(calls[0]).toMatchObject({
    path: "attention:raiseFromRunner",
    auth: "Bearer runner-token",
    args: {
      sessionId: SESSION,
      generation: 7,
      title: "Build",
      detail: "Ready",
      notifyId: expect.any(String),
    },
  });
  const source = register.mock.lastCall![1].commandArtifact!;
  expect(await source({ sessionId: SESSION, digest: "sha256:test" })).toBe("canonical body");
  expect(query).toHaveBeenCalledWith("transcripts:commandArtifact", {
    sessionId: SESSION,
    generation: 7,
    digest: "sha256:test",
  });
  await expect(source({ sessionId: "not-owned", digest: "sha256:test" })).rejects.toThrow(
    "does not own",
  );
  expect(
    await cloud.cloudSessionVerbs.socket({ sessionId: "not-owned", request: notify }),
  ).toMatchObject({ ok: false, error: { code: "FORBIDDEN_ACTOR" } });
  cursors.save({ ...cursor, blocked: { code: "fenced", message: "Claim moved", at: 1 } });
  expect(await cloud.cloudSessionVerbs.socket({ sessionId: SESSION, request: read })).toMatchObject(
    { ok: false, error: { code: "SESSION_NOT_FOUND" } },
  );
  expect(calls.some((c) => c.path === "agentTokens:mint")).toBe(true);
  expect(cloud.agentCommands.cloudWorktreeTickets.machinePaths.kind).toBe("cloud");
  expect(
    await cloud.agentCommands.cloudWorktreeTickets.roster({
      sessionId: SESSION,
      request: { ...read, cmd: "conflicts" },
    }),
  ).toMatchObject({ ok: false, response: { ok: false, error: { code: "TICKET_NOT_FOUND" } } });
  expect(
    calls.some((c) => c.path === "projects:listForActor" && c.auth === "Bearer agent-token"),
  ).toBe(true);
});
