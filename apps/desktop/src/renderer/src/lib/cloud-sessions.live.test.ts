/**
 * The cloud Session view through the real transport (VC-931): a runner and
 * two windows of its owner, each a real Convex React client on the pinned
 * local backend. No Electron, no IPC.
 *
 * - **Window A is the claimed runner**, signed in with a real runner token
 *   (an install token, the rotated credential, the backend-signed token). It
 *   accepts the Session's facts, written by the real Session Engine, through
 *   `sessions.accept`; it watches `sessionViewers.watched` and streams chunk
 *   rows (`streamChunks.append`) only while that names the Session; then it
 *   stages the settled message's body, accepts the `transcript.referenced`
 *   fact that settles it and calls `streamChunks.settle`.
 * - **Window B is the person's window**, through this window's own glue: the
 *   app's `cloudChatTransport` under a `ChatSessionClient` and a
 *   `createSurfaceStore` store, and a `CloudSessionSource` for the listing.
 *   It must show the streamed text live, then the settled message exactly
 *   once, and open (then close) the viewer that gates the stream.
 * - **Window C is a second window of the same person**, with its own
 *   `CloudSessionSource`: both listings follow the runner's facts.
 *
 * Runs only under the fixture, which hands it the backend's URLs and the test
 * issuer's key. It needs no admin key: every row it seeds goes through public
 * functions. CI's `Convex (codegen + backend)` lane is meant to run it with
 * `VOLLI_CLOUD_SESSION_LIVE_REQUIRED=1` (it then fails rather than skips);
 * it skips everywhere else, the desktop lanes included.
 *
 *   pnpm -C convex with-backend --deploy -- \
 *     sh -c 'cd ../apps/desktop && vp test run src/renderer/src/lib/cloud-sessions.live.test.ts'
 */
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ConvexHttpClient } from "convex/browser";
import { ConvexReactClient } from "convex/react";
import { api } from "@volli/convex/api";
import {
  createRunnerLinkClient,
  createRunnerTokenSource,
  linkWithInstallToken,
  runnerHostFacts,
  type RunnerLink,
  type RunnerLinkStore,
} from "@volli/host-core/cloud-runner";
import {
  canonicalJson,
  createSessionEngine,
  TRANSCRIPT_ARTIFACT_MEDIA_TYPE,
  type SessionTranscriptArtifact,
} from "@volli/session-engine";
import { createInMemorySessionLedger } from "@volli/session-engine/testing";
import { ChatSessionClient, createSurfaceStore, type FlushHost } from "@volli/session-presentation";
import type {
  SessionAttachment,
  SessionEventProvenance,
  SessionListingRow,
  TranscriptReference,
} from "@volli/shared";
import type { UIMessage } from "ai";

import { DEV_AUDIENCE, DEV_ISSUER, DEV_KEY_ID } from "../../../main/account/dev-issuer";
import { signEs256Jwt } from "../../../main/account/jwt";
import type { CloudSession } from "./cloud-client";
import { CloudSessionSource } from "./cloud-session-source";
import { cloudChatTransport } from "./cloud-session-transport";

const url = process.env["VOLLI_CONVEX_URL"];
const siteUrl = process.env["VOLLI_CONVEX_SITE_URL"];
const privateKeyPem = process.env["VOLLI_CONVEX_TEST_PRIVATE_KEY"];
const fixture = url !== undefined && siteUrl !== undefined && privateKeyPem !== undefined;

// CI's Convex lane sets this: there the test must run, never skip.
if (process.env["VOLLI_CLOUD_SESSION_LIVE_REQUIRED"] === "1" && !fixture) {
  throw new Error(
    "The live cloud Session test needs the fixture: run it under `with-backend --deploy`.",
  );
}

const WAIT = { timeout: 15_000, interval: 50 };

function token(subject: string): string {
  const now = Math.floor(Date.now() / 1000);
  return signEs256Jwt(privateKeyPem!, DEV_KEY_ID, {
    iss: DEV_ISSUER,
    aud: DEV_AUDIENCE,
    sub: subject,
    iat: now,
    exp: now + 3600,
    name: "Live Dana",
    email: `${subject}@example.com`,
    email_verified: true,
  });
}

/** A window of the person: a real Convex React client over the platform's WebSocket. */
function personWindow(subject: string): ConvexReactClient {
  const client = new ConvexReactClient(url!, { unsavedChangesWarning: false });
  client.setAuth(async () => token(subject));
  return client;
}

/** A runner linked the real way, as its own Convex React client (window A). */
async function linkRunner(person: ConvexHttpClient) {
  const { installToken } = await person.action(api.runners.createInstallToken, {
    nameHint: "live-runner",
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
  const links = createRunnerLinkClient({ siteUrl: siteUrl! });
  const link = await linkWithInstallToken({
    client: links,
    store,
    host: runnerHostFacts("user"),
    installToken,
  });
  const tokens = createRunnerTokenSource({ client: links, store });
  const client = new ConvexReactClient(url!, { unsavedChangesWarning: false });
  client.setAuth(({ forceRefreshToken }) => tokens.token({ forceRefreshToken }));
  return { runnerId: link.runnerId, client };
}

/** One live query held open, its latest answer read on demand. */
function hold<T>(watch: { onUpdate(callback: () => void): () => void; localQueryResult(): T }) {
  const stop = watch.onUpdate(() => {});
  return { read: () => watch.localQueryResult(), stop };
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

/**
 * The runner's local ledger: the real Session Engine over an in-memory
 * ledger, whose new facts `ship` sends through `sessions.accept` as the
 * drain does (their JSON text, contiguous from the accepted head).
 */
function runnerLedger(
  runner: ConvexReactClient,
  sessionId: string,
): {
  engine: ReturnType<typeof createSessionEngine>;
  observe(fields: Record<string, unknown>): Promise<unknown>;
  ship(): Promise<number>;
} {
  let now = Date.now();
  const engine = createSessionEngine({
    ledger: createInMemorySessionLedger(),
    clock: { now: () => now++ },
    ids: { next: () => randomUUID() },
  });
  let accepted = 0;
  return {
    engine,
    observe: (fields) =>
      engine.observe({
        id: randomUUID(),
        sessionId,
        occurredAt: now++,
        provenance: adapterProvenance,
        ...fields,
      } as never),
    async ship() {
      const fresh = (await engine.listEvents({ sessionId })).filter(
        ({ sequence }) => sequence > accepted,
      );
      const reply = await runner.mutation(api.sessions.accept, {
        sessionId,
        generation: 1,
        events: fresh.map((event) => JSON.stringify(event)),
      });
      expect(reply).toMatchObject({ quarantined: 0, unknownKinds: 0 });
      accepted = reply.acceptedThrough;
      expect(accepted).toBe(fresh.at(-1)?.sequence ?? accepted);
      return accepted;
    },
  };
}

/** A frame callback for the chat core's pacing; Node has none, so a short timer stands in. */
const flushHost: FlushHost = {
  requestAnimationFrame: (callback) => setTimeout(callback, 16) as unknown as number,
  cancelAnimationFrame: (handle) =>
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
  setTimeout: (callback, ms) => setTimeout(callback, ms) as unknown as number,
  clearTimeout: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
};

function textOf(message: UIMessage): string {
  return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

describe.skipIf(!fixture)("the cloud Session view against the pinned local backend", () => {
  it("streams a runner's reply live to a watching window, settles it once, and keeps both listings current", async () => {
    const warn = vi.spyOn(console, "warn");
    const subject = `live-session-${randomUUID()}`;

    // Setup, as the person: their account, their Workspace, a project.
    const person = new ConvexHttpClient(url!);
    person.setAuth(token(subject));
    await person.mutation(api.accounts.ensureViewer, {});
    const [workspace] = await person.query(api.workspaces.listMine, {});
    const projectId = randomUUID();
    await person.mutation(api.projects.create, {
      commandId: randomUUID(),
      workspaceId: workspace!.workspaceId,
      projectId,
      name: "Live sessions",
      ticketPrefix: "LIVS",
      origin: "blank",
    });

    // Window A: the person's runner, and the one subscription it streams by.
    const runner = await linkRunner(person);
    cleanups.push(() => runner.client.close());
    const watched = hold(runner.client.watchQuery(api.sessionViewers.watched, {}));
    cleanups.push(watched.stop);

    // Windows B and C: the person's listings, each its own client and source.
    const macB = personWindow(subject);
    cleanups.push(() => macB.close());
    const macC = personWindow(subject);
    cleanups.push(() => macC.close());
    const sessionB: CloudSession = { client: macB, api };
    const sessionC: CloudSession = { client: macC, api };
    const listings = {
      B: new Map<string, SessionListingRow[]>(),
      C: new Map<string, SessionListingRow[]>(),
    };
    const listingFailed = vi.fn();
    const sourceB = new CloudSessionSource(
      sessionB,
      (id, rows) => void listings.B.set(id, rows),
      listingFailed,
    );
    const sourceC = new CloudSessionSource(
      sessionC,
      (id, rows) => void listings.C.set(id, rows),
      listingFailed,
    );
    cleanups.push(
      () => sourceB.closeAll(),
      () => sourceC.closeAll(),
    );
    await expect(sourceB.open(projectId)).resolves.toEqual([]);
    await expect(sourceC.open(projectId)).resolves.toEqual([]);

    // The runner's Session: created, attached, a turn started; accepted.
    const sessionId = randomUUID();
    const ledger = runnerLedger(runner.client, sessionId);
    await ledger.engine.createSession({
      commandId: randomUUID(),
      requestedSessionId: sessionId,
      projectId,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: "Streamed live",
      provenance: userProvenance,
    });
    const start = await ledger.engine.submit({
      commandId: randomUUID(),
      sessionId,
      intent: { kind: "executor.start", adapterId: "pi", continuity: "fresh" },
      provenance: userProvenance,
    });
    const attachment: SessionAttachment = {
      id: randomUUID(),
      sessionId,
      adapterId: "pi",
      venue,
      continuity: "fresh",
      native: { id: "native-1", detail: { file: "pi.jsonl" } },
      authority: null,
    };
    await ledger.observe({ kind: "attachment.opened", commandId: start.command.id, attachment });
    const turnId = randomUUID();
    await ledger.observe({ kind: "turn.started", attachmentId: attachment.id, turnId });
    const head = await ledger.ship();

    // Both listings show the Session working, from the backend's row.
    const rowIn = (listing: Map<string, SessionListingRow[]>) =>
      listing
        .get(projectId)
        ?.find((row) => row.kind === "chat" && row.record.sessionId === sessionId)?.record;
    for (const listing of [listings.B, listings.C]) {
      await vi.waitFor(
        () =>
          expect(rowIn(listing)).toMatchObject({
            title: "Streamed live",
            activity: "working",
            live: true,
          }),
        WAIT,
      );
    }

    // Nobody watches yet, so the runner streams nothing.
    await vi.waitFor(() => expect(watched.read()).toBeDefined(), WAIT);
    expect(watched.read()!.sessionIds).not.toContain(sessionId);

    // Window B opens the Session through the app's own cloud transport.
    // `cloudChatTransport` paces its folds on the window's frame callbacks.
    vi.stubGlobal("window", flushHost);
    const transport = cloudChatTransport(sessionB);
    vi.unstubAllGlobals();
    const store = createSurfaceStore();
    store.getState().seed(sessionId, "ready");
    const notices: string[] = [];
    const chat = new ChatSessionClient(sessionId, {
      ...transport,
      store,
      notify: (message) => void notices.push(message),
      renameSession: () => {},
    });
    let disposed = false;
    cleanups.push(() => {
      if (!disposed) chat.dispose();
    });
    await chat.connect();
    const slice = () => store.getState().sessions[sessionId]!;
    expect(slice().transcript.throughSequence).toBe(head);
    expect(slice().projection).toMatchObject({
      session: { id: sessionId, projectId },
      turnActive: true,
      liveExecutor: { id: attachment.id },
    });

    // Its viewer reaches the runner's subscription: now the runner streams.
    await vi.waitFor(() => expect(watched.read()?.sessionIds).toContain(sessionId), WAIT);

    const messageId = `reply-${randomUUID()}`;
    const shown = () => slice().transcript.messages.filter(({ id }) => id === messageId);
    const append = (seq: number, ops: object[], throughSequence = head) =>
      runner.client.mutation(api.streamChunks.append, {
        sessionId,
        messageId,
        turnId,
        seq,
        baseline: (ops[0] as { op: string }).op === "reset",
        throughSequence,
        ops: JSON.stringify(ops),
      });
    await expect(
      append(0, [
        {
          op: "reset",
          message: {
            id: messageId,
            role: "assistant",
            parts: [{ key: "text-0", part: { type: "text", text: "Hel" } }],
          },
        },
      ]),
    ).resolves.toEqual({ written: true });
    await vi.waitFor(() => expect(shown().map(textOf)).toEqual(["Hel"]), WAIT);
    await expect(
      append(1, [{ op: "part.append", key: "text-0", text: "lo, world" }]),
    ).resolves.toEqual({
      written: true,
    });
    await vi.waitFor(() => expect(shown().map(textOf)).toEqual(["Hello, world"]), WAIT);
    // Still transient: an overlay, nothing durable yet.
    expect(slice().transcript.overlay.has(messageId)).toBe(true);
    expect(slice().transcript.durableMessages).toEqual([]);

    // The message settles: its body staged by the runner's owner under the
    // claim, then the fact that references it accepted, then the settle.
    const settled: UIMessage = {
      id: messageId,
      role: "assistant",
      parts: [{ type: "text", text: "Hello, world." }],
    };
    const artifact: SessionTranscriptArtifact = {
      version: 1,
      threadId: randomUUID(),
      branchId: randomUUID(),
      attemptId: randomUUID(),
      turnId,
      message: settled,
    };
    const body = canonicalJson(artifact);
    const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    const reference: TranscriptReference = {
      id: digest,
      digest,
      mediaType: TRANSCRIPT_ARTIFACT_MEDIA_TYPE,
    };
    await person.mutation(api.transcripts.stageArtifacts, {
      sessionId,
      claim: { runnerId: runner.runnerId, generation: 1 },
      artifacts: [
        {
          digest,
          mediaType: TRANSCRIPT_ARTIFACT_MEDIA_TYPE,
          bytes: new TextEncoder().encode(body).length,
          body,
          spillKey: null,
          sequence: head + 1,
        },
      ],
    });
    await ledger.observe({
      kind: "transcript.referenced",
      attachmentId: attachment.id,
      turnId,
      reference,
      digest: { role: "assistant", reply: true },
    });
    const settledAt = await ledger.ship();
    expect(settledAt).toBe(head + 1);
    const settle = await runner.client.mutation(api.streamChunks.settle, {
      sessionId,
      messageId,
      sequence: settledAt,
    });
    expect(["deleted", "deleting"]).toContain(settle.state);

    // Window B shows the settled message once, in its durable words; the
    // overlay is gone, and the chunk rows go with the settle.
    await vi.waitFor(() => {
      expect(shown().map(textOf)).toEqual(["Hello, world."]);
      expect(slice().transcript.overlay.size).toBe(0);
      expect(slice().transcript.durableSequences.get(messageId)).toBe(settledAt);
    }, WAIT);
    expect(slice().transcript.messages.filter(({ role }) => role === "assistant")).toHaveLength(1);
    await vi.waitFor(async () => {
      await expect(
        person.query(api.streamChunks.since, { sessionId, cursors: [] }),
      ).resolves.toEqual({
        streams: [],
      });
      await expect(
        person.query(api.streamChunks.since, { sessionId, cursors: [{ messageId, seq: 0 }] }),
      ).resolves.toEqual({ streams: [] });
    }, WAIT);

    // A chunk emitted before the settle but arriving after it is stale: it
    // reaches window B's chunk query and changes nothing on screen.
    await expect(
      append(2, [{ op: "part.append", key: "text-0", text: " again" }]),
    ).resolves.toEqual({
      written: true,
    });
    await vi.waitFor(async () => {
      const late = await person.query(api.streamChunks.since, {
        sessionId,
        cursors: [{ messageId, seq: 1 }],
      });
      expect(late.streams.map(({ chunks }) => chunks.map(({ seq }) => seq))).toEqual([[2]]);
    }, WAIT);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(shown().map(textOf)).toEqual(["Hello, world."]);
    expect(slice().transcript.overlay.size).toBe(0);

    // Attention from the cloud store: both listings and window B's projection.
    const attentionId = `attention-${randomUUID()}`;
    await ledger.observe({
      kind: "attention.raised",
      attachmentId: attachment.id,
      attention: {
        id: attentionId,
        kind: "input_required",
        attachmentId: attachment.id,
        detail: "Which branch?",
        diagnostic: null,
      },
    });
    await ledger.ship();
    for (const listing of [listings.B, listings.C]) {
      await vi.waitFor(
        () => expect(rowIn(listing)).toMatchObject({ activity: "waiting", waitingOn: "question" }),
        WAIT,
      );
    }
    await vi.waitFor(
      () => expect(slice().projection?.attention.active.map(({ id }) => id)).toEqual([attentionId]),
      WAIT,
    );

    // The person answers elsewhere; the turn ends. Everything settles back.
    await ledger.observe({ kind: "attention.cleared", attachmentId: attachment.id, attentionId });
    await ledger.observe({ kind: "turn.completed", attachmentId: attachment.id, turnId });
    const end = await ledger.ship();
    for (const listing of [listings.B, listings.C]) {
      await vi.waitFor(
        () =>
          expect(rowIn(listing)).toMatchObject({
            activity: "idle",
            live: false,
            outcome: "completed",
          }),
        WAIT,
      );
    }
    await vi.waitFor(() => {
      expect(slice().transcript.throughSequence).toBe(end);
      expect(slice().transcript.turnActive).toBe(false);
      expect(slice().projection?.attention.active).toEqual([]);
    }, WAIT);
    expect(shown().map(textOf)).toEqual(["Hello, world."]);
    expect(listings.B.get(projectId)).toHaveLength(1);
    expect(listings.C.get(projectId)).toHaveLength(1);

    // Window B lets go: its viewer closes, and the runner stops streaming.
    chat.dispose();
    disposed = true;
    await vi.waitFor(() => expect(watched.read()?.sessionIds).not.toContain(sessionId), WAIT);

    expect(slice().sessionError).toBeNull();
    expect(notices).toEqual([]);
    expect(listingFailed).not.toHaveBeenCalled();
    expect(
      warn.mock.calls.filter(([message]) => String(message).startsWith("[cloud-session]")),
    ).toEqual([]);
  }, 120_000);
});
