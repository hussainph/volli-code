/**
 * Agent verbs against the real pinned backend: a runner linked the real way
 * mints a real Agent token (signed in an action, verified by the deployment's
 * auth config), and host-core's cloud board verbs (the runner's side, over
 * Convex's HTTP functions API) write the board as the agent Actor. A claim
 * moved to another runner ends the token at once.
 */
import { randomUUID } from "node:crypto";

import { ConvexHttpClient } from "convex/browser";
import { describe, expect, test } from "vite-plus/test";

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
import { connectBackend } from "../fixture/testing";
import { wire, writeSession } from "./sessionFixtures";

const backend = connectBackend();
const linkClient = createRunnerLinkClient({ siteUrl: backend.siteUrl });

async function linkRunner(person: ConvexHttpClient) {
  const { installToken } = await person.action(api.runners.createInstallToken, {
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
  const link = await linkWithInstallToken({
    client: linkClient,
    store,
    host: runnerHostFacts("user"),
    installToken,
  });
  const tokens = createRunnerTokenSource({ client: linkClient, store });
  const token = await tokens.token();
  if (token === null) throw new Error("no runner token");
  const client = new ConvexHttpClient(backend.url);
  client.setAuth(token);
  return { id: link.runnerId, client, tokens };
}

function request(cmd: AgentCommand, args: Record<string, unknown>): AgentRequest {
  return { v: 1, cmd, args, ctx: { cwd: "/work", env: {} } };
}

describe("agent verbs through the runner", () => {
  test("a cloud Session's agent writes the board as itself, until its claim moves", async () => {
    const email = `agent-verbs-${randomUUID()}@example.test`;
    await backend.admin(internal.previewAccess.set, { kind: "email", value: email, enabled: true });
    const person = backend.client(`user:${randomUUID()}`, {
      claims: { email, email_verified: true },
    });
    const { userId } = await person.mutation(api.accounts.ensureViewer, {
      acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
    });
    const [workspace] = await person.query(api.workspaces.listMine, {});
    const projectId = randomUUID();
    await person.mutation(api.projects.create, {
      commandId: randomUUID(),
      workspaceId: workspace!.workspaceId,
      projectId,
      name: "Agent verbs",
      origin: "blank",
      ticketPrefix: "AV",
    });
    const runner = await linkRunner(person);
    const next = await linkRunner(person);

    // The Session reaches the backend the way the drain sends it.
    const { sessionId, events } = await writeSession({ projectId });
    await runner.client.mutation(api.sessions.accept, {
      sessionId,
      generation: 1,
      events: events.map(wire),
    });

    const agentBackend = createAgentBackend({
      functions: createCloudFunctionsClient({ url: backend.url }),
      runnerToken: () => runner.tokens.token(),
      connected: () => true,
    });
    const verbs = createCloudBoardVerbs({ backend: agentBackend, runnerName: "test-runner" });

    const created = await verbs["board.createTicket"]({
      sessionId,
      request: request("ticket.create", { title: "Found by the agent", status: "todo" }),
    });
    expect(created).toMatchObject({
      ok: true,
      data: { ticket: { id: "AV-1", title: "Found by the agent", status: "todo" } },
    });
    await expect(
      verbs["ticket.move"]({
        sessionId,
        request: request("ticket.move", { id: "AV-1", to: "doing" }),
      }),
    ).resolves.toMatchObject({ ok: true, data: { ticket: { status: "doing" } } });
    await expect(
      verbs["board.createComment"]({
        sessionId,
        request: request("ticket.comment", { id: "AV-1", message: "On it." }),
      }),
    ).resolves.toMatchObject({ ok: true });

    // The person sees the agent's work, attributed to it.
    const { ticketId } = await person.query(api.board.resolveTicketKey, { key: "AV-1" });
    const history = await person.query(api.board.ticketEvents, { ticketId });
    expect(history.map((event) => [event.kind, event.actor])).toEqual([
      ["created", { kind: "agent", userId, sessionId, ticketId: null }],
      ["status_changed", { kind: "agent", userId, sessionId, ticketId: null }],
      ["commented", { kind: "agent", userId, sessionId, ticketId: null }],
    ]);
    await expect(
      verbs["ticket.show"]({ sessionId, request: request("ticket.show", { id: "AV-1" }) }),
    ).resolves.toMatchObject({
      ok: true,
      data: { comments: [{ body: "On it.", actor: "session" }] },
    });

    // A runner token is not an agent's, and neither is a person.
    await expect(runner.client.query(api.board.roster, { projectId })).rejects.toMatchObject({
      data: { code: "not_a_person" },
    });

    // A clean handoff to the other runner: the agent token minted here is fenced.
    await backend.admin(internal.sessions.transferClaim, {
      sessionId,
      toRunnerId: next.id,
      headSequence: events.length,
    });
    await expect(verbs.board({ sessionId, request: request("board", {}) })).resolves.toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN_ACTOR" },
    });
    // And this runner cannot mint another for it.
    await expect(runner.client.action(api.agentTokens.mint, { sessionId })).rejects.toMatchObject({
      data: { code: "not_claimed" },
    });
    await expect(next.client.action(api.agentTokens.mint, { sessionId })).resolves.toMatchObject({
      token: expect.any(String),
    });
  });
});
