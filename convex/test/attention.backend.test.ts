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

import { api, internal } from "../functions/_generated/api";
import { connectBackend } from "../fixture/testing";
import { wire, writeSession } from "./sessionFixtures";

const backend = connectBackend();

const linkClient = createRunnerLinkClient({ siteUrl: backend.siteUrl });

/** A runner linked the real way: an install token, a rotated credential, a runner token. */
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
  await linkWithInstallToken({
    client: linkClient,
    store,
    host: runnerHostFacts("user"),
    installToken,
  });
  const token = await createRunnerTokenSource({ client: linkClient, store }).token();
  if (token === null) throw new Error("no runner token");
  const client = new ConvexHttpClient(backend.url);
  client.setAuth(token);
  return client;
}

describe("volli notify on the real backend", () => {
  test("the claimed runner raises an item its owner reads and answers by seeing it; another runner is fenced", async () => {
    const person = backend.client(`user:${randomUUID()}`);
    const { userId } = await person.mutation(api.accounts.ensureViewer, {});
    const { projectId } = await backend.admin(internal.testSeed.seedWorld, {
      ownerUserId: userId,
      runners: 0,
    });
    const runner = await linkRunner(person);
    const other = await linkRunner(person);
    const { sessionId, events } = await writeSession({ projectId });
    await runner.mutation(api.sessions.accept, {
      sessionId,
      generation: 1,
      events: events.slice(0, 1).map(wire),
    });

    const call = {
      sessionId,
      generation: 1,
      notifyId: randomUUID(),
      title: "Deploy finished",
      detail: null,
    };
    await expect(other.mutation(api.attention.raiseFromRunner, call)).rejects.toMatchObject({
      data: { code: "fenced" },
    });
    const raised = await runner.mutation(api.attention.raiseFromRunner, call);
    expect(raised).toMatchObject({ userId, duplicate: false });

    const open = await person.query(api.sessions.attention, { sessionId });
    expect(open).toEqual([
      expect.objectContaining({
        id: raised.attentionId,
        source: "notify",
        title: "Deploy finished",
        seenAt: null,
      }),
    ]);
    await expect(
      person.mutation(api.attention.markSeen, { ids: [raised.attentionId] }),
    ).resolves.toEqual({ marked: 1 });
    await expect(person.query(api.sessions.attention, { sessionId })).resolves.toEqual([]);
    // The runner's retry finds the item it raised and leaves it answered.
    await expect(runner.mutation(api.attention.raiseFromRunner, call)).resolves.toMatchObject({
      attentionId: raised.attentionId,
      duplicate: true,
    });
    await expect(person.query(api.sessions.attention, { sessionId })).resolves.toEqual([]);
  });
});
