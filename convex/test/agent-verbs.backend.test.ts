/**
 * Agent verbs against the real pinned backend: a runner linked the real way
 * mints a real Agent token (signed in an action, verified by the deployment's
 * auth config), and host-core's cloud board verbs (the runner's side, over
 * Convex's HTTP functions API) write the board as the agent Actor. A claim
 * moved to another runner ends the token at once.
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
import { createCloudSessionVerbs } from "../../packages/host-core/src/cloud-agent/session-verbs";
import { createCloudWorktreeTickets } from "../../packages/host-core/src/cloud-agent/worktree-tickets";
import { createAgentCommandService } from "../../packages/host-core/src/agent-commands";
import { createRunnerPathRegistry } from "../../packages/host-core/src/cloud-store/paths";
import { insertProject } from "../../packages/host-core/src/db/projects-repo";
import { insertTicket } from "../../packages/host-core/src/db/tickets-repo";
import { openTestDb, testProject, testTicket } from "../../packages/host-core/src/db/test-helpers";
import { testHostHandlers } from "../../packages/host-core/src/testing/host-handlers";
import { createSessionTokenRegistry } from "../../packages/host-core/src/session-tokens";

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

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

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
    const { sessionId, events, engine } = await writeSession({ projectId });
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

    // A real remote Session, and the actual tool producer through the HTTP
    // functions API: its canonical body must pass the backend's own checker.
    const remote = await writeSession({ projectId });
    await next.client.mutation(api.sessions.accept, {
      sessionId: remote.sessionId,
      generation: 1,
      events: remote.events.map(wire),
    });
    const sessionVerbs = createCloudSessionVerbs({
      backend: agentBackend,
      engine,
      projectIds: () => [projectId],
      claimedHere: (id) => id === sessionId,
      notify: async () => ({ displayName: "unused" }),
    });
    const call = {
      verb: "session.send" as const,
      toolCallId: "remote-send-1",
      input: {
        session: remote.sessionId.slice(0, 8),
        message: "Owner direction: inspect the new command.",
      },
    };
    const caller = {
      sessionId,
      projectId,
      ticketId: null,
      role: "project" as const,
      rootThreadId: "fixture-root",
      attachmentId: "fixture-attachment",
    };
    expect(
      (
        await sessionVerbs.tool(caller, {
          verb: "session.await",
          toolCallId: "watch-remote",
          input: { sessions: remote.sessionId.slice(0, 8), for: "verdict" },
        })
      )?.text,
    ).toContain("retired await");
    expect(
      (
        await sessionVerbs.tool(caller, {
          verb: "watch",
          toolCallId: "unwatch-remote",
          input: { sessions: remote.sessionId.slice(0, 8), action: "unwatch" },
        })
      )?.details,
    ).toMatchObject({ ended: 1 });
    expect((await sessionVerbs.tool(caller, call))?.text).toContain("Queued steering");
    expect((await sessionVerbs.tool(caller, call))?.text).toContain("Queued steering");
    const jobs = await next.client.mutation(api.runnerJobs.claim, {
      bootId: randomUUID(),
      max: 32,
    });
    const queued = jobs.filter((job) => job.job.commandId === `${sessionId}:remote-send-1`);
    expect(queued).toHaveLength(1);
    const intent = JSON.parse((queued[0]!.job.payload as { intent: string }).intent) as {
      reference: { digest: string };
    };
    const staged = await next.client.query(api.transcripts.commandArtifact, {
      sessionId: remote.sessionId,
      generation: 1,
      digest: intent.reference.digest,
    });
    expect(staged?.body).toContain("Steering from supervising Session");
    await expect(
      runner.client.query(api.transcripts.commandArtifact, {
        sessionId: remote.sessionId,
        generation: 1,
        digest: intent.reference.digest,
      }),
    ).rejects.toMatchObject({ data: { code: "stale_claim" } });
    await expect(
      next.client.mutation(api.runnerJobs.complete, {
        jobId: queued[0]!.job.id,
        bootId: queued[0]!.lease.bootId,
        attempt: queued[0]!.lease.attempt,
        outcome: { status: "done", result: null },
      }),
    ).resolves.toMatchObject({ ack: "recorded" });

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

// This uses the admitted socket dispatch, real Agent-token HTTP reads and real
// git in registered folders. SQLite contains only inert, filtered identities.
test("Cloud worktree status/diff/sync/conflicts resolve before machine git", async () => {
  const email = `worktree-verbs-${randomUUID()}@example.test`;
  await backend.admin(internal.previewAccess.set, { kind: "email", value: email, enabled: true });
  const person = backend.client(`user:${randomUUID()}`, {
    claims: { email, email_verified: true },
  });
  await person.mutation(api.accounts.ensureViewer, {
    acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
  });
  const [workspace] = await person.query(api.workspaces.listMine, {});
  const projectId = randomUUID();
  await person.mutation(api.projects.create, {
    commandId: randomUUID(),
    projectId,
    workspaceId: workspace!.workspaceId,
    name: "Worktree verbs",
    origin: "blank",
    ticketPrefix: "WT",
  });
  const ticketIds = [randomUUID(), randomUUID()];
  for (const ticketId of ticketIds) {
    await person.mutation(api.board.createTicket, {
      commandId: randomUUID(),
      projectId,
      ticketId,
      title: "Cloud copy",
      status: "doing",
    });
  }
  const runner = await linkRunner(person);
  const { sessionId, events, engine } = await writeSession({ projectId, ticketId: ticketIds[0] });
  await runner.client.mutation(api.sessions.accept, {
    sessionId,
    generation: 1,
    events: events.map(wire),
  });
  let connected = true;
  const agentBackend = createAgentBackend({
    functions: createCloudFunctionsClient({ url: backend.url }),
    runnerToken: () => runner.tokens.token(),
    connected: () => connected,
  });
  const db = openTestDb();
  try {
    const root = join(db.dbPath, "..");
    const checkout = join(root, "checkout");
    mkdirSync(checkout);
    git(checkout, "init", "-b", "main");
    git(
      checkout,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "base",
    );
    const project = testProject({
      id: projectId,
      name: "Frozen",
      ticketPrefix: "OLD",
      path: join(root, "shadow"),
    });
    insertProject(db.db, project);
    insertTicket(
      db.db,
      testTicket(projectId, {
        id: ticketIds[0],
        worktreePath: join(root, "never-read"),
        branch: "frozen",
      }),
    );
    db.db
      .prepare(
        "INSERT INTO cloud_shadow_rows(kind,id,owner_user_id) VALUES ('project',?,'owner'),('ticket',?,'owner')",
      )
      .run(projectId, ticketIds[0]);
    const frozen = db.db.prepare("SELECT * FROM tickets").all();
    const registry = createRunnerPathRegistry(db.db, { runnerId: runner.id });
    const repoId = randomUUID();
    registry.checkouts.register({ projectId, projectRepoId: repoId, absPath: checkout });
    for (const [index, ticketId] of ticketIds.entries()) {
      const copy = join(root, `copy-${index}`);
      git(checkout, "worktree", "add", "-b", `cloud-${index}`, copy, "main");
      writeFileSync(join(copy, "shared.txt"), "untracked work\n");
      registry.workingCopies.register({
        ticketId,
        projectRepoId: repoId,
        absPath: copy,
        branch: `cloud-${index}`,
        baseBranch: "main",
      });
    }
    const tokens = createSessionTokenRegistry();
    const token = tokens.mint({ sessionId, attachmentId: "test" });
    const service = createAgentCommandService({
      db: db.db,
      appVersion: "test",
      sessionEngine: engine,
      handlers: testHostHandlers({ db: db.db }),
      projects: () => [{ ...project, path: checkout }],
      verifySessionToken: tokens.verify,
      cloudWorktreeTickets: createCloudWorktreeTickets({
        backend: agentBackend,
        registry: () => registry,
        ticketDisplayIdOf: () => null,
      }),
    });
    const call = (cmd: AgentCommand, args: Record<string, unknown> = {}) =>
      service.execute({
        v: 1,
        cmd,
        args,
        ctx: { cwd: checkout, env: { session: sessionId, token } },
      });
    expect(await call("worktree.status")).toMatchObject({
      ok: true,
      data: { ticket: "WT-1", project: "Worktree verbs", branch: "cloud-0", uncommitted: true },
    });
    expect(await call("worktree.diff", { id: "WT-2", workingTree: true })).toMatchObject({
      ok: true,
      data: { ticket: "WT-2", totalFiles: 1 },
    });
    expect(await call("worktree.sync", { dryRun: true })).toMatchObject({
      ok: true,
      data: { dryRun: true },
    });
    expect(await call("worktree.sync")).toMatchObject({
      ok: true,
      data: { ticket: "WT-1", status: "already-up-to-date", mergedRef: "main" },
    });
    expect(await call("conflicts", { project: "WT" })).toMatchObject({
      ok: true,
      data: { scanned: 2, overlaps: [{ path: "shared.txt", tickets: ["WT-1", "WT-2"] }] },
    });
    git(join(root, "copy-0"), "switch", "-c", "wrong-branch");
    expect(await call("worktree.sync")).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("not cloud-0") },
    });
    expect(db.db.prepare("SELECT * FROM tickets").all()).toEqual(frozen);
    connected = false;
    expect(await call("conflicts")).toMatchObject({ ok: false, error: { code: "OFFLINE" } });
  } finally {
    db.cleanup();
  }
}, 60_000);
