/**
 * Regression smoke: a generated CLI can relaunch the same app/profile after
 * its original Electron process exits.
 *
 * This is the two-generation seam that caught the former dev failure:
 * generation one could bake paths relative to apps/desktop, while generation
 * two inferred apps/desktop/dist-electron and rewrote the shim with
 * apps/packages/cli/dist/volli.cjs plus a doubled dist-electron app entry.
 *
 * Run after the desktop build:
 *   node apps/desktop/e2e/agent-cli-relaunch-smoke.mjs
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  identifyRequest,
  makeShortScratch,
  requestOverSocket,
  runVolliShim,
  shimPathFor,
  socketPathFor,
} from "./lib/agent-kit.mjs";
import {
  assertProfileIsolated,
  createRunner,
  launch,
  makeGitRepo,
  pathExists,
  seedProjects,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const execFileAsync = promisify(execFile);
const { scratch, userDataDir, cleanup } = await makeShortScratch("relaunch");
const { attempt, summarize } = createRunner();
const socketPath = socketPathFor(userDataDir);
const shimPath = shimPathFor(userDataDir);
const installedBundlePath = join(userDataDir, "bin", "volli.cjs");
const profileDbPath = join(userDataDir, "volli.db");

async function stopDetachedSocketOwner() {
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("/usr/sbin/lsof", ["-t", socketPath]));
  } catch (error) {
    if (typeof error?.code === "number" && error.code === 1) return;
    throw error;
  }
  const pids = stdout
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10))
    .filter(Number.isInteger);
  for (const pid of pids) process.kill(pid, "SIGTERM");
  try {
    await waitUntil(
      "detached app socket to disappear",
      async () => !(await pathExists(socketPath)),
      {
        timeout: 5_000,
      },
    );
  } catch (error) {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The owner may have exited between the timeout and escalation.
      }
    }
    throw error;
  }
}

async function main() {
  let app = await launch({
    dbPath: profileDbPath,
    userDataDir,
    extraEnv: { VOLLI_AGENT_CONSENT_CHOICE: "defer" },
  });
  try {
    await assertProfileIsolated(app, userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const projectPath = await makeGitRepo(scratch, "relaunch-");
    await seedProjects(page, [
      { id: "relaunch-project", name: "Relaunch Project", path: projectPath, prefix: "RL" },
    ]);
    await waitUntil(
      "generation-one socket, shim, and installed bundle",
      async () =>
        (await pathExists(socketPath)) &&
        (await pathExists(shimPath)) &&
        (await pathExists(installedBundlePath)),
      { timeout: 15_000 },
    );

    await attempt(1, "generation one installs a profile-local client bundle", async () => {
      const shim = await fs.readFile(shimPath, "utf8");
      const ok =
        shim.includes(installedBundlePath) &&
        !shim.includes("/apps/packages/") &&
        !shim.includes("dist-electron/dist-electron");
      return { ok, detail: `installed=${shim.includes(installedBundlePath)}` };
    });

    await app.close();
    app = null;
    await waitUntil("generation-one socket to close", async () => !(await pathExists(socketPath)), {
      timeout: 10_000,
    });

    await attempt(2, "generated shim relaunches the same profile", async () => {
      const result = await runVolliShim(shimPath, ["app", "launch", "--timeout", "20"]);
      return {
        ok: result.code === 0 && result.stdout.trim() === "Volli launched",
        detail: `code=${result.code} stdout=${JSON.stringify(result.stdout.trim())} stderr=${JSON.stringify(result.stderr.trim())}`,
      };
    });

    await attempt(3, "generation two answers identify on the original socket", async () => {
      const response = await requestOverSocket(socketPath, identifyRequest(projectPath));
      const ok =
        response?.v === 1 &&
        response?.ok === true &&
        typeof response?.data?.appVersion === "string" &&
        response.data.appVersion.length > 0;
      return {
        ok,
        detail: `v=${response?.v} ok=${response?.ok} appVersion=${JSON.stringify(response?.data?.appVersion)}`,
      };
    });

    await attempt(4, "generation two keeps every baked runtime path stable", async () => {
      const shim = await fs.readFile(shimPath, "utf8");
      const bundle = await fs.readFile(installedBundlePath);
      const ok =
        bundle.length > 0 &&
        shim.includes(installedBundlePath) &&
        !shim.includes("/apps/packages/") &&
        !shim.includes("dist-electron/dist-electron");
      return { ok, detail: `bundleBytes=${bundle.length}` };
    });
  } finally {
    await app?.close();
    await stopDetachedSocketOwner();
  }
  return summarize();
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error("\nSMOKE ABORTED:", error?.stack ?? error);
  code = 1;
} finally {
  await cleanup();
}
process.exit(code);
