/**
 * The BYO lane's view of the pinned local backend (VC-1043), over Convex's
 * plain HTTP API (`POST /api/{query,mutation,action}`): no Convex client
 * dependency, so this directory runs before `apps/runner` has a manifest.
 *
 * Everything here is SETUP or EVIDENCE, never the behaviour under test:
 * - the person (a test-issuer token, preview access granted with the
 *   fixture's admin key, the current Preview Agreement accepted) and their
 *   project, through the same public functions the app calls;
 * - the deployment's GitHub App pointed at the fake GitHub, and the person's
 *   GitHub connected and installed through the backend's own callback and
 *   setup routes (the driver plays the browser);
 * - install tokens and the runners list, as Settings → Runners reads them.
 *
 * The admin key and the issuer's private key come from
 * `convex/fixture/with-backend.ts --deploy`. Neither is ever written to
 * evidence; the person's tokens are minted in memory per call.
 */

import { randomUUID } from "node:crypto";

import { mintTestToken } from "../../../../convex/fixture/jwt.ts";
// `preview-legal.ts` has no imports of its own, so plain Node loads it (the
// cloud barrel re-exports it under extensionless paths Node cannot resolve).
// It is the version `PREVIEW_ENROLLMENT_AGREEMENT_VERSION` aliases.
import { PREVIEW_AGREEMENT_VERSION } from "../../../../packages/shared/src/preview-legal.ts";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function loopbackUrl(name, raw) {
  let url;
  try {
    url = new URL(raw ?? "");
  } catch {
    throw new Error(`${name} is not a URL: run under \`convex/fixture/with-backend.ts --deploy\``);
  }
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname)) {
    throw new Error(`${name} must be the loopback fixture backend, not ${url.origin}`);
  }
  return url.origin;
}

/**
 * The fixture backend from `with-backend.ts --deploy`'s environment. Refuses
 * anything but a loopback backend with a test issuer and an admin key: this
 * lane never points at a real deployment.
 */
export function fixtureFromEnv(env = process.env) {
  const privateKeyPem = env.VOLLI_CONVEX_TEST_PRIVATE_KEY ?? "";
  if (!privateKeyPem.includes("PRIVATE KEY")) {
    throw new Error("VOLLI_CONVEX_TEST_PRIVATE_KEY is missing: run under `with-backend --deploy`");
  }
  const adminKey = env.VOLLI_CONVEX_ADMIN_KEY ?? "";
  if (adminKey === "")
    throw new Error("VOLLI_CONVEX_ADMIN_KEY is missing: run under `with-backend --deploy`");
  return {
    convexUrl: loopbackUrl("VOLLI_CONVEX_URL", env.VOLLI_CONVEX_URL),
    siteUrl: loopbackUrl("VOLLI_CONVEX_SITE_URL", env.VOLLI_CONVEX_SITE_URL),
    privateKeyPem,
    adminKey,
  };
}

/** A Convex function failed: `data` is its `ConvexError` payload, when it threw one. */
export class ConvexCallError extends Error {
  constructor(path, message, data) {
    super(`${path}: ${message}`);
    this.path = path;
    this.data = data ?? null;
    this.code = typeof data?.code === "string" ? data.code : null;
  }
}

/**
 * Call one function. `auth` is `{ bearer }` (a person or runner token) or
 * `{ admin }` (the fixture's admin key, which may also call internal
 * functions). Answers the function's value or throws {@link ConvexCallError}.
 */
export async function convexCall(convexUrl, kind, path, args = {}, auth = {}, fetchImpl = fetch) {
  if (!["query", "mutation", "action"].includes(kind))
    throw new Error(`not a function kind: ${kind}`);
  const headers = { "content-type": "application/json" };
  if (auth.bearer) headers.authorization = `Bearer ${auth.bearer}`;
  else if (auth.admin) headers.authorization = `Convex ${auth.admin}`;
  const response = await fetchImpl(`${convexUrl}/api/${kind}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ConvexCallError(path, `HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  if (body?.status === "success") return body.value;
  throw new ConvexCallError(path, body?.errorMessage ?? `HTTP ${response.status}`, body?.errorData);
}

/** Set deployment variables through the admin API (the GitHub App's, here). */
export async function setDeploymentEnv(fixture, values, fetchImpl = fetch) {
  const response = await fetchImpl(`${fixture.convexUrl}/api/update_environment_variables`, {
    method: "POST",
    headers: { authorization: `Convex ${fixture.adminKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      changes: Object.entries(values).map(([name, value]) => ({ name, value })),
    }),
  });
  if (!response.ok) {
    throw new Error(`setting deployment env failed: ${response.status} ${await response.text()}`);
  }
}

/** Admin-only calls against the fixture (seeding and operator steps). */
export function adminOf(fixture, fetchImpl = fetch) {
  const call = (kind) => (path, args) =>
    convexCall(fixture.convexUrl, kind, path, args, { admin: fixture.adminKey }, fetchImpl);
  return { query: call("query"), mutation: call("mutation"), action: call("action") };
}

/**
 * A person on the fixture: `subject` signs in through the test issuer with a
 * verified email, so the backend sees the same identity a real sign-in gives.
 */
export function personOf(fixture, { subject, email, name }, fetchImpl = fetch) {
  const token = () =>
    mintTestToken(fixture.privateKeyPem, subject, {
      claims: { email, email_verified: true, name },
    });
  const call = (kind) => (path, args) =>
    convexCall(fixture.convexUrl, kind, path, args, { bearer: token() }, fetchImpl);
  return {
    subject,
    email,
    name,
    token,
    query: call("query"),
    mutation: call("mutation"),
    action: call("action"),
  };
}

/**
 * SETUP: an enrolled person with a Workspace and one project. Preview access
 * is the admin's grant; the agreement is accepted the way the app's sign-in
 * accepts it; the project is the board's public `projects.create`.
 */
export async function seedPerson(fixture, { subject, email, name, project }, fetchImpl = fetch) {
  const person = personOf(fixture, { subject, email, name }, fetchImpl);
  const admin = adminOf(fixture, fetchImpl);
  const { userId } = await person.mutation("accounts:ensureViewer", {});
  await admin.mutation("previewAccess:set", { kind: "user", value: userId, enabled: true });
  await person.mutation("accounts:ensureViewer", {
    acceptedAgreementVersion: PREVIEW_AGREEMENT_VERSION,
  });
  const workspaces = await person.query("workspaces:listMine", {});
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    throw new Error("the enrolled person has no Workspace");
  }
  const workspaceId = workspaces[0].workspaceId;
  const projectId = randomUUID();
  await person.mutation("projects:create", {
    commandId: randomUUID(),
    workspaceId,
    projectId,
    name: project.name,
    ticketPrefix: project.prefix,
    origin: project.origin ?? "blank",
  });
  return { person, userId, workspaceId, projectId };
}

/**
 * SETUP: connect the person's GitHub through the backend's real connect
 * flow, playing the browser: `beginConnect` → the fake's authorize page →
 * the backend's confirm page → the confirm form's POST. Answers the
 * connection as `github.connection` reads it.
 */
export async function connectGithub(fixture, person, fetchImpl = fetch) {
  const { url } = await person.action("github:beginConnect", { flowId: randomUUID() });
  const authorized = await fetchImpl(url, { redirect: "manual" });
  const callback = authorized.headers.get("location");
  if (authorized.status !== 302 || callback === null) {
    throw new Error(`the fake GitHub did not approve: ${authorized.status}`);
  }
  const back = new URL(callback);
  if (back.origin !== fixture.siteUrl) throw new Error(`refusing to follow ${back.origin}`);
  const confirmPage = await fetchImpl(back, { redirect: "manual" });
  if (!confirmPage.ok) throw new Error(`the confirm page answered ${confirmPage.status}`);
  const confirmed = await fetchImpl(`${back.origin}${back.pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: fixture.siteUrl,
    },
    body: new URLSearchParams({
      code: back.searchParams.get("code") ?? "",
      state: back.searchParams.get("state") ?? "",
    }).toString(),
    redirect: "manual",
  });
  if (!confirmed.ok) {
    throw new Error(
      `the connect confirm answered ${confirmed.status}: ${(await confirmed.text()).slice(0, 300)}`,
    );
  }
  return person.query("github:connection", {});
}

/**
 * SETUP: the person installs the App on an installation the fake already
 * holds: `beginInstall` → (GitHub's install pages, skipped) → the App's
 * Setup URL on the backend with that installation id and the flow's state.
 */
export async function installGithubApp(fixture, person, installationId, fetchImpl = fetch) {
  const flowId = randomUUID();
  const { url } = await person.action("github:beginInstall", { flowId });
  const state = new URL(url).searchParams.get("state") ?? "";
  const setup = new URL(`${fixture.siteUrl}/github/setup`);
  setup.searchParams.set("installation_id", String(installationId));
  setup.searchParams.set("setup_action", "install");
  setup.searchParams.set("state", state);
  const answer = await fetchImpl(setup, { redirect: "manual" });
  if (!answer.ok) {
    throw new Error(
      `the App's setup page answered ${answer.status}: ${(await answer.text()).slice(0, 300)}`,
    );
  }
  return person.query("github:flow", { flowId });
}

/** SETUP: a fresh install token, as Settings → Runners → Add a runner mints one. */
export function createInstallToken(person, nameHint = null) {
  return person.action("runners:createInstallToken", { nameHint, defaultWorkspaceId: null });
}

/** EVIDENCE: the person's runners, as Settings → Runners lists them. */
export function listRunners(person) {
  return person.query("runners:list", {});
}

/** Poll `probe` until it answers non-null, or fail naming `what` and the last answer. */
export async function waitFor(what, probe, { timeoutMs = 60_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await probe();
      if (last !== null && last !== undefined && last !== false) return last;
    } catch (error) {
      last = error;
    }
    if (Date.now() >= deadline) {
      const detail = last instanceof Error ? last.message : JSON.stringify(last);
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what} (last: ${detail})`);
    }
    await new Promise((done) => setTimeout(done, intervalMs));
  }
}

/**
 * SETUP: one more of the person's runners linked through an install token and
 * signed in with its own runner token, the way a Mac's desktop runner is. It
 * never heartbeats; the lane uses it only to report a checkout, as the
 * person's Mac does when it first opens the project's folder.
 */
export async function linkReportingMac(fixture, person, fetchImpl = fetch) {
  const minted = await createInstallToken(person, "byo-mac");
  const linked = await fetchImpl(`${fixture.siteUrl}/runner/link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      installToken: minted.installToken,
      host: {
        hostname: "byo-mac",
        platform: { os: "darwin", arch: "arm64", release: "25.0.0", distro: null },
        installMode: "user",
      },
      name: null,
    }),
  });
  if (!linked.ok) throw new Error(`linking the Mac answered ${linked.status}`);
  const grant = await linked.json();
  const exchanged = await fetchImpl(`${fixture.siteUrl}/runner/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runnerId: grant.runnerId, credential: grant.credential }),
  });
  if (!exchanged.ok) throw new Error(`the Mac's token exchange answered ${exchanged.status}`);
  const { token } = await exchanged.json();
  const call = (kind) => (path, args) =>
    convexCall(fixture.convexUrl, kind, path, args, { bearer: token }, fetchImpl);
  return {
    runnerId: grant.runnerId,
    secrets: [minted.installToken, grant.credential, token],
    query: call("query"),
    mutation: call("mutation"),
  };
}
