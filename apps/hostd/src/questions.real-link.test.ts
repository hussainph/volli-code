/** VC-721: a hostd question belongs to its Session, not to a Client connection. */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { piOwnedModelAccess } from "@volli/agent-runtime";
import { createHostCore, throwTransactionViolation } from "@volli/host-core";
import { insertProject } from "@volli/host-core/db";
import { testProject } from "@volli/host-core/testing";
import { createHostLink, type HostLink } from "@volli/host-protocol/client-link";
import type { RendererSessionProjection, RendererSessionStreamFrame } from "@volli/session-rpc";
import type { SessionListingPage } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { scriptedProvider } from "../../../packages/agent-runtime/test-fixtures/scripted-provider";
import { hostdBoardFeed, startHostdProtocolListener } from "./host-protocol";
import { headlessPorts } from "./ports";
import { openHeadlessSecrets } from "./secrets";
import { createHeadlessSessionRuntime } from "./session-runtime";

const WORKSPACE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const HOST = "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b";
const DEVICE = "8a9b0c1d-2e3f-4a5b-9c6d-7e8f9a0b1c2d";
const QUESTION = "Which release should ship?";
const RESOLUTION = { optionIds: ["stable"], response: "Keep the stable release." };

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

interface Snapshot {
  projection: RendererSessionProjection;
  throughSequence: number;
  frames: RendererSessionStreamFrame[];
}

async function client(url: string): Promise<HostLink> {
  const link = createHostLink({
    url,
    workspaceId: WORKSPACE,
    client: { kind: "desktop", version: "questions-real-link-test" },
    features: ["sessions", "sessions.listing"],
    credential: () => "test-only-credential",
  });
  cleanups.push(() => link.close());
  await vi.waitFor(() => expect(link.getState().status).toBe("ready"));
  return link;
}

async function fixture() {
  // All stores (including Pi's auth) are this fixture's, never the person's.
  const scratch = resolve(import.meta.dirname, "../../../.tmp");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "hostd-question-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "project");
  mkdirSync(directory);
  const script = scriptedProvider([
    {
      tool: {
        name: "ask_user",
        args: {
          question: QUESTION,
          options: [
            { id: "stable", label: "Stable" },
            { id: "preview", label: "Preview" },
          ],
        },
      },
    },
    { text: "The stable release will ship." },
  ]);
  const modelAccess = {
    ...piOwnedModelAccess({ agentDir: join(root, "pi") }),
    models: script.models,
  };
  await modelAccess.catalogReady;
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const ports = headlessPorts(logger);
  const host = createHostCore(ports, {
    dataDir: join(root, "data"),
    onTransactionViolation: throwTransactionViolation,
    devDiagnostics: false,
    processReaders: { liveSessionIds: () => [], openTerminalCwds: () => [] },
    modelAccess: () => modelAccess,
  });
  if (host.kind !== "live") throw new Error(host.database.error);
  cleanups.push(() => host.stop("question test done"));
  insertProject(host.database.db, testProject({ id: WORKSPACE, path: directory }));
  const env = { HOME: root, PATH: process.env.PATH };
  const owner = createHeadlessSessionRuntime({
    host,
    ports,
    boardFeed: hostdBoardFeed(() => host.database.db),
    version: "test",
    secrets: openHeadlessSecrets(host.dataDir, env),
    env,
    socketPath: join(root, "unused.sock"),
    options: {
      binDir: join(root, "bin"),
      venue: { id: HOST, kind: "remote" },
      modelAccess,
      platform: "linux",
    },
  });
  cleanups.push(() => owner.close());
  const ready = await owner.ready();
  if (ready.sessions === undefined || ready.submitSessionMessage === undefined)
    throw new Error("The headless Session services are unavailable.");

  // The same recovered services used by the CLI: no Client exists at birth or ask time.
  const started = await ready.sessions.start({
    operationId: "start-question",
    projectId: WORKSPACE,
    ticketId: null,
    role: "project",
    title: "Release decision",
    modelOverride: {
      model: { providerId: "scripted-fixture", modelId: "scripted" },
      reasoningLevel: "off",
    },
  });
  expect(started.state).toBe("ready");
  // The kickoff joins the turn, so observe it without awaiting the parked ask.
  // Capture rejection immediately; the test checks the outcome after the answer.
  const kickoff = ready
    .submitSessionMessage({
      sessionId: started.sessionId,
      commandId: "ask-release",
      messageId: "release-message",
      text: "Choose the release.",
    })
    .then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  return { host, ready, logger, script, kickoff, sessionId: started.sessionId };
}

describe("hostd questions over a real host link", () => {
  it("keeps an unconnected ask pending across Client close/reopen, then resumes the turn on a wire answer", async () => {
    const f = await fixture();
    await vi.waitFor(
      async () => {
        const projection = await f.host.sessionEngine.getSession({ sessionId: f.sessionId });
        expect(projection?.interactions.active).toEqual([
          expect.objectContaining({ kind: "question", title: QUESTION }),
        ]);
        expect(projection?.turnActive).toBe(true);
      },
      { timeout: 5_000 },
    );
    expect(f.script.requests).toHaveLength(1); // Pi is parked, not failed or auto-answered.
    const events = await f.host.sessionEngine.listEvents({ sessionId: f.sessionId });
    const surface = events.find(
      ({ payload }) =>
        payload.kind === "session.input.recorded" && payload.input.kind === "tool-surface",
    )?.payload;
    if (surface?.kind !== "session.input.recorded" || surface.input.kind !== "tool-surface")
      throw new Error("No frozen Session tool surface");
    expect(surface.input.tools).toContain("ask_user");
    expect(surface.input.tools).not.toContain("request_secret");

    const listener = await startHostdProtocolListener({
      db: f.host.database.db,
      hostId: HOST,
      version: "test",
      bind: { host: "127.0.0.1", port: 0 },
      verifier: {
        verify: async () => ({
          actor: { kind: "device", deviceId: DEVICE, workspaceId: WORKSPACE },
          current: () => true,
        }),
      },
      handlers: f.ready.handlers,
      sessionEngine: f.host.sessionEngine,
      logger: f.logger,
    });
    cleanups.push(() => listener.close());
    const first = await client(listener.url);
    const snapshot = (await first.query("session.snapshot", {
      sessionId: f.sessionId,
    })) as Snapshot;
    const question = snapshot.projection.interactions.active[0]!;
    expect(question).toMatchObject({ kind: "question", title: QUESTION });
    expect(snapshot.projection.turnActive).toBe(true);
    const listing = (await first.query("session.listing", {
      projectId: WORKSPACE,
    })) as SessionListingPage;
    expect(listing.sessions).toEqual([
      expect.objectContaining({
        kind: "chat",
        record: expect.objectContaining({
          sessionId: f.sessionId,
          live: true,
          activity: "waiting",
          waitingOn: "question",
        }),
      }),
    ]);

    first.close();
    expect(first.getState().status).toBe("closed");
    const second = await client(listener.url);
    const reopened = (await second.query("session.snapshot", {
      sessionId: f.sessionId,
    })) as Snapshot;
    expect(reopened.projection.interactions.active).toEqual([question]);
    expect(reopened.projection.turnActive).toBe(true);
    expect(f.script.requests).toHaveLength(1);

    const result = await second.mutate("session.command", {
      sessionId: f.sessionId,
      commandId: "answer-release",
      command: { kind: "interaction.resolve", interactionId: question.id, resolution: RESOLUTION },
    });
    expect(result).toMatchObject({ receipt: { status: "accepted" } });
    await vi.waitFor(
      async () => {
        const projection = await f.host.sessionEngine.getSession({ sessionId: f.sessionId });
        expect(projection?.turnActive).toBe(false);
        expect(projection?.lastTurnOutcome).toBe("completed");
      },
      { timeout: 5_000 },
    );
    expect(await f.kickoff).toEqual({ ok: true });
    expect(f.script.requests).toHaveLength(2);
    // The actual tool result reached the scripted provider's next request.
    expect(JSON.stringify(f.script.requests[1])).toContain("Chose: stable");
    expect(JSON.stringify(f.script.requests[1])).toContain(RESOLUTION.response);
    const answered = (await second.query("session.snapshot", {
      sessionId: f.sessionId,
    })) as Snapshot;
    expect(answered.projection.interactions.active).toEqual([]);
    expect(answered.projection.interactions.resolved).toEqual([
      expect.objectContaining({
        interaction: expect.objectContaining({ id: question.id }),
        resolution: RESOLUTION,
      }),
    ]);
    expect(answered.frames.map(({ event }) => event.payload.kind)).toContain(
      "interaction.resolved",
    );
    expect(JSON.stringify(answered)).toContain("The stable release will ship.");
  }, 20_000);
});
