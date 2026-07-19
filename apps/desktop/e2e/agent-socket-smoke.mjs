/**
 * e2e probe 1 (PR #70, spec §Tests → e2e): "app boots socket".
 *
 * Launches the BUILT app against a scratch profile and asserts the agent
 * surface is live the way an external CLI would find it:
 *   1. `<userData>/volli.sock` exists and is a socket with mode 0600
 *      (spec decision 8: private, owner-only).
 *   2. A raw NDJSON `identify` request over that socket gets a well-formed v1
 *      response carrying the app version — the socket actually answers, not
 *      merely binds.
 *   3. The launcher shim `<userData>/bin/volli` is (re)generated on boot
 *      (spec decision 7), so an agent has a `volli` to run.
 *
 * Consent is pre-answered "defer" via the documented test seam so no native
 * dialog sheet dangles over teardown (this probe is not about consent).
 *
 *   Run:
 *     vp run --filter @volli/desktop build
 *     node apps/desktop/e2e/agent-socket-smoke.mjs
 *
 * MANUALLY-RUN (needs a display + the built app); NOT wired into `vp test`.
 */
import { promises as fs } from "node:fs";

import {
  identifyRequest,
  makeShortScratch,
  requestOverSocket,
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

const { scratch, userDataDir, dbPath, cleanup } = await makeShortScratch("sock");
const { attempt, summarize } = createRunner();

async function main() {
  const app = await launch({
    dbPath,
    userDataDir,
    extraEnv: { VOLLI_AGENT_CONSENT_CHOICE: "defer" },
  });
  const socketPath = socketPathFor(userDataDir);
  const shimPath = shimPathFor(userDataDir);
  try {
    await assertProfileIsolated(app, userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // Seed one real project so `identify` has a registered-project cwd to
    // resolve against (the socket resolves context, never guesses — decision 3).
    const projectPath = await makeGitRepo(scratch, "sock-");
    await seedProjects(page, [
      { id: "sock-project", name: "Socket Project", path: projectPath, prefix: "SK" },
    ]);

    // === 1. Socket file exists with owner-only 0600 permissions ==============
    await attempt(1, "volli.sock exists and is a 0600 socket", async () => {
      await waitUntil("socket file to appear", () => pathExists(socketPath), { timeout: 15000 });
      const stat = await fs.lstat(socketPath);
      const isSocket = stat.isSocket();
      const mode = stat.mode & 0o777;
      const ok = isSocket && mode === 0o600;
      return { ok, detail: `isSocket=${isSocket} mode=0${mode.toString(8)}` };
    });

    // === 2. The socket answers a raw identify request with a v1 response =====
    // ctx.cwd is the seeded project's path, so the server resolves context and
    // returns the live app version + project identity.
    await attempt(2, "raw identify round-trip resolves context + app version", async () => {
      const response = await waitUntil(
        "identify to answer ok",
        async () => {
          try {
            const r = await requestOverSocket(socketPath, identifyRequest(projectPath));
            return r?.ok ? r : null;
          } catch {
            return null;
          }
        },
        { timeout: 15000 },
      );
      const ok =
        response?.v === 1 &&
        response?.ok === true &&
        typeof response?.data?.appVersion === "string" &&
        response.data.appVersion.length > 0 &&
        response?.data?.project?.prefix === "SK";
      return {
        ok,
        detail: `v=${response?.v} ok=${response?.ok} appVersion=${JSON.stringify(response?.data?.appVersion)} project=${JSON.stringify(response?.data?.project?.prefix)}`,
      };
    });

    // === 3. Boot regenerated the launcher shim ==============================
    await attempt(3, "boot regenerated the <userData>/bin/volli shim", async () => {
      await waitUntil("shim to appear", () => pathExists(shimPath), { timeout: 15000 });
      const stat = await fs.lstat(shimPath);
      const executable = (stat.mode & 0o111) !== 0;
      const contents = await fs.readFile(shimPath, "utf8");
      const ok =
        executable && contents.includes("ELECTRON_RUN_AS_NODE") && contents.includes("exec");
      return {
        ok,
        detail: `executable=${executable} bakesRunAsNode=${contents.includes("ELECTRON_RUN_AS_NODE")}`,
      };
    });
  } finally {
    await app.close();
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
