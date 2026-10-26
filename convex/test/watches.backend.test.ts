import { randomUUID } from "node:crypto";
import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { expect, test } from "vite-plus/test";
import {
  createRunnerLinkClient,
  createRunnerTokenSource,
  linkWithInstallToken,
  runnerHostFacts,
  type RunnerLink,
  type RunnerLinkStore,
} from "@volli/host-core/cloud-runner";
import { parseJobPayload } from "@volli/shared/cloud";
import { api, internal } from "../functions/_generated/api";
import { connectBackend } from "../fixture/testing";
import { enrollBackendPreview } from "./preview-fixtures";
import { wire, writeSession, userProvenance } from "./sessionFixtures";

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
  return { http, token };
}

test("a sleeping watcher wakes to one coalesced notice, claims once, and mirrors the final receipt", async () => {
  const person = backend.client(`user:${randomUUID()}`);
  const { userId } = await person.mutation(api.accounts.ensureViewer, {});
  // The linked runners serve this account: its grant is what their calls recheck.
  await enrollBackendPreview(backend, person, userId);
  const { projectId, ticketId } = await backend.admin(internal.testSeed.seedWorld, {
    ownerUserId: userId,
    runners: 0,
  });
  const sleeping = await linkRunner(person);
  const producing = await linkRunner(person);
  const watcher = await writeSession({ projectId, ticketId });
  await sleeping.http.mutation(api.sessions.accept, {
    sessionId: watcher.sessionId,
    generation: 1,
    events: watcher.events.map(wire),
  });
  const target = await writeSession({ projectId, ticketId });
  const turnEnd = target.events.findIndex((e) => e.payload.kind === "turn.completed");
  await producing.http.mutation(api.sessions.accept, {
    sessionId: target.sessionId,
    generation: 1,
    events: target.events.slice(0, turnEnd).map(wire),
  });
  const { token } = await sleeping.http.action(api.agentTokens.mint, {
    sessionId: watcher.sessionId,
  });
  const agent = new ConvexHttpClient(backend.url);
  agent.setAuth(token);
  await agent.mutation(api.watches.watch, {
    watcherSessionId: watcher.sessionId,
    target: { kind: "session", id: target.sessionId },
    commandId: randomUUID(),
  });

  // The watcher does not claim while asleep. A real subscription, not a poll,
  // learns the coalesced job's deadline as the producer's facts are accepted.
  const subscriber = new ConvexClient(backend.url);
  subscriber.setAuth(async () => sleeping.token);
  let wake!: (at: number) => void;
  let seed!: () => void;
  const initial = new Promise<void>((resolve) => {
    seed = resolve;
  });
  const noticed = new Promise<number>((resolve) => {
    wake = resolve;
  });
  const unsubscribe = subscriber.onUpdate(api.runnerJobs.wake, {}, (value) => {
    seed();
    if (value.nextAvailableAt !== null) wake(value.nextAvailableAt);
  });
  try {
    await initial;
    await producing.http.mutation(api.sessions.accept, {
      sessionId: target.sessionId,
      generation: 1,
      events: target.events.slice(turnEnd).map(wire),
    });
    const availableAt = await noticed;
    const queue = await sleeping.http.query(api.runnerJobs.wake, {});
    expect(queue.nextAvailableAt).toBe(availableAt);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, availableAt - Date.now()) + 50));
    const bootId = randomUUID();
    const jobs = await sleeping.http.mutation(api.runnerJobs.claim, { bootId });
    expect(jobs).toHaveLength(1);
    const claimed = jobs[0]!;
    expect(claimed.job.kind).toBe("session.notice");
    const payload = parseJobPayload("session.notice", claimed.job.payload);
    expect(payload.notice).toBe("watch");
    expect(payload.notice === "watch" && payload.changes.map((c) => c.fact)).toEqual([
      "turn-completed",
      "signaled-blocked",
    ]);
    expect(claimed.job.commandId).toMatch(new RegExp(`^watch:${watcher.sessionId}:`));
    await sleeping.http.mutation(api.runnerJobs.complete, {
      jobId: claimed.job.id,
      bootId,
      attempt: claimed.lease.attempt,
      outcome: { status: "done", result: { stage: "on_runner" } },
    });
    expect(await sleeping.http.mutation(api.runnerJobs.claim, { bootId })).toEqual([]);

    // The runner's durable message acceptance is stage two, and finds the
    // notice job by its frozen derived command id, just like a UUID command.
    const submitted = await watcher.engine.submit({
      sessionId: watcher.sessionId,
      commandId: payload.commandId,
      intent: {
        kind: "message.submit",
        reference: { id: "notice-body", mediaType: null, digest: null },
      },
      provenance: userProvenance,
    });
    await watcher.engine.observe({
      id: randomUUID(),
      kind: "command.receipt",
      sessionId: watcher.sessionId,
      occurredAt: Date.now(),
      attachmentId: submitted.command.route!.attachmentId,
      provenance: {
        source: { kind: "adapter", id: "pi", detail: null },
        venue: { kind: "local", id: "local" },
      },
      receipt: {
        id: randomUUID(),
        commandId: payload.commandId,
        status: "accepted",
        acceptedAt: Date.now(),
        result: { kind: "message.submitted", sessionId: watcher.sessionId },
      },
    });
    const added = [...(await watcher.engine.listEvents({ sessionId: watcher.sessionId }))].slice(
      watcher.events.length,
    );
    await sleeping.http.mutation(api.sessions.accept, {
      sessionId: watcher.sessionId,
      generation: 1,
      events: added.map(wire),
    });
    const stored = await backend.admin(internal.testJobs.inspect, { jobId: claimed.job.id });
    expect(stored?.receipt?.status).toBe("accepted");
  } finally {
    unsubscribe();
    await subscriber.close();
  }
});
