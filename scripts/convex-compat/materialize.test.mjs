import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { extractTree, installTree } from "./materialize.mjs";

const scratch = fileURLToPath(new URL("../../.scratch/", import.meta.url));
function fixture() {
  mkdirSync(scratch, { recursive: true });
  return mkdtempSync(resolve(scratch, "materialize-test-"));
}
test("materialization archives the exact commit, not working-tree edits or git metadata", () => {
  const tree = fixture();
  try {
    const repo = resolve(tree, "repo"),
      out = resolve(tree, "out");
    mkdirSync(repo);
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    git("init", "--quiet");
    writeFileSync(resolve(repo, "source.txt"), "shipped");
    git("add", "source.txt");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    );
    const commit = git("rev-parse", "HEAD");
    writeFileSync(resolve(repo, "source.txt"), "not shipped");
    extractTree(commit, out, repo);
    assert.equal(readFileSync(resolve(out, "source.txt"), "utf8"), "shipped");
    assert.equal(existsSync(resolve(out, ".git")), false);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});
test("install uses the selected tree, frozen graph, no lifecycle scripts; failures do not fall back", () => {
  const tree = fixture(),
    previous = process.env.PATH;
  try {
    const bin = resolve(tree, "bin");
    mkdirSync(bin);
    const command = resolve(bin, "vp");
    writeFileSync(command, '#!/bin/sh\nprintf "%s\\n" "$@" > install-args.txt\n', { mode: 0o755 });
    process.env.PATH = `${bin}:${previous}`;
    installTree(tree, "@volli/convex");
    assert.deepEqual(readFileSync(resolve(tree, "install-args.txt"), "utf8").trim().split("\n"), [
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--filter",
      "@volli/convex...",
    ]);
    writeFileSync(command, "#!/bin/sh\nexit 9\n", { mode: 0o755 });
    assert.throws(() => installTree(tree, "@volli/desktop"), /vp install failed/);
  } finally {
    process.env.PATH = previous;
    rmSync(tree, { recursive: true, force: true });
  }
});
test("prepare normalizes symlinked output paths; runner cannot reuse a stale passing report", () => {
  const tree = fixture();
  try {
    const repo = resolve(tree, "repo"),
      bin = resolve(tree, "bin");
    const suite = "apps/desktop/src/main/cloud-sessions.live.test.ts";
    mkdirSync(resolve(repo, "apps/desktop/src/main"), { recursive: true });
    mkdirSync(resolve(repo, "convex/functions/_generated"), { recursive: true });
    mkdirSync(bin);
    writeFileSync(resolve(repo, "apps/desktop/package.json"), '{"version":"1.2.3"}');
    writeFileSync(resolve(repo, "convex/functions/_generated/api.js"), "// fixture");
    writeFileSync(resolve(repo, suite), "// shipped suite fixture");
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    git("init", "--quiet");
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "release fixture",
    );
    git("tag", "v1.2.3");
    // Fake only the install/test command. Archive, manifests and reporter
    // handling execute through the real CLIs, without a backend or network.
    writeFileSync(
      resolve(bin, "vp"),
      '#!/bin/sh\nif [ "$1" = install ]; then mkdir -p apps/desktop/node_modules/@volli; ln -s ../../../../convex apps/desktop/node_modules/@volli/convex; fi\n',
      { mode: 0o755 },
    );
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_STEP_SUMMARY: "" };
    mkdirSync(resolve(tree, "actual"));
    symlinkSync(resolve(tree, "actual"), resolve(tree, "alias"));
    const prepare = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./prepare-older-app.mjs", import.meta.url)),
        "--tag",
        "v1.2.3",
        "--out",
        resolve(tree, "alias"),
      ],
      { cwd: repo, env, encoding: "utf8" },
    );
    assert.equal(prepare.status, 0, prepare.stderr);
    const manifestPath = prepare.stdout.trim().split("\n").at(-1);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.tree, realpathSync(manifest.tree));
    assert.equal(manifest.tree.includes("/alias/"), false);
    const report = resolve(tree, "report.json");
    writeFileSync(
      report,
      JSON.stringify({
        success: true,
        numTotalTests: 1,
        numPassedTests: 1,
        testResults: [
          {
            name: resolve(manifest.tree, suite),
            status: "passed",
            assertionResults: [{ status: "passed" }],
          },
        ],
      }),
    );
    const run = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./older-app-live.mjs", import.meta.url)),
        "--manifest",
        manifestPath,
        "--report",
        report,
      ],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...env,
          VOLLI_CONVEX_URL: "http://127.0.0.1:1",
          VOLLI_CONVEX_SITE_URL: "http://127.0.0.1:2",
          VOLLI_CONVEX_TEST_PRIVATE_KEY: "fixture-only",
          VOLLI_CONVEX_ADMIN_KEY: "fixture-only",
        },
      },
    );
    assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
    assert.equal(JSON.parse(readFileSync(report, "utf8")).verdict.total, 0);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});
