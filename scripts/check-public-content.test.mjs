import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./check-public-content.mjs", import.meta.url));
const scratch = fileURLToPath(new URL("../.tmp/", import.meta.url));
const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CEILING_DIRECTORIES: scratch,
};

function repository(t) {
  mkdirSync(scratch, { recursive: true });
  const cwd = mkdtempSync(join(scratch, "public-content-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd, env: gitEnv });
  return cwd;
}

function add(cwd, path, staged = true) {
  const file = join(cwd, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "fixture\n");
  if (staged) execFileSync("git", ["add", "--", path], { cwd, env: gitEnv });
}

function check(cwd) {
  return spawnSync(process.execPath, [script], {
    cwd,
    encoding: "utf8",
    env: gitEnv,
  });
}

test("allows public docs, benchmarks and similarly named directories", (t) => {
  const cwd = repository(t);
  for (const path of [
    "docs/protocol.md",
    "docs/licensing/NOTICE.md",
    "packages/shared/bench/baseline.json",
    "docs/plans-guide.md",
    "docs/research-tools/README.md",
  ])
    add(cwd, path);
  const result = check(cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Public content check passed/);
});

for (const directory of ["plans", "research"]) {
  test(`rejects tracked files nested under docs/${directory}`, (t) => {
    const cwd = repository(t);
    const path = `docs/${directory}/nested/a note.md`;
    add(cwd, path);
    const result = check(cwd);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(path));
  });
}

test("rejects untracked additions before they are staged", (t) => {
  const cwd = repository(t);
  add(cwd, "docs/research/proof.png", false);
  const result = check(cwd);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /proof\.png/);
});

test("allows removal of the last restricted file", (t) => {
  const cwd = repository(t);
  add(cwd, "docs/plans/note.md");
  execFileSync("git", ["rm", "--force", "--", "docs/plans/note.md"], { cwd, env: gitEnv });
  assert.equal(check(cwd).status, 0);
});

test("the CI check lane runs the guard and its tests", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const checkLane = workflow.slice(
    workflow.indexOf("\n  check:"),
    workflow.indexOf("\n  test-desktop:"),
  );
  assert.match(checkLane, /node --test scripts\/check-public-content\.test\.mjs/);
  assert.match(checkLane, /node scripts\/check-public-content\.mjs/);
});

test("session peek screenshots default to ignored workspace output", () => {
  const source = readFileSync(
    new URL("../apps/desktop/e2e/session-peek-shots.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /const OUT_DIR = process\.argv\[2\] \?\? join\(REPO, "\.tmp", "session-peek-shots"\);/,
  );
  const ignored = spawnSync("git", ["check-ignore", ".tmp/session-peek-shots/capture.png"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: gitEnv,
    encoding: "utf8",
  });
  assert.equal(ignored.status, 0, ignored.stderr);
});

test("fails closed outside a git repository", (t) => {
  const cwd = repository(t);
  rmSync(join(cwd, ".git"), { recursive: true, force: true });
  assert.notEqual(check(cwd).status, 0);
});
