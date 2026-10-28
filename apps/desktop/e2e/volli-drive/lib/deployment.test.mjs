import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { REPO, electronExtraEnv, instanceLayout, launchProblems, supervisorEnv } from "./core.mjs";
import {
  assertDeploymentLaunch,
  deploymentElectronEnv,
  readDeployment,
  recordedWorkosSignIn,
} from "./deployment.mjs";

const values = {
  convexUrl: "https://staging.example.com/",
  siteUrl: "https://actions.example.com/",
  workosClientId: "client_test",
  storageOrigin: "https://storage.example.com/",
};
const flags = { deployment: "staging", ...values };
const spec = (deployment) => ({ build: "dev", deployment });
const entry = (value) => JSON.stringify({ method: "openExternal", args: [value] });

async function withProfile(name, profile, run) {
  const parent = join(REPO, ".scratch");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "deployment-rules-"));
  try {
    await mkdir(join(root, ".scratch", "deployments"), { recursive: true });
    await writeFile(join(root, ".scratch", "deployments", `${name}.json`), JSON.stringify(profile));
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("no target is selected by ambient environment or by default", async () => {
  assert.equal(await readDeployment({}, "/unused"), null);
  for (const options of [{ confirmProd: true }, values])
    await assert.rejects(readDeployment(options, "/unused"), /require --deployment/);
});

test("named gitignored profile and flags yield the same normalized public target", async () => {
  await withProfile("staging", { name: "staging", ...values }, async (root) => {
    const selected = await readDeployment({ deployment: "staging" }, root);
    assert.deepEqual(selected, await readDeployment(flags, root));
    assert.equal(selected.convexUrl, "https://staging.example.com");
    assert.equal(selected.siteUrl, "https://actions.example.com");
    assert.equal(selected.storageOrigin, "https://storage.example.com");
    assert.doesNotThrow(() => assertDeploymentLaunch(spec(selected)));
  });
});

test("no missing/partial source falls back to another profile or ambient values", async () => {
  await assert.rejects(
    readDeployment({ deployment: "staging" }, "/unused"),
    /cannot read deployment profile/,
  );
  await withProfile("staging", { name: "staging", ...values }, async (root) => {
    await assert.rejects(
      readDeployment({ deployment: "staging", convexUrl: values.convexUrl }, root),
      /needs public value/,
    );
  });
});

test("prod requires explicit selection AND a boolean confirmation, on both launch gates", async () => {
  for (const confirmProd of [undefined, false, "true", "false", "1"]) {
    await assert.rejects(
      readDeployment({ ...values, deployment: "prod", confirmProd }, "/unused"),
      /production requires/,
    );
    assert.throws(
      () => assertDeploymentLaunch(spec({ name: "prod", ...values, confirmedProd: confirmProd })),
      /production requires/,
    );
  }
  const prod = await readDeployment(
    { ...values, deployment: "prod", confirmProd: true },
    "/unused",
  );
  assert.doesNotThrow(() => assertDeploymentLaunch(spec(prod)));
  for (const deployment of [undefined, "production", "../prod", true, "PROD"])
    await assert.rejects(readDeployment({ ...values, deployment, confirmProd: true }, "/unused"));
  await assert.rejects(readDeployment({ ...flags, confirmProd: true }, "/unused"), /only valid/);
  await withProfile("staging", { name: "prod", ...values }, async (root) => {
    await assert.rejects(
      readDeployment({ deployment: "staging" }, root),
      /prod cannot be an alias/,
    );
  });
});

test("profile rejects unknown fields (including credentials) before recording a spec", async () => {
  for (const extra of [{ deployKey: "not-a-real-key" }, { confirmedProd: true }]) {
    await withProfile("prod", { name: "prod", ...values, ...extra }, async (root) => {
      await assert.rejects(
        readDeployment({ deployment: "prod", confirmProd: true }, root),
        /only name and the four public values/,
      );
    });
  }
});

test("public values use release validation: complete client id and exact HTTPS origins", async () => {
  for (const key of ["convexUrl", "siteUrl", "storageOrigin"]) {
    for (const raw of [
      "",
      true,
      "http://127.0.0.1:3210",
      "https://a.test/path",
      "https://user:pass@a.test",
      "https://*.test",
      "https://a.test?x=y",
      "https://a.test#x",
    ]) {
      await assert.rejects(readDeployment({ ...flags, [key]: raw }, "/unused"));
    }
  }
  for (const workosClientId of ["", true, "secret_test", "client_with spaces"])
    await assert.rejects(readDeployment({ ...flags, workosClientId }, "/unused"));
});

test("real deployment and fixture/packed journeys cannot be combined", async () => {
  const deployment = await readDeployment(flags, "/unused");
  for (const extra of [
    { cloud: true },
    { cloudSubject: "alice" },
    { cloudEmail: "a@example.com" },
    { remoteAcceptance: true },
    { build: "packed" },
    { app: "/unused.app" },
  ])
    await assert.rejects(readDeployment({ ...flags, ...extra }, "/unused"));
  for (const extra of [
    { build: "packed" },
    { appBinary: "/unused.app" },
    { cloud: {} },
    { remoteAcceptance: {} },
  ])
    assert.throws(() => assertDeploymentLaunch({ ...spec(deployment), ...extra }));
  const problems = launchProblems(spec({ ...deployment, name: "prod" }));
  assert.ok(
    problems.some((p) => p.includes("production requires")),
    "shared CLI/supervisor gate revalidates prod",
  );
});

test("real runtime inputs preserve isolation and never carry fixture keys or release inputs", async () => {
  const deployment = await readDeployment(flags, "/unused");
  const inherited = supervisorEnv({
    VOLLI_CONVEX_URL: "https://prod.example.com",
    VOLLI_DRIVE_PROD_CHECK: "1",
    CONVEX_DEPLOY_KEY: "not-a-real-key",
    WORKOS_API_KEY: "not-a-real-key",
    VOLLI_BUILD_CONVEX_URL: "https://prod.example.com",
  });
  assert.deepEqual(inherited, {});
  const layout = instanceLayout("/scratch", "/evidence");
  const env = {
    ...inherited,
    ...electronExtraEnv(layout, { loginShell: "/shell", path: "/bin" }),
    ...deploymentElectronEnv(deployment),
  };
  assert.equal(env.VOLLI_HARNESS, "1");
  assert.equal(env.VOLLI_HARNESS_SCRATCH, "/scratch");
  assert.equal(env.HOME, layout.home);
  assert.equal(env.VOLLI_ACCOUNT_PROVIDER, "workos");
  assert.equal(env.VOLLI_CONVEX_URL, "https://staging.example.com");
  assert.equal(env.VOLLI_SMOKE_MENU_BAR_HOST, "1");
  assert.equal(env.VOLLI_CONVEX_TEST_PRIVATE_KEY, undefined);
  assert.equal(env.VOLLI_SMOKE_CLOUD_RUNNER_POWER, undefined);
  assert.ok(Object.keys(env).every((k) => !k.startsWith("VOLLI_BUILD_")));
});

test("sign-in URL is a read of a recorded WorkOS request, not an authentication double", () => {
  const url =
    "https://api.workos.com/user_management/authorize?client_id=client_test&state=example";
  assert.equal(recordedWorkosSignIn(`${entry(url)}\npartial`, "client_test"), url);
  for (const other of [
    url.replace("api.workos.com", "evil.example.com"),
    url.replace("authorize", "sessions/logout"),
    url.replace("client_test", "client_other"),
  ])
    assert.throws(() => recordedWorkosSignIn(entry(other), "client_test"), /no recorded/);
});

test("supervisor wires real deployment without admitting it to fixture-only commands", async () => {
  const source = await readFile(new URL("../supervisor.mjs", import.meta.url), "utf8");
  assert.match(source, /spec\.deployment \? deploymentElectronEnv\(spec\.deployment\)/);
  assert.match(source, /if \(spec\.cloud \|\| spec\.deployment\)/);
  assert.match(source, /async function restart\(reason\) \{\s*requireCloudLaunch\(\)/);
  assert.match(
    source,
    /function requireCloudLaunch\(\) \{\s*if \(!spec\.deployment\) requireCloud\(\)/,
  );
  for (const cmd of ["cloud-sign-in-browser", "runner-power", "cloud-state"])
    assert.match(
      source.slice(source.indexOf(`case "${cmd}"`) + `case "${cmd}"`.length).split(/case "/)[0],
      /requireCloud\(\)/,
    );
});
