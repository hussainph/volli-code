/**
 * volli-drive's Volli Cloud fixture (VC-895 N2-3): two isolated dev instances
 * ("Mac A", "Mac B") of ONE person against ONE throwaway pinned local
 * backend (`convex/fixture/with-backend.ts --deploy`).
 *
 * Everything here is SETUP or a double at a boundary the product already
 * isolates, never the behaviour under test:
 *
 * - the instance's environment: the `cloud` flag, the unpackaged dev sign-in
 *   (`VOLLI_ACCOUNT_PROVIDER=dev`, one shared subject so both instances are
 *   the same person), the backend's URLs, and the dual-locked power smoke
 *   seam (`VOLLI_SMOKE_CLOUD_RUNNER_POWER=1`, honoured only unpackaged);
 * - the "browser": the app's sign-in opens the dev issuer's authorize URL
 *   through `shell.openExternal`, which harness mode only records. The
 *   driver follows that recorded loopback URL the way a browser would, and
 *   nothing else;
 * - preview enrollment and the person's project, written through the
 *   backend's own functions (the admin key for enrollment only);
 * - reads for evidence (the person's runners list, this Mac's runner record).
 *
 * The test issuer key reaches the supervisor and Electron through the
 * environment only. It is never written to spec.json, the manifest or any
 * evidence file. It is the fixture's own throwaway key, but it is still
 * kept out of artifacts.
 */
import { execFile } from "node:child_process";
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { exactOrigin } from "../../../src/main/deployment-config.ts";

const exec = promisify(execFile);

/** The built renderer page (`vite.config.ts`'s renderer `outDir`). */
export const BUILT_RENDERER_HTML = fileURLToPath(
  new URL("../../../dist/index.html", import.meta.url),
);

/**
 * Whether the built renderer's CSP reaches the loopback (a build with
 * `VOLLI_CLOUD_LOOPBACK=1`, `src/main/renderer-csp.ts`). Without it the
 * window's own Convex client cannot reach the fixture backend.
 */
export async function rendererAllowsLoopback(path = BUILT_RENDERER_HTML) {
  const html = await fs.readFile(path, "utf8").catch(() => "");
  return html.includes("ws://127.0.0.1:*");
}

/** `apps/desktop/src/main/account/dev-issuer.ts`: the dev issuer's token identity. */
export const DEV_ISSUER = "https://test.volli.invalid";
export const DEV_AUDIENCE = "volli-test";
export const DEV_KEY_ID = "volli-test-1";
/** The dev issuer's default profile (no `email` option is configured in the app). */
export const DEV_EMAIL = "dev-user@volli.invalid";
export const DEV_NAME = "Dev User";

/** The supervisor's own copy of the fixture env (never inherited by name: `VOLLI_*` is scrubbed). */
export const CLOUD_SUPERVISOR_ENV = Object.freeze({
  convexUrl: "VOLLI_DRIVE_CLOUD_CONVEX_URL",
  siteUrl: "VOLLI_DRIVE_CLOUD_SITE_URL",
  storageOrigin: "VOLLI_DRIVE_CLOUD_STORAGE_ORIGIN",
  privateKeyPem: "VOLLI_DRIVE_CLOUD_TEST_KEY",
});

/** The person's project both Macs show. */
export const CLOUD_PROJECT = Object.freeze({ name: "Wake demo", prefix: "WAKE" });

/** The app_state rows this journey reads (registered keys in `@volli/shared`). */
export const CLOUD_LAUNCH_KEY = "volli:cloud-launch";
export const CLOUD_RUNNER_KEY = "volli:cloud-runner";

function loopbackHttpUrl(name, raw) {
  let url;
  try {
    url = new URL(raw ?? "");
  } catch {
    throw new Error(`${name} is not a URL: run under \`convex/fixture/with-backend.ts --deploy\``);
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error(`${name} must be the loopback fixture backend, not ${url.origin}`);
  }
  return raw;
}

function fixtureStorageOrigin(raw) {
  if (!raw) return null;
  return exactOrigin(loopbackHttpUrl("VOLLI_CLOUD_STORAGE_ORIGIN", raw), true);
}

/**
 * The fixture backend, from `with-backend.ts --deploy`'s environment. Refuses
 * anything that is not a loopback backend with a test issuer key: a drive
 * never points at a real deployment.
 */
export function cloudFixtureFromEnv(env = process.env) {
  const convexUrl = loopbackHttpUrl("VOLLI_CONVEX_URL", env.VOLLI_CONVEX_URL);
  const siteUrl = loopbackHttpUrl("VOLLI_CONVEX_SITE_URL", env.VOLLI_CONVEX_SITE_URL);
  const privateKeyPem = env.VOLLI_CONVEX_TEST_PRIVATE_KEY;
  if (!privateKeyPem || !privateKeyPem.includes("PRIVATE KEY")) {
    throw new Error("VOLLI_CONVEX_TEST_PRIVATE_KEY is missing: run under `with-backend --deploy`");
  }
  return {
    convexUrl,
    siteUrl,
    storageOrigin: fixtureStorageOrigin(env.VOLLI_CLOUD_STORAGE_ORIGIN),
    privateKeyPem,
    adminKey: env.VOLLI_CONVEX_ADMIN_KEY ?? null,
  };
}

/** What `cli launch --cloud` hands its supervisor, beside the scrubbed environment. */
export function cloudSupervisorEnv(fixture) {
  return {
    [CLOUD_SUPERVISOR_ENV.convexUrl]: fixture.convexUrl,
    [CLOUD_SUPERVISOR_ENV.siteUrl]: fixture.siteUrl,
    ...(fixture.storageOrigin
      ? { [CLOUD_SUPERVISOR_ENV.storageOrigin]: fixture.storageOrigin }
      : {}),
    [CLOUD_SUPERVISOR_ENV.privateKeyPem]: fixture.privateKeyPem,
  };
}

/** The supervisor reads its copy back; `null` when the launch is not a cloud one. */
export function cloudFixtureFromSupervisorEnv(env = process.env) {
  const convexUrl = env[CLOUD_SUPERVISOR_ENV.convexUrl];
  const siteUrl = env[CLOUD_SUPERVISOR_ENV.siteUrl];
  const privateKeyPem = env[CLOUD_SUPERVISOR_ENV.privateKeyPem];
  if (!convexUrl || !siteUrl || !privateKeyPem) return null;
  return {
    convexUrl: loopbackHttpUrl("cloud fixture URL", convexUrl),
    siteUrl: loopbackHttpUrl("cloud fixture site URL", siteUrl),
    storageOrigin: fixtureStorageOrigin(env[CLOUD_SUPERVISOR_ENV.storageOrigin]),
    privateKeyPem,
  };
}

/** The dev sign-in subject both instances share (one person, two Macs). */
export function cloudSubject(raw) {
  const subject = String(raw ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/u.test(subject)) {
    throw new Error("--cloud-subject is 3-63 lowercase letters, digits and dashes");
  }
  return subject;
}

/**
 * What Electron gets for a cloud instance: the flag, the dev sign-in, the
 * fixture backend and the power smoke seam. Everything else stays
 * `electronExtraEnv`'s.
 */
export function cloudElectronEnv(fixture, subject) {
  return {
    VOLLI_EXPERIMENTAL: "cloud",
    VOLLI_ACCOUNT_PROVIDER: "dev",
    VOLLI_ACCOUNT_DEV_SUBJECT: subject,
    VOLLI_CONVEX_URL: fixture.convexUrl,
    VOLLI_CONVEX_SITE_URL: fixture.siteUrl,
    ...(fixture.storageOrigin ? { VOLLI_CLOUD_STORAGE_ORIGIN: fixture.storageOrigin } : {}),
    VOLLI_CONVEX_TEST_PRIVATE_KEY: fixture.privateKeyPem,
    // Honoured only by an unpackaged build in a Volli Cloud launch (smoke-power.ts).
    VOLLI_SMOKE_CLOUD_RUNNER_POWER: "1",
    // The menu-bar controller on `globalThis.volliMenuBarHost` (unpackaged
    // only): a cloud launch stays resident on an ordinary quit ("Keep this
    // Mac available"), so the driver quits for real the way a person does,
    // through the Tray's Quit Volli (`quitFromTray`). It adds no settle
    // override (that needs VOLLI_SMOKE_MENU_BAR_SETTLE_MS, never set here).
    VOLLI_SMOKE_MENU_BAR_HOST: "1",
  };
}

/**
 * Tray → Quit Volli in a Volli Cloud launch, which stays resident on an
 * ordinary quit ("Keep this Mac available"). It goes through main's own
 * menu-bar controller, `globalThis.volliMenuBarHost`, which only an
 * unpackaged build with `VOLLI_SMOKE_MENU_BAR_HOST=1` exposes (and only
 * {@link cloudElectronEnv} sets that). `quitFromTray` is the production
 * policy: it asks first when work is live, exactly as for a person.
 * Resolves once `exited()` holds, or after `timeoutMs` with `exited: false`.
 * The supervisor calls it for cloud instances only.
 */
export async function quitCloudLaunchFromTray(app, exited, { timeoutMs = 30_000 } = {}) {
  const asked = await app
    .evaluate(() => {
      const host = globalThis.volliMenuBarHost;
      if (host === undefined) return false;
      // On main's next turn, so this call answers before the app goes away.
      setTimeout(() => host.quitFromTray(), 0);
      return true;
    })
    .catch(() => false);
  if (!asked) return { asked: false, exited: exited() };
  const deadline = Date.now() + timeoutMs;
  while (!exited() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
  return { asked: true, exited: exited() };
}

/**
 * The close record of an Electron that already quit on its own (the Tray's
 * Quit Volli), proven from the EXACT ChildProcess handle the supervisor
 * captured when it launched that pid. Playwright disposes its Electron
 * dispatcher once the process exits, so `app.process()` (and with it
 * `closeAppBounded`) can no longer inspect it. The handle captured at launch
 * still holds Node's own exit fields.
 *
 * - `null`: the child is still running. The caller closes it the bounded way
 *   while Playwright can still reach it.
 * - throws when there is no captured handle, or it is not the recorded pid:
 *   a missing or unknown child is a fault, never a clean exit.
 *
 * It sends no signal and touches no process.
 */
export function observedChildExit(child, expectedPid) {
  if (child === null || child === undefined || typeof child !== "object") {
    throw new Error("no captured Electron child handle: cannot prove how it exited");
  }
  if (!Number.isInteger(expectedPid) || expectedPid <= 0 || child.pid !== expectedPid) {
    throw new Error(
      `the captured Electron child is pid ${child.pid}, not the recorded pid ${expectedPid}`,
    );
  }
  const exitCode = child.exitCode ?? null;
  const signal = child.signalCode ?? null;
  if (exitCode === null && signal === null) return null;
  return {
    kind: "already-exited",
    pid: child.pid,
    exit: { code: exitCode, signal },
    closeFailures: [],
  };
}

/**
 * How a driven Electron must have ended: its own quit, exit code 0, no signal,
 * no failed close step. A bounded close that had to terminate or kill it is
 * not a clean quit, whatever the leftovers say.
 */
export function cleanQuitProblems(close) {
  if (!close) return ["no close record"];
  const problems = [];
  if (!["graceful", "natural-after-close", "already-exited"].includes(close.kind))
    problems.push(`closed by ${close.kind}`);
  if (close.exit?.code !== 0 || close.exit?.signal !== null)
    problems.push(`exit ${JSON.stringify(close.exit ?? null)}`);
  if (!Array.isArray(close.closeFailures) || close.closeFailures.length > 0)
    problems.push(`close failures ${JSON.stringify(close.closeFailures ?? null)}`);
  return problems;
}

const base64url = (value) => Buffer.from(value).toString("base64url");

/**
 * An access token the app's dev issuer would mint for `subject` (same issuer,
 * audience, key id, subject form `dev:<subject>` and default profile), so the
 * driver's SETUP calls act as the same person the instances sign in as.
 */
export function devAccessToken({ privateKeyPem, subject, now = Date.now() }) {
  const iat = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: DEV_KEY_ID }));
  const body = base64url(
    JSON.stringify({
      iss: DEV_ISSUER,
      aud: DEV_AUDIENCE,
      sub: `dev:${subject}`,
      sid: `drive_${randomUUID()}`,
      name: DEV_NAME,
      email: DEV_EMAIL,
      email_verified: true,
      iat,
      exp: iat + 3600,
    }),
  );
  const signature = sign("sha256", Buffer.from(`${header}.${body}`), {
    key: createPrivateKey(privateKeyPem),
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${body}.${signature.toString("base64url")}`;
}

/**
 * The newest dev sign-in the app asked the "browser" to open, from harness
 * mode's `external-requests.jsonl`: an `openExternal` of the dev issuer's
 * loopback authorize URL, recorded after `sinceMs`. `null` when none.
 */
export function recordedDevSignIn(jsonl, sinceMs = 0) {
  const lines = String(jsonl ?? "")
    .split("\n")
    .filter(Boolean);
  for (const line of lines.toReversed()) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.method !== "openExternal" || !(entry.at >= sinceMs)) continue;
    const target = entry.args?.[0];
    let url;
    try {
      url = new URL(target);
    } catch {
      continue;
    }
    if (url.protocol === "http:" && url.hostname === "127.0.0.1") return target;
  }
  return null;
}

/**
 * The browser's half of the dev sign-in: open the recorded authorize URL
 * (which redirects to the app's loopback callback) and follow that one
 * redirect, exactly as the desktop's live sign-in test does. Both hops must
 * stay on the loopback.
 */
export async function completeDevSignIn(target, fetchImpl = fetch) {
  const first = new URL(target);
  if (first.hostname !== "127.0.0.1") throw new Error(`refusing to open ${first.origin}`);
  const answer = await fetchImpl(target, { redirect: "manual" });
  const location = answer.headers.get("location");
  if (location === null) throw new Error(`the dev issuer answered ${answer.status}, no redirect`);
  const callback = new URL(location, target);
  if (callback.hostname !== "127.0.0.1") throw new Error(`refusing to open ${callback.origin}`);
  const done = await fetchImpl(callback.href, { redirect: "manual" });
  return { authorize: answer.status, callback: done.status };
}

/** A Convex HTTP client; imported lazily so the pure helpers above load without it. */
async function convexClient(url) {
  const [{ ConvexHttpClient }, { makeFunctionReference }] = await Promise.all([
    import("convex/browser"),
    import("convex/server"),
  ]);
  return { client: new ConvexHttpClient(url), ref: makeFunctionReference };
}

/** SETUP: preview enrollment for the dev profile's email, on the throwaway backend only. */
export async function grantPreview({ convexUrl, adminKey, email = DEV_EMAIL }) {
  if (!adminKey) throw new Error("Preview enrollment needs the fixture's VOLLI_CONVEX_ADMIN_KEY");
  const { client, ref } = await convexClient(convexUrl);
  client.setAdminAuth(adminKey);
  await client.mutation(ref("previewAccess:set"), { kind: "email", value: email, enabled: true });
}

/** SETUP: the person's project, in their own Workspace, through the board's public function. */
export async function seedCloudProject({ convexUrl, token, name, prefix }) {
  const { client, ref } = await convexClient(convexUrl);
  client.setAuth(token);
  const workspaces = await client.query(ref("workspaces:listMine"), {});
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    throw new Error("The person has no Workspace yet: sign in first");
  }
  const projectId = randomUUID();
  await client.mutation(ref("projects:create"), {
    commandId: randomUUID(),
    workspaceId: workspaces[0].workspaceId,
    projectId,
    name,
    ticketPrefix: prefix,
    origin: "blank",
  });
  return { projectId, workspaceId: workspaces[0].workspaceId };
}

/** EVIDENCE: a project's Sessions as the backend lists them for the person (newest first). */
export async function projectSessions({ convexUrl, token, projectId }) {
  const { client, ref } = await convexClient(convexUrl);
  client.setAuth(token);
  const answer = await client.query(ref("sessions:list"), {
    projectId,
    paginationOpts: { numItems: 20, cursor: null },
  });
  return answer.page;
}

/** EVIDENCE: the person's own runners, as their window reads them. */
export async function personRunners({ convexUrl, token }) {
  const { client, ref } = await convexClient(convexUrl);
  client.setAuth(token);
  return client.query(ref("runners:list"), {});
}

/** The signed-in person a launch marker names, or `null`. */
export function launchMarkerUser(raw) {
  try {
    const userId = JSON.parse(raw ?? "null")?.userId;
    return typeof userId === "string" && userId.length > 0 ? userId : null;
  } catch {
    return null;
  }
}

/** This Mac's runner id for `userId` in its non-secret record (`cloud-runner/record.ts`), or `null`. */
export function recordedRunnerId(raw, userId) {
  try {
    const runnerId = JSON.parse(raw ?? "null")?.accounts?.[userId]?.runnerId;
    return typeof runnerId === "string" ? runnerId : null;
  } catch {
    return null;
  }
}

/** One `app_state` value, read-only, from an instance's database. */
export async function readAppState(dbPath, key) {
  if (!/^[a-z:-]+$/u.test(key)) throw new Error(`not an app_state key: ${key}`);
  const { stdout } = await exec("sqlite3", [
    "-readonly",
    "-json",
    dbPath,
    `SELECT value FROM app_state WHERE key = '${key}'`,
  ]);
  const rows = stdout.trim() ? JSON.parse(stdout) : [];
  return rows[0]?.value ?? null;
}
