import { randomUUID } from "node:crypto";

import { ConvexHttpClient } from "convex/browser";
import { describe, expect, test } from "vite-plus/test";

import {
  createRunnerLinkClient,
  createRunnerTokenSource,
  linkWithInstallToken,
  runnerHostFacts,
  type RunnerLink,
  type RunnerLinkStore,
} from "@volli/host-core/cloud-runner";

import { CLOUD_SESSION_STATE_MAX_BYTES } from "@volli/shared/cloud";
import type { SessionEvent } from "@volli/shared";

import { api, internal } from "../functions/_generated/api";
import { connectBackend } from "../fixture/testing";
import { enrollBackendPreview } from "./preview-fixtures";
import { moreTurns, wire, writeSession } from "./sessionFixtures";

const backend = connectBackend();

const linkClient = createRunnerLinkClient({ siteUrl: backend.siteUrl });

/**
 * A runner linked the real way (an install token, a rotated credential, a
 * runner token signed by the backend), with a client that calls as it.
 */
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
  const token = await createRunnerTokenSource({ client: linkClient, store }).token();
  if (token === null) throw new Error("no runner token");
  const client = new ConvexHttpClient(backend.url);
  client.setAuth(token);
  return { id: link.runnerId, client };
}

/** A fresh person with a Workspace, a project and two linked runners, on the shared backend. */
async function world() {
  const person = backend.client(`user:${randomUUID()}`);
  const { userId } = await person.mutation(api.accounts.ensureViewer, {});
  // The linked runners serve this account: its grant is what their calls recheck.
  await enrollBackendPreview(backend, person, userId);
  const seeded = await backend.admin(internal.testSeed.seedWorld, {
    ownerUserId: userId,
    runners: 0,
  });
  return { ...seeded, person, runner: await linkRunner(person), next: await linkRunner(person) };
}

type Runner = Awaited<ReturnType<typeof world>>["runner"];

function accept(
  runner: Runner,
  sessionId: string,
  events: readonly SessionEvent[],
  generation = 1,
) {
  return runner.client.mutation(api.sessions.accept, {
    sessionId,
    generation,
    events: events.map(wire),
  });
}

/** Batches under the accept limits: ≤ 100 facts and ≤ 128 KB of JSON text each. */
function batches(events: readonly SessionEvent[]): SessionEvent[][] {
  const out: SessionEvent[][] = [];
  let batch: SessionEvent[] = [];
  let bytes = 0;
  for (const event of events) {
    const size = wire(event).length;
    if (batch.length > 0 && (batch.length === 100 || bytes + size > 120 * 1024)) {
      out.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(event);
    bytes += size;
  }
  if (batch.length > 0) out.push(batch);
  return out;
}

function median(values: number[]): number {
  return values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;
}

describe("Session intake on the pinned local backend", () => {
  test("accepts in order, refuses gaps, answers resends, and folds to the head", async () => {
    const { runner, person, projectId } = await world();
    const { sessionId, events } = await writeSession({ projectId, turns: 1 });
    await expect(accept(runner, sessionId, events.slice(0, 3))).resolves.toMatchObject({
      acceptedThrough: 3,
    });
    await expect(accept(runner, sessionId, [events[4]!])).rejects.toMatchObject({
      data: { code: "out_of_order", acceptedThrough: 3 },
    });
    await expect(accept(runner, sessionId, events.slice(0, 5))).resolves.toEqual({
      acceptedThrough: 5,
      duplicates: 3,
      quarantined: 0,
      unknownKinds: 0,
    });
    await expect(
      accept(runner, sessionId, [{ ...events[2]!, id: randomUUID() }]),
    ).rejects.toMatchObject({ data: { code: "conflict", acceptedThrough: 5 } });
    for (const event of events.slice(5)) await accept(runner, sessionId, [event]);

    const snapshot = await person.query(api.sessions.snapshot, { sessionId });
    expect(snapshot).toMatchObject({
      catchingUp: false,
      foldedThrough: events.length,
      session: { turnActive: false, lastTurnOutcome: "completed", signal: { signal: "blocked" } },
    });
    const history = await person.query(api.sessions.history, { sessionId, afterSequence: 0 });
    expect(history.events.map(({ eventId }) => eventId)).toEqual(events.map(({ id }) => id));
  });

  test("fences the old runner once the claim moves, and the new one carries on", async () => {
    const { runner, next, projectId } = await world();
    const { sessionId, events } = await writeSession({ projectId });
    await accept(runner, sessionId, events.slice(0, 4));
    await expect(
      backend.admin(internal.sessions.transferClaim, {
        sessionId,
        toRunnerId: next.id,
        headSequence: 4,
      }),
    ).resolves.toEqual({ generation: 2 });
    await expect(accept(runner, sessionId, [events[4]!])).rejects.toMatchObject({
      data: { code: "fenced", acceptedThrough: 4 },
    });
    await expect(accept(next, sessionId, [events[4]!], 2)).resolves.toMatchObject({
      acceptedThrough: 5,
    });
  });

  test("a 14.8k-fact Session stays under its fold bound and keeps its accept rate", async () => {
    const { runner, person, projectId } = await world();
    const { sessionId, events: start } = await writeSession({ projectId });
    const events = [...start, ...moreTurns(start, Math.ceil((14_800 - start.length) / 4))];
    expect(events.length).toBeGreaterThanOrEqual(14_800);
    const parts = batches(events);
    const timings: number[] = [];
    for (const part of parts) {
      const began = performance.now();
      await accept(runner, sessionId, part);
      timings.push(performance.now() - began);
    }
    // Steady state is one fact per mutation: the tail of a long Session must not degrade.
    const tail = moreTurns(events, 25);
    const single: number[] = [];
    for (const event of tail) {
      const began = performance.now();
      await accept(runner, sessionId, [event]);
      single.push(performance.now() - began);
    }
    const snapshot = await person.query(api.sessions.snapshot, { sessionId });
    const head = events.length + tail.length;
    expect(snapshot.foldedThrough).toBe(events.length + tail.length);
    expect(new TextEncoder().encode(snapshot.state!).length).toBeLessThanOrEqual(
      CLOUD_SESSION_STATE_MAX_BYTES,
    );
    const firstBatches = median(timings.slice(0, 10));
    const lastBatches = median(timings.slice(-10));
    console.error(
      `[sessions] ${events.length} facts in ${parts.length} batches: median ${firstBatches.toFixed(0)} ms early, ${lastBatches.toFixed(0)} ms late; single-fact median ${median(single).toFixed(0)} ms`,
    );
    // The head is one document, not an index scan: late batches cost what early ones did.
    expect(lastBatches).toBeLessThan(firstBatches * 3 + 50);
    const window = await person.query(api.sessions.history, {
      sessionId,
      beforeSequence: head + 1,
      limit: 50,
    });
    expect(window.events.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: 50 }, (_, index) => head - 49 + index),
    );
  }, 300_000);
});
