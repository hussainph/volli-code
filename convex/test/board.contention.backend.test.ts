/**
 * Board writes under a burst, on the pinned local backend: 32 writers at once
 * against one project, four times the burst `board.backend.test.ts` uses.
 *
 * Every board write in a project reads and writes the project's counter (the
 * next ticket number and the event `seq`), so they serialize by design:
 * numbers stay contiguous and the history stays a gapless total order. A
 * burst that size outruns the backend's own optimistic-concurrency retries
 * (a few attempts in about a second), and how each client transport answers
 * that is the product's policy, proven here through the real transports:
 *
 * - a desktop window (WebSocket): the client closes the socket (1013),
 *   reconnects and resends the same command;
 * - a runner, for its agents' verbs (HTTP): the backend answers 503 with a
 *   typed body, read as contention (nothing applied), and the runner sends
 *   the same arguments again on a jittered, bounded schedule inside the
 *   verb's deadline (`agent-backend.ts`), answering `BUSY` only past it.
 *
 * Only contention is retried: the last test sends the burst with no retry at
 * all and proves that every write refused under it was contention, and that
 * none of them left anything behind.
 */
import { randomUUID } from "node:crypto";

import { ConvexHttpClient, type ConvexClient } from "convex/browser";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import {
  createAgentBackend,
  createCloudBoardVerbs,
  createCloudFunctionsClient,
  createRunnerLinkClient,
  createRunnerTokenSource,
  linkWithInstallToken,
  runnerHostFacts,
  type RunnerLink,
  type RunnerLinkStore,
} from "@volli/host-core/cloud-runner";
import type { AgentCommand, AgentRequest } from "@volli/shared";
import { PREVIEW_ENROLLMENT_AGREEMENT_VERSION } from "@volli/shared/cloud";

import { api, internal } from "../functions/_generated/api";
import { concurrently, connectBackend } from "../fixture/testing";
import { wire, writeSession } from "./sessionFixtures";
import { CloudContentionError } from "../../packages/host-core/src/cloud-agent/functions-client";

const backend = connectBackend();
const uuid = () => randomUUID();

/** Writers in one burst (`VOLLI_TEST_BOARD_BURST` raises it to reproduce contention harder). */
const BURST = Number(process.env["VOLLI_TEST_BOARD_BURST"] ?? 32);

const email = `board-contention-${uuid()}@example.test`;
const subject = `user:${uuid()}`;
const claims = { email, email_verified: true };
const person = () => backend.client(subject, { claims });
const windows: ConvexClient[] = [];
let projectId: string;

async function newProject(name: string, ticketPrefix: string): Promise<string> {
  const [workspace] = await person().query(api.workspaces.listMine, {});
  const id = uuid();
  await person().mutation(api.projects.create, {
    commandId: uuid(),
    workspaceId: workspace!.workspaceId,
    projectId: id,
    name,
    origin: "blank",
    ticketPrefix,
  });
  return id;
}

async function column(project: string, status: string) {
  const { tickets } = await person().query(api.board.roster, { projectId: project });
  return tickets
    .filter((ticket) => ticket.status === status)
    .toSorted((a, b) => (a.position < b.position ? -1 : 1));
}

function agentRequest(cmd: AgentCommand, args: Record<string, unknown> = {}): AgentRequest {
  return { v: 1, cmd, args, ctx: { cwd: "/work", env: {} } };
}

const contiguous = (numbers: readonly number[]) => {
  const sorted = numbers.toSorted((a, b) => a - b);
  return Array.from({ length: sorted.length }, (_, index) => sorted[0]! + index);
};

beforeAll(async () => {
  await backend.admin(internal.previewAccess.set, { kind: "email", value: email, enabled: true });
  await person().mutation(api.accounts.ensureViewer, {
    acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
  });
  projectId = await newProject("Board contention", "BC");
  for (let index = 0; index < BURST; index++) windows.push(backend.socket(subject, { claims }));
}, 120_000);

afterAll(async () => {
  await Promise.all(windows.map((window) => window.close()));
});

describe("a burst of board writes to one project", () => {
  test("a burst of windows creates at once: every ticket lands, numbers contiguous, keys distinct", async () => {
    const replies = await concurrently(
      windows.map(
        (window, index) => () =>
          window.mutation(api.board.createTicket, {
            commandId: uuid(),
            projectId,
            ticketId: uuid(),
            status: "backlog",
            title: `Burst ${index}`,
          }),
      ),
    );
    const numbers = replies.map((reply) => reply.number);
    expect(numbers.toSorted((a, b) => a - b)).toEqual(contiguous(numbers));
    expect(replies.every((reply) => !reply.receipt.replayed)).toBe(true);
    const backlog = await column(projectId, "backlog");
    expect(backlog).toHaveLength(BURST);
    expect(new Set(backlog.map((ticket) => ticket.position)).size).toBe(BURST);
  }, 120_000);

  test("a burst of windows moves into one gap at once: all land in it, each with its own key", async () => {
    const after = uuid();
    const before = uuid();
    for (const [ticketId, title] of [
      [after, "After"],
      [before, "Before"],
    ] as const) {
      await person().mutation(api.board.createTicket, {
        commandId: uuid(),
        projectId,
        ticketId,
        status: "doing",
        title,
      });
    }
    const movers = (await column(projectId, "backlog")).map((ticket) => ticket.id);
    expect(movers).toHaveLength(BURST);
    await concurrently(
      movers.map(
        (ticketId, index) => () =>
          windows[index]!.mutation(api.board.moveTickets, {
            commandId: uuid(),
            projectId,
            ticketIds: [ticketId],
            toStatus: "doing",
            afterTicketId: after,
            beforeTicketId: before,
          }),
      ),
    );
    const doing = await column(projectId, "doing");
    const ids = doing.map((ticket) => ticket.id);
    expect(ids[0]).toBe(after);
    expect(ids.at(-1)).toBe(before);
    expect(new Set(ids.slice(1, -1))).toEqual(new Set(movers));
    expect(new Set(doing.map((ticket) => ticket.position)).size).toBe(doing.length);

    // The history stayed a gapless total order through both bursts: the
    // creates, 2 anchors and the moves, nothing else in this project.
    const events = await concurrently(
      ids.map((ticketId) => () => person().query(api.board.ticketEvents, { ticketId })),
    );
    const seqs = events.flat().map((event) => event.seq);
    expect(seqs).toHaveLength(BURST * 2 + 2);
    expect(seqs.toSorted((a, b) => a - b)).toEqual(contiguous(seqs));
  }, 120_000);

  test("a burst of agent verbs creates at once through one runner: every one answers ok, numbers contiguous", async () => {
    const agentProject = await newProject("Agent burst", "AB");
    const linkClient = createRunnerLinkClient({ siteUrl: backend.siteUrl });
    const { installToken } = await person().action(api.runners.createInstallToken, {
      nameHint: null,
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
    await linkWithInstallToken({
      client: linkClient,
      store,
      host: runnerHostFacts("user"),
      installToken,
    });
    const tokens = createRunnerTokenSource({ client: linkClient, store });
    const runnerToken = await tokens.token();
    if (runnerToken === null) throw new Error("no runner token");
    const runner = new ConvexHttpClient(backend.url);
    runner.setAuth(runnerToken);
    // The Session reaches the backend the way the drain sends it.
    const { sessionId, events } = await writeSession({ projectId: agentProject });
    await runner.mutation(api.sessions.accept, {
      sessionId,
      generation: 1,
      events: events.map(wire),
    });
    // The real HTTP client, counting what the backend answered with contention.
    const http = createCloudFunctionsClient({ url: backend.url });
    let contended = 0;
    const functions: typeof http = {
      call: (...call) =>
        http.call(...call).catch((error: unknown) => {
          if (error instanceof CloudContentionError) contended += 1;
          throw error;
        }),
    };
    const verbs = createCloudBoardVerbs({
      backend: createAgentBackend({
        functions,
        runnerToken: () => tokens.token(),
        connected: () => true,
      }),
      runnerName: "test-runner",
    });
    // The Agent token is minted once, before the burst, as a running Session's is.
    await verbs.board({ sessionId, request: agentRequest("board") });
    const answers = await concurrently(
      Array.from(
        { length: BURST },
        (_, index) => () =>
          verbs["board.createTicket"]({
            sessionId,
            request: agentRequest("ticket.create", {
              title: `Agent burst ${index}`,
              status: "backlog",
            }),
          }),
      ),
    );
    // Retained evidence in the run's log: how often the runner's retry was needed.
    console.info(
      `board contention: the runner resent ${contended} agent writes that lost every backend retry`,
    );
    const refused = answers.filter((answer) => !answer.ok);
    expect(refused).toEqual([]);
    const numbers = answers.map((answer) =>
      Number(
        ((answer as { data: { ticket: { id: string } } }).data.ticket.id as string).split("-")[1],
      ),
    );
    expect(numbers.toSorted((a, b) => a - b)).toEqual(contiguous(numbers));
    const backlog = await column(agentProject, "backlog");
    expect(backlog).toHaveLength(BURST);
    expect(new Set(backlog.map((ticket) => ticket.position)).size).toBe(BURST);
  }, 120_000);

  test("with no retry at all, every write the burst refused was contention, and it left nothing behind", async () => {
    const rawProject = await newProject("Raw burst", "RB");
    const functions = createCloudFunctionsClient({ url: backend.url });
    const token = backend.token(subject, { claims });
    const ticketIds = Array.from({ length: BURST }, () => uuid());
    const results = await Promise.allSettled(
      ticketIds.map((ticketId, index) =>
        functions.call(
          "mutation",
          "board:createTicket",
          {
            commandId: uuid(),
            projectId: rawProject,
            ticketId,
            status: "todo",
            title: `Raw ${index}`,
          },
          token,
        ),
      ),
    );
    const refusedIds = ticketIds.filter((_, index) => results[index]!.status === "rejected");
    // Retained evidence in the run's log: how many lost every backend retry.
    console.info(
      `board contention: ${refusedIds.length}/${BURST} raw HTTP creates lost every backend retry`,
    );
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toBeInstanceOf(CloudContentionError);
    }
    const landed = results.flatMap((result) =>
      result.status === "fulfilled" ? [(result.value as { number: number }).number] : [],
    );
    // What landed is still contiguous from the project's first number: a
    // refused write took no number.
    expect(landed.toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: landed.length }, (_, index) => index + 1),
    );
    const todo = await column(rawProject, "todo");
    expect(todo).toHaveLength(BURST - refusedIds.length);
    const present = new Set(todo.map((ticket) => ticket.id));
    for (const ticketId of refusedIds) expect(present.has(ticketId)).toBe(false);
  }, 120_000);
});
