/**
 * E2e probe: the read-only `volli worktree status` / `worktree diff` CLI
 * commands (issue #80) against a live app, over the REAL generated shim + Unix
 * socket.
 *
 * These two commands are the agent's window into "the tree I'm standing in":
 * `worktree status` reports a ticket's branch/base and sync state; `worktree
 * diff` summarizes either the PR range (merge-base, the default) or the
 * uncommitted working tree (`--working-tree`). Both resolve their ticket either
 * from an explicit display-id argument OR — with no id — from the caller's cwd
 * (cwd → worktree → ticket). This probe exercises every one of those rungs end
 * to end through the shim, so a regression in the parser, the socket handler,
 * the worktree module, or the cwd resolution surfaces here.
 *
 * A ticket's worktree is materialized the same way worktree-smoke.mjs does it:
 * boot the ticket's FIRST session over the preload bridge
 * (`window.api.terminal.create({ ticket })`), which runs main's ensure pipeline
 * (`git worktree add` under `$VOLLI_WORKTREE_HOME_DIR`, stamp the row's
 * worktreePath/branch/baseBranch). We poll the ticket row for that stamp rather
 * than scraping the DOM, then run the shim FROM INSIDE the stamped worktree dir
 * (agent-kit's `runVolliShim(..., { cwd })`). The booted session's harness is
 * the FAKE HARNESS (./lib/fake-harness.mjs, the same shadow composer-kickoff-smoke
 * uses): on a dev machine the real `claude` binary IS on PATH, and letting the
 * held command launch a real Claude Code session would nondeterministically
 * dirty the worktree between this probe's exact-count diff/status assertions.
 * The fake is inert (records argv, exits 0) — irrelevant here, which cares only
 * about the git/worktree query surface, not the agent process.
 *
 * `$VOLLI_WORKTREE_HOME_DIR` is ALWAYS overridden to a scratch dir so a dev's
 * real `~/.volli/worktrees` is never touched; the scratch profile roots under a
 * SHORT `/tmp` base (makeShortScratch) so the app's `<userData>/volli.sock`
 * stays inside the ~104-byte sun_path limit. Consent is pre-answered "defer"
 * (the same seam agent-cli-roundtrip uses) so the shim + socket install.
 *
 *   Run:
 *     vp run --filter @volli/desktop build   # (builds the CLI bundle too)
 *     node apps/desktop/e2e/worktree-cli-smoke.mjs
 *
 * MANUALLY-RUN (needs a display + the built app); NOT wired into `vp test`.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  createTicketViaBridge,
  makeShortScratch,
  runVolliShim,
  shimPathFor,
  socketPathFor,
} from "./lib/agent-kit.mjs";
import { buildFakeHarness, harnessEnv } from "./lib/fake-harness.mjs";
import {
  assertProfileIsolated,
  createRunner,
  launch,
  makeGitRepo,
  pathExists,
  readSeededProjects,
  seedProjects,
  sleep,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const execFileAsync = promisify(execFile);

const { scratch, userDataDir, dbPath, cleanup } = await makeShortScratch("wtcli");
const { attempt, summarize } = createRunner();

const PROJECT = { id: "wt-cli-project", name: "Worktree CLI Project", prefix: "WC" };
const DEFAULT_HARNESS_ID = "claude-code";

/** stdout of `git …` in `cwd`, trimmed (empty string on any failure). */
async function gitOut(cwd, args) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout.trim();
  } catch {
    return "";
  }
}

/** Parse a shim result's stdout as JSON, or null when it isn't parseable. */
function parseJson(result) {
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return null;
  }
}

async function main() {
  // Deliberately LOGICAL worktree home: the scratch root sits under macOS's
  // `/tmp` (a symlink to `/private/tmp`), so the row's stamped worktreePath
  // inherits the logical prefix while the EXTERNAL `volli` process reports the
  // PHYSICAL path from `process.cwd()`. The cwd → worktree rung must
  // canonicalize both sides for scenario 1 to resolve at all — this probe is
  // the end-to-end proof of that.
  const fakeHome = join(scratch, "home");
  await fs.mkdir(fakeHome, { recursive: true });
  const harness = await buildFakeHarness(scratch);

  const app = await launch({
    dbPath,
    userDataDir,
    extraEnv: {
      VOLLI_WORKTREE_HOME_DIR: fakeHome,
      VOLLI_AGENT_CONSENT_CHOICE: "defer",
      ...harnessEnv(harness),
    },
  });
  const shimPath = shimPathFor(userDataDir);
  const socketPath = socketPathFor(userDataDir);
  const liveSessionIds = [];

  try {
    await assertProfileIsolated(app, userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1000);

    const projectPath = await makeGitRepo(scratch, "wt-cli-");
    await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
    const { byName } = await readSeededProjects(page);
    const projectId = byName[PROJECT.name]?.id;
    if (!projectId) throw new Error("seeded project missing after import");

    // The shim bakes VOLLI_SOCKET to this app's socket; wait for both artifacts.
    await waitUntil(
      "shim + socket to exist",
      async () => (await pathExists(shimPath)) && (await pathExists(socketPath)),
    );

    async function bootSession(ticketId, prompt) {
      return page.evaluate(
        ({ workspaceId, cwd, tid, harnessId, promptText }) =>
          window.api.terminal.create({
            workspaceId,
            cwd,
            cols: 80,
            rows: 24,
            ticket: { ticketId: tid, kickoff: { harnessId, prompt: promptText } },
          }),
        {
          workspaceId: projectId,
          cwd: projectPath,
          tid: ticketId,
          harnessId: DEFAULT_HARNESS_ID,
          promptText: prompt,
        },
      );
    }

    async function ticketRow(ticketId) {
      const tickets = await page.evaluate(async (pid) => {
        const boot = await window.api.data.bootstrap();
        if (!boot.ok) return [];
        return boot.data.ticketsByProject?.[pid] ?? [];
      }, projectId);
      return tickets.find((t) => t.id === ticketId);
    }

    /** Boot a ticket and return its row once the ensure pipeline stamps the worktree. */
    async function materializeWorktree(title) {
      const { ticketId, displayId } = await createTicketViaBridge(page, PROJECT.name, {
        title,
        status: "todo",
      });
      const created = await bootSession(ticketId, title);
      if (!created.ok) throw new Error(`terminal.create failed: ${created.error}`);
      liveSessionIds.push(created.sessionId);
      const row = await waitUntil(
        "ticket row stamped with worktreePath + branch",
        async () => {
          const r = await ticketRow(ticketId);
          return r && r.worktreePath && r.branch ? r : null;
        },
        { timeout: 30000 },
      );
      return { ticketId, displayId, row };
    }

    // Materialize ONE worktree ticket up front; scenarios 1–3 all query it.
    const { displayId, row } = await materializeWorktree("Worktree CLI observability ticket");
    const worktreeDir = row.worktreePath;
    const branch = row.branch;
    const baseBranch = row.baseBranch;

    // === 1. `worktree status` from INSIDE the worktree cwd (no id arg) =========
    //         Resolves the ticket from cwd → worktree → ticket, and both the
    //         --json shape and the stable text carry branch/base/dirty.
    await attempt(
      1,
      "worktree status (no id) resolves the ticket from the cwd's worktree — branch/base/clean, --json shape",
      async () => {
        const dirtyTruth = (await gitOut(worktreeDir, ["status", "--porcelain"])).length > 0;

        const jsonRes = await runVolliShim(
          shimPath,
          ["worktree", "status", "--json"],
          {},
          {
            cwd: worktreeDir,
          },
        );
        const data = parseJson(jsonRes);
        const jsonOk =
          jsonRes.code === 0 &&
          data !== null &&
          data.ticket === displayId &&
          data.project === PROJECT.name &&
          data.worktreePath === worktreeDir &&
          data.branch === branch &&
          data.baseBranch === baseBranch &&
          data.uncommitted === dirtyTruth &&
          typeof data.sequencerActive === "boolean" &&
          "aheadOfBase" in data &&
          "behindBase" in data &&
          "unpushed" in data;

        const textRes = await runVolliShim(
          shimPath,
          ["worktree", "status"],
          {},
          { cwd: worktreeDir },
        );
        const text = textRes.stdout;
        const textOk =
          textRes.code === 0 &&
          text.includes(displayId) &&
          text.includes(`${branch} → ${baseBranch}`) &&
          text.includes(`uncommitted  ${dirtyTruth ? "yes" : "no"}`);

        return {
          ok: jsonOk && textOk,
          detail:
            `jsonCode=${jsonRes.code} jsonOk=${jsonOk} ticket=${JSON.stringify(data?.ticket)} ` +
            `branch=${JSON.stringify(data?.branch)} base=${JSON.stringify(data?.baseBranch)} ` +
            `uncommitted=${JSON.stringify(data?.uncommitted)} (truth=${dirtyTruth}) ` +
            `textCode=${textRes.code} textOk=${textOk}`,
        };
      },
    );

    // === 2. `worktree status <ID>` from OUTSIDE any worktree ===================
    //         The explicit display-id overrides cwd resolution: run from the
    //         scratch dir (no worktree there) and still resolve the same tree.
    await attempt(
      2,
      "worktree status <ID> from outside any worktree resolves by explicit id (same worktree/branch)",
      async () => {
        const jsonRes = await runVolliShim(
          shimPath,
          ["worktree", "status", displayId, "--json"],
          {},
          { cwd: scratch },
        );
        const data = parseJson(jsonRes);
        const ok =
          jsonRes.code === 0 &&
          data !== null &&
          data.ticket === displayId &&
          data.worktreePath === worktreeDir &&
          data.branch === branch;
        return {
          ok,
          detail: `code=${jsonRes.code} ticket=${JSON.stringify(data?.ticket)} worktreePath=${JSON.stringify(data?.worktreePath)} branch=${JSON.stringify(data?.branch)}`,
        };
      },
    );

    // === 3. `worktree diff`: merge-base (PR) vs --working-tree differ ==========
    //         A COMMITTED new file lands in the PR range but not the working
    //         tree; an UNCOMMITTED edit lands in the working tree but not the PR
    //         range. The two modes must therefore report different files/counts.
    await attempt(
      3,
      "worktree diff merge-base (committed feature) vs --working-tree (uncommitted edit) report different files + counts",
      async () => {
        // Committed change: a brand-new tracked file with 3 lines.
        await fs.writeFile(join(worktreeDir, "feature.txt"), "a\nb\nc\n");
        await execFileAsync("git", ["add", "feature.txt"], { cwd: worktreeDir });
        await execFileAsync("git", ["commit", "-q", "-m", "add feature"], { cwd: worktreeDir });

        // Uncommitted change: append 2 lines to the already-tracked README.md.
        await fs.appendFile(join(worktreeDir, "README.md"), "extra line 1\nextra line 2\n");

        const mbRes = await runVolliShim(
          shimPath,
          ["worktree", "diff", "--json"],
          {},
          { cwd: worktreeDir },
        );
        const mb = parseJson(mbRes);
        const mbPaths = Array.isArray(mb?.files) ? mb.files.map((f) => f.path) : [];
        const mbOk =
          mbRes.code === 0 &&
          mb !== null &&
          mb.mode === "merge-base" &&
          mb.baseBranch === baseBranch &&
          mb.totalFiles === 1 &&
          mbPaths.some((p) => p.endsWith("feature.txt")) &&
          !mbPaths.some((p) => p.endsWith("README.md")) &&
          mb.insertions === 3 &&
          mb.deletions === 0;

        const wtRes = await runVolliShim(
          shimPath,
          ["worktree", "diff", "--working-tree", "--json"],
          {},
          { cwd: worktreeDir },
        );
        const wt = parseJson(wtRes);
        const wtPaths = Array.isArray(wt?.files) ? wt.files.map((f) => f.path) : [];
        const wtOk =
          wtRes.code === 0 &&
          wt !== null &&
          wt.mode === "working-tree" &&
          wt.totalFiles === 1 &&
          wtPaths.some((p) => p.endsWith("README.md")) &&
          !wtPaths.some((p) => p.endsWith("feature.txt")) &&
          wt.insertions === 2 &&
          wt.deletions === 0;

        // The whole point: the two modes answer DIFFERENT questions.
        const differ =
          mb !== null &&
          wt !== null &&
          (mb.insertions !== wt.insertions ||
            JSON.stringify(mbPaths.toSorted()) !== JSON.stringify(wtPaths.toSorted()));

        return {
          ok: mbOk && wtOk && differ,
          detail:
            `mbCode=${mbRes.code} mbOk=${mbOk} mbFiles=${JSON.stringify(mbPaths)} mbIns=${mb?.insertions} ` +
            `wtCode=${wtRes.code} wtOk=${wtOk} wtFiles=${JSON.stringify(wtPaths)} wtIns=${wt?.insertions} differ=${differ}`,
        };
      },
    );

    // === 4. Friendly error for a ticket with no worktree ======================
    //         A ticket that never reached Doing has no worktree; the command
    //         must refuse with a human error (INVALID_REQUEST → exit 2), never a
    //         stack trace or a git run against a null path.
    await attempt(
      4,
      "worktree status on a worktree-less ticket returns a friendly error (exit 2)",
      async () => {
        const { displayId: bareId } = await createTicketViaBridge(page, PROJECT.name, {
          title: "Worktree CLI no-worktree ticket",
          status: "todo",
        });
        const res = await runVolliShim(
          shimPath,
          ["worktree", "status", bareId],
          {},
          { cwd: scratch },
        );
        const ok = res.code === 2 && res.stderr.includes("has no worktree yet");
        return {
          ok,
          detail: `code=${res.code} stderr=${JSON.stringify(res.stderr.trim())}`,
        };
      },
    );

    // Kill any live PTYs so teardown's close gate has nothing busy to negotiate.
    for (const sessionId of liveSessionIds) {
      await page.evaluate((id) => window.api.terminal.kill(id), sessionId).catch(() => {});
    }
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
