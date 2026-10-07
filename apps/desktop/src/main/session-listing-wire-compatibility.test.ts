// @vitest-environment node
/**
 * The Session listing (VC-713, feature `sessions.listing`): committed
 * public-wire recordings, VC-669's ceremony for a newly public feature (HP §
 * N−1 public wire recordings).
 *
 * - `session-listing-wire-fixtures/current.json` pins what today's host
 *   answers for `session.listing` and `session.listingForTicket`: a
 *   Workspace's rows (a Session waiting on a question, an idle chat with its
 *   model and an Automation's provenance, a terminal companion), one ticket's
 *   rows, a ticket from another Workspace refused, and what an older Client is
 *   granted. It is recorded through the real production listener and the stock
 *   tRPC WebSocket client, from host-core's real handler map over a test
 *   database, never written by hand or read back into the host.
 * - `session-listing-wire-fixtures/n-minus-one.json` is frozen: a
 *   representative pre-feature peer (main before VC-713, not a shipped
 *   release), which offers no `sessions.listing`: its hostd's offer as it
 *   stood, every feature that build knew as the old Client's request, and
 *   what VC-669's frozen, reconstructed router
 *   (`session-rpc-n-minus-one.test-support.ts`) answers a call to an
 *   operation it never had. The old peer's welcome below is synthesized from
 *   that offer, not recorded.
 *
 * Both skew directions run: a new Client against the old host reads no
 * `sessions.listing` off its welcome and keeps the listing it has; an old
 * Client against today's host is granted no listing and is refused before any
 * input is read. The listing is WebSocket-only (the window keeps its own
 * `volli:session-list`), so there is no IPC leg.
 *
 * Refresh `current.json` with `VOLLI_RECORD_SESSION_LISTING_WIRE=1` and review
 * the diff; never refresh `n-minus-one.json` to make a change pass.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { createTRPCClient, createWSClient, getUntypedClient, wsLink } from "@trpc/client";
import { boardResourceWorkspace } from "@volli/host-core/board";
import { insertProject, insertTicket } from "@volli/host-core/db";
import { admittedHandlers, createHostHandlers, ROUTER_POLICY } from "@volli/host-core/handlers";
import {
  createTestSessionEngine,
  insertSession,
  openTestDb,
  testProject,
  testSession,
  testTicket,
} from "@volli/host-core/testing";
import {
  buildHostHello,
  encodeHostHello,
  readHostError,
  validateWelcome,
  type HostHello,
  type HostWelcome,
} from "@volli/host-protocol";
import { webSocketContractLink } from "@volli/host-protocol/testing";
import {
  createHostRouter,
  HostProcedureError,
  RpcDiagnosticLog,
  sessionProcedureSchemas,
  type HostRouter,
} from "@volli/session-rpc";
import { startHostProtocolListener } from "@volli/session-rpc/websocket";
import {
  EMPTY_SESSION_USAGE_SUMMARY,
  type SessionAttachmentProjection,
  type SessionProjection,
} from "@volli/shared";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createOldSessionRouter, loadCanaryPeer } from "./session-rpc-n-minus-one.test-support";

import {
  captureCanaryRecording,
  checkNextHost,
  recordingExchanges,
  replayCanaryPeer,
  peerInput,
} from "../../../../packages/session-rpc/src/canary-peer.test-support";
const canary = process.env.VOLLI_CANARY_CAPTURE_DIR ? null : loadCanaryPeer();

const CURRENT = new URL("./session-listing-wire-fixtures/current.json", import.meta.url);
const N_MINUS_ONE = new URL("./session-listing-wire-fixtures/n-minus-one.json", import.meta.url);
const RECORD = process.env["VOLLI_RECORD_SESSION_LISTING_WIRE"] === "1";

const WORKSPACE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const OTHER_WORKSPACE = "0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
const HOST_ID = "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b";
const TICKET = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const FOREIGN_TICKET = "f0e1d2c3-b4a5-4968-8776-655443322110";
const DEVICE = {
  kind: "device" as const,
  deviceId: "8a9b0c1d-2e3f-4a5b-9c6d-7e8f9a0b1c2d",
  workspaceId: WORKSPACE,
};
/** What today's hostd offers, and what today's desktop asks for. */
const OFFERED = [
  "sessions",
  "sessions.queue",
  "sessions.subscribe",
  "sessions.history",
  "session.read",
  "board.read",
  "board.write",
  "sign-ins",
  "auth.callback",
  "sessions.listing",
] as const;
const REQUESTED = OFFERED;

interface Recording {
  readonly procedure: string;
  readonly input: unknown;
  readonly output: unknown;
}

interface CurrentWire {
  readonly provenance: Record<string, unknown>;
  readonly welcome: { requested: readonly string[]; granted: readonly string[] };
  readonly listing: Recording;
  readonly listingForTicket: Recording;
  readonly refusal: Recording;
  readonly oldClient: {
    requested: readonly string[];
    granted: readonly string[];
    refusal: Recording;
  };
}

interface FrozenWire {
  readonly provenance: Record<string, unknown>;
  readonly hostOffered: readonly string[];
  readonly clientRequested: readonly string[];
  readonly unknownOperation: Recording;
}

function read<T>(url: URL): T {
  return JSON.parse(readFileSync(url, "utf8")) as T;
}

function structured(sessionId: string): SessionAttachmentProjection {
  return {
    id: `${sessionId}-attachment`,
    sessionId,
    adapterId: "pi",
    venue: { id: HOST_ID, kind: "remote" },
    continuity: "fresh",
    native: null,
    authority: null,
    status: "open",
    openedAt: 2,
    closedAt: null,
    outcome: null,
    failure: null,
    exitCode: null,
  };
}

function chat(
  id: string,
  ticketId: string | null,
  overrides: Partial<SessionProjection>,
): SessionProjection {
  return {
    session: {
      id,
      projectId: WORKSPACE,
      ticketId,
      role: ticketId === null ? "project" : "ticket",
      parentSessionId: null,
      title: `Session ${id.slice(0, 4)}`,
      createdAt: 1,
    },
    status: "open",
    commands: [],
    resumptions: [],
    latestTurnId: null,
    latestTurnOrigin: { kind: "user" },
    resumedAfterStop: false,
    receipts: [],
    pendingExecutorStart: null,
    attachments: [structured(id)],
    liveExecutor: null,
    attention: { active: [], primary: null },
    interactions: { active: [], resolved: [] },
    signal: null,
    stopped: null,
    turnActive: false,
    lastTurnOutcome: "completed",
    usage: EMPTY_SESSION_USAGE_SUMMARY,
    lastActivityAt: 10,
    bornTicketless: ticketId === null,
    modelSelection: null,
    modelTier: null,
    ...overrides,
  };
}

const WAITING = "c0ffee00-0000-4000-8000-000000000001";
const IDLE = "c0ffee00-0000-4000-8000-000000000002";

/** Deterministic: fixed projections for the chats, a real ledger row for the terminal. */
function deterministicHost() {
  const db = openTestDb();
  insertProject(db.db, testProject({ id: WORKSPACE, ticketPrefix: "VC" }));
  insertProject(db.db, testProject({ id: OTHER_WORKSPACE, ticketPrefix: "OT" }));
  insertTicket(db.db, testTicket(WORKSPACE, { id: TICKET, ticketNumber: 7 }));
  insertTicket(db.db, testTicket(OTHER_WORKSPACE, { id: FOREIGN_TICKET, ticketNumber: 1 }));
  insertSession(
    db.db,
    testSession(WORKSPACE, null, {
      id: "c0ffee00-0000-4000-8000-000000000003",
      title: "Terminal companion",
      createdAt: 3,
    }),
  );
  const engine = createTestSessionEngine(db.db, { now: () => 5 });
  const chats: SessionProjection[] = [
    chat(WAITING, TICKET, {
      turnActive: true,
      lastTurnOutcome: null,
      lastActivityAt: 30,
      interactions: {
        active: [
          {
            id: "interaction-1",
            attachmentId: `${WAITING}-attachment`,
            kind: "question",
            title: "Which branch should I push?",
            detail: null,
            options: [],
            multiple: false,
            native: { id: null, detail: null },
          },
        ],
        resolved: [],
      },
    }),
    chat(IDLE, null, {
      modelSelection: { providerId: "anthropic", modelId: "model-a", reasoningLevel: "high" },
    }),
  ];
  const handlers = admittedHandlers(
    createHostHandlers({ events: { publish() {} }, attention: { deliver: () => ({}) } } as never, {
      db: db.db,
      dataDir: "",
      runtime: null,
      sessions: null,
      modelAccess: null,
      experiments: null,
      automations: { kind: "degraded" } as never,
      busyWorktreeSites: async () => [],
      sessionListing: {
        db: db.db,
        listSessions: async (query) => [
          ...chats.filter(
            (projection) =>
              query.scope !== "ticket" || projection.session.ticketId === query.ticketId,
          ),
          ...(await engine.listSessions(query)),
        ],
        // The waiting Session's executor is bound on the host right now.
        liveAttachmentIds: () => new Set([`${WAITING}-attachment`]),
      },
    }),
    ROUTER_POLICY,
  );
  return { handlers, resourceWorkspace: boardResourceWorkspace(db.db), cleanup: db.cleanup };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** Today's host behind the production listener, and a stock client saying `features`. */
async function todaysHost(features: readonly string[]) {
  const host = deterministicHost();
  cleanups.push(host.cleanup);
  const listener = await startHostProtocolListener({
    router: createHostRouter(),
    bind: { host: "127.0.0.1", port: 0 },
    host: { id: HOST_ID, version: "wire-recording" },
    workspace: () => ({ id: WORKSPACE, epoch: 1 }),
    verifier: { verify: async () => ({ actor: DEVICE, current: () => true }) },
    features: OFFERED,
    context: () => ({
      handlers: host.handlers,
      diagnostics: new RpcDiagnosticLog(),
      resourceWorkspace: (resource) => host.resourceWorkspace(resource),
    }),
  });
  const hello = buildHostHello({
    client: { kind: "desktop", version: "wire-recording" },
    workspaceId: WORKSPACE,
    lastSeen: null,
    features,
    credential: "test-only-credential",
  });
  const socket = createWSClient({ url: listener.url, connectionParams: encodeHostHello(hello) });
  const client = createTRPCClient<HostRouter>({ links: [wsLink({ client: socket })] });
  cleanups.push(async () => {
    await socket.close();
    await listener.close();
  });
  return { client, raw: getUntypedClient(client) };
}

async function refusalOf(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    return readHostError(error);
  }
  throw new Error("expected a refusal");
}

function N_MINUS_ONE_CLIENT_REQUEST(): readonly string[] {
  return read<FrozenWire>(N_MINUS_ONE).clientRequested;
}

/** Records what today's host answers, through the real listener and client. */
async function recordCurrent(): Promise<Omit<CurrentWire, "provenance">> {
  const host = await todaysHost(REQUESTED);
  const welcome = await host.client.protocol.welcome.query();
  const listingInput = peerInput(canary, "listing-websocket", "session.listing", {
    projectId: WORKSPACE,
  });
  const ticketInput = peerInput(canary, "listing-websocket", "session.listingForTicket", {
    ticketId: TICKET,
  });
  const refusalInput = peerInput(
    canary,
    "listing-websocket",
    "session.listingForTicket",
    { ticketId: FOREIGN_TICKET },
    1,
  );
  const old = await todaysHost(N_MINUS_ONE_CLIENT_REQUEST());
  return {
    welcome: { requested: REQUESTED, granted: welcome.features },
    listing: {
      procedure: "session.listing",
      input: listingInput,
      output: await host.client.session.listing.query(listingInput),
    },
    listingForTicket: {
      procedure: "session.listingForTicket",
      input: ticketInput,
      output: await host.client.session.listingForTicket.query(ticketInput),
    },
    refusal: {
      procedure: "session.listingForTicket",
      input: refusalInput,
      output: await refusalOf(host.client.session.listingForTicket.query(refusalInput)),
    },
    oldClient: {
      requested: N_MINUS_ONE_CLIENT_REQUEST(),
      granted: (await old.client.protocol.welcome.query()).features,
      refusal: {
        procedure: "session.listing",
        input: listingInput,
        output: await refusalOf(old.raw.query("session.listing", listingInput)),
      },
    },
  };
}

describe("the Session listing on the public wire (VC-713)", () => {
  it("today's host answers exactly the committed recordings", async () => {
    const recorded = await recordCurrent();
    const exchanges = recordingExchanges(recorded);
    captureCanaryRecording("listing-websocket", "websocket", recorded, exchanges);
    if (canary) checkNextHost(canary, "listing-websocket", recorded);
    if (RECORD) {
      const provenance = read<CurrentWire>(CURRENT).provenance;
      writeFileSync(CURRENT, `${JSON.stringify({ provenance, ...recorded }, null, 2)}\n`);
    }
    const { provenance: _provenance, ...committed } = read<CurrentWire>(CURRENT);
    expect(recorded).toEqual(committed);
  });

  it("every recorded answer parses with today's published schemas, and says who is waiting", () => {
    const wire = read<CurrentWire>(CURRENT);
    const schemas = sessionProcedureSchemas();
    for (const recording of [wire.listing, wire.listingForTicket]) {
      expect(schemas[recording.procedure]!.input.safeParse(recording.input).success).toBe(true);
      expect(schemas[recording.procedure]!.output.safeParse(recording.output).success).toBe(true);
    }
    // A reopened Client reads the question off the row, full id and all.
    expect(wire.listing.output).toMatchObject({
      omitted: 0,
      sessions: expect.arrayContaining([
        expect.objectContaining({
          kind: "chat",
          record: expect.objectContaining({
            sessionId: WAITING,
            activity: "waiting",
            waitingOn: "question",
            live: true,
          }),
        }),
        expect.objectContaining({ kind: "terminal" }),
      ]),
    });
    expect(wire.refusal.output).toMatchObject({ code: "NOT_FOUND", reason: "workspace-unknown" });
  });

  it.runIf(!canary)(
    "a new Client keeps its listing for the older host, which never had this one",
    async () => {
      const frozen = read<FrozenWire>(N_MINUS_ONE);
      const hello: HostHello = buildHostHello({
        client: { kind: "desktop", version: "new" },
        workspaceId: WORKSPACE,
        lastSeen: null,
        features: REQUESTED,
        credential: "test-only-credential",
      });
      const welcome: HostWelcome = {
        protocolVersion: 1,
        host: { id: HOST_ID, version: "n-minus-one" },
        workspace: { id: WORKSPACE, epoch: 1 },
        actor: DEVICE,
        features: REQUESTED.filter((feature) => frozen.hostOffered.includes(feature)),
        proof: null,
      };
      expect(validateWelcome(welcome, hello, {})).toMatchObject({ ok: true });
      expect(welcome.features).not.toContain("sessions.listing");
      // A call anyway reaches the frozen peer's router, which has no such operation.
      const frozenHost = webSocketContractLink<null, HostRouter>({
        router: createOldSessionRouter(HostProcedureError) as unknown as HostRouter,
        createContext: () => ({}) as never,
      });
      const connection = await frozenHost.open(null);
      try {
        const answer = await refusalOf(
          getUntypedClient(connection.client).query("session.listing", { projectId: WORKSPACE }),
        );
        expect({
          procedure: "session.listing",
          input: { projectId: WORKSPACE },
          output: answer,
        }).toEqual(frozen.unknownOperation);
      } finally {
        await connection.close();
      }
    },
  );

  it.runIf(!canary)(
    "an older Client is granted no listing by today's host, and is refused before input",
    () => {
      const wire = read<CurrentWire>(CURRENT);
      expect(wire.oldClient.granted).not.toContain("sessions.listing");
      expect(wire.oldClient.refusal.output).toMatchObject({
        code: "FORBIDDEN",
        reason: "verb-refused",
      });
    },
  );
});

it.runIf(!!canary)(
  "next Client reads the actual canary listing over the WebSocket adapter",
  async () => {
    await replayCanaryPeer(canary!, "listing-websocket", sessionProcedureSchemas());
  },
);
