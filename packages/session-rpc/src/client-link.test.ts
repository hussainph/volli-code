// The client host link (VC-670) against the production WebSocket listener
// (VC-663): its real handshake, refusals, revocation and replay bounds.
import { createTRPCClient, type TRPCClient } from "@trpc/client";
import {
  readHostError,
  SUBSCRIPTION_REPLAY_BOUNDS,
  type HostActor,
  type HostCredentialGrant,
  type HostError,
} from "@volli/host-protocol";
import {
  createHostLink,
  hostLinkTrpcLink,
  type HostLink,
  type HostLinkState,
} from "@volli/host-protocol/client-link";
import type {
  SessionRuntime,
  SessionStreamEmission,
  SessionStreamFrame,
} from "@volli/session-engine";
import { createSessionProjectionCheckpoint } from "@volli/shared";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { WebSocket } from "ws";

import { createSessionRouter, RpcDiagnosticLog, type AppRouter } from "./index";
import { sessionHandlersFrom } from "./session-handlers.test-support";
import { startHostProtocolListener } from "./websocket-server";

const WORKSPACE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const HOST = "b7c1d2e3-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const DEVICE = "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b";
const SESSION = "session-1";
const device: HostActor = { kind: "device", deviceId: DEVICE, workspaceId: WORKSPACE };

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const session = {
  id: SESSION,
  projectId: WORKSPACE,
  ticketId: null,
  role: "project" as const,
  parentSessionId: null,
  title: null,
  createdAt: 10,
};

function frame(sequence: number): SessionStreamFrame {
  return {
    sessionId: SESSION,
    sequence,
    transcript: null,
    event: {
      id: `event-${sequence}`,
      sessionId: SESSION,
      sequence,
      occurredAt: 10,
      recordedAt: 10,
      provenance: { source: { kind: "system", id: "test", detail: null }, venue: null },
      payload: { kind: "session.retitled", title: `title ${sequence}` },
    },
  };
}

/** A Session ledger: replays strictly after a cursor, then goes live. */
function ledger() {
  const frames: SessionStreamFrame[] = [];
  const listeners = new Set<(emission: SessionStreamEmission) => void | Promise<void>>();
  const reads: string[] = [];
  const projection = createSessionProjectionCheckpoint(session, []).projection;
  const runtime: SessionRuntime = {
    snapshot: async () => ({
      projection,
      throughSequence: frames.length,
      frames: [...frames],
      transcript: [],
    }),
    projection: async () => ({ projection, throughSequence: frames.length }),
    subscribe: async ({ afterSequence, signal }, listener) => {
      reads.push(`subscribe:${afterSequence}`);
      for (const replayed of frames.slice(afterSequence)) {
        if (signal?.aborted === true) return () => {};
        await listener(replayed);
      }
      listeners.add(listener);
      signal?.addEventListener("abort", () => listeners.delete(listener));
      return () => listeners.delete(listener);
    },
    command: async () => {
      throw new Error("not reached");
    },
    cancelInteraction: async () => {},
    reconcile: async () => {},
    close: async () => {},
  };
  const append = async (count: number): Promise<void> => {
    for (let index = 0; index < count; index++) {
      const next = frame(frames.length + 1);
      frames.push(next);
      for (const listener of listeners) await listener(next);
    }
  };
  /** Frames the host holds but no live listener hears: written while every client was away. */
  const backfill = (count: number): void => {
    for (let index = 0; index < count; index++) frames.push(frame(frames.length + 1));
  };
  return { runtime, listeners, reads, append, backfill };
}

/** The production listener over the ledger, with credentials the test can mint and revoke. */
async function serve() {
  const source = ledger();
  const valid = new Map<string, { valid: boolean; revoked: (() => void) | null }>();
  const listener = await startHostProtocolListener({
    router: createSessionRouter(),
    bind: { host: "127.0.0.1", port: 0 },
    host: { id: HOST, version: "test" },
    features: ["sessions", "sessions.subscribe"],
    workspace: async (id) => (id === WORKSPACE ? { id, epoch: 1 } : null),
    verifier: {
      verify: ({ credential }) => {
        const entry = valid.get(credential);
        if (entry === undefined || !entry.valid) return null;
        const grant: HostCredentialGrant = {
          actor: device,
          current: () => entry.valid,
          watch: (revoked) => {
            entry.revoked = revoked;
            return () => {
              entry.revoked = null;
            };
          },
        };
        return grant;
      },
    },
    context: () => ({
      handlers: sessionHandlersFrom({ runtime: source.runtime }),
      diagnostics: new RpcDiagnosticLog(),
      resourceWorkspace: ({ id }) => (id === SESSION ? WORKSPACE : null),
    }),
  });
  cleanups.push(() => listener.close());
  return {
    listener,
    ...source,
    issue(credential: string) {
      valid.set(credential, { valid: true, revoked: null });
    },
    revoke(credential: string) {
      const entry = valid.get(credential)!;
      entry.valid = false;
      entry.revoked?.();
    },
  };
}

/** A link whose sockets the test can reach, to drop one the way a network does. */
function link(url: string, credential: () => string) {
  const sockets: WebSocket[] = [];
  class Tracked extends WebSocket {
    constructor(address: string) {
      super(address);
      sockets.push(this);
    }
  }
  const created = createHostLink({
    url,
    workspaceId: WORKSPACE,
    client: { kind: "desktop", version: "test" },
    features: ["sessions", "sessions.subscribe"],
    credential,
    WebSocket: Tracked as unknown as typeof globalThis.WebSocket,
    timing: { backoffBaseMs: 20, backoffCapMs: 40, heartbeatIntervalMs: 500 },
  });
  cleanups.push(() => created.close());
  return { link: created, drop: () => sockets.at(-1)!.terminate() };
}

async function until<Status extends HostLinkState["status"]>(
  subject: HostLink,
  status: Status,
): Promise<Extract<HostLinkState, { status: Status }>> {
  for (let attempt = 0; attempt < 600; attempt++) {
    const state = subject.getState();
    if (state.status === status) return state as Extract<HostLinkState, { status: Status }>;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${status}; at ${subject.getState().status}`);
}

async function eventually(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function stream(subject: HostLink) {
  const ids: string[] = [];
  const ends: { kind: "resnapshot" | "error"; error: HostError }[] = [];
  subject.subscribe(
    "session.subscribe",
    { sessionId: SESSION },
    {
      onData: (event) => ids.push((event as { id: string }).id),
      onResnapshot: (error) => ends.push({ kind: "resnapshot", error }),
      onError: (error) => ends.push({ kind: "error", error: readHostError(error) }),
    },
  );
  return { ids, ends };
}

describe("the client host link on the production listener", () => {
  it("handshakes, then resumes a dropped Session stream with no loss and no duplicate", async () => {
    const host = await serve();
    host.issue("token");
    const { link: subject, drop } = link(host.listener.url, () => "token");
    const ready = await until(subject, "ready");
    expect(ready.welcome).toMatchObject({
      host: { id: HOST },
      workspace: { id: WORKSPACE, epoch: 1 },
      features: ["sessions", "sessions.subscribe"],
    });
    const feed = stream(subject);
    await eventually(() => host.listeners.size === 1, "the stream to open");
    await host.append(3);
    await eventually(() => feed.ids.length === 3, "three frames");
    drop();
    await until(subject, "unreachable");
    await eventually(() => host.listeners.size === 0, "the dropped stream's listener to go");
    host.backfill(2);
    await until(subject, "ready");
    await eventually(() => feed.ids.length === 5, "the replay");
    await eventually(() => host.listeners.size === 1, "the resumed stream to go live");
    await host.append(1);
    await eventually(() => feed.ids.length === 6, "the live frame");
    expect(feed.ids).toStrictEqual(["1", "2", "3", "4", "5", "6"]);
    expect(host.reads).toStrictEqual(["subscribe:0", "subscribe:3"]);
    expect(feed.ends).toStrictEqual([]);
  });

  it("surfaces the listener's refusal as a typed state, not a socket error", async () => {
    const host = await serve();
    const { link: subject } = link(host.listener.url, () => "stolen");
    const refused = await until(subject, "refused");
    expect(refused.error).toMatchObject({ code: "UNAUTHORIZED", reason: "credential-invalid" });
    expect(
      await subject.query("session.projection", { sessionId: SESSION }).catch(readHostError),
    ).toMatchObject({ reason: "credential-invalid" });
  });

  it("reconnects a revoked connection with a fresh credential, and keeps the stream", async () => {
    const host = await serve();
    let issued = 0;
    const { link: subject } = link(host.listener.url, () => {
      issued += 1;
      host.issue(`token-${issued}`);
      return `token-${issued}`;
    });
    await until(subject, "ready");
    const feed = stream(subject);
    await eventually(() => host.listeners.size === 1, "the stream to open");
    await host.append(1);
    await eventually(() => feed.ids.length === 1, "the first frame");
    host.revoke("token-1");
    const revoked = await until(subject, "unreachable");
    expect(revoked).toMatchObject({ closeCode: 4401, error: { reason: "credential-invalid" } });
    await until(subject, "ready");
    await eventually(() => host.listeners.size === 1, "the resumed stream");
    await host.append(1);
    await eventually(() => feed.ids.length === 2, "the next frame");
    expect(feed.ids).toStrictEqual(["1", "2"]);
    expect(feed.ends).toStrictEqual([]);
  });

  it("calls onResnapshot when the resume is past the replay bound", async () => {
    const host = await serve();
    host.issue("token");
    const { link: subject, drop } = link(host.listener.url, () => "token");
    await until(subject, "ready");
    const feed = stream(subject);
    await eventually(() => host.listeners.size === 1, "the stream to open");
    await host.append(1);
    await eventually(() => feed.ids.length === 1, "the first frame");
    drop();
    await until(subject, "unreachable");
    host.backfill(SUBSCRIPTION_REPLAY_BOUNDS.events + 1);
    await eventually(() => feed.ends.length === 1, "the resnapshot");
    expect(feed.ends[0]).toMatchObject({
      kind: "resnapshot",
      error: { code: "PRECONDITION_FAILED", reason: "subscription-resnapshot-required" },
    });
    expect(feed.ids).toStrictEqual(["1"]);
  });

  it("gives a typed client the router's procedures with the link's policy underneath", async () => {
    const host = await serve();
    host.issue("token");
    const { link: subject } = link(host.listener.url, () => "token");
    const client: TRPCClient<AppRouter> = createTRPCClient<AppRouter>({
      links: [hostLinkTrpcLink<AppRouter>(subject)],
    });
    expect(
      readHostError(
        await client.session.projection.query({ sessionId: SESSION }).catch((error) => error),
      ),
    ).toMatchObject({ reason: "host-unreachable" });
    await until(subject, "ready");
    const answer = await client.session.projection.query({ sessionId: SESSION });
    expect(answer.projection.session.id).toBe(SESSION);
  });
});
