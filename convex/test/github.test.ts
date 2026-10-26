/**
 * The GitHub App's backend against a fake GitHub (`github-fake.ts`):
 * connect and install flows, webhooks, reconciles, token refresh and
 * revocation.
 */

import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { formatFlowState, newId } from "@volli/shared/cloud";

import { api, internal } from "../functions/_generated/api";
import type { GithubMint } from "../functions/githubTokens";
import schema from "../functions/schema";
import { seedWorkspace as seedWorkspaceOf, signIn } from "./board-helpers";
import {
  APP_ID,
  CLIENT_ID,
  OLD_WEBHOOK_SECRET,
  SITE,
  SLUG,
  WEB,
  WEBHOOK_SECRET,
  installFakeGithub,
  signBody,
  type FakeGithub,
} from "./github-fake";
import { enrollPreview } from "./preview-fixtures";

let github: FakeGithub;

const modules = {
  ...import.meta.glob("../functions/**/*.ts"),
  // Test-only: `mintGithubToken` as an action (`github-mint.module.ts`).
  "../functions/githubTokensTest.ts": () => import("./github-mint.module"),
};
function setup() {
  return convexTest(schema, modules);
}
type Tester = ReturnType<typeof setup>;
const mintRef = makeFunctionReference<"action", { userId: string }, GithubMint>(
  "githubTokensTest:mint",
);
const seedWorkspace = (t: Tester, userId: string) => seedWorkspaceOf(t as never, [{ userId }]);

beforeEach(async () => {
  github = await installFakeGithub();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const DANA = { id: 501, login: "dana", name: "Dana Doe" };

/** Runs scheduled functions (reconciles, revokes) to completion. */
async function settle(t: Tester) {
  vi.useFakeTimers();
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.useRealTimers();
}

async function connect(t: Tester, name: string, githubUser: { id: number; login: string }) {
  const person = await signIn(t as never, name);
  if (!github.users.has(githubUser.id)) github.addUser(githubUser);
  const flowId = newId("githubFlow");
  const { url } = await person.as.action(api.github.beginConnect, { flowId });
  const { code: authCode, state } = github.authorize(url, githubUser.id);
  const confirm = await t.fetch(
    `/github/oauth/callback?code=${authCode}&state=${encodeURIComponent(state)}`,
  );
  const page = await confirm.text();
  const response = await confirmConnect(t, authCode, state);
  return { ...person, flowId, url, state, page, response };
}

/** What the confirm page's form posts. */
function confirmConnect(t: Tester, authCode: string, state: string, origin = SITE) {
  return t.fetch("/github/oauth/callback", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin },
    body: new URLSearchParams({ code: authCode, state }).toString(),
  });
}

async function deliver(
  t: Tester,
  event: string,
  payload: unknown,
  options: { id?: string; secret?: string; appId?: string } = {},
) {
  const body = JSON.stringify(payload);
  return t.fetch("/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": options.id ?? crypto.randomUUID(),
      "x-github-hook-installation-target-type": "integration",
      "x-github-hook-installation-target-id": options.appId ?? APP_ID,
      "x-hub-signature-256": await signBody(options.secret ?? WEBHOOK_SECRET, body),
    },
    body,
  });
}

async function seedRepo(
  t: Tester,
  repo: { githubRepoId: string; installationId: string; owner: string; name: string },
) {
  const projectId = newId("project");
  await t.run(async (ctx) => {
    await ctx.db.insert("projectRepos", {
      id: newId("projectRepo"),
      projectId,
      role: "primary",
      position: "a0",
      provider: "github",
      githubRepoId: repo.githubRepoId,
      installationId: repo.installationId,
      owner: repo.owner,
      name: repo.name,
      baseBranch: null,
      defaultBranchCache: "main",
      dirName: repo.name,
      githubAccess: "ok",
      accessCheckedAt: 0,
    });
  });
  return projectId;
}

const repoRow = (t: Tester, githubRepoId: string) =>
  t.run((ctx) =>
    ctx.db
      .query("projectRepos")
      .withIndex("by_github_repo", (q) => q.eq("githubRepoId", githubRepoId))
      .first(),
  );

describe("connect", () => {
  test("the authorize URL carries the App's client, the callback, the state and a PKCE challenge", async () => {
    const t = setup();
    const { as } = await signIn(t as never, "dana");
    const flowId = newId("githubFlow");
    const { url } = await as.action(api.github.beginConnect, { flowId });
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(`${WEB}/login/oauth/authorize`);
    expect(parsed.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "https://volli.convex.site.test/github/oauth/callback",
    );
    expect(parsed.searchParams.get("state")!.startsWith(`${flowId}.`)).toBe(true);
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(await as.query(api.github.flow, { flowId })).toMatchObject({
      purpose: "connect",
      status: "pending",
    });
  });

  test("the callback stores the sealed pair, the profile and the link; queries never show a token", async () => {
    const t = setup();
    github.addUser({
      ...DANA,
      emails: [
        { email: "dana@example.test", primary: true, verified: true, visibility: "public" },
        { email: "unverified@example.test", primary: false, verified: false, visibility: null },
      ],
    });
    const { as, userId, flowId, response } = await connect(t, "dana", DANA);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Connected as @dana");
    expect(await as.query(api.github.flow, { flowId })).toMatchObject({
      status: "done",
      accountLogin: "dana",
    });
    const summary = await as.query(api.github.connection, {});
    expect(summary).toMatchObject({
      status: "active",
      login: "dana",
      name: "Dana Doe",
      githubUserId: "501",
    });
    expect(JSON.stringify(summary)).not.toContain("ghu_");
    const stored = await t.run(async (ctx) => ({
      connection: await ctx.db.query("githubConnections").first(),
      link: await ctx.db.query("externalAccounts").first(),
    }));
    expect(stored.connection!.emails.map((email) => email.email)).toEqual(["dana@example.test"]);
    expect(stored.link).toMatchObject({
      userId,
      provider: "github",
      providerUserId: "501",
      login: "dana",
    });
    const ciphertext = new TextDecoder("latin1").decode(stored.connection!.accessToken!.ciphertext);
    expect(ciphertext).not.toContain("ghu_");
    // The sealed token opens to the live one.
    const mint = await t.action(mintRef, { userId });
    expect(mint).toMatchObject({ ok: true, login: "dana", githubUserId: "501" });
    expect(github.tokensOf(DANA.id)).toContain((mint as { token: string }).token);
  });

  test("a flow finishes once; a replay, a forged state and an expired flow are refused", async () => {
    const t = setup();
    const { state, as, flowId } = await connect(t, "dana", DANA);
    const replay = await t.fetch(
      `/github/oauth/callback?code=x&state=${encodeURIComponent(state)}`,
    );
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain("already used");
    const forged = await t.fetch(
      `/github/oauth/callback?code=x&state=${encodeURIComponent(formatFlowState(flowId, "b".repeat(43)))}`,
    );
    expect(await forged.text()).toContain("isn&#39;t valid");
    expect(await (await t.fetch(`/github/oauth/callback?code=x&state=junk`)).text()).toContain(
      "isn&#39;t valid",
    );

    const late = newId("githubFlow");
    const { url } = await as.action(api.github.beginConnect, { flowId: late });
    const { code: authCode, state: lateState } = github.authorize(url, DANA.id);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("githubFlows")
        .withIndex("by_uuid", (q) => q.eq("id", late))
        .unique();
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 });
    });
    const expired = await confirmConnect(t, authCode, lateState);
    expect(await expired.text()).toContain("expired");
    expect(await as.query(api.github.flow, { flowId: late })).toMatchObject({
      status: "failed",
      error: "flow_expired",
    });
    // A flow id is single use, and nobody else reads someone's flow.
    await expect(as.action(api.github.beginConnect, { flowId })).rejects.toThrow();
    const sam = await signIn(t as never, "sam");
    expect(await sam.as.query(api.github.flow, { flowId })).toBeNull();
  });

  test("declining on GitHub fails the flow", async () => {
    const t = setup();
    const { as } = await signIn(t as never, "dana");
    const flowId = newId("githubFlow");
    const { url } = await as.action(api.github.beginConnect, { flowId });
    const state = new URL(url).searchParams.get("state")!;
    const response = await t.fetch(
      `/github/oauth/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    );
    expect(response.status).toBe(400);
    expect(await as.query(api.github.flow, { flowId })).toMatchObject({
      status: "failed",
      error: "github_denied",
    });
  });

  test("the callback only asks; the connect needs the confirm, posted from this site", async () => {
    const t = setup();
    github.addUser(DANA);
    const { as } = await signIn(t as never, "dana");
    const flowId = newId("githubFlow");
    const { url } = await as.action(api.github.beginConnect, { flowId });
    const { code: authCode, state } = github.authorize(url, DANA.id);
    const asked = await t.fetch(
      `/github/oauth/callback?code=${authCode}&state=${encodeURIComponent(state)}`,
    );
    const page = await asked.text();
    expect(page).toContain("to a Volli account with no verified email?");
    expect(page).toContain("close this tab");
    expect(page).toContain(`<form method="post" action="/github/oauth/callback">`);
    expect(asked.headers.get("x-frame-options")).toBe("DENY");
    expect(await as.query(api.github.flow, { flowId })).toMatchObject({ status: "pending" });
    expect(github.codes.has(authCode)).toBe(true);
    const crossSite = await confirmConnect(t, authCode, state, "https://evil.test");
    expect(crossSite.status).toBe(400);
    expect(await as.query(api.github.connection, {})).toBeNull();
    expect((await confirmConnect(t, authCode, state)).status).toBe(200);
    expect(await as.query(api.github.connection, {})).toMatchObject({ login: "dana" });
  });

  test("a double-posted confirm connects once", async () => {
    const t = setup();
    github.addUser(DANA);
    const { as } = await signIn(t as never, "dana");
    const flowId = newId("githubFlow");
    const { url } = await as.action(api.github.beginConnect, { flowId });
    const { code: authCode, state } = github.authorize(url, DANA.id);
    const [first, second] = await Promise.all([
      confirmConnect(t, authCode, state),
      confirmConnect(t, authCode, state),
    ]);
    const pages = [await first.text(), await second.text()];
    expect(pages.some((text) => text.includes("Connected as @dana"))).toBe(true);
    expect(pages.every((text) => !text.includes("couldn"))).toBe(true);
    expect(await as.query(api.github.flow, { flowId })).toMatchObject({ status: "done" });
  });

  test("the confirm names the account by its verified email, never its chosen name", async () => {
    const t = setup();
    const as = t.withIdentity({
      subject: "user:mallory",
      issuer: "https://issuer.test",
      name: "Alice Smith (alice@acme.test)",
      email: "mallory@evil.test",
      email_verified: true,
    } as never);
    const { userId: mallory } = await as.mutation(api.accounts.ensureViewer, {});
    await enrollPreview(t, mallory);
    const { url } = await as.action(api.github.beginConnect, { flowId: newId("githubFlow") });
    github.addUser(DANA);
    const { code: authCode, state } = github.authorize(url, DANA.id);
    const page = await (
      await t.fetch(`/github/oauth/callback?code=${authCode}&state=${encodeURIComponent(state)}`)
    ).text();
    expect(page).toContain("the Volli account mallory@evil.test?");
    expect(page).not.toContain("Alice");
  });

  test("one Volli account per GitHub account", async () => {
    const t = setup();
    await connect(t, "dana", DANA);
    const second = await connect(t, "dana-alt", DANA);
    expect(await second.response.text()).toContain("another Volli account");
    expect(await second.as.query(api.github.flow, { flowId: second.flowId })).toMatchObject({
      status: "failed",
      error: "account_already_linked",
    });
    expect(await second.as.query(api.github.connection, {})).toBeNull();
  });

  test("without an App configured, starting refuses and the routes answer 503", async () => {
    const t = setup();
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "");
    const { as } = await signIn(t as never, "dana");
    expect(await as.query(api.github.config, {})).toEqual({ configured: false });
    await expect(
      as.action(api.github.beginConnect, { flowId: newId("githubFlow") }),
    ).rejects.toThrow(/isn't set up/);
    expect((await t.fetch("/github/oauth/callback?code=x")).status).toBe(503);
    expect((await t.fetch("/github/webhook", { method: "POST", body: "{}" })).status).toBe(503);
  });
});

const ACME = {
  id: 77,
  account: { id: 9001, login: "acme", type: "Organization" as const },
};

describe("install", () => {
  test("needs a connection", async () => {
    const t = setup();
    const { as, userId } = await signIn(t as never, "dana");
    const workspaceId = await seedWorkspace(t, userId);
    await expect(
      as.action(api.github.beginInstall, { flowId: newId("githubFlow"), workspaceId }),
    ).rejects.toThrow(
      expect.objectContaining({ data: expect.objectContaining({ code: "not_connected" }) }),
    );
  });

  test("a verified installation is recorded and the flow completes", async () => {
    const t = setup();
    github.addInstallation({
      ...ACME,
      repositories: [
        {
          id: 3001,
          name: "api",
          owner: { login: "acme" },
          default_branch: "main",
          archived: false,
        },
      ],
    });
    github.addUser({ ...DANA, installations: [ACME.id] });
    const { as, userId } = await connect(t, "dana", DANA);
    const workspaceId = await seedWorkspace(t, userId);
    const flowId = newId("githubFlow");
    const { url } = await as.action(api.github.beginInstall, { flowId, workspaceId });
    expect(url.startsWith(`${WEB}/apps/${SLUG}/installations/select_target?state=`)).toBe(true);
    const targeted = await as.action(api.github.beginInstall, {
      flowId: newId("githubFlow"),
      workspaceId,
      targetId: "9001",
    });
    expect(new URL(targeted.url).searchParams.get("target_id")).toBe("9001");
    const state = new URL(url).searchParams.get("state")!;
    const response = await t.fetch(
      `/github/setup?installation_id=77&setup_action=install&state=${encodeURIComponent(state)}`,
    );
    expect(await response.text()).toContain("installed on acme");
    expect(await as.query(api.github.flow, { flowId })).toMatchObject({
      status: "done",
      installationId: "77",
      accountLogin: "acme",
    });
    const row = await t.run((ctx) => ctx.db.query("githubInstallations").first());
    expect(row).toMatchObject({
      installationId: "77",
      accountId: "9001",
      accountType: "org",
      installedByUserId: userId,
      deletedAt: null,
    });
    const listed = await as.action(api.github.installations, { workspaceId });
    expect(listed.connection).toBe("active");
    expect(listed.installations).toEqual([
      expect.objectContaining({
        installationId: "77",
        accountLogin: "acme",
        visible: true,
        projects: 0,
        configureUrl: `${WEB}/organizations/acme/settings/installations/77`,
      }),
    ]);
  });

  test("an installation id the person cannot see is refused", async () => {
    const t = setup();
    github.addInstallation(ACME);
    github.addUser(DANA);
    const { as, userId } = await connect(t, "dana", DANA);
    const flowId = newId("githubFlow");
    const { url } = await as.action(api.github.beginInstall, {
      flowId,
      workspaceId: await seedWorkspace(t, userId),
    });
    const state = new URL(url).searchParams.get("state")!;
    const response = await t.fetch(
      `/github/setup?installation_id=77&state=${encodeURIComponent(state)}`,
    );
    expect(response.status).toBe(400);
    expect(await as.query(api.github.flow, { flowId })).toMatchObject({
      status: "failed",
      error: "installation_not_visible",
    });
    expect(await t.run((ctx) => ctx.db.query("githubInstallations").first())).toBeNull();
  });

  test("an organization request completes when the installation's webhook names the requester", async () => {
    const t = setup();
    github.addUser(DANA);
    const { as, userId } = await connect(t, "dana", DANA);
    const flowId = newId("githubFlow");
    const { url } = await as.action(api.github.beginInstall, {
      flowId,
      workspaceId: await seedWorkspace(t, userId),
    });
    const state = new URL(url).searchParams.get("state")!;
    const response = await t.fetch(
      `/github/setup?setup_action=request&state=${encodeURIComponent(state)}`,
    );
    expect(await response.text()).toContain("Request sent");
    expect(await as.query(api.github.flow, { flowId })).toMatchObject({ status: "requested" });
    const installation = github.addInstallation(ACME);
    const delivered = await deliver(t, "installation", {
      action: "created",
      installation,
      requester: { id: DANA.id, login: "dana" },
    });
    expect(delivered.status).toBe(202);
    expect(await as.query(api.github.flow, { flowId })).toMatchObject({
      status: "done",
      installationId: "77",
      accountLogin: "acme",
    });
  });

  test("a setup redirect without a flow just points back to Volli", async () => {
    const t = setup();
    expect(await (await t.fetch("/github/setup?installation_id=77")).text()).toContain(
      "Open Volli",
    );
    expect(
      await (
        await t.fetch(
          `/github/setup?installation_id=77&state=${newId("githubFlow")}.${"c".repeat(43)}`,
        )
      ).text(),
    ).toContain("Open Volli");
  });
});

describe("webhooks", () => {
  test("a valid signature is accepted under the current and the previous secret", async () => {
    const t = setup();
    const installation = github.addInstallation(ACME);
    expect((await deliver(t, "installation", { action: "created", installation })).status).toBe(
      202,
    );
    expect((await deliver(t, "ping", { zen: "hi" }, { secret: OLD_WEBHOOK_SECRET })).status).toBe(
      202,
    );
    const rows = await t.run((ctx) => ctx.db.query("githubWebhookDeliveries").collect());
    expect(rows.map((row) => [row.event, row.outcome])).toEqual([
      ["installation", "applied"],
      ["ping", "ignored"],
    ]);
  });

  test("a bad signature, another App's delivery and a malformed one write nothing", async () => {
    const t = setup();
    const installation = github.addInstallation(ACME);
    expect(
      (await deliver(t, "installation", { action: "created", installation }, { secret: "nope" }))
        .status,
    ).toBe(401);
    expect(
      (await deliver(t, "installation", { action: "created", installation }, { appId: "2002" }))
        .status,
    ).toBe(401);
    const body = "not json";
    const malformed = await t.fetch("/github/webhook", {
      method: "POST",
      headers: {
        "x-github-event": "installation",
        "x-github-delivery": "d-1",
        "x-github-hook-installation-target-type": "integration",
        "x-github-hook-installation-target-id": APP_ID,
        "x-hub-signature-256": await signBody(WEBHOOK_SECRET, body),
      },
      body,
    });
    expect(malformed.status).toBe(400);
    expect(await t.run((ctx) => ctx.db.query("githubWebhookDeliveries").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("githubInstallations").collect())).toEqual([]);
  });

  test("a redelivered webhook is a no-op", async () => {
    const t = setup();
    const installation = github.addInstallation(ACME);
    await deliver(t, "installation", { action: "created", installation }, { id: "same" });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("githubInstallations").first();
      await ctx.db.patch(row!._id, { accountLogin: "changed-since" });
    });
    expect(
      (await deliver(t, "installation", { action: "created", installation }, { id: "same" }))
        .status,
    ).toBe(202);
    const rows = await t.run(async (ctx) => ({
      deliveries: await ctx.db.query("githubWebhookDeliveries").collect(),
      installation: await ctx.db.query("githubInstallations").first(),
    }));
    expect(rows.deliveries).toHaveLength(1);
    expect(rows.installation!.accountLogin).toBe("changed-since");
  });

  test("removing the App blocks the project's repository; a reinstall restores it", async () => {
    const t = setup();
    const repo = {
      id: 3001,
      name: "api",
      owner: { login: "acme" },
      default_branch: "main",
      archived: false,
    };
    const installation = github.addInstallation({ ...ACME, repositories: [repo] });
    await deliver(t, "installation", { action: "created", installation });
    await seedRepo(t, { githubRepoId: "3001", installationId: "77", owner: "acme", name: "api" });
    await deliver(t, "installation", { action: "deleted", installation });
    expect(await repoRow(t, "3001")).toMatchObject({ githubAccess: "app_removed" });
    expect(await t.run((ctx) => ctx.db.query("githubInstallations").first())).toMatchObject({
      deletedAt: expect.any(Number),
    });
    github.installations.delete(77);
    const again = github.addInstallation({ ...ACME, id: 78, repositories: [repo] });
    await deliver(t, "installation", { action: "created", installation: again });
    await settle(t);
    expect(await repoRow(t, "3001")).toMatchObject({ githubAccess: "ok", installationId: "78" });
  });

  test("a suspension blocks, and an unsuspend reconciles back", async () => {
    const t = setup();
    const repo = {
      id: 3001,
      name: "api",
      owner: { login: "acme" },
      default_branch: "main",
      archived: false,
    };
    const installation = github.addInstallation({ ...ACME, repositories: [repo] });
    await seedRepo(t, { githubRepoId: "3001", installationId: "77", owner: "acme", name: "api" });
    await deliver(t, "installation", {
      action: "suspend",
      installation: { ...installation, suspended_at: "x" },
    });
    expect(await repoRow(t, "3001")).toMatchObject({ githubAccess: "app_removed" });
    await deliver(t, "installation", { action: "unsuspend", installation });
    await settle(t);
    expect(await repoRow(t, "3001")).toMatchObject({ githubAccess: "ok" });
  });

  test("a repository removed from the selection is not_in_installation", async () => {
    const t = setup();
    const installation = github.addInstallation(ACME);
    await seedRepo(t, { githubRepoId: "3001", installationId: "77", owner: "acme", name: "api" });
    await deliver(t, "installation_repositories", {
      action: "removed",
      installation,
      repositories_removed: [{ id: 3001 }],
    });
    await settle(t);
    expect(await repoRow(t, "3001")).toMatchObject({ githubAccess: "not_in_installation" });
  });

  test("renames delivered out of order converge on the API's current name", async () => {
    const t = setup();
    const repo = {
      id: 3001,
      name: "api-v3",
      owner: { login: "acme" },
      default_branch: "trunk",
      archived: false,
    };
    github.addInstallation({ ...ACME, repositories: [repo] });
    await seedRepo(t, { githubRepoId: "3001", installationId: "77", owner: "acme", name: "api" });
    // The second rename's delivery arrives first; each only nudges a reconcile.
    await deliver(t, "repository", {
      action: "renamed",
      repository: { id: 3001, name: "api-v3" },
      installation: { id: 77 },
    });
    await deliver(t, "repository", {
      action: "renamed",
      repository: { id: 3001, name: "api-v2" },
      installation: { id: 77 },
    });
    await settle(t);
    expect(await repoRow(t, "3001")).toMatchObject({
      name: "api-v3",
      defaultBranchCache: "trunk",
      githubAccess: "ok",
    });
    repo.archived = true;
    await deliver(t, "repository", {
      action: "archived",
      repository: { id: 3001 },
      installation: { id: 77 },
    });
    await settle(t);
    expect(await repoRow(t, "3001")).toMatchObject({ githubAccess: "archived" });
    await deliver(t, "repository", {
      action: "deleted",
      repository: { id: 3001 },
      installation: { id: 77 },
    });
    expect(await repoRow(t, "3001")).toMatchObject({ githubAccess: "deleted" });
  });

  test("repository events for repositories no project uses are ignored", async () => {
    const t = setup();
    await deliver(t, "repository", {
      action: "renamed",
      repository: { id: 4242 },
      installation: { id: 77 },
    });
    expect(await t.run((ctx) => ctx.db.query("githubWebhookDeliveries").first())).toMatchObject({
      outcome: "ignored",
    });
  });

  test("account renames converge on the API's current login, whatever the delivery order", async () => {
    const t = setup();
    const installation = github.addInstallation(ACME);
    await deliver(t, "installation", { action: "created", installation });
    await settle(t);
    installation.account.login = "acme-inc";
    // The newer rename's delivery arrives first.
    for (const login of ["acme-inc", "acme-co"]) {
      await deliver(t, "installation_target", {
        action: "renamed",
        installation: { id: 77 },
        account: { id: 9001, login },
      });
    }
    await settle(t);
    expect(await t.run((ctx) => ctx.db.query("githubInstallations").first())).toMatchObject({
      accountLogin: "acme-inc",
    });
  });

  test("a late suspend does not block repositories GitHub has unsuspended", async () => {
    const t = setup();
    const repo = {
      id: 3001,
      name: "api",
      owner: { login: "acme" },
      default_branch: "main",
      archived: false,
    };
    const installation = github.addInstallation({ ...ACME, repositories: [repo] });
    await seedRepo(t, { githubRepoId: "3001", installationId: "77", owner: "acme", name: "api" });
    await deliver(t, "installation", { action: "unsuspend", installation });
    await deliver(t, "installation", {
      action: "suspend",
      installation: { ...installation, suspended_at: "2026-10-25T00:00:00Z" },
    });
    await settle(t);
    expect(await repoRow(t, "3001")).toMatchObject({ githubAccess: "ok" });
    expect(await t.run((ctx) => ctx.db.query("githubInstallations").first())).toMatchObject({
      suspendedAt: null,
    });
  });

  test("a revoked authorization forgets the tokens, but a late revoke spares a newer connect", async () => {
    const t = setup();
    const { as, userId } = await connect(t, "dana", DANA);
    // The token still works: a revoke from before this connect.
    await deliver(t, "github_app_authorization", { action: "revoked", sender: { id: DANA.id } });
    await settle(t);
    expect(await as.query(api.github.connection, {})).toMatchObject({ status: "active" });
    // Revoked on GitHub for real.
    github.access.clear();
    github.refresh.clear();
    await deliver(t, "github_app_authorization", { action: "revoked", sender: { id: DANA.id } });
    await settle(t);
    expect(await as.query(api.github.connection, {})).toMatchObject({ status: "revoked" });
    expect(await t.action(mintRef, { userId })).toMatchObject({
      ok: false,
      code: "not_connected",
    });
  });
});

async function expireAccess(t: Tester) {
  await t.run(async (ctx) => {
    const row = await ctx.db.query("githubConnections").first();
    await ctx.db.patch(row!._id, { accessExpiresAt: Date.now() + 60_000 });
  });
}

describe("tokens", () => {
  test("two concurrent mints of a due token cause one refresh", async () => {
    const t = setup();
    const { userId } = await connect(t, "dana", DANA);
    await expireAccess(t);
    const [a, b] = await Promise.all([
      t.action(mintRef, { userId }),
      t.action(mintRef, { userId }),
    ]);
    expect(github.refreshCalls).toBe(1);
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
    expect((a as { token: string }).token).toBe((b as { token: string }).token);
    expect(github.tokensOf(DANA.id)).toEqual([(a as { token: string }).token]);
  });

  test("a refused refresh token needs a reconnect", async () => {
    const t = setup();
    const { as, userId } = await connect(t, "dana", DANA);
    await expireAccess(t);
    github.refresh.clear();
    expect(await t.action(mintRef, { userId })).toMatchObject({
      ok: false,
      code: "needs_reconnect",
    });
    expect(await as.query(api.github.connection, {})).toMatchObject({ status: "needs_reconnect" });
    // Installing needs a working connection.
    await expect(
      as.action(api.github.beginInstall, {
        flowId: newId("githubFlow"),
        workspaceId: await seedWorkspace(t, userId),
      }),
    ).rejects.toThrow(
      expect.objectContaining({ data: expect.objectContaining({ code: "needs_reconnect" }) }),
    );
    // Reconnecting restores it.
    await connect(t, "dana", DANA);
    expect(await as.query(api.github.connection, {})).toMatchObject({ status: "active" });
  });

  test("a refresh token past its lifetime reads as needing a reconnect", async () => {
    const t = setup();
    const { as, userId } = await connect(t, "dana", DANA);
    await t.run(async (ctx) => {
      const row = await ctx.db.query("githubConnections").first();
      await ctx.db.patch(row!._id, { accessExpiresAt: Date.now(), refreshExpiresAt: Date.now() });
    });
    expect(await as.query(api.github.connection, {})).toMatchObject({ status: "needs_reconnect" });
    expect(await t.action(mintRef, { userId })).toMatchObject({
      ok: false,
      code: "needs_reconnect",
    });
    expect(github.refreshCalls).toBe(0);
  });

  test("GitHub down during a refresh is unavailable, and the lease is released", async () => {
    const t = setup();
    const { userId } = await connect(t, "dana", DANA);
    await expireAccess(t);
    github.down = /oauth/u;
    expect(await t.action(mintRef, { userId })).toMatchObject({
      ok: false,
      code: "github_unavailable",
    });
    github.down = null;
    expect(await t.action(mintRef, { userId })).toMatchObject({ ok: true });
  });
});

describe("revocation", () => {
  test("disconnect revokes the grant on GitHub and forgets the connection", async () => {
    const t = setup();
    const { as } = await connect(t, "dana", DANA);
    await as.action(api.github.disconnect, {});
    expect(github.revokedGrants).toEqual([DANA.id]);
    expect(github.tokensOf(DANA.id)).toEqual([]);
    expect(await as.query(api.github.connection, {})).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("externalAccounts").collect())).toEqual([]);
  });

  test("disconnect keeps the connection when GitHub is down", async () => {
    const t = setup();
    const { as } = await connect(t, "dana", DANA);
    github.down = /grant/u;
    await expect(as.action(api.github.disconnect, {})).rejects.toThrow(
      expect.objectContaining({ data: expect.objectContaining({ code: "github_unavailable" }) }),
    );
    expect(await as.query(api.github.connection, {})).toMatchObject({ status: "active" });
  });

  test("requesting account deletion revokes the grant", async () => {
    const t = setup();
    const { as } = await connect(t, "dana", DANA);
    await as.mutation(api.accounts.requestDeletion, {});
    await settle(t);
    expect(github.revokedGrants).toEqual([DANA.id]);
    expect(await t.run((ctx) => ctx.db.query("githubConnections").collect())).toEqual([]);
  });
});

describe("sweeps", () => {
  test("the sweep redelivers failed deliveries Volli never recorded", async () => {
    const t = setup();
    const now = new Date().toISOString();
    github.deliveries = [
      { id: 1, guid: "g-known", delivered_at: now, status: "Invalid HTTP Response: 500" },
      { id: 2, guid: "g-lost", delivered_at: now, status: "Invalid HTTP Response: 502" },
      { id: 3, guid: "g-ok", delivered_at: now, status: "OK" },
      { id: 4, guid: "g-retried", delivered_at: now, status: "OK" },
      { id: 5, guid: "g-retried", delivered_at: now, status: "timeout" },
      {
        id: 6,
        guid: "g-old",
        delivered_at: new Date(Date.now() - 3 * 86400_000).toISOString(),
        status: "timeout",
      },
    ];
    await t.run((ctx) =>
      ctx.db.insert("githubWebhookDeliveries", {
        deliveryId: "g-known",
        event: "ping",
        action: null,
        installationId: null,
        receivedAt: Date.now(),
        outcome: "ignored",
      }),
    );
    expect(await t.action(internal.githubIngest.sweep, {})).toEqual({ redelivered: 1 });
    expect(github.redelivered).toEqual([2]);
  });

  test("the daily reconcile removes installations GitHub no longer has", async () => {
    vi.useFakeTimers();
    const t = setup();
    const installation = github.addInstallation(ACME);
    await deliver(t, "installation", { action: "created", installation });
    // Finish the webhook's reconcile while GitHub still has the installation.
    // Otherwise it can remove the row before the daily sweep counts it.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.query("githubInstallations").first())).toMatchObject({
      deletedAt: null,
      reconciledAt: expect.any(Number),
    });
    await seedRepo(t, { githubRepoId: "3001", installationId: "77", owner: "acme", name: "api" });
    github.installations.clear();
    expect(await t.action(internal.githubIngest.reconcileAll, {})).toEqual({ removed: 1 });
    expect(await repoRow(t, "3001")).toMatchObject({ githubAccess: "app_removed" });
  });

  test("the purge removes old deliveries and expired flows", async () => {
    const t = setup();
    const { as } = await signIn(t as never, "dana");
    const flowId = newId("githubFlow");
    await as.action(api.github.beginConnect, { flowId });
    await t.run(async (ctx) => {
      await ctx.db.insert("githubWebhookDeliveries", {
        deliveryId: "old",
        event: "ping",
        action: null,
        installationId: null,
        receivedAt: Date.now() - 8 * 86400_000,
        outcome: "ignored",
      });
      const flow = await ctx.db.query("githubFlows").first();
      await ctx.db.patch(flow!._id, { expiresAt: Date.now() - 2 * 3600_000 });
    });
    expect(await t.mutation(internal.githubIngest.purge, {})).toEqual({ removed: 2 });
  });

  test("without an App the sweeps do nothing", async () => {
    const t = setup();
    vi.stubEnv("GITHUB_APP_ID", "");
    expect(await t.action(internal.githubIngest.sweep, {})).toEqual({ redelivered: 0 });
    expect(await t.action(internal.githubIngest.reconcileAll, {})).toEqual({ removed: 0 });
  });
});

test("the connect page refuses an unauthenticated caller", async () => {
  const t = setup();
  await expect(t.query(api.github.connection, {})).rejects.toThrow(/Sign in/);
});
