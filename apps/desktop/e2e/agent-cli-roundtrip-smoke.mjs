/**
 * e2e probe 2 (PR #70, spec §Tests → e2e): "real CLI against the running app".
 *
 * Drives the ACTUAL generated `volli` shim (Electron-as-node over the built CLI
 * bundle, decision 7) against a live app's Unix socket and asserts the full
 * write→read round-trip an agent performs, including the display-ID and
 * exit-code contracts (decision 6):
 *   1. `ticket create` prints the new display ID first, in Backlog, exit 0.
 *   2. `ticket move --to doing` reports the same ID now in Doing, exit 0.
 *   3. `ticket comment -m` acknowledges against the same ID, exit 0.
 *   4. `board` shows that ID under Doing, exit 0.
 *   5. `--json` create yields machine output whose ticket.id matches the
 *      pretty display ID (parallel code path, not munged pretty-print).
 *   6. A dead VOLLI_SOCKET yields error[APP_UNREACHABLE] on stderr, exit 3
 *      (the retryable infra class hooks branch on).
 *
 * Consent is pre-answered "defer" via the documented test seam.
 *
 *   Run:
 *     vp run --filter @volli/desktop build
 *     node apps/desktop/e2e/agent-cli-roundtrip-smoke.mjs
 *
 * MANUALLY-RUN (needs a display + the built app); NOT wired into `vp test`.
 */
import { join } from "node:path";

import { makeShortScratch, runVolliShim, shimPathFor, socketPathFor } from "./lib/agent-kit.mjs";
import {
  assertProfileIsolated,
  createRunner,
  launch,
  makeGitRepo,
  pathExists,
  seedProjects,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const { scratch, userDataDir, dbPath, cleanup } = await makeShortScratch("cli");
const { attempt, summarize } = createRunner();

const PREFIX = "CL";

async function main() {
  const app = await launch({
    dbPath,
    userDataDir,
    extraEnv: { VOLLI_AGENT_CONSENT_CHOICE: "defer" },
  });
  const shimPath = shimPathFor(userDataDir);
  const socketPath = socketPathFor(userDataDir);
  try {
    await assertProfileIsolated(app, userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    const projectPath = await makeGitRepo(scratch, "cli-");
    await seedProjects(page, [
      { id: "cli-project", name: "CLI Project", path: projectPath, prefix: PREFIX },
    ]);

    // The shim bakes VOLLI_SOCKET to this app's socket, so a bare invocation
    // targets this live app. Wait for both artifacts to exist first.
    await waitUntil(
      "shim + socket to exist",
      async () => (await pathExists(shimPath)) && (await pathExists(socketPath)),
    );

    let displayId = null;

    // === 1. ticket create → new display ID first, Backlog, exit 0 ============
    await attempt(1, "ticket create prints new display ID in Backlog (exit 0)", async () => {
      const r = await runVolliShim(shimPath, [
        "ticket",
        "create",
        "--title",
        "CLI created ticket",
        "--project",
        PREFIX,
        "--no-worktree",
      ]);
      const firstLine = r.stdout.trim().split("\n")[0] ?? "";
      const match = firstLine.match(new RegExp(`^${PREFIX}-\\d+`));
      displayId = match ? match[0] : null;
      const ok =
        r.code === 0 &&
        displayId !== null &&
        firstLine.includes("Backlog") &&
        firstLine.includes("CLI created ticket");
      return {
        ok,
        detail: `code=${r.code} stdout=${JSON.stringify(firstLine)} stderr=${JSON.stringify(r.stderr.trim())}`,
      };
    });

    // === 2. ticket move --to doing → same ID, Doing, exit 0 =================
    await attempt(2, "ticket move --to doing reports the same ID in Doing (exit 0)", async () => {
      if (displayId === null) return { ok: false, detail: "no display ID from create" };
      const r = await runVolliShim(shimPath, ["ticket", "move", displayId, "--to", "doing"]);
      const line = r.stdout.trim();
      const ok = r.code === 0 && line.startsWith(displayId) && line.includes("Doing");
      return { ok, detail: `code=${r.code} stdout=${JSON.stringify(line)}` };
    });

    // === 3. ticket comment -m → acknowledged against the same ID (exit 0) ====
    await attempt(3, "ticket comment -m acknowledges against the same ID (exit 0)", async () => {
      if (displayId === null) return { ok: false, detail: "no display ID from create" };
      const r = await runVolliShim(shimPath, [
        "ticket",
        "comment",
        displayId,
        "-m",
        "hello from the cli",
      ]);
      const line = r.stdout.trim();
      const ok = r.code === 0 && line.startsWith(displayId) && line.includes("comment added");
      return { ok, detail: `code=${r.code} stdout=${JSON.stringify(line)}` };
    });

    // === 4. board → the ID appears under Doing (exit 0) =====================
    await attempt(4, "board shows the ID under Doing (exit 0)", async () => {
      if (displayId === null) return { ok: false, detail: "no display ID from create" };
      const r = await runVolliShim(shimPath, ["board", "--project", PREFIX]);
      const out = r.stdout;
      const doingIndex = out.indexOf("Doing");
      const idIndex = out.indexOf(displayId);
      const ok = r.code === 0 && doingIndex !== -1 && idIndex > doingIndex;
      return {
        ok,
        detail: `code=${r.code} hasDoing=${doingIndex !== -1} idAfterDoing=${idIndex > doingIndex}`,
      };
    });

    // === 5. --json create: machine ticket.id matches the display-ID contract =
    await attempt(5, "--json create emits a parseable ticket.id display ID (exit 0)", async () => {
      const r = await runVolliShim(shimPath, [
        "ticket",
        "create",
        "--title",
        "CLI json ticket",
        "--project",
        PREFIX,
        "--no-worktree",
        "--json",
      ]);
      let parsed = null;
      try {
        parsed = JSON.parse(r.stdout.trim());
      } catch {
        parsed = null;
      }
      const id = parsed?.ticket?.id;
      const ok = r.code === 0 && typeof id === "string" && new RegExp(`^${PREFIX}-\\d+$`).test(id);
      return { ok, detail: `code=${r.code} ticket.id=${JSON.stringify(id)}` };
    });

    // === 6. Dead socket → error[APP_UNREACHABLE], exit 3 ====================
    await attempt(6, "dead VOLLI_SOCKET yields error[APP_UNREACHABLE] exit 3", async () => {
      const deadSocket = join(scratch, "definitely-not-a-socket.sock");
      const r = await runVolliShim(shimPath, ["board", "--project", PREFIX], {
        VOLLI_SOCKET: deadSocket,
      });
      const ok = r.code === 3 && r.stderr.includes("error[APP_UNREACHABLE]");
      return { ok, detail: `code=${r.code} stderr=${JSON.stringify(r.stderr.trim())}` };
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
