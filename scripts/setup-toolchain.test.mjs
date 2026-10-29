import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parse } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const load = (path) => parse(readFileSync(join(root, path), "utf8"));
const action = load(".github/actions/setup-toolchain/action.yml");
const steps = action.runs.steps;
const step = (name) => {
  const found = steps.find((entry) => entry.name === name);
  assert.ok(found, `missing step: ${name}`);
  return found;
};

test("all Vite+ workflow sites use the shared locked bootstrap after checkout", () => {
  let sites = 0;
  let deferredInstalls = 0;
  for (const file of ["ci.yml", "ci-extended.yml", "release.yml", "smoke-quarantine.yml"]) {
    const workflow = load(`.github/workflows/${file}`);
    for (const [name, job] of Object.entries(workflow.jobs)) {
      for (const [index, setup] of (job.steps ?? []).entries()) {
        assert.ok(!setup.uses?.startsWith("voidzero-dev/setup-vp@"), `${file}: ${name}`);
        if (setup.name !== "Setup Vite+") continue;
        sites++;
        assert.equal(setup.uses, "./.github/actions/setup-toolchain");
        assert.ok(
          job.steps.slice(0, index).some((entry) => entry.uses?.startsWith("actions/checkout@")),
        );
        assert.deepEqual(
          Object.keys(setup.with).toSorted(),
          setup.with.cache ? ["cache", "run-install"] : ["run-install"],
        );
        if (setup.with["run-install"] === false) deferredInstalls++;
      }
    }
  }
  assert.equal(sites, 19);
  assert.equal(deferredInstalls, 3);
});

test("Node and third-party actions are pinned; store caching is opt-in and lock-keyed", () => {
  assert.equal(action.runs.using, "composite");
  assert.equal(action.inputs.cache.default, "false");
  assert.equal(action.inputs["run-install"].default, "true");
  assert.deepEqual(step("Setup pinned Node").with, {
    "node-version-file": ".nvmrc",
    "package-manager-cache": false,
  });
  for (const entry of steps) {
    if (entry.uses) assert.match(entry.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    if (entry.run) assert.equal(entry.shell, "bash");
  }
  const cache = step("Cache pnpm store");
  assert.equal(cache.if, "inputs.cache == 'true'");
  assert.equal(step("Locate pnpm store").if, cache.if);
  assert.equal(cache.with.path, "${{ steps.store.outputs.path }}");
  for (const input of [
    "runner.os",
    "runner.arch",
    ".nvmrc",
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "patches/**",
  ]) {
    assert.ok(cache.with.key.includes(input), input);
  }
  assert.equal(step("Install from the workspace lockfile").if, "inputs.run-install == 'true'");
  assert.equal(step("Install from the workspace lockfile").run, "pnpm install --frozen-lockfile");
  assert.equal(step("Report locked toolchain").if, "inputs.run-install == 'true'");
  assert.match(step("Report locked toolchain").run, /command -v vp/);
  assert.match(step("Report locked toolchain").run, /list vite-plus vite/);
  assert.match(step("Report locked toolchain").run, /list rolldown/);
});

function fixture(t) {
  mkdirSync(join(root, ".tmp"), { recursive: true });
  const dir = mkdtempSync(join(root, ".tmp/setup-toolchain-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "node-bin");
  mkdirSync(bin);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@11.10.0" }));
  writeFileSync(join(dir, ".nvmrc"), "24.22.1\n");
  const executable = (name, content) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/bash\nset -euo pipefail\n${content}\n`);
    chmodSync(path, 0o755);
  };
  // Exercise the action's real shell, but never install shims in the real Node
  // directory or fetch anything. Only runtime/version discovery is substituted.
  executable(
    "node",
    `case "$*" in
    '-p process.execPath') echo "$0" ;;
    '-p process.versions.node') echo "$NODE_VERSION" ;;
    *) exec "$REAL_NODE" "$@" ;;
  esac`,
  );
  executable(
    "corepack",
    `printf '%s\\n' "$*" >> "$COMMANDS"
    test "$1" = enable
    test "$2" = --install-directory
    test "$4" = pnpm
    printf '#!/bin/bash\\necho %s\\n' "$PNPM_VERSION" > "$3/pnpm"
    chmod +x "$3/pnpm"`,
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    REAL_NODE: process.execPath,
    RUNNER_TEMP: dir,
    GITHUB_WORKSPACE: dir,
    GITHUB_PATH: join(dir, "path"),
    COMMANDS: join(dir, "commands"),
    PNPM_VERSION: "11.10.0",
    NODE_VERSION: "24.22.1",
  };
  return { dir, env, executable };
}

test("bootstrap enables only exact pnpm and exposes the future workspace binary path", (t) => {
  const { dir, env } = fixture(t);
  const outcome = spawnSync("bash", ["-c", step("Enable pinned pnpm and workspace binaries").run], {
    cwd: dir,
    env,
    encoding: "utf8",
  });
  assert.equal(outcome.status, 0, outcome.stdout + outcome.stderr);
  assert.equal(
    readFileSync(env.GITHUB_PATH, "utf8"),
    `${dir}/pnpm-bin\n${dir}/node_modules/.bin\n`,
  );
  assert.equal(
    readFileSync(env.COMMANDS, "utf8"),
    `enable --install-directory ${dir}/pnpm-bin pnpm\n`,
  );
});

for (const mismatch of [{ PNPM_VERSION: "11.11.0" }, { NODE_VERSION: "24.22.2" }]) {
  test(`bootstrap fails closed on version drift: ${Object.keys(mismatch)[0]}`, (t) => {
    const { dir, env } = fixture(t);
    const outcome = spawnSync(
      "bash",
      ["-c", step("Enable pinned pnpm and workspace binaries").run],
      {
        cwd: dir,
        env: { ...env, ...mismatch },
        encoding: "utf8",
      },
    );
    assert.notEqual(outcome.status, 0);
  });
}

test("install executes frozen pnpm and reporting rejects a global Vite+ binary", (t) => {
  const { dir, env, executable } = fixture(t);
  executable("pnpm", 'printf "%s\\n" "$*" >> "$COMMANDS"');
  executable("vp", "exit 0");
  const install = spawnSync("bash", ["-c", step("Install from the workspace lockfile").run], {
    cwd: dir,
    env,
    encoding: "utf8",
  });
  assert.equal(install.status, 0, install.stderr);
  assert.equal(readFileSync(env.COMMANDS, "utf8"), "install --frozen-lockfile\n");
  const report = spawnSync("bash", ["-c", step("Report locked toolchain").run], {
    cwd: dir,
    env,
    encoding: "utf8",
  });
  assert.notEqual(report.status, 0);
});
