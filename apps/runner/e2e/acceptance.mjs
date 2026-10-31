#!/usr/bin/env node
/**
 * BYO runner acceptance (VC-1043, BYO-14): a person's own Linux box, end to
 * end, against the pinned local backend. ci-extended's `BYO runner
 * acceptance` job runs it on a disposable Ubuntu runner:
 *
 *   node convex/fixture/with-backend.ts --deploy -- \
 *     node apps/runner/e2e/acceptance.mjs [--require-all] [--host-shell]
 *
 * The legs (see `lib/legs.mjs` for how each reports):
 *
 * 0. **harness** — the lane's own plumbing, proven before any claim rests
 *    on it: a seeded person with a project; the deployment's GitHub App on
 *    the fake GitHub, the person's GitHub connected and the App installed
 *    through the backend's real routes; a test-minted install token; a fresh
 *    Ubuntu 24.04 box booted under systemd that reaches the backend, the
 *    local release and the fake GitHub (a token clones and pushes, no token
 *    is refused); and the box redeeming an install token over
 *    `POST /runner/link`, which Settings → Runners then lists.
 * 1. **install** — `curl … | sh -s -- --token … --server …` → "is online".
 * 2. **session** — a Session started through `sessionStarts.startOn` as the
 *    person (the picker's API) runs a fake-model turn whose agent commits
 *    and `git push`es → the fake GitHub has the commit.
 * 3. **update** — v+1 published to the local release and set in
 *    `releaseChannels` → the runner updates and is online at v+1.
 * 4. **rollback** — a broken v+2 → the runner rolls back to v+1 and reports
 *    `update_failed`.
 *
 * Legs 1–4 are declared with the merged work they need and stay `pending`
 * until it lands and the leg is wired (VC-1043 final); `--require-all` makes
 * anything short of every leg passing red.
 *
 * SETUP and doubles, never the behaviour under test: the person (test
 * issuer, preview granted with the fixture's admin key), the fake GitHub
 * (`scripts/fake-github`), the local release file server, the fake model
 * provider, and the driver playing the browser on the GitHub pages. The box
 * is a real systemd boot in a privileged container on the host network.
 *
 * `--host-shell` runs the box's commands in a plain shell on this machine
 * instead (local debugging without Docker). It is labelled in every output
 * and is never what CI runs.
 *
 * Evidence (no secrets: every token is redacted) goes to
 * `$VOLLI_BYO_EVIDENCE` (default: a temp dir): `evidence.json`, `summary.md`.
 * The summary is also appended to `$GITHUB_STEP_SUMMARY`.
 */

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { startFakeGithub } from "../../../scripts/fake-github/server.mjs";
import {
  connectGithub,
  createInstallToken,
  fixtureFromEnv,
  installGithubApp,
  listRunners,
  seedPerson,
  setDeploymentEnv,
  waitFor,
} from "./lib/backend.mjs";
import { buildBoxImage, startBox } from "./lib/box.mjs";
import { exitCodeFor, redact, renderSummary, runLegs } from "./lib/legs.mjs";
import { startReleaseServer } from "./lib/release-server.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The person, their GitHub and their repository (all fakes, all fixed). */
export const WORLD = Object.freeze({
  person: { subject: "byo-person", email: "byo-person@example.test", name: "BYO Person" },
  project: { name: "BYO demo", prefix: "BYO" },
  github: { userId: 9001, login: "byo-person", installationId: 90_010, repoId: 900_100 },
  repo: { owner: "byo-person", name: "demo" },
  boxHostname: "byo-box-1",
});

const BYO = {
  runner: { ticket: "VC-1034 (BYO-1)", path: "apps/runner/package.json" },
  lifecycle: {
    ticket: "VC-1035 (BYO-2)",
    path: "packages/host-core/src/cloud-runner/headless-runner.ts",
  },
  startOn: { ticket: "VC-1036 (BYO-3)", path: "convex/functions/sessionStarts.ts" },
  picker: { ticket: "VC-1036 (BYO-3)", path: "convex/functions/runnerPicker.ts" },
  executor: {
    ticket: "VC-1036 (BYO-3)",
    path: "packages/host-core/src/cloud-store/session-start-jobs.ts",
  },
  releaseFeed: { ticket: "VC-1038 (BYO-5)", path: "convex/functions/runnerReleases.ts" },
  installScript: { ticket: "VC-1040 (BYO-7)", path: "apps/runner/packaging/install.sh" },
  buildImage: { ticket: "VC-1040 (BYO-7)", path: ".devcontainer/runner-build/Dockerfile" },
  buildScript: { ticket: "VC-1040 (BYO-7)", path: "apps/runner/scripts/ci-build-artifact.sh" },
  manifest: { ticket: "VC-1040 (BYO-7)", path: "scripts/runner-release-manifest.mjs" },
  tokenRoute: {
    ticket: "VC-1041 (BYO-8)",
    path: "convex/functions/http.ts",
    contains: "/runner/github-token",
  },
  managedClone: {
    ticket: "VC-1041 (BYO-8)",
    path: "packages/host-core/src/cloud-store/managed-clone.ts",
  },
  run: { ticket: "VC-1042 (BYO-9)", path: "apps/runner/src/commands/run.ts" },
  install: { ticket: "BYO-10 (wave 2)", path: "apps/runner/src/install" },
  update: { ticket: "BYO-12 (wave 2)", path: "apps/runner/src/update" },
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A box stand-in for `--host-shell`: the same `run` contract, on this machine. */
function hostShell() {
  return {
    name: "host-shell",
    hostShell: true,
    systemState: "host-shell (not a box)",
    run(script, { env = {}, input, timeoutMs = 120_000 } = {}) {
      return new Promise((done, fail) => {
        const child = spawn("sh", ["-c", script], { env: { ...process.env, ...env } });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.once("error", fail);
        child.once("close", (code) => {
          clearTimeout(timer);
          done({ code: code ?? 1, stdout, stderr });
        });
        child.stdin.end(input ?? "");
      });
    },
    async journal() {
      return "";
    },
    async stop() {},
  };
}

/** Run `script` on the box and require exit 0; answers its stdout. */
async function onBox(context, what, script, options = {}) {
  const result = await context.box.run(script, options);
  context.boxCommands.push({
    what,
    code: result.code,
    stdout: context.redact(result.stdout).slice(-2_000),
    stderr: context.redact(result.stderr).slice(-2_000),
  });
  if (result.code !== 0 && !options.allowFailure) {
    throw new Error(
      `${what} exited ${result.code}: ${context.redact(result.stderr || result.stdout).slice(-1_000)}`,
    );
  }
  return result;
}

/** A git invocation on the box that no ambient config or prompt can rescue. */
const BOX_GIT = "GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 git";

async function harness(context, log) {
  const { fixture, github, release } = context;

  // The person and their GitHub, through the backend's own routes.
  github.addUser({ id: WORLD.github.userId, login: WORLD.github.login, name: WORLD.person.name });
  github.createRepo(WORLD.repo.owner, WORLD.repo.name);
  github.addInstallation({
    id: WORLD.github.installationId,
    account: { id: WORLD.github.userId, login: WORLD.github.login },
    repositories: [{ id: WORLD.github.repoId, owner: WORLD.repo.owner, name: WORLD.repo.name }],
    userIds: [WORLD.github.userId],
  });
  await setDeploymentEnv(fixture, github.appEnv());
  const seeded = await seedPerson(fixture, { ...WORLD.person, project: WORLD.project });
  Object.assign(context, seeded);
  log(`person ${seeded.userId}, project ${seeded.projectId}`);
  const connection = await connectGithub(fixture, seeded.person);
  assert.equal(connection?.status, "active", "the person's GitHub is connected");
  assert.equal(connection.login, WORLD.github.login);
  const install = await installGithubApp(fixture, seeded.person, WORLD.github.installationId);
  assert.equal(install?.status, "done", `the App install finished: ${JSON.stringify(install)}`);

  // A local release the box downloads from (a probe asset, not a runner).
  const probe = Buffer.from(`byo harness probe ${randomBytes(8).toString("hex")}\n`);
  release.publish("v0.0.0-harness", { "harness-probe.txt": probe }, { prerelease: true });

  const box = context.box;
  log(`box ${box.name}: systemd ${box.systemState}`);
  if (!box.hostShell) {
    const pid1 = await onBox(context, "PID 1 is systemd", "ps -p 1 -o comm=");
    assert.equal(pid1.stdout.trim(), "systemd");
    const os = await onBox(
      context,
      "the box is Ubuntu 24.04",
      ". /etc/os-release && echo $ID $VERSION_ID",
    );
    assert.equal(os.stdout.trim(), "ubuntu 24.04");
    await onBox(context, "no Node on the box", "! command -v node");
  }

  // The box reaches the backend, the site and the release.
  await onBox(context, "backend reachable", `curl -fsS ${fixture.convexUrl}/version`);
  const fetched = await onBox(
    context,
    "release asset download",
    `curl -fsSL ${release.assetUrl("v0.0.0-harness", "harness-probe.txt")} | sha256sum`,
  );
  assert.equal(fetched.stdout.split(" ")[0], sha256(probe), "the box got the published bytes");

  // The box's git against the fake GitHub: a token clones and pushes; none is refused.
  const token = github.issueAccessToken(WORLD.github.userId);
  context.secrets.push(token);
  const host = github.origin.replace(/^http:\/\//u, "");
  const work = `/tmp/byo-harness-${randomBytes(3).toString("hex")}`;
  await onBox(
    context,
    "an unauthenticated clone is refused",
    `! ${BOX_GIT} clone --quiet ${github.origin}/${WORLD.repo.owner}/${WORLD.repo.name}.git ${work}-refused`,
  );
  await onBox(
    context,
    "a token clones, commits and pushes",
    [
      "set -e",
      `${BOX_GIT} clone --quiet "http://x-access-token:$BYO_GIT_TOKEN@${host}/${WORLD.repo.owner}/${WORLD.repo.name}.git" ${work}`,
      `cd ${work}`,
      "echo harness > harness.txt",
      `${BOX_GIT} add harness.txt`,
      `${BOX_GIT} -c user.name=Harness -c user.email=harness@example.test commit --quiet -m "Harness probe"`,
      `${BOX_GIT} push --quiet origin HEAD:refs/heads/byo/harness-probe`,
      `cd / && rm -rf ${work}`,
    ].join("\n"),
    { env: { BYO_GIT_TOKEN: token } },
  );
  const pushed = github.refs(WORLD.repo.owner, WORLD.repo.name)["refs/heads/byo/harness-probe"];
  assert.ok(pushed, "the fake GitHub holds the pushed branch");
  assert.equal(github.commit(WORLD.repo.owner, WORLD.repo.name, pushed).subject, "Harness probe");

  // An install token, redeemed by the box over the route the installer uses.
  const minted = await createInstallToken(seeded.person, "harness-probe");
  context.secrets.push(minted.installToken);
  const waiting = await seeded.person.query("runners:installTokenStatus", {
    installTokenId: minted.installTokenId,
  });
  assert.equal(waiting.state, "waiting");
  const body = JSON.stringify({
    installToken: minted.installToken,
    host: {
      hostname: WORLD.boxHostname,
      platform: { os: "linux", arch: "x64", release: "harness", distro: "ubuntu 24.04" },
      installMode: "system",
    },
    name: null,
  });
  // The token reaches the box in the environment, never on a command line.
  const linked = await onBox(
    context,
    "the box redeems an install token",
    `printf '%s' "$BYO_LINK_BODY" | curl -fsS -X POST -H 'content-type: application/json' --data-binary @- ${fixture.siteUrl}/runner/link`,
    { env: { BYO_LINK_BODY: body } },
  );
  const grant = JSON.parse(linked.stdout);
  context.secrets.push(grant.credential);
  assert.equal(grant.name, "harness-probe", "the token's name hint names the runner");
  const used = await seeded.person.query("runners:installTokenStatus", {
    installTokenId: minted.installTokenId,
  });
  assert.equal(used.state, "used");
  assert.equal(used.runner?.id, grant.runnerId);
  const listed = await waitFor("the probe runner in Settings → Runners", async () =>
    (await listRunners(seeded.person)).find((runner) => runner.id === grant.runnerId),
  );
  assert.equal(listed.kind, "linux");
  // A redeemed token is spent: a second redemption is refused.
  const again = await onBox(
    context,
    "a spent install token is refused",
    `printf '%s' "$BYO_LINK_BODY" | curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data-binary @- ${fixture.siteUrl}/runner/link`,
    { env: { BYO_LINK_BODY: body } },
  );
  assert.notEqual(again.stdout.trim(), "200");
  // The probe runner leaves the person's list, so later legs start clean.
  await seeded.person.mutation("runners:remove", { runnerId: grant.runnerId });
  assert.equal(
    (await listRunners(seeded.person)).some((runner) => runner.id === grant.runnerId),
    false,
  );
  return `person, GitHub (connect + install), release, box (${box.systemState}), git token gate and install-token link all proven`;
}

/** The legs, in order. Only `harness` is wired in the scaffold. */
export const LEGS = [
  { id: "harness", title: "Harness: backend, fake GitHub, release, systemd box", run: harness },
  {
    id: "install",
    title: "curl … | sh -s -- --token … --server … → is online",
    after: ["harness"],
    needs: [
      BYO.runner,
      BYO.lifecycle,
      BYO.installScript,
      BYO.buildImage,
      BYO.buildScript,
      BYO.manifest,
      BYO.run,
      BYO.install,
    ],
  },
  {
    id: "session",
    title: "startOn → the agent commits and pushes → the fake GitHub has it",
    after: ["install"],
    needs: [BYO.startOn, BYO.picker, BYO.executor, BYO.tokenRoute, BYO.managedClone],
  },
  {
    id: "update",
    title: "v+1 published and set in releaseChannels → online at v+1",
    after: ["install"],
    needs: [BYO.releaseFeed, BYO.update],
  },
  {
    id: "rollback",
    title: "broken v+2 → rolled back to v+1, update_failed reported",
    after: ["update"],
    needs: [BYO.releaseFeed, BYO.update],
  },
];

const log = (line) => console.error(`[byo] ${line}`);

async function main(argv) {
  const requireAll = argv.includes("--require-all");
  const useHostShell = argv.includes("--host-shell");
  const unknown = argv.filter((arg) => !["--require-all", "--host-shell"].includes(arg));
  if (unknown.length > 0) {
    console.error(
      `usage: acceptance.mjs [--require-all] [--host-shell] (unknown: ${unknown.join(" ")})`,
    );
    return 2;
  }
  const evidenceDir =
    process.env.VOLLI_BYO_EVIDENCE ?? mkdtempSync(join(tmpdir(), "byo-acceptance-"));
  mkdirSync(evidenceDir, { recursive: true });
  if (useHostShell)
    log("HOST SHELL: box commands run on this machine, not in a box (debugging only)");

  const fixture = fixtureFromEnv();
  const secrets = [fixture.adminKey, fixture.privateKeyPem];
  const context = {
    fixture,
    secrets,
    boxCommands: [],
    redact: (text) => redact(text, secrets),
  };
  const github = await startFakeGithub();
  const release = await startReleaseServer();
  context.github = github;
  context.release = release;
  let results = [];
  try {
    if (useHostShell) {
      context.box = hostShell();
    } else {
      log("building the box image");
      await buildBoxImage();
      context.box = await startBox({
        name: `byo-box-${randomBytes(3).toString("hex")}`,
        hostname: WORLD.boxHostname,
      });
    }
    results = await runLegs(LEGS, context, {
      root: ROOT,
      log: (line) => log(redact(line, secrets)),
    });
  } catch (error) {
    results = [
      {
        id: "harness",
        title: LEGS[0].title,
        status: "failed",
        detail: String(error?.stack ?? error),
      },
    ];
    log(`FAILED before the legs ran: ${redact(String(error?.stack ?? error), secrets)}`);
  } finally {
    const journal =
      context.box && results.some((result) => result.status === "failed")
        ? await context.box.journal(null, 200).catch(() => "")
        : "";
    const evidence = {
      headSha: process.env.GITHUB_SHA ?? null,
      hostShell: useHostShell,
      requireAll,
      boxSystemState: context.box?.systemState ?? null,
      results: results.map((result) => ({ ...result, detail: redact(result.detail, secrets) })),
      // Redacted again here: a secret learned after a command ran (the link
      // grant's credential) must not survive in what that command printed.
      boxCommands: JSON.parse(redact(JSON.stringify(context.boxCommands), secrets)),
      fakeGithubRequests: github.requests,
      releaseRequests: release.requests,
      boxJournal: redact(journal, secrets),
    };
    writeFileSync(join(evidenceDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    await context.box?.stop();
    await github.close();
    await release.close();
  }
  const summary = renderSummary(
    results.map((result) => ({ ...result, detail: redact(result.detail, secrets) })),
    { requireAll, headSha: process.env.GITHUB_SHA ?? null },
  );
  const labelled = useHostShell ? `${summary}\n**HOST SHELL run: not a box.**\n` : summary;
  writeFileSync(join(evidenceDir, "summary.md"), labelled);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, labelled);
  process.stdout.write(labelled);
  for (const result of results) {
    if (result.status === "pending" || result.status === "blocked") {
      console.log(`::notice title=BYO leg ${result.status}::${result.id}: ${result.detail}`);
    }
  }
  log(`evidence: ${evidenceDir}`);
  return exitCodeFor(results, { requireAll });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
