import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { installLegalFixture, selectLegalException } from "./legal-fixture.mjs";
import { LIVE_SUITES } from "./harness.mjs";

const entries = JSON.parse(
  readFileSync(new URL("./live-exceptions.json", import.meta.url), "utf8"),
);
const entry = entries[0];
const state = {
  tag: entry.tag,
  commit: entry.commit,
  latestTag: entry.tag,
  currentVersion: entry.toVersion,
};
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const modulePath = "packages/shared/src/cloud/preview-access.ts";
const probePath = "apps/desktop/src/main/legal-consent.exception.live.test.ts";
const original = `// Prepared fixture only.\nexport const PREVIEW_ENROLLMENT_AGREEMENT_VERSION = "${entry.fromVersion}";\nexport const unrelated = true;\n`;
const fixtureEntry = {
  ...entry,
  moduleSha256: createHash("sha256").update(original).digest("hex"),
};
function fixture() {
  const tree = mkdtempSync(join(ROOT, ".legal-fixture-test-"));
  mkdirSync(dirname(join(tree, modulePath)), { recursive: true });
  mkdirSync(dirname(join(tree, probePath)), { recursive: true });
  writeFileSync(join(tree, modulePath), original);
  writeFileSync(join(tree, "apps/desktop/src/main/frozen.live.test.ts"), "unchanged test body");
  return { tree, close: () => rmSync(tree, { recursive: true, force: true }) };
}

test("exact legal exception requires reason and ticket; is automatically inactive after any newer tag", () => {
  assert.equal(selectLegalException(entries, state), entry);
  for (const latestTag of ["v0.3.0-canary.2.1", "v0.3.0-canary.3", "v0.3.0", "v0.4.0"]) {
    assert.equal(selectLegalException(entries, { ...state, latestTag }), null);
  }
  assert.equal(selectLegalException(entries, { ...state, tag: "v0.3.0-canary.3" }), null);
  assert.throws(
    () => selectLegalException(entries, { ...state, commit: "f".repeat(40) }),
    /does not match/,
  );
  assert.throws(
    () => selectLegalException(entries, { ...state, currentVersion: "another-version" }),
    /does not match/,
  );
  assert.throws(
    () => selectLegalException(entries, { ...state, latestTag: "v0.3.0-canary.1" }),
    /does not match/,
  );
  assert.throws(
    () => selectLegalException(entries, { ...state, latestTag: "not-a-tag" }),
    /newest released/,
  );
  assert.throws(() => selectLegalException([entry, entry], state), /Duplicate/);
  assert.throws(() => selectLegalException({}, state), /array/);
  for (const change of [
    { reason: "" },
    { ticket: "" },
    { expiresAfterTag: "v1.0.0" },
    { fromVersion: entry.toVersion },
    { commit: "anything" },
    { moduleSha256: "" },
    { refusalCode: "generic_error" },
    { tag: "not-a-tag" },
  ]) {
    assert.throws(() => selectLegalException([{ ...entry, ...change }], state), /require/);
  }
});

test("adapts only the exact prepared constant, adds the mandatory typed probe, and restores everything", () => {
  const { tree, close } = fixture();
  try {
    const installed = installLegalFixture(tree, fixtureEntry, "http://127.0.0.1:3000");
    assert.equal(installed.suite, probePath);
    assert.equal(
      readFileSync(join(tree, modulePath), "utf8"),
      original.replace(entry.fromVersion, entry.toVersion),
    );
    assert.equal(
      readFileSync(join(tree, "apps/desktop/src/main/frozen.live.test.ts"), "utf8"),
      "unchanged test body",
    );
    const probe = readFileSync(join(tree, probePath), "utf8");
    assert.ok(probe.includes(JSON.stringify(entry.fromVersion)));
    assert.ok(probe.includes(JSON.stringify(entry.toVersion)));
    assert.match(probe, /toBeInstanceOf\(ConvexError\)/);
    assert.ok(probe.includes(`code: "${entry.refusalCode}"`));
    assert.match(probe, /expect\(refusal\.data\)\.toEqual/);
    assert.match(probe, /accounts\.viewer, \{\}\)\)\.toBeNull/);
    assert.match(probe, /SIMULATED current-consent fixture/);
    assert.match(probe, /expect\(accepted\.previewAgreementAccepted\)\.toBe\(true\)/);
    assert.throws(() => installLegalFixture(tree, fixtureEntry, "http://127.0.0.1:3000"), /EEXIST/);
    installed.restore();
    assert.equal(readFileSync(join(tree, modulePath), "utf8"), original);
    assert.equal(existsSync(join(tree, probePath)), false);
    assert.equal(existsSync(join(tree, ".legal-fixture.lock")), false);
  } finally {
    close();
  }
});

test("no adaptation can reach a cloud deployment or accept a changed module", () => {
  const { tree, close } = fixture();
  try {
    for (const url of [
      "https://production.convex.cloud",
      "http://192.168.1.1",
      "http://name:password@127.0.0.1:3000",
    ]) {
      assert.throws(() => installLegalFixture(tree, fixtureEntry, url), /loopback/);
    }
    assert.throws(
      () => installLegalFixture(tree, entry, "http://localhost:3000"),
      /exception hash/,
    );
    assert.equal(existsSync(join(tree, ".legal-fixture.lock")), false);
    assert.equal(readFileSync(join(tree, modulePath), "utf8"), original);
    writeFileSync(join(tree, probePath), "someone else's file");
    assert.throws(
      () => installLegalFixture(tree, fixtureEntry, "http://localhost:3000"),
      /overwrite/,
    );
    assert.equal(readFileSync(join(tree, probePath), "utf8"), "someone else's file");
    assert.equal(existsSync(join(tree, ".legal-fixture.lock")), false);
    rmSync(join(tree, probePath));
    const missing = original.replace("export const", "const");
    writeFileSync(join(tree, modulePath), missing);
    assert.throws(
      () =>
        installLegalFixture(
          tree,
          {
            ...fixtureEntry,
            moduleSha256: createHash("sha256").update(missing).digest("hex"),
          },
          "http://127.0.0.1:3000",
        ),
      /missing or duplicated/,
    );
    assert.equal(existsSync(join(tree, ".legal-fixture.lock")), false);
  } finally {
    close();
  }
});

test("runner requires fresh probe evidence, restores on failures, and expires the adaptation", () => {
  const { tree, close } = fixture();
  try {
    // Exact public source snapshot, pinned by the exception hash. No tag or checkout mutation.
    const frozen = readFileSync(
      new URL("./fixtures/canary.2-preview-access.txt", import.meta.url),
      "utf8",
    );
    assert.equal(createHash("sha256").update(frozen).digest("hex"), entry.moduleSha256);
    writeFileSync(join(tree, modulePath), frozen);
    for (const suite of LIVE_SUITES) {
      mkdirSync(dirname(join(tree, suite)), { recursive: true });
      writeFileSync(join(tree, suite), "frozen body");
    }
    mkdirSync(join(tree, "convex/functions/_generated"), { recursive: true });
    writeFileSync(join(tree, "convex/functions/_generated/api.js"), "// own API");
    mkdirSync(join(tree, "apps/desktop/node_modules/@volli"), { recursive: true });
    symlinkSync(join(tree, "convex"), join(tree, "apps/desktop/node_modules/@volli/convex"));
    mkdirSync(join(tree, "node_modules/.bin"), { recursive: true });
    const repo = join(tree, "tags");
    mkdirSync(repo);
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "--quiet");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "tags fixture",
    );
    git("tag", entry.tag);
    const manifest = join(tree, "older-app.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        ...state,
        tree,
        suites: LIVE_SUITES,
        absent: [],
        appVersion: "0.3.0-canary.2",
      }),
    );
    const report = join(tree, "report.json");
    const invocation = join(tree, "invocation.json");
    // Only the external test runner is fake: real CLI, manifest, registry,
    // adaptation, cleanup and reporter validation execute in child processes.
    writeFileSync(
      join(tree, "node_modules/.bin/vp"),
      `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const suites = args.filter(arg => arg.endsWith(".test.ts")).map(arg => "apps/desktop/" + arg);
fs.writeFileSync(${JSON.stringify(invocation)}, JSON.stringify({ suites, module: fs.readFileSync(${JSON.stringify(join(tree, modulePath))}, "utf8") }));
const mode = process.env.LEGAL_FIXTURE_UNIT_MODE;
const results = suites.filter(file => mode !== "missing" || !file.includes("legal-consent.exception")).map((file, index) => ({ name: path.join(${JSON.stringify(tree)}, file), status: "passed", assertionResults: [{ status: (mode === "body-failure" && index === 0) || (mode === "probe-failure" && file.includes("legal-consent.exception")) ? "failed" : "passed" }] }));
const failed = results.filter(result => result.assertionResults[0].status === "failed").length;
fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ success: failed === 0, numTotalTests: results.length, numPassedTests: results.length - failed, numFailedTests: failed, testResults: results }));
process.exit(mode === "runner-failure" ? 1 : 0);
`,
      { mode: 0o755 },
    );
    const run = (mode) =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("./older-app-live.mjs", import.meta.url)),
          "--manifest",
          manifest,
          "--report",
          report,
        ],
        {
          cwd: repo,
          encoding: "utf8",
          env: {
            ...process.env,
            GITHUB_STEP_SUMMARY: "",
            LEGAL_FIXTURE_UNIT_MODE: mode,
            VOLLI_CONVEX_URL: "http://127.0.0.1:3000",
            VOLLI_CONVEX_SITE_URL: "http://127.0.0.1:3001",
            VOLLI_CONVEX_TEST_PRIVATE_KEY: "unit-fixture-only",
            VOLLI_CONVEX_ADMIN_KEY: "unit-fixture-only",
          },
        },
      );
    for (const mode of ["pass", "missing", "body-failure", "probe-failure", "runner-failure"]) {
      const child = run(mode);
      assert.equal(
        child.status,
        mode === "pass" ? 0 : 1,
        `${mode}: ${child.stdout}\n${child.stderr}`,
      );
      const called = JSON.parse(readFileSync(invocation, "utf8"));
      assert.ok(called.suites.includes(probePath));
      assert.ok(called.module.includes(`= "${entry.toVersion}";`));
      assert.equal(readFileSync(join(tree, modulePath), "utf8"), frozen);
      assert.equal(existsSync(join(tree, probePath)), false);
      assert.equal(existsSync(join(tree, ".legal-fixture.lock")), false);
      for (const suite of LIVE_SUITES)
        assert.equal(readFileSync(join(tree, suite), "utf8"), "frozen body");
    }
    git("tag", "v0.3.0-canary.3");
    const expired = run("pass");
    assert.equal(expired.status, 0, expired.stderr);
    assert.equal(JSON.parse(readFileSync(report, "utf8")).legalException, null);
    assert.equal(JSON.parse(readFileSync(invocation, "utf8")).module, frozen);
    assert.equal(JSON.parse(readFileSync(invocation, "utf8")).suites.includes(probePath), false);
  } finally {
    close();
  }
});

test("restoration never discards concurrent edits", () => {
  for (const changed of [modulePath, probePath]) {
    const { tree, close } = fixture();
    try {
      const installed = installLegalFixture(tree, fixtureEntry, "http://127.0.0.1:3000");
      writeFileSync(join(tree, changed), "concurrent change");
      assert.throws(() => installed.restore(), /changed during the run/);
      assert.equal(readFileSync(join(tree, changed), "utf8"), "concurrent change");
      assert.equal(existsSync(join(tree, ".legal-fixture.lock")), false);
      if (changed === modulePath) assert.equal(existsSync(join(tree, probePath)), false);
      else assert.equal(readFileSync(join(tree, modulePath), "utf8"), original);
    } finally {
      close();
    }
  }
});
