/**
 * E2e smoke for the Done flow — the Details-rail commit / push+draft-PR
 * affordances. Sibling of worktree-smoke.mjs
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
 *     It logs its argv, keeps open-PR lookup empty for publication, and creates
 *     a canned draft URL. Retention discovery reports a different MERGED PR
 *     only for a branch explicitly registered in a scratch control file.
 *
 * The scenario boots a ticket session so main's ensure pipeline materializes the
 * worktree (worktree-smoke.mjs is the template for that), dirties the worktree
 * from the test, then drives the REAL rail UI — open the ticket detail, wait
 * for and click the ONE adaptive primary button
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
 * R1–R4 then exercise retention on TWO independent additional tickets: branch-
 * only MERGED discovery (no stored PR URL) and its real rail primary, Keep /
 * unkeep, real archive-and-clean with the branch retained, and dirty-untracked
 * refusal without disk / board / roster changes. R1 has NO bridge UI fallback.
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
  goToBoard,
  launch,
  makeGitRepo,
  makeScratch,
  readSeededProjects,
  seedProjects,
  sleep,
  waitUntil,
  writeFakeLoginShell,
} from "./lib/smoke-kit.mjs";

const execFileAsync = promisify(execFile);

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-done-flow-smoke-");
const { attempt, summarize } = createRunner();

const PROJECT = { id: "done-flow-project", name: "Done Flow Project", prefix: "DF" };
const DEFAULT_HARNESS_ID = "claude-code";
const CANNED_PR_URL = "https://github.com/fake/repo/pull/42";
const MERGED_PR_URL = "https://github.com/fake/repo/pull/76";
const MERGED_AT = "2026-07-21T00:00:00Z";

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

/** The two lookup codecs differ: publication reads jq URL lines, retention JSON. */
async function writeGhShim(binDir, logPath, mergedFile) {
  await fs.mkdir(binDir, { recursive: true });
  const shimPath = join(binDir, "gh");
  const mergedRows = JSON.stringify(
    JSON.stringify([{ url: MERGED_PR_URL, state: "MERGED", updatedAt: MERGED_AT }]),
  );
  const mergedView = JSON.stringify(
    JSON.stringify({
      state: "MERGED",
      mergedAt: MERGED_AT,
      mergeStateStatus: "CLEAN",
      statusCheckRollup: [],
    }),
  );
  const openView = JSON.stringify(
    JSON.stringify({
      state: "OPEN",
      mergedAt: null,
      mergeStateStatus: "CLEAN",
      statusCheckRollup: [],
    }),
  );
  const script = `#!/bin/sh
{
  echo "=== gh invocation ==="
  for arg in "$@"; do echo "$arg"; done
} >> ${JSON.stringify(logPath)}
head=""
state=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--head" ]; then head="$arg"; fi
  if [ "$prev" = "--state" ]; then state="$arg"; fi
  prev="$arg"
done
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  # ghFindPr's open-only --jq lookup must stay empty, NOT print a JSON array.
  if [ "$state" = "all" ]; then
    if [ -n "$head" ] && grep -qxF "$head" ${JSON.stringify(mergedFile)} 2>/dev/null; then
      printf '%s\\n' ${mergedRows}
    else
      printf '%s\\n' '[]'
    fi
  fi
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  branch=$(git symbolic-ref --short HEAD)
  if [ "$3" = ${JSON.stringify(MERGED_PR_URL)} ] && grep -qxF "$branch" ${JSON.stringify(mergedFile)} 2>/dev/null; then
    printf '%s\\n' ${mergedView}
  elif [ "$3" = ${JSON.stringify(CANNED_PR_URL)} ]; then
    printf '%s\\n' ${openView}
  else
    echo "Unexpected PR view: $3 ($branch)" >&2
    exit 1
  fi
  exit 0
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
  // Match the ensure pipeline's resolved cwd even under macOS /var symlinks.
  const fakeHome = await fs.realpath(await fs.mkdtemp(join(scratch, "home-")));
  const binDir = join(scratch, "bin");
  const ghLog = join(scratch, "gh-invocations.log");
  const mergedFile = join(scratch, "merged-branches");
  await fs.writeFile(mergedFile, "");

  await writeGhShim(binDir, ghLog, mergedFile);
  // Shadowing takes BOTH halves since VC-94: boot adoption installs the union of
  // this launch PATH and `$SHELL`'s answer with the LOGIN entries FIRST, so a
  // prepended bin dir alone lands behind `/opt/homebrew/bin` and the app calls
  // the developer's real `gh` instead of the shim (see writeFakeLoginShell).
  const fakeShell = await writeFakeLoginShell(binDir, `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`);

  const app = await launch({
    dbPath,
    userDataDir,
    extraEnv: {
      VOLLI_WORKTREE_HOME_DIR: fakeHome,
      // Prepend the fake-gh bin dir so it SHADOWS any real `gh` on the runner;
      // git and everything else still resolve from the inherited PATH, which
      // the union keeps reachable behind the login half.
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      SHELL: fakeShell,
      VOLLI_RETENTION_INTERVAL_MS: "300",
      VOLLI_RETENTION_MAX_BACKOFF_MS: "1000",
    },
  });

  const liveSessionIds = [];
  let page;

  try {
    await assertProfileIsolated(app, userDataDir);
    page = await app.firstWindow();
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
        if (!boot.ok) throw new Error(`data.bootstrap failed: ${JSON.stringify(boot)}`);
        return boot.data.ticketsByProject?.[pid] ?? [];
      }, projectId);
      return tickets.find((t) => t.id === ticketId);
    }

    async function eventsFor(ticketId) {
      const res = await page.evaluate(
        (tid) => window.api.tickets.events({ ticketId: tid }),
        ticketId,
      );
      if (!res.ok) throw new Error(`tickets.events failed: ${JSON.stringify(res)}`);
      return res.events;
    }

    async function retentionState(ticketId) {
      const res = await page.evaluate((tid) => window.api.retention.state(tid), ticketId);
      if (!res.ok || !res.state) throw new Error(`retention.state failed: ${JSON.stringify(res)}`);
      return res.state;
    }

    async function pollAndRead(ticketId) {
      const res = await page.evaluate(() => window.api.retention.poll());
      if (!res.ok) throw new Error(`retention.poll failed: ${JSON.stringify(res)}`);
      return retentionState(ticketId);
    }

    async function archivedTickets() {
      const res = await page.evaluate((pid) => window.api.tickets.listArchived(pid), projectId);
      if (!res.ok) throw new Error(`tickets.listArchived failed: ${JSON.stringify(res)}`);
      return res.tickets;
    }

    async function seedWorktreeTicket(title) {
      const { ticketId, displayId } = await createTicketViaBridge(page, PROJECT.name, {
        title,
        status: "todo",
      });
      const created = await bootSession(ticketId, title);
      if (!created.ok) throw new Error(`terminal.create failed: ${created.error}`);
      liveSessionIds.push(created.sessionId);
      const row = await waitUntil(
        "retention ticket stamped with worktreePath + branch",
        async () => {
          const r = await ticketRow(ticketId);
          return r?.worktreePath && r.branch ? r : null;
        },
        { timeout: 30000 },
      );
      return {
        ticketId,
        displayId,
        sessionId: created.sessionId,
        worktreeDir: row.worktreePath,
        branch: row.branch,
      };
    }

    // Killing is not an exit barrier. Wait for the durable terminal roster to
    // report no live attachment before either destructive retention call.
    async function killAndWait(ticketId, sessionId) {
      const killed = await page.evaluate((id) => window.api.terminal.kill(id), sessionId);
      if (!killed.ok && killed.error !== "Unknown terminal session") {
        throw new Error(`terminal.kill failed: ${JSON.stringify(killed)}`);
      }
      await waitUntil(
        "retention ticket PTY ended",
        async () => {
          const res = await page.evaluate(
            (tid) => window.api.sessions.listForTicket({ ticketId: tid }),
            ticketId,
          );
          if (!res.ok) throw new Error(`sessions.listForTicket failed: ${JSON.stringify(res)}`);
          return (
            res.sessions.some((row) => row.kind === "terminal") &&
            res.sessions.every((row) =>
              row.kind === "terminal" ? row.record.endedAt !== null : !row.record.live,
            )
          );
        },
        { timeout: 15000 },
      );
      const index = liveSessionIds.indexOf(sessionId);
      if (index !== -1) liveSessionIds.splice(index, 1);
    }

    // ---- UI helpers (mirror ticket-detail-smoke) ---------------------------
    function cardBy(id) {
      const exact = new RegExp(`^${id}$`);
      return page
        .locator("article")
        .filter({ visible: true, has: page.locator("span.font-mono", { hasText: exact }) });
    }

    function docTab(displayId) {
      return page.getByRole("tab", { name: displayId, exact: true });
    }

    /**
     * Open the worktree body under the rail's pinned footer (VC-406).
     *
     * The publish split lives in that body, which rests CLOSED — the footer row
     * carries the branch and one glance, and the body is one press away. Idempotent:
     * a body already open is left alone, so a check may call this without knowing
     * what the previous one left behind.
     */
    async function unfoldWorktreeBody() {
      const fold = page
        .locator('[data-inspector-panel][data-shown="true"]')
        .getByTestId("ticket-repository-fold");
      await waitUntil("worktree fold present", async () => (await fold.count()) === 1, {
        timeout: 10000,
      });
      if ((await fold.getAttribute("aria-expanded")) === "false") await fold.click();
      await waitUntil(
        "worktree body unfolded",
        async () => (await fold.getAttribute("aria-expanded")) === "true",
        { timeout: 10000 },
      );
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

    /**
     * Click a Done-flow rail button by its accessible name, opening the detail
     * first. Returns "ui" on success, or throws so the caller can fall back to
     * the bridge. `timeout` bounds how long we wait for the button to appear (it
     * only renders once the section's status fetch says the action applies).
     *
     * VC-55 folded the old collapsed "Details" drawer into the repository card
     * on the rail's resting Now page, so there is nothing to expand anymore —
     * the adaptive primary is in the rail (`aside`) as soon as the detail view
     * opens. The drawer-expanding step waited forever for a button that no
     * longer exists.
     */
    async function clickRailButton(displayId, name, { timeout = 15000 } = {}) {
      if ((await docTab(displayId).count()) !== 1) await openDetail(displayId);
      const button = page
        .locator('[data-inspector-panel][data-shown="true"]')
        .getByRole("button", { name });
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

        // Drive the single primary button, then confirm. The press is no longer
        // the commit: a commit is not undoable from inside the app, and it was
        // happening on one unconfirmed click with a message nobody chose, so the
        // rail now raises a gate carrying the change set and the message field.
        // Leaving the field blank is what this check wants — it keeps the frozen
        // `chore(<ID>)` subject asserted below, so the gate is proved without
        // changing what the durable row says.
        //
        // The bridge fallback calls the IPCs directly and never draws UI, so it
        // has no gate to press; the DB/git/gh assertions after this are identical
        // either way.
        //
        // The gate press sits OUTSIDE the fallback on purpose. If the button
        // renders and the gate does not, that is the gate being broken, and
        // catching it here would drop to the bridge — which calls the IPCs
        // directly, passes every assertion below, and reports the run green
        // while the confirm this check exists to prove is gone. A fallback that
        // can swallow the thing under test is not a fallback.
        let pressedPrimary = false;
        try {
          flowVia = await clickRailButton(displayId, "Commit & create draft PR");
          pressedPrimary = true;
        } catch (uiError) {
          flowVia = "bridge";
          console.log(`  (primary UI path unavailable: ${uiError.message}; using bridge fallback)`);
          const commitRes = await page.evaluate((tid) => window.api.worktree.commit(tid), ticketId);
          if (!commitRes.ok)
            return { ok: false, detail: `bridge commit failed: ${commitRes.error}` };
          const pushRes = await page.evaluate((tid) => window.api.worktree.pushPr(tid), ticketId);
          if (!pushRes.ok) return { ok: false, detail: `bridge pushPr failed: ${pushRes.error}` };
        }

        // Leaving the message blank is what this check wants: it keeps the
        // frozen `chore(<ID>)` subject asserted below, so the gate is proved
        // without changing what the durable row says.
        if (pressedPrimary) {
          const gate = page.getByTestId("ticket-commit-gate-confirm");
          try {
            await gate.waitFor({ state: "visible", timeout: 10000 });
          } catch {
            return {
              ok: false,
              detail:
                "primary press did not raise the commit gate — an irreversible " +
                "commit would run on one unconfirmed click",
            };
          }
          await gate.click();
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
        // VC-406 re-homed the repository card as the rail's pinned FOOTER: the
        // branch and its one glance stay on screen, and the card's body — the
        // state strip, the CI row, and this publish split — folds above it,
        // closed at rest. The primary is one press away rather than absent, so
        // the check unfolds before looking, exactly as `ticket-rail-shots` does.
        await unfoldWorktreeBody();
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

    // === R1. Branch-only MERGED discovery, independent of publication ======
    let mergeTicket = null;
    await attempt(
      "R1",
      'Branch-only MERGED discovery: URL/state/readiness/reason/event and the real "Archive & clean" rail primary',
      async () => {
        const t = await seedWorktreeTicket("Retention merge ticket");
        mergeTicket = t;
        const before = await ticketRow(t.ticketId);
        const branchOnlyBefore =
          before?.branch === t.branch && before?.worktreePath === t.worktreeDir && !before?.prUrl;
        if (!branchOnlyBefore) {
          return {
            ok: false,
            detail: `not branch-only before discovery: ${JSON.stringify(before)}`,
          };
        }

        // Do NOT clear the published ticket's URL: this is a new ticket, and
        // only its branch becomes discoverable. The first ticket stays OPEN.
        await fs.appendFile(mergedFile, `${t.branch}\n`);
        const state = await waitUntil(
          "retention state archive-ready after branch discovery",
          async () => {
            const s = await pollAndRead(t.ticketId);
            return s.archiveReady ? s : null;
          },
          { timeout: 20000 },
        );
        const row = await ticketRow(t.ticketId);
        const urlStamped = state.prUrl === MERGED_PR_URL && row?.prUrl === MERGED_PR_URL;
        const merged = state.prState === "merged";
        const ready = state.archiveReady === true;
        const reasonMerged = state.reason === "pr-merged";
        const events = await eventsFor(t.ticketId);
        const mergedEvent = events.some(
          (e) => e.payload.kind === "pr_merged" && e.payload.url === MERGED_PR_URL,
        );
        const publishedStillOwnPr =
          (await ticketRow(committedTicket?.ticketId))?.prUrl === CANNED_PR_URL;

        // Publication left another Ticket in front. Return to the actual Board
        // before looking for the new visible card, then use the real shown rail.
        // This observation MUST NOT use the publication bridge fallback.
        await goToBoard(page);
        await openDetail(t.displayId);
        await unfoldWorktreeBody();
        const primary = page
          .locator('[data-inspector-panel][data-shown="true"]')
          .getByRole("button", { name: "Archive & clean", exact: true });
        const archiveButtonShown = await waitUntil(
          'real rail "Archive & clean" visible and enabled',
          async () => (await primary.isVisible()) && (await primary.isEnabled()),
          { timeout: 10000 },
        )
          .then(() => true)
          .catch(() => false);
        return {
          ok:
            branchOnlyBefore &&
            urlStamped &&
            merged &&
            ready &&
            reasonMerged &&
            mergedEvent &&
            publishedStillOwnPr &&
            archiveButtonShown,
          detail:
            `branchOnlyBefore=${branchOnlyBefore} urlStamped=${urlStamped} ` +
            `prState=${JSON.stringify(state.prState)} ready=${ready} reason=${JSON.stringify(state.reason)} ` +
            `prMergedEvent=${mergedEvent} publishedStillOwnPr=${publishedStillOwnPr} ` +
            `archiveButtonShown=${archiveButtonShown}`,
        };
      },
    );

    // === R2. Keep is a hard, immediate exemption ===========================
    await attempt(
      "R2",
      "Keep suppresses archive readiness; unkeep immediately restores merged readiness",
      async () => {
        if (!mergeTicket) return { ok: false, detail: "no merge ticket from R1" };
        const { ticketId } = mergeTicket;
        const setOn = await page.evaluate(
          (tid) => window.api.retention.setKeep(tid, true),
          ticketId,
        );
        const kept = await retentionState(ticketId);
        const keepOn = setOn.ok && kept.keep === true && kept.archiveReady === false;
        const setOff = await page.evaluate(
          (tid) => window.api.retention.setKeep(tid, false),
          ticketId,
        );
        const unkept = await retentionState(ticketId);
        const keepOff = setOff.ok && unkept.keep === false && unkept.archiveReady === true;
        return {
          ok: keepOn && keepOff,
          detail:
            `setOn=${JSON.stringify(setOn)} kept(keep=${kept.keep},ready=${kept.archiveReady}) ` +
            `setOff=${JSON.stringify(setOff)} unkept(keep=${unkept.keep},ready=${unkept.archiveReady})`,
        };
      },
    );

    // === R3. Actual clean archive retains the branch and history ===========
    await attempt(
      "R3",
      "Clean archive after PTY exit: directory/checkout removed, branch retained, archived roster/board/event agree",
      async () => {
        if (!mergeTicket) return { ok: false, detail: "no merge ticket from R1" };
        const { ticketId, worktreeDir, branch, sessionId } = mergeTicket;
        await killAndWait(ticketId, sessionId);
        const cleanBefore =
          (await git(worktreeDir, ["status", "--porcelain"])).stdout.trim() === "";
        const branchBefore = await gitOut(projectPath, ["rev-parse", `refs/heads/${branch}`]);
        const registeredBefore = (
          await git(projectPath, ["worktree", "list", "--porcelain"])
        ).stdout.includes(`worktree ${worktreeDir}\n`);
        const result = await page.evaluate(
          (tid) => window.api.retention.archiveAndClean(tid),
          ticketId,
        );
        const worktreeGone = !(await fs.stat(worktreeDir).then(
          () => true,
          (error) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        ));
        const branchAfter = await gitOut(projectPath, ["rev-parse", `refs/heads/${branch}`]);
        const branchSurvives = branchBefore.length > 0 && branchAfter === branchBefore;
        const checkoutGone = !(
          await git(projectPath, ["worktree", "list", "--porcelain"])
        ).stdout.includes(`worktree ${worktreeDir}\n`);
        const archived = (await archivedTickets()).some((t) => t.id === ticketId);
        const goneFromBoard = (await ticketRow(ticketId)) === undefined;
        const archivedEvent = (await eventsFor(ticketId)).some(
          (e) => e.payload.kind === "archived",
        );
        return {
          ok:
            cleanBefore &&
            registeredBefore &&
            result.ok === true &&
            worktreeGone &&
            branchSurvives &&
            checkoutGone &&
            archived &&
            goneFromBoard &&
            archivedEvent,
          detail:
            `cleanBefore=${cleanBefore} registeredBefore=${registeredBefore} result=${JSON.stringify(result)} ` +
            `worktreeGone=${worktreeGone} branchSurvives=${branchSurvives} checkoutGone=${checkoutGone} ` +
            `archived=${archived} goneFromBoard=${goneFromBoard} archivedEvent=${archivedEvent}`,
        };
      },
    );

    // === R4. A THIRD, dirty-untracked checkout must remain untouched =======
    await attempt(
      "R4",
      "Dirty-untracked refusal: error names dirty work; disk, live ticket and archive/git rosters stay unchanged",
      async () => {
        const t = await seedWorktreeTicket("Retention dirty ticket");
        const dirtyFile = join(t.worktreeDir, "unsaved-work.txt");
        const contents = "in progress\n";
        await fs.writeFile(dirtyFile, contents);
        await killAndWait(t.ticketId, t.sessionId);
        const statusBefore = (await git(t.worktreeDir, ["status", "--porcelain"])).stdout;
        const untrackedBefore = statusBefore.split("\n").includes("?? unsaved-work.txt");
        const rowBefore = await ticketRow(t.ticketId);
        const archivedBefore = (await archivedTickets()).map((row) => row.id).toSorted();
        const rosterBefore = (await git(projectPath, ["worktree", "list", "--porcelain"])).stdout;
        const headBefore = await gitOut(t.worktreeDir, ["rev-parse", "HEAD"]);
        const preconditions =
          untrackedBefore &&
          rowBefore?.worktreePath === t.worktreeDir &&
          rowBefore?.branch === t.branch &&
          !rowBefore?.prUrl &&
          !archivedBefore.includes(t.ticketId) &&
          rosterBefore.includes(`worktree ${t.worktreeDir}\n`);
        if (!preconditions) {
          return {
            ok: false,
            detail: `dirty fixture invalid: status=${JSON.stringify(statusBefore)} row=${JSON.stringify(rowBefore)}`,
          };
        }
        const result = await page.evaluate(
          (tid) => window.api.retention.archiveAndClean(tid),
          t.ticketId,
        );
        const refused = result.ok === false;
        const errorNamesDirty =
          refused &&
          typeof result.error === "string" &&
          result.error.includes("Worktree has uncommitted work");
        const fileUnchanged = (await fs.readFile(dirtyFile, "utf8")) === contents;
        const statusUnchanged =
          (await git(t.worktreeDir, ["status", "--porcelain"])).stdout === statusBefore;
        const headUnchanged =
          headBefore.length > 0 &&
          (await gitOut(t.worktreeDir, ["rev-parse", "HEAD"])) === headBefore;
        const rowAfter = await ticketRow(t.ticketId);
        const stillOnBoardUnchanged = JSON.stringify(rowAfter) === JSON.stringify(rowBefore);
        const archivedAfter = (await archivedTickets()).map((row) => row.id).toSorted();
        const archiveRosterUnchanged =
          JSON.stringify(archivedAfter) === JSON.stringify(archivedBefore);
        const gitRosterUnchanged =
          (await git(projectPath, ["worktree", "list", "--porcelain"])).stdout === rosterBefore;
        const noArchivedEvent = !(await eventsFor(t.ticketId)).some(
          (e) => e.payload.kind === "archived",
        );
        return {
          ok:
            refused &&
            errorNamesDirty &&
            fileUnchanged &&
            statusUnchanged &&
            headUnchanged &&
            stillOnBoardUnchanged &&
            archiveRosterUnchanged &&
            gitRosterUnchanged &&
            noArchivedEvent,
          detail:
            `untrackedBefore=${untrackedBefore} refused=${refused} errorNamesDirty=${errorNamesDirty} ` +
            `error=${JSON.stringify(refused ? result.error : null)} fileUnchanged=${fileUnchanged} ` +
            `statusUnchanged=${statusUnchanged} headUnchanged=${headUnchanged} liveTicketUnchanged=${stillOnBoardUnchanged} ` +
            `archiveRosterUnchanged=${archiveRosterUnchanged} gitRosterUnchanged=${gitRosterUnchanged} noArchivedEvent=${noArchivedEvent}`,
        };
      },
    );
  } finally {
    // Also clean up PTYs when setup or a later check throws before the summary.
    try {
      for (const sessionId of liveSessionIds) {
        await page?.evaluate((id) => window.api.terminal.kill(id), sessionId).catch(() => {});
      }
    } finally {
      await app.close();
    }
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
