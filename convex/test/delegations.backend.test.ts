import { createHash, randomUUID } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { expect, test } from "vite-plus/test";
import {
  createRunnerLinkClient,
  createRunnerTokenSource,
  linkWithInstallToken,
  runnerHostFacts,
  type RunnerLink,
  type RunnerLinkStore,
} from "@volli/host-core/cloud-runner";
import { assertSessionEvent, type SessionEvent } from "@volli/shared";
import { canonicalJson, parseJobPayload } from "@volli/shared/cloud";
import { api, internal } from "../functions/_generated/api";
import { connectBackend } from "../fixture/testing";
import { enrollBackendPreview } from "./preview-fixtures";
import { wire, writeSession } from "./sessionFixtures";

const backend = connectBackend();

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
  const client = createRunnerLinkClient({ siteUrl: backend.siteUrl });
  await linkWithInstallToken({ client, store, host: runnerHostFacts("user"), installToken });
  const token = await createRunnerTokenSource({ client, store }).token();
  if (token === null) throw new Error("No runner token");
  const http = new ConvexHttpClient(backend.url);
  http.setAuth(token);
  return http;
}

test("a child on runner B settles once into the sleeping parent's runner A inbox", async () => {
  const person = backend.client(`user:${randomUUID()}`);
  const { userId } = await person.mutation(api.accounts.ensureViewer, {});
  // The linked runners serve this account: its grant is what their calls recheck.
  await enrollBackendPreview(backend, person, userId);
  const { projectId, ticketId } = await backend.admin(internal.testSeed.seedWorld, {
    ownerUserId: userId,
    runners: 0,
  });
  const parentRunner = await linkRunner(person);
  const childRunner = await linkRunner(person);
  const parent = await writeSession({ projectId, ticketId });
  await parentRunner.mutation(api.sessions.accept, {
    sessionId: parent.sessionId,
    generation: 1,
    events: parent.events.map(wire),
  });
  const child = await writeSession({ projectId, ticketId, parentSessionId: parent.sessionId });
  const first = child.events[0]!.payload;
  if (first.kind !== "command.recorded") throw new Error("No creation command");
  const oldCommandId = first.command.id;
  const operationId = `${parent.sessionId}:backend-call`;
  const createCommandId = `${operationId}:create`;
  const events = child.events.map((event): SessionEvent => {
    if (event.payload.kind === "command.recorded" && event.payload.command.id === oldCommandId) {
      return {
        ...event,
        commandId: createCommandId,
        payload: { ...event.payload, command: { ...event.payload.command, id: createCommandId } },
      };
    }
    if (
      event.payload.kind === "command.receipt.recorded" &&
      event.payload.receipt.commandId === oldCommandId
    ) {
      return {
        ...event,
        commandId: createCommandId,
        payload: {
          ...event.payload,
          receipt: { ...event.payload.receipt, commandId: createCommandId },
        },
      };
    }
    return event;
  });
  for (const event of events) assertSessionEvent(event, "delegation backend fixture");
  const end = events.findIndex((event) => event.payload.kind === "turn.completed");
  await childRunner.mutation(api.sessions.accept, {
    sessionId: child.sessionId,
    generation: 1,
    events: events.slice(0, end).map(wire),
  });
  expect(await parentRunner.query(api.runnerJobs.wake, {})).toEqual({
    ready: 0,
    nextAvailableAt: null,
  });
  await childRunner.mutation(api.sessions.accept, {
    sessionId: child.sessionId,
    generation: 1,
    events: events.slice(end).map(wire),
  });
  // A re-drain after a lost response cannot produce a second answer job.
  await childRunner.mutation(api.sessions.accept, {
    sessionId: child.sessionId,
    generation: 1,
    events: events.slice(end).map(wire),
  });
  expect((await parentRunner.query(api.runnerJobs.wake, {})).ready).toBe(1);
  const bootId = randomUUID();
  const claimed = await parentRunner.mutation(api.runnerJobs.claim, { bootId });
  expect(claimed).toHaveLength(1);
  const job = claimed[0]!;
  expect(job.job).toMatchObject({
    sessionId: parent.sessionId,
    kind: "session.notice",
    commandId: `${operationId}:answer`,
  });
  expect(parseJobPayload("session.notice", job.job.payload)).toMatchObject({
    notice: "subagent",
    childSessionId: child.sessionId,
    state: "completed",
  });
  await parentRunner.mutation(api.runnerJobs.complete, {
    jobId: job.job.id,
    bootId,
    attempt: job.lease.attempt,
    outcome: { status: "done", result: { stage: "on_runner" } },
  });
  expect(await parentRunner.mutation(api.runnerJobs.claim, { bootId })).toEqual([]);
  expect(await childRunner.mutation(api.runnerJobs.claim, { bootId: randomUUID() })).toEqual([]);
});

function request(messageId: string) {
  const body = canonicalJson({
    version: 1,
    threadId: "thread",
    branchId: "branch",
    attemptId: "attempt",
    turnId: null,
    message: { id: messageId, role: "user", parts: [{ type: "text", text: "Follow-up" }] },
  });
  const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  return {
    intent: {
      kind: "message.submit",
      delivery: "queue",
      messageId,
      reference: { id: digest, digest, mediaType: "application/vnd.volli.ui-message+json" },
    },
    body,
    digest,
  };
}

test("sleeping-runner cancel is final; wake publishes the mirror before intake completes", async () => {
  const person = backend.client(`user:${randomUUID()}`);
  const { userId } = await person.mutation(api.accounts.ensureViewer, {});
  await enrollBackendPreview(backend, person, userId);
  const { projectId, ticketId } = await backend.admin(internal.testSeed.seedWorld, {
    ownerUserId: userId,
    runners: 0,
  });
  const runner = await linkRunner(person);
  const { sessionId, events } = await writeSession({ projectId, ticketId });
  await runner.mutation(api.sessions.accept, {
    sessionId,
    generation: 1,
    events: events.map(wire),
  });

  const cancelled = request("cancelled");
  await person.mutation(api.sessions.command, {
    sessionId,
    commandId: randomUUID(),
    intent: JSON.stringify(cancelled.intent),
    artifact: cancelled.body,
  });
  await person.mutation(api.sessions.command, {
    sessionId,
    commandId: randomUUID(),
    intent: JSON.stringify({ kind: "message.cancel", messageId: "cancelled" }),
  });
  expect(await runner.mutation(api.runnerJobs.claim, { bootId: randomUUID() })).toEqual([]);
  const pending = request("pending");
  const commandId = randomUUID();
  await person.mutation(api.sessions.command, {
    sessionId,
    commandId,
    intent: JSON.stringify(pending.intent),
    artifact: pending.body,
  });
  const bootId = randomUUID();
  const [claimed] = await runner.mutation(api.runnerJobs.claim, { bootId });
  expect(claimed!.job).toMatchObject({ kind: "session.followUp", commandId });
  await runner.mutation(api.followUps.mirror, {
    sessionId,
    generation: 1,
    revision: 1,
    items: [
      {
        messageId: "pending",
        commandId,
        state: "queued",
        message: JSON.stringify({ id: "pending", role: "user", parts: [] }),
        messageDigest: pending.digest,
      },
    ],
  });
  expect((await person.query(api.followUps.queue, { sessionId })).items).toHaveLength(1);
  await runner.mutation(api.runnerJobs.complete, {
    jobId: commandId,
    bootId,
    attempt: claimed!.lease.attempt,
    outcome: {
      status: "done",
      result: { receipt: { status: "accepted", code: null, detail: null } },
    },
  });
  const view = await person.query(api.followUps.queue, { sessionId });
  expect(view.items).toHaveLength(1);
  expect(view.items[0]).toMatchObject({ messageId: "pending", message: expect.any(String) });
  expect(await runner.mutation(api.runnerJobs.claim, { bootId })).toEqual([]);
});
