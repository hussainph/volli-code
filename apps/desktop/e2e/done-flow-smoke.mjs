/**
 * E2e smoke for the Done flow — the Details-rail commit / push+draft-PR
 * affordances (docs/plans/done-flow.md "Testing"). Sibling of worktree-smoke.mjs
 * (same launch/DB/event assertion style) but exercising the LATER half of a
 * ticket's life: a materialized worktree gets dirtied, then squared away and
 * published entirely from the rail.
 *
 * The fixture wires three real things so the network verbs run for real without
 * touching GitHub:
 *   • a normal git repo as the project (makeGitRepo), plus
 *   • a LOCAL BARE repo added as `origin` (with the initial default branch
 *     pushed, so `origin/<base>` exists for the best-effort fetch), and
 *   • a FAKE `gh` shim — an executable shell script in a scratch bin dir that is
 *     PREPENDED to PATH via `launch({ extraEnv })`, so it shadows any real `gh`.
 *     It appends its argv to a log file and is deterministic: `gh pr view …`
 *     prints "no pull requests found" to stderr and exits 1 (→ ghFindPr sees no
 *     PR); `gh pr create …` prints a canned URL to stdout and exits 0.
 *
 * The scenario boots a ticket session so main's ensure pipeline materializes the
 * worktree (worktree-smoke.mjs is the template for that), dirties the worktree
 * from the test, then drives the REAL rail UI — open the ticket detail, expand
 * the "Details" drawer, wait for and click the ONE adaptive primary button
 * (decision #45), which reads "Commit & create draft PR" for a dirty tree with
 * no PR and runs the whole stacked flow (commit → push → draft PR) in a single
 * click. The git/DB/gh side effects are the assertions:
 *   commit  → worktree HEAD subject == "chore(<DISPLAY-ID>): commit remaining
 *             work", working tree clean, a `worktree_committed` ticket event.
 *   push+PR → the bare remote gained the ticket branch, the gh log shows
 *             `pr create --draft` (with --base/--title), the ticket row's
 *             `pr_url` == the canned URL, a `pr_opened` event, and the primary
 *             button now reads "View PR".
 *
 * If a rail button proves genuinely unreachable in-harness within its timeout,
 * the step FALLS BACK to invoking `window.api.worktree.commit/pushPr` over the
 * bridge (the DB/git/gh assertions are identical either way); the summary line
 * reports whether each step went via "ui" or "bridge".
 *
 *   Run:
 *     vp run --filter @volli/desktop build
 *     node apps/desktop/e2e/done-flow-smoke.mjs
 *
 * MANUALLY-RUN (needs a display + the built app); NOT wired into `vp test`.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { createTicketViaBridge } from "./lib/agent-kit.mjs";
import {
  assertProfileIsolated,
  createRunner,
  launch,
  makeGitRepo,
  makeScratch,
  readSeededProjects,
  seedProjects,
  sleep,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const execFileAsync = promisify(execFile);

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-done-flow-smoke-");
const { attempt, summarize } = createRunner();

const PROJECT = { id: "done-flow-project", name: "Done Flow Project", prefix: "DF" };
const DEFAULT_HARNESS_ID = "claude-code";
const CANNED_PR_URL = "https://github.com/fake/repo/pull/42";

// ---- small local helpers ---------------------------------------------------

async function git(cwd, args) {
  return execFileAsync("git", args, { cwd });
}

/** stdout of `git … ` in `cwd`, trimmed (empty string on any failure). */
async function gitOut(cwd, args) {
  try {
    const { stdout } = await git(cwd, args);
    return stdout.trim();
  } catch {
    return "";
  }
}

/** Whether `git rev-parse --verify <ref>` succeeds in `cwd` (ref exists). */
async function refExists(cwd, ref) {
  try {
    await git(cwd, ["rev-parse", "--verify", ref]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the fake `gh` shim: an executable POSIX-sh script that appends its argv
 * (one line per arg, after a header) to `logPath`, answers `pr view` with a
 * no-PR failure and `pr create` with the canned URL, and exits 0 for anything
 * else. The log path is baked in literally so the shim needs no env of its own.
 */
async function writeGhShim(binDir, logPath) {
  await fs.mkdir(binDir, { recursive: true });
  const shimPath = join(binDir, "gh");
  const script = `#!/bin/sh
{
  echo "=== gh invocation ==="
  for arg in "$@"; do echo "$arg"; done
} >> ${JSON.stringify(logPath)}
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  echo "no pull requests found for branch" 1>&2
  exit 1
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  echo ${JSON.stringify(CANNED_PR_URL)}
  exit 0
fi
exit 0
`;
  await fs.writeFile(shimPath, script, { mode: 0o755 });
  await fs.chmod(shimPath, 0o755);
  return shimPath;
}

async function main() {
  const fakeHome = join(scratch, "home");
  const binDir = join(scratch, "bin");
  const ghLog = join(scratch, "gh-invocations.log");
  await fs.mkdir(fakeHome, { recursive: true });

  await writeGhShim(binDir, ghLog);

  const app = await launch({
    dbPath,
    userDataDir,
    extraEnv: {
      VOLLI_WORKTREE_HOME_DIR: fakeHome,
      // Prepend the fake-gh bin dir so it SHADOWS any real `gh` on the runner;
      // git and everything else still resolve from the inherited PATH.
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  });

  const liveSessionIds = [];

  try {
    await assertProfileIsolated(app, userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1000);

    // ---- fixture repo + bare `origin` --------------------------------------
    const projectPath = await makeGitRepo(scratch, "done-flow-");
    const barePath = await fs.realpath(await fs.mkdtemp(join(scratch, "origin-")));
    await git(barePath, ["init", "--bare", "-q"]);
    const defaultBranch =
      (await gitOut(projectPath, ["symbolic-ref", "--short", "HEAD"])) || "main";
    await git(projectPath, ["remote", "add", "origin", barePath]);
    // Push the initial branch so `origin/<base>` exists (best-effort fetch target).
    await git(projectPath, ["push", "-q", "-u", "origin", defaultBranch]);

    await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
    const { byName } = await readSeededProjects(page);
    const projectId = byName[PROJECT.name]?.id;
    if (!projectId) throw new Error("seeded project missing after import");

    // ---- bridge helpers (mirror worktree-smoke) ----------------------------
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

    async function eventsFor(ticketId) {
      const res = await page.evaluate(
        (tid) => window.api.tickets.events({ ticketId: tid }),
        ticketId,
      );
      return res.ok ? res.events : [];
    }

    // ---- UI helpers (mirror ticket-detail-smoke) ---------------------------
    function cardBy(id) {
      const exact = new RegExp(`^${id}$`);
      return page
        .locator("article")
        .filter({ has: page.locator("span.font-mono", { hasText: exact }) });
    }

    function docTab(displayId) {
      return page.getByRole("tab", { name: displayId, exact: true });
    }

    async function openDetail(displayId) {
      for (let i = 0; i < 4; i += 1) {
        await cardBy(displayId).dblclick();
        try {
          await waitUntil(
            "detail view to open",
            async () => (await docTab(displayId).count()) === 1,
            { timeout: 4000 },
          );
          return;
        } catch {
          // fall through and retry
        }
      }
      throw new Error("detail view never opened after double-click");
    }

    /** Ensure the right rail's collapsed "Details" drawer is expanded. */
    async function expandDetailsDrawer() {
      const aside = page.locator("aside");
      const details = aside.getByRole("button", { name: "Details", exact: true });
      await waitUntil("Details drawer button", async () => (await details.count()) >= 1);
      if ((await details.getAttribute("aria-expanded")) !== "true") {
        await details.click();
      }
      await waitUntil(
        "Details drawer expanded (Status visible)",
        async () => (await aside.getByText("Status", { exact: false }).count()) >= 1,
      );
    }

    /**
     * Click a Done-flow rail button by its accessible name, opening the detail +
     * expanding the drawer first. Returns "ui" on success, or throws so the
     * caller can fall back to the bridge. `timeout` bounds how long we wait for
     * the button to appear (it only renders once the section's status fetch says
     * the action applies).
     */
    async function clickRailButton(displayId, name, { timeout = 15000 } = {}) {
      if ((await docTab(displayId).count()) !== 1) await openDetail(displayId);
      await expandDetailsDrawer();
      const button = page.locator("aside").getByRole("button", { name });
      await waitUntil(`rail button "${name}" to appear`, async () => (await button.count()) >= 1, {
        timeout,
      });
      await button.first().click();
      return "ui";
    }

    // === 1. Commit & create draft PR — the single primary button (decision #45)
    //         runs commit → push → PR in one click; here we assert the commit leg.
    let committedTicket = null;
    let flowVia = "ui";
    await attempt(
      1,
      'Commit & create draft PR: one primary click commits the dirtied worktree — HEAD subject "chore(<id>): commit remaining work", tree clean, worktree_committed event',
      async () => {
        const title = "Done flow commit ticket";
        const { ticketId, displayId } = await createTicketViaBridge(page, PROJECT.name, {
          title,
          status: "todo",
        });
        committedTicket = { ticketId, displayId, title };

        const created = await bootSession(ticketId, title);
        if (!created.ok) return { ok: false, detail: `terminal.create failed: ${created.error}` };
        liveSessionIds.push(created.sessionId);

        // Wait for the ensure pipeline to stamp the worktree onto the ticket row.
        const row = await waitUntil(
          "ticket row stamped with worktreePath + branch",
          async () => {
            const r = await ticketRow(ticketId);
            return r && r.worktreePath && r.branch ? r : null;
          },
          { timeout: 30000 },
        );
        const worktreeDir = row.worktreePath;
        const branch = row.branch;
        committedTicket.worktreeDir = worktreeDir;
        committedTicket.branch = branch;

        // Dirty the worktree with a new (tracked, non-ignored) file.
        await fs.writeFile(join(worktreeDir, "done-flow-change.txt"), "work in progress\n");
        const dirtyBefore = (await gitOut(worktreeDir, ["status", "--porcelain"])).length > 0;

        // Drive the single primary button (one click = commit → push → PR); fall
        // back to the bridge (running the same two IPCs in sequence) if it never
        // shows. Either way the DB/git/gh assertions below are identical.
        try {
          flowVia = await clickRailButton(displayId, "Commit & create draft PR");
        } catch (uiError) {
          flowVia = "bridge";
          console.log(`  (primary UI path unavailable: ${uiError.message}; using bridge fallback)`);
          const commitRes = await page.evaluate((tid) => window.api.worktree.commit(tid), ticketId);
          if (!commitRes.ok)
            return { ok: false, detail: `bridge commit failed: ${commitRes.error}` };
          const pushRes = await page.evaluate((tid) => window.api.worktree.pushPr(tid), ticketId);
          if (!pushRes.ok) return { ok: false, detail: `bridge pushPr failed: ${pushRes.error}` };
        }

        // Assert the commit landed with the fixed message and a clean tree.
        const expectedSubject = `chore(${displayId}): commit remaining work`;
        const subjectMatched = await waitUntil(
          "worktree HEAD subject == fixed chore message",
          async () => (await gitOut(worktreeDir, ["log", "-1", "--format=%s"])) === expectedSubject,
          { timeout: 15000 },
        )
          .then(() => true)
          .catch(() => false);
        const treeClean = (await gitOut(worktreeDir, ["status", "--porcelain"])).length === 0;
        // The new file is actually in the commit.
        const fileCommitted = (
          await gitOut(worktreeDir, ["show", "--name-only", "--format=", "HEAD"])
        ).includes("done-flow-change.txt");

        const events = await eventsFor(ticketId);
        const committedEvent = events.find(
          (e) => e.payload.kind === "worktree_committed" && e.payload.message === expectedSubject,
        );

        const ok =
          dirtyBefore &&
          subjectMatched &&
          treeClean &&
          fileCommitted &&
          committedEvent !== undefined;
        return {
          ok,
          detail:
            `via=${flowVia} dirtyBefore=${dirtyBefore} subjectMatched=${subjectMatched} ` +
            `treeClean=${treeClean} fileCommitted=${fileCommitted} committedEvent=${committedEvent !== undefined}`,
        };
      },
    );

    // === 2. …the same click pushed + opened the draft PR (bare remote + gh + DB) ===
    //         No second button: the stacked primary already ran push → PR. We
    //         assert those side effects landed and the primary now reads "View PR".
    await attempt(
      2,
      'Push & create draft PR (same click): the branch reached the bare origin, `gh pr create --draft` ran, pr_url + pr_opened persisted, and the primary button now reads "View PR"',
      async () => {
        if (!committedTicket) return { ok: false, detail: "no committed ticket from step 1" };
        const { ticketId, displayId, worktreeDir, branch } = committedTicket;

        // The ticket row's pr_url reaches the canned URL once the flow persists.
        const prUrlPersisted = await waitUntil(
          "ticket row pr_url == canned URL",
          async () => {
            const r = await ticketRow(ticketId);
            return r?.prUrl === CANNED_PR_URL ? r : null;
          },
          { timeout: 20000 },
        )
          .then(() => true)
          .catch(() => false);

        // The bare remote gained the ticket branch.
        const remoteHasBranch = await refExists(barePath, branch);
        // The pushed tip matches the local worktree HEAD.
        const localHead = await gitOut(worktreeDir, ["rev-parse", "HEAD"]);
        const remoteHead = await gitOut(barePath, ["rev-parse", branch]);
        const tipsMatch = localHead.length > 0 && localHead === remoteHead;

        // The gh shim recorded a `pr create --draft` with --base and --title.
        const ghLogText = await fs.readFile(ghLog, "utf8").catch(() => "");
        const ghLines = new Set(ghLogText.split("\n").map((l) => l.trim()));
        const sawCreate = ghLines.has("create");
        const sawDraft = ghLines.has("--draft");
        const sawBase = ghLines.has("--base");
        const sawTitle = ghLines.has("--title");

        const events = await eventsFor(ticketId);
        const prOpenedEvent = events.find(
          (e) => e.payload.kind === "pr_opened" && e.payload.url === CANNED_PR_URL,
        );

        // The primary button now resolves to "View PR" (prUrl set) — check via the real UI.
        if ((await docTab(displayId).count()) !== 1) await openDetail(displayId);
        await expandDetailsDrawer();
        const viewPrShown = await waitUntil(
          '"View PR" primary button',
          async () =>
            (await page
              .locator("aside")
              .getByRole("button", { name: "View PR", exact: true })
              .count()) >= 1,
          { timeout: 10000 },
        )
          .then(() => true)
          .catch(() => false);

        const ok =
          prUrlPersisted &&
          remoteHasBranch &&
          tipsMatch &&
          sawCreate &&
          sawDraft &&
          sawBase &&
          sawTitle &&
          prOpenedEvent !== undefined &&
          viewPrShown;
        return {
          ok,
          detail:
            `via=${flowVia} prUrl=${prUrlPersisted} remoteHasBranch=${remoteHasBranch} ` +
            `tipsMatch=${tipsMatch} ghCreate=${sawCreate} draft=${sawDraft} base=${sawBase} ` +
            `title=${sawTitle} prOpenedEvent=${prOpenedEvent !== undefined} viewPrShown=${viewPrShown}`,
        };
      },
    );

    console.log(`\n  path: stacked commit→push→PR via ${flowVia}`);

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
