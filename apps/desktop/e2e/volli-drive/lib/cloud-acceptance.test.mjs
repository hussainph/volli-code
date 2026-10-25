import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CLOUD_SUPERVISOR_ENV,
  DEV_AUDIENCE,
  DEV_EMAIL,
  DEV_ISSUER,
  DEV_KEY_ID,
  cleanQuitProblems,
  cloudElectronEnv,
  cloudFixtureFromEnv,
  cloudFixtureFromSupervisorEnv,
  cloudSubject,
  cloudSupervisorEnv,
  completeDevSignIn,
  devAccessToken,
  launchMarkerUser,
  quitCloudLaunchFromTray,
  recordedDevSignIn,
  recordedRunnerId,
} from "./cloud-acceptance.mjs";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const env = {
  VOLLI_CONVEX_URL: "http://127.0.0.1:3210",
  VOLLI_CONVEX_SITE_URL: "http://127.0.0.1:3211",
  VOLLI_CONVEX_TEST_PRIVATE_KEY: pem,
  VOLLI_CONVEX_ADMIN_KEY: "admin",
};

test("the fixture is the loopback backend with a test key, never a deployment", () => {
  assert.deepEqual(cloudFixtureFromEnv(env), {
    convexUrl: env.VOLLI_CONVEX_URL,
    siteUrl: env.VOLLI_CONVEX_SITE_URL,
    privateKeyPem: pem,
    adminKey: "admin",
  });
  assert.throws(
    () => cloudFixtureFromEnv({ ...env, VOLLI_CONVEX_URL: "https://happy-cat.convex.cloud" }),
    /loopback/,
  );
  assert.throws(() => cloudFixtureFromEnv({ ...env, VOLLI_CONVEX_URL: undefined }), /not a URL/);
  assert.throws(
    () => cloudFixtureFromEnv({ ...env, VOLLI_CONVEX_TEST_PRIVATE_KEY: "" }),
    /PRIVATE_KEY is missing/,
  );
});

test("the key reaches the supervisor by environment only, and back", () => {
  const fixture = cloudFixtureFromEnv(env);
  const passed = cloudSupervisorEnv(fixture);
  assert.equal(passed[CLOUD_SUPERVISOR_ENV.privateKeyPem], pem);
  assert.deepEqual(cloudFixtureFromSupervisorEnv(passed), {
    convexUrl: fixture.convexUrl,
    siteUrl: fixture.siteUrl,
    privateKeyPem: pem,
  });
  assert.equal(cloudFixtureFromSupervisorEnv({}), null);
});

test("Electron gets the flag, the dev sign-in, the backend and the power seam", () => {
  const fixture = cloudFixtureFromEnv(env);
  assert.deepEqual(cloudElectronEnv(fixture, "wake-1"), {
    VOLLI_EXPERIMENTAL: "cloud",
    VOLLI_ACCOUNT_PROVIDER: "dev",
    VOLLI_ACCOUNT_DEV_SUBJECT: "wake-1",
    VOLLI_CONVEX_URL: env.VOLLI_CONVEX_URL,
    VOLLI_CONVEX_SITE_URL: env.VOLLI_CONVEX_SITE_URL,
    VOLLI_CONVEX_TEST_PRIVATE_KEY: pem,
    VOLLI_SMOKE_CLOUD_RUNNER_POWER: "1",
    VOLLI_SMOKE_MENU_BAR_HOST: "1",
  });
  assert.equal(cloudSubject(" wake-ab12 "), "wake-ab12");
  assert.throws(() => cloudSubject("Has Spaces"), /lowercase/);
});

test("a setup token is the dev issuer's own, for the same person", () => {
  const token = devAccessToken({ privateKeyPem: pem, subject: "wake-1", now: 1_000_000 });
  const [header, body, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), {
    alg: "ES256",
    typ: "JWT",
    kid: DEV_KEY_ID,
  });
  const claims = JSON.parse(Buffer.from(body, "base64url"));
  assert.equal(claims.iss, DEV_ISSUER);
  assert.equal(claims.aud, DEV_AUDIENCE);
  assert.equal(claims.sub, "dev:wake-1");
  assert.equal(claims.email, DEV_EMAIL);
  assert.equal(claims.exp - claims.iat, 3600);
  assert.ok(
    verify(
      "sha256",
      Buffer.from(`${header}.${body}`),
      { key: createPublicKey(pem), dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    ),
  );
});

test("the recorded sign-in is the newest loopback openExternal after the click", () => {
  const jsonl = [
    { method: "openExternal", args: ["http://127.0.0.1:5000/authorize?old"], at: 10 },
    { method: "openExternal", args: ["https://volli.app/legal/preview/"], at: 30 },
    { method: "showItemInFolder", args: ["/tmp/x"], at: 40 },
    { method: "openExternal", args: ["http://127.0.0.1:5000/authorize?new"], at: 50 },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  assert.equal(recordedDevSignIn(jsonl, 20), "http://127.0.0.1:5000/authorize?new");
  assert.equal(recordedDevSignIn(jsonl, 60), null);
  assert.equal(recordedDevSignIn("not json\n", 0), null);
});

/** A dev issuer that sends the browser off the loopback. */
const redirectsAway = async () => ({
  status: 302,
  headers: new Headers({ location: "https://example.com/callback" }),
});

test("the browser double follows one loopback redirect and refuses anything else", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return url.includes("authorize")
      ? { status: 302, headers: new Headers({ location: "http://127.0.0.1:6000/callback?c=1" }) }
      : { status: 200, headers: new Headers() };
  };
  assert.deepEqual(await completeDevSignIn("http://127.0.0.1:5000/authorize", fetchImpl), {
    authorize: 302,
    callback: 200,
  });
  assert.deepEqual(seen, ["http://127.0.0.1:5000/authorize", "http://127.0.0.1:6000/callback?c=1"]);
  await assert.rejects(completeDevSignIn("https://example.com/authorize", fetchImpl), /refusing/);
  await assert.rejects(
    completeDevSignIn("http://127.0.0.1:5000/authorize", redirectsAway),
    /refusing/,
  );
});

test("only the app's own quit, exit 0, counts as a clean quit", () => {
  const exit = { code: 0, signal: null };
  assert.deepEqual(cleanQuitProblems({ kind: "already-exited", exit, closeFailures: [] }), []);
  assert.deepEqual(cleanQuitProblems({ kind: "graceful", exit, closeFailures: [] }), []);
  assert.equal(cleanQuitProblems({ kind: "terminated", exit, closeFailures: [] }).length, 1);
  assert.equal(
    cleanQuitProblems({
      kind: "graceful",
      exit: { code: null, signal: "SIGKILL" },
      closeFailures: [],
    }).length,
    1,
  );
  assert.equal(cleanQuitProblems({ kind: "graceful", exit, closeFailures: ["x"] }).length, 1);
  assert.deepEqual(cleanQuitProblems(null), ["no close record"]);
});

test("the launch marker and runner record are read, never guessed", () => {
  assert.equal(launchMarkerUser('{"userId":"u1"}'), "u1");
  assert.equal(launchMarkerUser(null), null);
  assert.equal(launchMarkerUser("{"), null);
  const raw = JSON.stringify({ v: 1, accounts: { u1: { runnerId: "r1", machine: "m" } } });
  assert.equal(recordedRunnerId(raw, "u1"), "r1");
  assert.equal(recordedRunnerId(raw, "u2"), null);
  assert.equal(recordedRunnerId("nope", "u1"), null);
});

test("the Tray quit asks main's controller on its next turn, then waits for the exit", async () => {
  let exited = false;
  const evaluated = [];
  const app = {
    async evaluate(fn) {
      evaluated.push(fn.toString());
      // Main's side, simulated: the controller exists and the quit ends the process.
      globalThis.volliMenuBarHost = { quitFromTray: () => void (exited = true) };
      try {
        return fn();
      } finally {
        delete globalThis.volliMenuBarHost;
      }
    },
  };
  assert.deepEqual(await quitCloudLaunchFromTray(app, () => exited, { timeoutMs: 2_000 }), {
    asked: true,
    exited: true,
  });
  assert.equal(evaluated.length, 1);
  const absent = { evaluate: async (fn) => fn() };
  assert.deepEqual(await quitCloudLaunchFromTray(absent, () => false), {
    asked: false,
    exited: false,
  });
  const gone = { evaluate: async () => Promise.reject(new Error("closed")) };
  assert.deepEqual(await quitCloudLaunchFromTray(gone, () => true), {
    asked: false,
    exited: true,
  });
});

/** The supervisor's source, for the privilege pins below. */
const supervisor = readFileSync(new URL("../supervisor.mjs", import.meta.url), "utf8");

test("only a cloud instance reaches the Tray quit; native Quit stays the remote journey's own", () => {
  // The menu-bar controller is named only in the cloud fixture module, never
  // in the supervisor (remote-acceptance.test.mjs pins the same).
  assert.doesNotMatch(supervisor, /VOLLI_SMOKE_MENU_BAR_HOST|volliMenuBarHost/u);
  // native-quit is exactly the application's native Quit menu item.
  const nativeQuit = supervisor.slice(
    supervisor.indexOf('case "native-quit":'),
    supervisor.indexOf('case "native-reopen":'),
  );
  assert.match(nativeQuit, /await quitNativeWindow\(app, page\)/u);
  assert.doesNotMatch(nativeQuit, /cloudTrayQuit|quitCloudLaunchFromTray|runner-power|restart/u);
  // The helper has one caller, which refuses any non-cloud instance first.
  assert.equal(supervisor.match(/quitCloudLaunchFromTray\(/gu)?.length, 1);
  assert.match(
    supervisor,
    /async function cloudTrayQuit\(\) \{\s*requireCloud\(\);\s*const result = await quitCloudLaunchFromTray\(/u,
  );
  // Its callers: stop, only for a cloud spec; restart, which refuses non-cloud instances.
  assert.equal(supervisor.match(/await cloudTrayQuit\(\)/gu)?.length, 2);
  assert.match(supervisor, /if \(spec\.cloud\) trayQuit = await cloudTrayQuit\(\)/u);
  const restart = supervisor.slice(
    supervisor.indexOf("async function restart("),
    supervisor.indexOf("async function handle("),
  );
  assert.match(restart, /if \(!spec\.cloud\) throw new Error/u);
  assert.ok(restart.indexOf("if (!spec.cloud)") < restart.indexOf("await cloudTrayQuit()"));
  // Every cloud-only command refuses an instance that is not one.
  for (const command of [
    "cloud-sign-in-browser",
    "runner-power",
    "cloud-checkout-folder",
    "cloud-state",
  ]) {
    const start = supervisor.indexOf(`case "${command}":`);
    assert.notEqual(start, -1, command);
    const body = supervisor.slice(start, supervisor.indexOf("case ", start + 6));
    assert.match(body, /requireCloud\(\);/u, `${command} refuses a non-cloud instance`);
  }
});
