import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  AGENT_TOKEN_ISSUER,
  PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
  RUNNER_TOKEN_ISSUER,
  newId,
  secretHash,
} from "@volli/shared/cloud";
import { api, internal } from "../functions/_generated/api";
import { seedTestWorld } from "../functions/lib/testWorld";
import schema from "../functions/schema";
import { seedSession } from "./board-helpers";

const modules = import.meta.glob("../functions/**/*.ts");
const identity = { subject: "preview-person", issuer: "https://issuer.test" };
const host = {
  hostname: "preview-mac",
  platform: { os: "darwin", distro: null, kernel: null, arch: "arm64", glibc: null },
  installMode: "app",
};
const code = (value: string) =>
  expect.objectContaining({ data: expect.objectContaining({ code: value }) });

async function world(granted = true) {
  const t = convexTest(schema, modules);
  const person = t.withIdentity(identity);
  const { userId } = await person.mutation(api.accounts.ensureViewer, {});
  if (granted) {
    await t.mutation(internal.previewAccess.set, { kind: "user", value: userId, enabled: true });
    await person.mutation(api.accounts.ensureViewer, {
      acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
    });
  }
  const seeded = await t.run((ctx) => seedTestWorld(ctx, { ownerUserId: userId }));
  const session = await seedSession(t, seeded, userId);
  const runner = t.withIdentity({
    issuer: RUNNER_TOKEN_ISSUER,
    subject: `runner:${session.runnerId}`,
    gen: 1,
  });
  const agent = t.withIdentity({
    issuer: AGENT_TOKEN_ISSUER,
    subject: `agent:${session.sessionId}`,
    own: userId,
    rnr: session.runnerId,
    gen: 1,
    tkt: seeded.ticketId,
  });
  return { t, person, runner, agent, userId, ...seeded, ...session };
}

afterEach(() => vi.useRealTimers());

describe("preview hard cutoff", () => {
  test.each(["revoked", "expired"])(
    "%s access cuts off existing people, runners and agents",
    async (reason) => {
      const w = await world();
      const read = () => w.person.query(api.projects.get, { projectId: w.projectId });
      const wake = () => w.runner.query(api.runnerJobs.wake, {});
      const agentRead = () => w.agent.query(api.projects.get, { projectId: w.projectId });
      await expect(read()).resolves.toMatchObject({ id: w.projectId });
      await expect(wake()).resolves.toMatchObject({ ready: 0 });
      await expect(agentRead()).resolves.toMatchObject({ id: w.projectId });
      await expect(
        w.runner.query(internal.agentTokens.authorizeMint, { sessionId: w.sessionId }),
      ).resolves.toBeTruthy();
      if (reason === "revoked") {
        await w.t.mutation(internal.previewAccess.set, {
          kind: "user",
          value: w.userId,
          enabled: false,
        });
      } else {
        await w.t.mutation(internal.previewAccess.set, {
          kind: "user",
          value: w.userId,
          enabled: true,
          expiresAt: Date.now() + 1_000,
        });
        vi.useFakeTimers();
        vi.advanceTimersByTime(1_001);
      }
      await expect(read()).rejects.toThrow(code("preview_waitlisted"));
      await expect(wake()).rejects.toThrow(code("preview_access_required"));
      await expect(agentRead()).rejects.toThrow(code("preview_access_required"));
      await expect(
        w.runner.query(internal.agentTokens.authorizeMint, { sessionId: w.sessionId }),
      ).rejects.toThrow(code("preview_access_required"));
      await expect(
        w.runner.mutation(api.sessions.accept, {
          sessionId: w.sessionId,
          generation: 1,
          events: [],
        }),
      ).rejects.toThrow(code("preview_access_required"));
      // Enrollment/recovery remains reachable, but cannot recover product access on its own.
      await expect(w.person.query(api.accounts.viewer, {})).resolves.toMatchObject({
        previewAccess: "waitlisted",
      });
      await expect(w.person.mutation(api.accounts.ensureViewer, {})).resolves.toMatchObject({
        previewAccess: "waitlisted",
      });
      await expect(read()).rejects.toThrow(code("preview_waitlisted"));
      await w.t.mutation(internal.previewAccess.set, {
        kind: "user",
        value: w.userId,
        enabled: true,
        expiresAt: Date.now() + 60_000,
      });
      // Re-grant restores the same identities; no runner credential was revoked.
      await expect(read()).resolves.toMatchObject({ id: w.projectId });
      await expect(wake()).resolves.toMatchObject({ ready: 0 });
      await expect(agentRead()).resolves.toMatchObject({ id: w.projectId });
    },
  );

  test("waitlisted accounts cannot register, mint install tokens, preview or approve device codes", async () => {
    const w = await world(false);
    for (const call of [
      () => w.person.action(api.runners.registerThisMac, { host, name: null }),
      () =>
        w.person.action(api.runners.createInstallToken, {
          nameHint: null,
          defaultWorkspaceId: null,
        }),
      () => w.person.mutation(api.runners.previewLink, { userCode: "BCDFGHJK" }),
      () =>
        w.person.mutation(api.runners.decideLink, {
          requestId: newId("runner"),
          userCode: "BCDFGHJK",
          decision: "approve" as const,
        }),
    ])
      await expect(call()).rejects.toThrow(code("preview_waitlisted"));
    await expect(w.runner.query(api.runnerJobs.wake, {})).rejects.toThrow(
      code("preview_access_required"),
    );
    await expect(w.agent.query(api.projects.get, { projectId: w.projectId })).rejects.toThrow(
      code("preview_access_required"),
    );
  });

  test("grant without a current agreement also cuts off product and machine access", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_uuid", (q) => q.eq("id", w.userId))
        .unique();
      await ctx.db.patch(user!._id, { previewAgreementVersion: "old" });
    });
    await expect(w.person.query(api.projects.get, { projectId: w.projectId })).rejects.toThrow(
      code("preview_agreement_required"),
    );
    await expect(w.runner.query(api.runnerJobs.wake, {})).rejects.toThrow(
      code("preview_access_required"),
    );
    await expect(w.agent.query(api.projects.get, { projectId: w.projectId })).rejects.toThrow(
      code("preview_access_required"),
    );
  });

  test("revocation between approval and exchange blocks both linking methods and credential refresh", async () => {
    const w = await world();
    const install = await w.person.action(api.runners.createInstallToken, {
      nameHint: null,
      defaultWorkspaceId: null,
    });
    const desktop = await w.person.action(api.runners.registerThisMac, { host, name: null });
    const requestId = newId("runner");
    const pollSecretHash = secretHash("poll");
    await w.t.mutation(internal.runners.startDeviceLink, {
      requestId,
      userCodeHash: secretHash("BCDFGHJK"),
      pollSecretHash,
      host,
      ip: "192.0.2.1",
    });
    await w.person.mutation(api.runners.decideLink, {
      requestId,
      userCode: "BCDFGHJK",
      decision: "approve",
    });
    await w.t.mutation(internal.previewAccess.set, {
      kind: "user",
      value: w.userId,
      enabled: false,
    });
    await expect(
      w.person.mutation(api.runners.decideLink, {
        requestId,
        userCode: "BCDFGHJK",
        decision: "approve",
      }),
    ).rejects.toThrow(code("preview_waitlisted"));
    await expect(
      w.t.mutation(internal.runners.linkWithInstallToken, {
        tokenHash: secretHash(install.installToken),
        credentialHash: secretHash("new"),
        host,
        name: null,
      }),
    ).resolves.toEqual({ ok: false, code: "invalid_install_token" });
    await expect(
      w.t.mutation(internal.runners.pollDeviceLink, {
        requestId,
        pollSecretHash,
        credentialHash: secretHash("new"),
      }),
    ).resolves.toEqual({ ok: true, status: "denied" });
    await expect(
      w.t.mutation(internal.runners.rotateCredential, {
        runnerId: desktop.runnerId,
        presentedHash: secretHash(desktop.credential),
        nextHash: secretHash("next"),
        ip: null,
      }),
    ).resolves.toEqual({ ok: false, code: "preview_access_required" });
    const stored = await w.t.run(async (ctx) => ({
      token: await ctx.db
        .query("runnerInstallTokens")
        .withIndex("by_uuid", (q) => q.eq("id", install.installTokenId))
        .unique(),
      credential: await ctx.db
        .query("runnerCredentials")
        .withIndex("by_runner", (q) => q.eq("runnerId", desktop.runnerId))
        .unique(),
    }));
    expect(stored.token!.usedAt).toBeNull();
    expect(stored.credential!.currentHash).toBe(secretHash(desktop.credential));
    await w.t.mutation(internal.previewAccess.set, {
      kind: "user",
      value: w.userId,
      enabled: true,
    });
    await expect(
      w.t.mutation(internal.runners.rotateCredential, {
        runnerId: desktop.runnerId,
        presentedHash: secretHash(desktop.credential),
        nextHash: secretHash("next"),
        ip: null,
      }),
    ).resolves.toMatchObject({ ok: true, generation: 2 });
    await w.t.run(async (ctx) => {
      const credential = await ctx.db
        .query("runnerCredentials")
        .withIndex("by_runner", (q) => q.eq("runnerId", desktop.runnerId))
        .unique();
      await ctx.db.patch(credential!._id, { currentFirstUsedAt: Date.now() });
    });
    await w.t.mutation(internal.previewAccess.set, {
      kind: "user",
      value: w.userId,
      enabled: false,
    });
    const refresh = (presented: string) =>
      w.t.mutation(internal.runners.rotateCredential, {
        runnerId: desktop.runnerId,
        presentedHash: secretHash(presented),
        nextHash: secretHash("later"),
        ip: null,
      });
    // A pause neither reveals itself to a bad credential nor disables reuse detection.
    await expect(refresh("wrong")).resolves.toEqual({ ok: false, code: "invalid_credential" });
    await expect(refresh(desktop.credential)).resolves.toEqual({ ok: false, code: "revoked" });
  });
});
