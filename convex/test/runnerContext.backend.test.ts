/** One real runner-token path: pre-accept brief, reports, first accept, membership refusal. */
import { randomUUID } from "node:crypto";

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

import { api, internal } from "../functions/_generated/api";
import { connectBackend } from "../fixture/testing";
import { wire, writeSession } from "./sessionFixtures";

const backend = connectBackend();

async function linkedRunner(person: ConvexHttpClient) {
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
  const link = await linkWithInstallToken({
    client,
    store,
    host: runnerHostFacts("app"),
    installToken,
  });
  const token = await createRunnerTokenSource({ client, store }).token();
  if (token === null) throw new Error("No runner token");
  const runner = new ConvexHttpClient(backend.url);
  runner.setAuth(token);
  return { id: link.runnerId, client: runner };
}

test("first accept registers a runner-originated Session; nonmember runners cannot read its project brief", async () => {
  const owner = backend.client(`user:${randomUUID()}`);
  const outsider = backend.client(`user:${randomUUID()}`);
  const { userId } = await owner.mutation(api.accounts.ensureViewer, {});
  await outsider.mutation(api.accounts.ensureViewer, {});
  const { projectId, ticketId } = await backend.admin(internal.testSeed.seedWorld, {
    ownerUserId: userId,
    runners: 0,
  });
  const runner = await linkedRunner(owner);
  const other = await linkedRunner(outsider);
  const { sessionId, events } = await writeSession({ projectId, ticketId });
  const brief = await runner.client.query(api.runnerContext.forSession, {
    sessionId,
    projectId,
    ticketId,
  });
  expect(brief).toMatchObject({
    ownerUserId: userId,
    ticket: { id: ticketId, checkoutMode: "worktree" },
    primaryRepo: { id: projectId, projectId },
  });
  await expect(owner.query(api.sessions.snapshot, { sessionId })).rejects.toMatchObject({
    data: { code: "not_found" },
  });

  await runner.client.mutation(api.projectCheckouts.report, {
    projectId,
    projectRepoId: brief.primaryRepo.id,
    kind: "main",
    headBranch: "main",
    headSha: "a".repeat(40),
  });
  const report = {
    ticketId,
    projectRepoId: brief.primaryRepo.id,
    kind: "worktree" as const,
    state: "ready" as const,
    branch: "volli/TS-1-ticket",
    baseBranch: "main",
    headSha: "b".repeat(40),
  };
  const copy = await runner.client.mutation(api.workingCopies.report, report);
  expect(await runner.client.mutation(api.workingCopies.report, report)).toEqual(copy);
  expect(await runner.client.query(api.projectCheckouts.locate, { projectId })).toMatchObject({
    runnerId: runner.id,
    headBranch: "main",
    headSha: "a".repeat(40),
  });

  await expect(
    runner.client.mutation(api.sessions.accept, {
      sessionId,
      generation: 1,
      events: events.slice(0, 2).map((event) =>
        wire(
          event.payload.kind === "session.created"
            ? {
                ...event,
                payload: {
                  ...event.payload,
                  session: { ...event.payload.session, ownerUserId: userId },
                },
              }
            : event,
        ),
      ),
    }),
  ).resolves.toMatchObject({ acceptedThrough: 2, quarantined: 0 });
  expect(await owner.query(api.sessions.snapshot, { sessionId })).toMatchObject({
    session: { id: sessionId, projectId, ticketId, ownerUserId: userId, placeRunnerId: runner.id },
  });
  expect(await runner.client.query(api.runnerContext.forSession, { sessionId })).toMatchObject({
    ownerUserId: userId,
    ticket: { id: ticketId },
  });
  await expect(
    other.client.query(api.runnerContext.forSession, {
      sessionId: randomUUID(),
      projectId,
      ticketId,
    }),
  ).rejects.toMatchObject({ data: { code: "not_found" } });
});
