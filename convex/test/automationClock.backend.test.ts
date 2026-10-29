/**
 * The Automation clock on the pinned local backend: real transactions, real
 * concurrency control and real runner tokens.
 *
 * - Overlapping clock passes and an edit racing them leave exactly one
 *   advance: one Run and one job at most, never two (VC-944: the backend's
 *   OCC retries the loser, which then finds nothing due).
 * - Only the armer's runner can lease the Run; it reads its fenced context,
 *   completes it, and the Run row records the start.
 * - A cancel racing a claim: exactly one wins, never both or neither.
 */
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
import { PREVIEW_ENROLLMENT_AGREEMENT_VERSION, type ClaimedJob } from "@volli/shared/cloud";

import { api, internal } from "../functions/_generated/api";
import { connectBackend } from "../fixture/testing";

const backend = connectBackend();
const linkClient = createRunnerLinkClient({ siteUrl: backend.siteUrl });

async function linkRunner(person: ConvexHttpClient, name: string) {
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
  await backend.admin(internal.testAutomations.advertiseExecutor, { runnerId });
  return { runnerId, client };
}

async function world(minute = 17) {
  const person = backend.client(`user:${randomUUID()}`);
  const { userId } = await person.mutation(api.accounts.ensureViewer, {});
  await backend.admin(internal.previewAccess.set, { kind: "user", value: userId, enabled: true });
  await person.mutation(api.accounts.ensureViewer, {
    acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
  });
  const [workspace] = await person.query(api.workspaces.listMine, {});
  const projectId = randomUUID();
  await person.mutation(api.projects.create, {
    commandId: randomUUID(),
    workspaceId: workspace!.workspaceId,
    projectId,
    name: "Clock",
    origin: "github",
  });
  const armer = await linkRunner(person, "mac-a");
  const other = await linkRunner(person, "mac-b");
  const automationId = randomUUID();
  const trigger = {
    kind: "schedule",
    schedule: { preset: "hourly", minute, timeZone: "Europe/London" },
  };
  await person.mutation(api.automations.create, {
    commandId: randomUUID(),
    projectId,
    automationId,
    name: "Hourly",
    instructions: "Sweep",
    runtime: null,
    trigger,
  });
  await person.mutation(api.automations.armSchedule, {
    commandId: randomUUID(),
    automationId,
    runnerId: armer.runnerId,
  });
  return { person, userId, projectId, automationId, trigger, armer, other };
}

const inspect = (automationId: string) =>
  backend.admin(internal.testAutomations.inspectSchedule, { automationId });

describe("the Automation clock on the pinned local backend", () => {
  test("the acceptance hook coalesces two distinct past occurrences in one real mutation", async () => {
    const minute = (new Date().getUTCMinutes() + 59) % 60 || 59;
    const w = await world(minute);
    await w.armer.client.mutation(api.runners.reportState, { state: "asleep", reason: null });
    const latest = new Date();
    latest.setUTCMinutes(minute, 0, 0);
    if (latest.getTime() > Date.now()) latest.setUTCHours(latest.getUTCHours() - 1);
    const firstDueAt = latest.getTime() - 3_600_000;
    const { first, second, secondDueAt } = await backend.admin(
      internal.testAutomations.coalescePastOccurrences,
      { automationId: w.automationId, firstDueAt },
    );
    expect(secondDueAt).toBe(latest.getTime());
    expect(first.runs).toHaveLength(1);
    expect(first.runs[0]).toMatchObject({ status: "queued", dueAt: firstDueAt });
    expect(second.runs).toHaveLength(2);
    expect(second.runs.find((run) => run.status === "skipped")).toMatchObject({
      dueAt: firstDueAt,
      missedCount: 1,
    });
    expect(second.runs.find((run) => run.status === "queued")).toMatchObject({
      id: first.runs[0]!.id,
      dueAt: secondDueAt,
    });
    expect(second.jobs).toHaveLength(1);
    expect(second.jobs[0]).toMatchObject({
      id: first.jobs[0]!.id,
      lease: null,
      availableAt: secondDueAt,
    });
    expect(second.schedule!.nextFireAt).toBeGreaterThan(Date.now());
    expect(secondDueAt).toBeLessThanOrEqual(Date.now());
  });
  test("overlapping passes and a racing edit advance a due schedule exactly once", async () => {
    const w = await world();
    const now = Date.now();
    await backend.admin(internal.testAutomations.backdateSchedule, {
      automationId: w.automationId,
      nextFireAt: now - 90 * 60_000,
    });
    await Promise.all([
      ...Array.from({ length: 4 }, () =>
        backend.admin(internal.testAutomations.fireDueAt, { now }),
      ),
      backend.admin(internal.automationSchedules.fireDue, {}),
      // Same trigger: the edit touches the schedule's Automation, not its cursor.
      w.person.mutation(api.automations.update, {
        commandId: randomUUID(),
        automationId: w.automationId,
        name: "Hourly sweep",
        instructions: "Sweep",
        runtime: null,
        trigger: w.trigger,
      }),
    ]);
    const { schedule, runs, jobs } = await inspect(w.automationId);
    expect(jobs).toHaveLength(1);
    expect(runs.filter((run) => run.status === "queued")).toHaveLength(1);
    // The 90-minute gap covered one earlier occurrence: one skip row, not two.
    expect(runs.filter((run) => run.status === "skipped")).toHaveLength(1);
    expect(schedule!.nextFireAt).toBeGreaterThan(now);
    expect(schedule!.pendingJobId).toBe(jobs[0]!.id);

    // A pass after the advance finds nothing due.
    await backend.admin(internal.automationSchedules.fireDue, {});
    expect((await inspect(w.automationId)).jobs).toHaveLength(1);
  });

  test("only the armer's runner leases the Run, reads its context and records its start", async () => {
    const w = await world();
    await backend.admin(internal.testAutomations.backdateSchedule, {
      automationId: w.automationId,
      nextFireAt: Date.now() - 1_000,
    });
    await backend.admin(internal.automationSchedules.fireDue, {});
    const bootId = randomUUID();
    expect(await w.other.client.mutation(api.runnerJobs.claim, { bootId })).toEqual([]);
    const claimed: ClaimedJob[] = await w.armer.client.mutation(api.runnerJobs.claim, { bootId });
    expect(claimed).toHaveLength(1);
    const lease = {
      jobId: claimed[0]!.job.id,
      bootId: claimed[0]!.lease.bootId,
      attempt: claimed[0]!.lease.attempt,
    };
    expect(
      await w.other.client.query(api.automationRunner.runContext, {
        jobId: lease.jobId,
        bootId: lease.bootId,
        attempt: lease.attempt,
      }),
    ).toEqual({ kind: "unavailable", reason: "lease_lost" });
    const context = await w.armer.client.query(api.automationRunner.runContext, {
      jobId: lease.jobId,
      bootId: lease.bootId,
      attempt: lease.attempt,
    });
    expect(context).toMatchObject({
      kind: "ready",
      projectId: w.projectId,
      scheduleArming: { automationId: w.automationId, runnerId: w.armer.runnerId },
      previousRunActive: false,
    });
    const sessionId = (claimed[0]!.job.payload as { sessionId: string }).sessionId;
    await w.armer.client.mutation(api.runnerJobs.complete, {
      jobId: lease.jobId,
      bootId: lease.bootId,
      attempt: lease.attempt,
      outcome: {
        status: "done",
        result: {
          kind: "started",
          sessionId,
          model: { providerId: "anthropic", modelId: "opus", reasoningLevel: "high" },
          attendance: "unattended",
        },
      },
    });
    const { schedule, runs } = await inspect(w.automationId);
    expect(runs).toMatchObject([{ status: "started", sessionId, trigger: "schedule" }]);
    expect(schedule!.pendingJobId).toBeNull();
  });

  test("a cancel racing a claim: exactly one of them wins", async () => {
    const w = await world();
    const ticketId = randomUUID();
    await w.person.mutation(api.board.createTicket, {
      commandId: randomUUID(),
      projectId: w.projectId,
      ticketId,
      status: "todo",
      title: "Race",
    });
    const reviewId = randomUUID();
    await w.person.mutation(api.automations.create, {
      commandId: randomUUID(),
      projectId: w.projectId,
      automationId: reviewId,
      name: "Review",
      instructions: "Review",
      runtime: null,
      trigger: { kind: "none" },
    });
    for (let round = 0; round < 4; round += 1) {
      const { jobId } = await w.person.mutation(api.automations.run, {
        commandId: randomUUID(),
        automationId: reviewId,
        ticketId,
        runnerId: w.armer.runnerId,
      });
      const [claimed, cancelled] = await Promise.allSettled([
        w.armer.client.mutation(api.runnerJobs.claim, { bootId: randomUUID() }),
        w.person.mutation(api.automations.cancelPendingArrival, { commandId: randomUUID(), jobId }),
      ]);
      const leased =
        claimed.status === "fulfilled" && claimed.value.some((c) => c.job.id === jobId);
      expect(cancelled.status === "fulfilled").toBe(!leased);
      const job = await backend.admin(internal.testJobs.inspect, { jobId });
      expect(job!.status).toBe(leased ? "leased" : "cancelled");
      if (leased) {
        const held = (claimed as PromiseFulfilledResult<ClaimedJob[]>).value.find(
          (c) => c.job.id === jobId,
        )!;
        await w.armer.client.mutation(api.runnerJobs.complete, {
          jobId,
          bootId: held.lease.bootId,
          attempt: held.lease.attempt,
          outcome: { status: "done", result: { kind: "abandoned", reason: "gone" } },
        });
      }
    }
  });
});
