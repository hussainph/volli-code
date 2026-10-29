#!/usr/bin/env node
/** Contained, visible owner UI check on the move harness's existing APFS copy.
 * No app is launched on import; tests exercise the environment/target plan.
 */
import { spawn } from "node:child_process";
import { readFile, mkdir, writeFile, realpath, mkdtemp, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { assertProfileIdle } from "../../../../packages/host-core/src/migration-dry-run/move-safety.ts";
import { pathToFileURL } from "node:url";
import { userInfo } from "node:os";
import { parseArgs } from "node:util";
import {
  APP_DIR,
  BUILT_MAIN,
  REPO,
  assertLaunchable,
  electronExtraEnv,
  instanceLayout,
  supervisorEnv,
} from "./lib/core.mjs";
import { deploymentElectronEnv, readDeployment } from "./lib/deployment.mjs";
import { startFakeProvider } from "./lib/fake-provider.mjs";
import { ELECTRON, writeFakeLoginShell } from "../lib/smoke-kit.mjs";

export async function rehearsalUiPlan(profile, deployment) {
  const copy = await realpath(profile);
  const root = dirname(copy),
    home = userInfo().homedir;
  if (root === "/" || root === home || root.startsWith(`${home}/`) || home.startsWith(`${root}/`))
    throw new Error("contained UI copy must be under a private /tmp root, outside the owner home");
  const state = JSON.parse(await readFile(`${copy}.rehearsal.json`, "utf8"));
  if (
    state.uiReady !== true ||
    (await realpath(state.profile)) !== copy ||
    state.target !== deployment.convexUrl ||
    deployment.name !== "staging"
  )
    throw new Error("UI check needs this harness's staging profile and matching deployment");
  const layout = {
    ...instanceLayout(dirname(copy), join(dirname(copy), "ui-evidence")),
    userDataDir: copy,
    dbPath: join(copy, "volli.db"),
    appSocket: join(copy, "volli.sock"),
  };
  return { layout, deployment };
}

/** UI history reads do not need a live checkout. Scrub machine-side pointers
 * only in the disposable copy before app startup. Never run git or clone a
 * repository here: linked worktrees can point back into the owner's .git.
 */
export async function containCopiedPaths(layout) {
  assertProfileIdle(layout.userDataDir);
  for (const path of [layout.dbPath, `${layout.dbPath}-wal`, `${layout.dbPath}-shm`]) {
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new Error("copied database symlink refused");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const db = new Database(layout.dbPath);
  db.pragma("foreign_keys = ON");
  try {
    const isolated = await mkdtemp(join(layout.scratch, "ui-projects-"));
    const projects = db.prepare("SELECT id,path FROM projects").all();
    for (const project of projects) {
      const path = join(
        isolated,
        createHash("sha256").update(project.id).digest("hex"),
        basename(project.path),
      );
      await mkdir(path, { recursive: true, mode: 0o700 });
      project.scratchPath = path;
    }
    db.transaction(() => {
      for (const project of projects)
        db.prepare("UPDATE projects SET path=? WHERE id=?").run(project.scratchPath, project.id);
      db.prepare("UPDATE tickets SET worktree_path=NULL").run();
      for (const table of [
        "project_checkout_paths",
        "working_copy_paths",
        "worktree_cleanup_receipts",
        "worktree_cleanup_facts",
        "worktree_cleanup_commands",
        "spawned_processes",
      ]) {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
          db.exec(`DELETE FROM ${table}`);
      }
      db.prepare("DELETE FROM app_state WHERE key='volli:orphan-processes'").run(); // default auto-reap is off
    })();
  } finally {
    db.close();
  }
}

async function main() {
  const { values } = parseArgs({
    options: { profile: { type: "string" }, deployment: { type: "string" } },
  });
  if (!values.profile || values.deployment !== "staging")
    throw new Error("usage: rehearsal-ui.mjs --profile <scratch-copy> --deployment staging");
  const deployment = await readDeployment({ deployment: values.deployment }, REPO);
  const { layout: L } = await rehearsalUiPlan(values.profile, deployment);
  assertLaunchable({ build: "dev", bundle: BUILT_MAIN, deployment });
  await containCopiedPaths(L);
  for (const directory of [L.home, L.piAgentDir, L.harnessDir, L.worktreeHome, L.binDir, L.zdotDir])
    await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(L.home, ".gitconfig"),
    "[user]\n name = Rehearsal\n email = rehearsal@volli.test\n[commit]\n gpgsign = false\n",
  );
  await writeFile(
    join(L.binDir, "gh"),
    "#!/bin/sh\necho 'gh disabled in rehearsal' >&2\nexit 1\n",
    { mode: 0o755 },
  );
  const path = `${L.binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`;
  const loginShell = await writeFakeLoginShell(L.binDir, path);
  const provider = await startFakeProvider();
  const env = {
    ...supervisorEnv(process.env),
    ...electronExtraEnv(L, { loginShell, path, providerEnv: provider.env }),
    ...deploymentElectronEnv(deployment),
    VOLLI_QUIET_WINDOWS: "0",
  };
  // Do not inherit the operator's deploy/person token, redaction inventory path,
  // SSH agent, provider keys, HOME or Pi auth. The guard traps real keychains.
  const child = spawn(ELECTRON, [APP_DIR, `--user-data-dir=${L.userDataDir}`], {
    cwd: APP_DIR,
    env,
    stdio: "inherit",
  });
  console.error(
    `WorkOS URLs are recorded in ${join(L.harnessDir, "external-requests.jsonl")}; open the staging sign-in URL yourself. For the Session check select Azure OpenAI / gpt-4.1-mini (loopback fake model).`,
  );
  const stop = () => child.kill("SIGTERM");
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, stop);
  try {
    process.exitCode = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => done(code ?? 1));
    });
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.removeListener(signal, stop);
    await provider.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    console.error(
      "Contained rehearsal UI refused; check the copy, staging profile and fresh dev build.",
    );
    process.exitCode = 1;
  });
}
