import { randomUUID } from "node:crypto";

import { ConvexHttpClient } from "convex/browser";
import { describe, expect, test } from "vite-plus/test";

import {
  createRunnerLinkClient,
  createRunnerTokenSource,
  linkWithInstallToken,
  runnerHostFacts,
  type RunnerLink,
} from "@volli/host-core/cloud-runner";
import { type ClaimedJob } from "@volli/shared/cloud";

import { api, internal } from "../functions/_generated/api";
import { connectBackend } from "../fixture/testing";

const backend = connectBackend();
const linkClient = createRunnerLinkClient({ siteUrl: backend.siteUrl });

const BOOT_A = "a0000000-0000-4000-8000-00000000000a";
const BOOT_B = "a0000000-0000-4000-8000-00000000000b";

interface World {
  ownerUserId: string;
  projectId: string;
  ticketId: string;
  runnerIds: string[];
}

/** Runner clients, signed in with real runner tokens from `/runner/token`. */
const runners = new Map<string, ConvexHttpClient>();

/** Links a runner for `person` the way a box does, and keeps a client signed in as it. */
async function linkRunner(person: ConvexHttpClient, name: string): Promise<string> {
  const { installToken } = await person.action(api.runners.createInstallToken, {
    nameHint: name,
    defaultWorkspaceId: null,
  });
  let saved: RunnerLink | null = null;
  const store = {
    load: async () => saved,
    save: async (link: RunnerLink) => {
      saved = { ...link };
    },
    clear: async () => {
      saved = null;
    },
  };
  const { runnerId } = await linkWithInstallToken({
    client: linkClient,
    store,
    host: runnerHostFacts("user"),
    installToken,
  });
  const token = await createRunnerTokenSource({ client: linkClient, store }).token();
  if (token === null) throw new Error("no runner token");
  const client = new ConvexHttpClient(backend.url);
  client.setAuth(token);
  runners.set(runnerId, client);
  return runnerId;
}

/** A person with their own Workspace, a project, a ticket and two linked runners. */
async function world(): Promise<World> {
  const person = backend.client(`user:${randomUUID()}`);
  const { userId } = await person.mutation(api.accounts.ensureViewer, {});
  const [workspace] = await person.query(api.workspaces.listMine, {});
  const projectId = randomUUID();
  await person.mutation(api.projects.create, {
    commandId: randomUUID(),
    workspaceId: workspace!.workspaceId,
    projectId,
    name: "Runner inbox",
    origin: "github",
  });
  const ticketId = randomUUID();
  await person.mutation(api.board.createTicket, {
    commandId: randomUUID(),
    projectId,
    ticketId,
    status: "todo",
    title: "Inbox",
  });
  const runnerIds = [await linkRunner(person, "mac-a"), await linkRunner(person, "mac-b")];
  return { ownerUserId: userId, projectId, ticketId, runnerIds };
}

function runner(runnerId: string): ConvexHttpClient {
  return runners.get(runnerId)!;
}

async function enqueue(w: World, runnerId = w.runnerIds[0]!) {
  const { jobId } = await backend.admin(internal.testJobs.enqueue, {
    draft: {
      runnerId,
      kind: "workingCopy.materialize",
      projectId: w.projectId,
      ticketId: w.ticketId,
      payload: { ticketId: w.ticketId, reason: "session_start" },
      createdBy: { kind: "person", userId: w.ownerUserId },
      onBehalfOf: w.ownerUserId,
    },
  });
  return jobId;
}

function done(runnerId: string, claimed: ClaimedJob, bootId = claimed.lease.bootId) {
  return runner(runnerId).mutation(api.runnerJobs.complete, {
    jobId: claimed.job.id,
    bootId,
    attempt: claimed.lease.attempt,
    outcome: { status: "done", result: { ok: true } },
  });
}

describe("the runner inbox on the pinned local backend", () => {
  test("concurrent claims lease every job exactly once", async () => {
    const w = await world();
    const runnerId = w.runnerIds[0]!;
    const jobIds = new Set<string>();
    for (let index = 0; index < 12; index += 1) jobIds.add(await enqueue(w));
    const claims = await Promise.all(
      Array.from({ length: 6 }, () =>
        runner(runnerId).mutation(api.runnerJobs.claim, { bootId: BOOT_A, max: 4 }),
      ),
    );
    const claimed = claims.flat().map((c) => c.job.id);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(new Set(claimed)).toEqual(jobIds);
    await expect(
      runner(runnerId).mutation(api.runnerJobs.claim, { bootId: BOOT_A }),
    ).resolves.toEqual([]);
  });

  test("a runner sees only its own jobs; a person's token naming a runner cannot claim", async () => {
    const w = await world();
    const [mine, other] = w.runnerIds as [string, string];
    const jobId = await enqueue(w, other);
    await expect(runner(mine).mutation(api.runnerJobs.claim, { bootId: BOOT_A })).resolves.toEqual(
      [],
    );
    await expect(
      backend.client(`runner:${mine}`).mutation(api.runnerJobs.claim, { bootId: BOOT_A }),
    ).rejects.toThrow(/not_a_runner/);
    const [claimed] = await runner(other).mutation(api.runnerJobs.claim, { bootId: BOOT_A });
    expect(claimed!.job.id).toBe(jobId);
    await expect(done(mine, claimed!)).resolves.toEqual({ ack: "superseded", reason: "gone" });
  });

  test("a lease that runs out goes back to the queue; until it is replaced, it may still report", async () => {
    const w = await world();
    const runnerId = w.runnerIds[0]!;
    const jobId = await enqueue(w);
    const [first] = await runner(runnerId).mutation(api.runnerJobs.claim, { bootId: BOOT_A });
    expect(first!.lease.attempt).toBe(1);
    await backend.admin(internal.testJobs.ageLease, { jobId });
    await backend.admin(internal.runnerJobs.expireLease, { jobId, attempt: 1 });
    await expect(backend.admin(internal.testJobs.inspect, { jobId })).resolves.toMatchObject({
      status: "queued",
      failure: { code: "lease_expired", by: "backend" },
    });
    await expect(done(runnerId, first!)).resolves.toEqual({ ack: "recorded", status: "done" });
    await expect(done(runnerId, first!)).resolves.toEqual({ ack: "duplicate", status: "done" });
    await expect(backend.admin(internal.testJobs.inspect, { jobId })).resolves.toMatchObject({
      status: "done",
      result: { ok: true },
      lease: { attempt: 1 },
    });
  });

  test("a restarted runner takes back what its earlier boot held", async () => {
    const w = await world();
    const runnerId = w.runnerIds[0]!;
    await enqueue(w);
    const [before] = await runner(runnerId).mutation(api.runnerJobs.claim, { bootId: BOOT_A });
    const [after] = await runner(runnerId).mutation(api.runnerJobs.claim, { bootId: BOOT_B });
    expect(after!.job.id).toBe(before!.job.id);
    expect(after!.lease).toMatchObject({ bootId: BOOT_B, attempt: 2 });
    // The earlier boot's lease is fenced, for renew and complete alike.
    await expect(
      runner(runnerId).mutation(api.runnerJobs.renew, {
        jobId: before!.job.id,
        bootId: BOOT_A,
        attempt: 1,
      }),
    ).resolves.toEqual({ ok: false, reason: "fenced" });
    await expect(done(runnerId, before!)).resolves.toEqual({ ack: "superseded", reason: "fenced" });
    await expect(done(runnerId, after!)).resolves.toEqual({ ack: "recorded", status: "done" });
  });

  test("completing is idempotent, even when the same report races itself", async () => {
    const w = await world();
    const runnerId = w.runnerIds[0]!;
    await enqueue(w);
    const [claimed] = await runner(runnerId).mutation(api.runnerJobs.claim, { bootId: BOOT_A });
    const replies = await Promise.all(Array.from({ length: 5 }, () => done(runnerId, claimed!)));
    expect(replies.filter((r) => r.ack === "recorded")).toEqual([
      { ack: "recorded", status: "done" },
    ]);
    expect(replies.filter((r) => r.ack === "duplicate")).toHaveLength(4);
  });

  test("a retryable failure waits out its backoff before it is offered again", async () => {
    const w = await world();
    const runnerId = w.runnerIds[0]!;
    const jobId = await enqueue(w);
    const [claimed] = await runner(runnerId).mutation(api.runnerJobs.claim, { bootId: BOOT_A });
    await expect(
      runner(runnerId).mutation(api.runnerJobs.complete, {
        jobId,
        bootId: BOOT_A,
        attempt: claimed!.lease.attempt,
        outcome: { status: "failed", code: "network", detail: null, retryable: true },
      }),
    ).resolves.toEqual({ ack: "recorded", status: "queued" });
    const row = await backend.admin(internal.testJobs.inspect, { jobId });
    expect(row).toMatchObject({ status: "queued", failure: { code: "network", by: "runner" } });
    expect(row!.availableAt - row!.failure!.at).toBe(5_000);
    await expect(
      runner(runnerId).mutation(api.runnerJobs.claim, { bootId: BOOT_A }),
    ).resolves.toEqual([]);
  });
});
