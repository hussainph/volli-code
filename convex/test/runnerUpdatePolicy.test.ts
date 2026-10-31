import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { AGENT_TOKEN_ISSUER, newId, parseId } from "@volli/shared/cloud";

import { api, internal } from "../functions/_generated/api";
import { enqueueJob } from "../functions/lib/jobs";
import { asRunner, code, runnerWorld } from "./runnerContextFixtures";
import { wire, writeSession } from "./sessionFixtures";

type World = Awaited<ReturnType<typeof runnerWorld>>;
const LOAD = {
  activeSessions: 1,
  activeTurns: 1,
  queueDepth: 0,
  freeDiskMb: 1000,
  freeMemMb: 1000,
};
const beat = (w: World) => w.runner.mutation(api.runners.heartbeat, { bootId: "boot", load: LOAD });
async function pointer(w: World, version = "0.4.0", minVersion = "0.3.1") {
  await w.t.mutation(internal.runnerReleases.pin, {
    channel: "stable",
    version,
    minVersion,
    manifestUrl: `https://github.com/hussainph/volli-code/releases/download/v${version}/volli-runner-manifest.json`,
    publishedAt: 1,
  });
}
async function row(w: World) {
  return w.t.run((ctx) =>
    ctx.db
      .query("runners")
      .withIndex("by_uuid", (q) => q.eq("id", w.runnerId))
      .unique(),
  );
}
async function patch(
  w: World,
  value: {
    version?: string;
    autoUpdate?: { enabled: boolean; channel: string; pinnedVersion: string | null };
  },
) {
  const runner = await row(w);
  await w.t.run((ctx) => ctx.db.patch(runner!._id, value));
}
afterEach(() => {
  vi.useRealTimers();
});

describe("runner update policy", () => {
  test("the first heartbeat below the floor blocks claims, not fact intake, and the first updated beat clears it", async () => {
    vi.useFakeTimers();
    const w = await runnerWorld();
    await pointer(w);
    await patch(w, { autoUpdate: { enabled: false, channel: "stable", pinnedVersion: "0.3.0" } });
    // A real engine history crosses the same codec as the runner's Retry buffer.
    const history = await writeSession({ projectId: w.projectId, ticketId: w.ticketId });
    const jobId = newId("job");
    await w.t.run((ctx) =>
      enqueueJob(ctx, {
        id: jobId,
        projectId: w.projectId,
        ticketId: w.ticketId,
        sessionId: null,
        runnerId: w.runnerId,
        createdBy: { kind: "person", userId: parseId("user", w.alice.userId), via: "desktop" },
        onBehalfOf: w.alice.userId,
        kind: "workingCopy.materialize",
        priority: "normal",
        payload: { ticketId: parseId("ticket", w.ticketId), reason: "session_start" },
      }),
    );
    expect(await beat(w)).toMatchObject({
      status: "upgrade_required",
      minVersion: "0.3.1",
      targetVersion: "0.4.0",
      autoUpdate: { enabled: false },
    });
    const timestamp = (await row(w))!.statusChangedAt;
    vi.advanceTimersByTime(1000);
    await beat(w);
    expect((await row(w))!.statusChangedAt).toBe(timestamp);
    expect(await w.runner.mutation(api.runnerJobs.claim, { bootId: newId("runner") })).toEqual([]);
    await expect(
      w.runner.mutation(api.sessions.accept, {
        sessionId: history.sessionId,
        generation: 1,
        events: history.events.slice(0, 2).map(wire),
      }),
    ).resolves.toMatchObject({ acceptedThrough: 2 });
    // A lifecycle report must not let an outdated runner resume claims.
    await w.runner.mutation(api.runners.reportState, { state: "degraded", reason: "test" });
    expect(await w.runner.mutation(api.runnerJobs.claim, { bootId: newId("runner") })).toEqual([]);
    // Re-establish the verdict after the lifecycle report, then clear it on update.
    await beat(w);
    await patch(w, { version: "0.3.1" });
    expect(await beat(w)).toMatchObject({ status: "online" });
    expect(
      await w.runner.mutation(api.runnerJobs.claim, { bootId: newId("runner") }),
    ).toMatchObject([{ id: jobId }]);
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  test.each([
    ["0.3.0-canary.9", "0.3.0-canary.10", "upgrade_required"],
    ["0.3.0", "0.3.0-canary.10", "online"],
    ["0.10.0", "0.9.0", "online"],
  ])("numeric/prerelease order: %s against floor %s is %s", async (version, floor, status) => {
    const w = await runnerWorld();
    await pointer(w, "1.0.0", floor);
    await patch(w, { version });
    expect(await beat(w)).toMatchObject({ status });
  });

  test("no feed leaves an existing runner alone", async () => {
    const w = await runnerWorld();
    expect(await beat(w)).toMatchObject({
      status: "online",
      targetVersion: null,
      minVersion: null,
    });
  });

  test("owner settings, explicit pin and summary; channel change releases the pin", async () => {
    const w = await runnerWorld();
    await pointer(w, "0.4.0", "0.3.0");
    const args = { runnerId: w.runnerId, enabled: false };
    await w.alice.as.mutation(api.runners.setAutoUpdate, args);
    expect(await w.alice.as.mutation(api.runners.updateNow, { runnerId: w.runnerId })).toEqual({
      autoUpdate: { enabled: false, channel: "stable", pinnedVersion: "0.4.0" },
    });
    // The feed moving again does not silently move an explicit runner pin.
    await pointer(w, "0.5.0", "0.3.0");
    expect(await beat(w)).toMatchObject({ targetVersion: "0.4.0" });
    expect(await w.runner.query(api.runnerReleases.target, {})).toMatchObject({
      targetVersion: "0.4.0",
      minVersion: "0.3.0",
      manifestUrl:
        "https://github.com/hussainph/volli-code/releases/download/v0.4.0/volli-runner-manifest.json",
    });
    expect(await w.alice.as.query(api.runners.list, {})).toContainEqual(
      expect.objectContaining({
        id: w.runnerId,
        autoUpdate: { enabled: false, channel: "stable", pinnedVersion: "0.4.0" },
        update: null,
      }),
    );
    expect(
      await w.alice.as.mutation(api.runners.setAutoUpdate, { ...args, channel: "canary" }),
    ).toEqual({
      autoUpdate: { enabled: false, channel: "canary", pinnedVersion: null },
    });
  });

  test("a completed Update-now pin is released on heartbeat without enabling auto-update", async () => {
    const w = await runnerWorld();
    await pointer(w, "0.4.0", "0.3.0");
    await w.alice.as.mutation(api.runners.setAutoUpdate, { runnerId: w.runnerId, enabled: false });
    await w.alice.as.mutation(api.runners.updateNow, { runnerId: w.runnerId });
    await pointer(w, "0.5.0", "0.3.0");
    await patch(w, { version: "0.4.0" });
    expect(await beat(w)).toMatchObject({
      targetVersion: "0.5.0",
      autoUpdate: { enabled: false, pinnedVersion: null },
    });
    expect((await row(w))?.pinnedManifestUrl).toBeNull();
  });

  test("a pin preserves its absolute manifest URL after the download origin or channel changes", async () => {
    const w = await runnerWorld();
    await w.t.mutation(internal.runnerReleases.pin, {
      channel: "stable",
      version: "0.4.0",
      minVersion: "0.3.0",
      manifestUrl: "https://dl.volli.app/runner/0.4.0/manifest.json",
      publishedAt: 1,
    });
    await w.alice.as.mutation(api.runners.updateNow, { runnerId: w.runnerId });
    await pointer(w, "0.5.0", "0.3.0");
    expect(await w.runner.query(api.runnerReleases.target, {})).toMatchObject({
      targetVersion: "0.4.0",
      manifestUrl: "https://dl.volli.app/runner/0.4.0/manifest.json",
    });
  });

  test("changing to a channel without a floor clears the previous floor verdict", async () => {
    const w = await runnerWorld();
    await pointer(w);
    expect(await beat(w)).toMatchObject({ status: "upgrade_required" });
    await w.alice.as.mutation(api.runners.setAutoUpdate, {
      runnerId: w.runnerId,
      enabled: true,
      channel: "canary",
    });
    expect(await beat(w)).toMatchObject({ status: "online", minVersion: null });
  });

  test("only the owner can change settings or request an update; runner and Agent identities are not people", async () => {
    const w = await runnerWorld();
    for (const call of [
      () => w.bob.as.mutation(api.runners.setAutoUpdate, { runnerId: w.runnerId, enabled: false }),
      () => w.bob.as.mutation(api.runners.updateNow, { runnerId: w.runnerId }),
    ])
      await expect(call()).rejects.toThrow(code("not_found"));
    for (const caller of [
      w.runner,
      w.t.withIdentity({ issuer: AGENT_TOKEN_ISSUER, subject: "agent:test" }),
    ]) {
      await expect(
        caller.mutation(api.runners.setAutoUpdate, { runnerId: w.runnerId, enabled: false }),
      ).rejects.toThrow(code("not_a_person"));
      await expect(
        caller.mutation(api.runners.updateNow, { runnerId: w.runnerId }),
      ).rejects.toThrow(code("not_a_person"));
    }
  });

  test("updateNow refuses missing releases and downgrades", async () => {
    const w = await runnerWorld();
    await expect(
      w.alice.as.mutation(api.runners.updateNow, { runnerId: w.runnerId }),
    ).rejects.toThrow(code("release_unavailable"));
    await pointer(w, "0.2.0", "0.1.0");
    await expect(
      w.alice.as.mutation(api.runners.updateNow, { runnerId: w.runnerId }),
    ).rejects.toThrow(code("invalid_request"));
  });

  test("unlinkSelf removes the runner and refuses future calls; a person cannot unlink a runner", async () => {
    const w = await runnerWorld();
    await expect(w.alice.as.mutation(api.runners.unlinkSelf, {})).rejects.toThrow(
      code("not_a_runner"),
    );
    await beat(w);
    await w.runner.mutation(api.runners.unlinkSelf, {});
    expect(await row(w)).toMatchObject({
      status: "revoked",
      statusReason: "removed",
      revokedAt: expect.any(Number),
    });
    expect(await w.alice.as.query(api.runners.list, {})).not.toContainEqual(
      expect.objectContaining({ id: w.runnerId }),
    );
    await expect(beat(w)).rejects.toThrow(code("revoked"));
    expect(
      await w.t.run((ctx) =>
        ctx.db
          .query("runnerPresence")
          .withIndex("by_runner", (q) => q.eq("runnerId", w.runnerId))
          .unique(),
      ),
    ).toBeNull();
    // Another runner's credential cannot name the removed one: unlink has no target argument.
    expect(
      await asRunner(w.t, w.runnerIds[1]!).mutation(api.runners.heartbeat, {
        bootId: "other",
        load: LOAD,
      }),
    ).toMatchObject({ status: "online" });
  });
});
