/**
 * E2e smoke for the worktree RETENTION feature (CONCEPT #16, issue #76) — the
 * merge-watch + Done-TTL surface that offers "Archive & clean" once a ticket's
 * PR merges (or its Done-TTL lapses) and never destroys unsaved work. Sibling of
 * done-flow-smoke.mjs: it reuses that probe's bare-origin-free fixture idea and
 * its FAKE `gh` shim pattern (an executable shell script PREPENDED to PATH via
 * `launch({ extraEnv })` so it shadows any real `gh`), but drives the LATER,
 * post-Done half of a ticket's life — discovery of an already-merged PR, the
 * Keep exemption, the archive-and-clean disposition, and the dirty refusal.
 *
 * The `gh` shim here is branch-scriptable: it answers `gh pr list --head <b>
 * --state all` with a MERGED PR **only** when `<b>` is listed in a plain-text
 * "merged-branches" file the test appends to once it learns a ticket's real
 * branch — so exactly the tickets the scenario means to merge get a PR, and the
 * dirty ticket stays PR-less. `gh pr view <url>` always reports the canned
 * MERGED body (`state: MERGED`, a real `mergedAt`, `mergeStateStatus: CLEAN`,
 * empty `statusCheckRollup`). No network, no real GitHub.
 *
 * The retention watch's timings are overridden through the env
 * (`VOLLI_RETENTION_INTERVAL_MS` ~ 300ms so polls fire fast); each scenario also
 * calls `window.api.retention.poll()` over the bridge inside a `waitUntil`, so
 * the discovery→status→merge pipeline is driven deterministically rather than
 * waiting on the wall-clock interval. Assertions read the composed state through
 * `window.api.retention.state(id)`, the event log through
 * `window.api.tickets.events`, the archive through `window.api.tickets.listArchived`,
 * and the on-disk worktree / branch refs through real `git`.
 *
 *   Run:
 *     vp run --filter @volli/desktop build
 *     node apps/desktop/e2e/retention-smoke.mjs
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

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-retention-smoke-");
const { attempt, summarize } = createRunner();

const PROJECT = { id: "retention-project", name: "Retention Project", prefix: "RT" };
const DEFAULT_HARNESS_ID = "claude-code";
const MERGED_PR_URL = "https://github.com/fake/repo/pull/76";
// The canned `mergedAt` the merged PR view reports (issue #76 sample body).
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

/** Whether a filesystem path currently exists. */
async function pathExists(p) {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

/**
 * Write the branch-scriptable fake `gh` shim. It logs its argv, then:
 *   • `gh pr list … --head <b> …`  → a MERGED-PR JSON array when `<b>` is listed
 *     (one per line) in `mergedFile`, else an empty array (no PR discovered);
 *   • `gh pr view <url> …`         → the canned MERGED body;
 *   • anything else                → exit 0.
 * Paths/URLs are baked in literally so the shim needs no env of its own.
 */
async function writeGhShim(binDir, logPath, mergedFile) {
  await fs.mkdir(binDir, { recursive: true });
  const shimPath = join(binDir, "gh");
  const mergedRow = JSON.stringify(
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
  const script = `#!/bin/sh
{
  echo "=== gh invocation ==="
  for arg in "$@"; do echo "$arg"; done
} >> ${JSON.stringify(logPath)}

# Extract the value following --head (the branch under query).
head=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--head" ]; then head="$arg"; fi
  prev="$arg"
done

if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  if [ -n "$head" ] && grep -qxF "$head" ${JSON.stringify(mergedFile)} 2>/dev/null; then
    printf '%s\\n' ${mergedRow}
  else
    printf '%s\\n' '[]'
  fi
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\n' ${mergedView}
  exit 0
fi
exit 0
`;
  await fs.writeFile(shimPath, script, { mode: 0o755 });
  await fs.chmod(shimPath, 0o755);
  return shimPath;
}

async function main() {
  // REALPATH the worktree-home dir: macOS /var (and /tmp) are symlinks, and the
  // ensure pipeline's cwd matching breaks if the stored path and the resolved
  // path disagree.
  const fakeHome = await fs.realpath(await fs.mkdtemp(join(scratch, "home-")));
  const binDir = join(scratch, "bin");
  const ghLog = join(scratch, "gh-invocations.log");
  const mergedFile = join(scratch, "merged-branches");
  await fs.writeFile(mergedFile, "");

  await writeGhShim(binDir, ghLog, mergedFile);

  const app = await launch({
    dbPath,
    userDataDir,
    extraEnv: {
      VOLLI_WORKTREE_HOME_DIR: fakeHome,
      // Shadow any real `gh`; git etc. still resolve from the inherited PATH.
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      // Poll fast so the discovery→merge pipeline runs within the probe's waits.
      VOLLI_RETENTION_INTERVAL_MS: "300",
      VOLLI_RETENTION_MAX_BACKOFF_MS: "1000",
    },
  });

  const liveSessionIds = [];

  try {
    await assertProfileIsolated(app, userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1000);

    // ---- fixture repo (no remote needed — the watch's network is the fake gh) -
    const projectPath = await makeGitRepo(scratch, "retention-");

    await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
    const { byName } = await readSeededProjects(page);
    const projectId = byName[PROJECT.name]?.id;
    if (!projectId) throw new Error("seeded project missing after import");

    // ---- bridge helpers (mirror worktree/done-flow smokes) -----------------
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

    async function retentionState(ticketId) {
      const res = await page.evaluate((tid) => window.api.retention.state(tid), ticketId);
      return res.ok ? res.state : null;
    }

    /** Fire a manual poll (fire-and-forget) and return the resulting state read. */
    async function pollAndRead(ticketId) {
      await page.evaluate(() => window.api.retention.poll());
      return retentionState(ticketId);
    }

    /** Boot a worktree ticket and wait for its worktreePath + branch to be stamped. */
    async function seedWorktreeTicket(title) {
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
      return {
        ticketId,
        displayId,
        sessionId: created.sessionId,
        worktreeDir: row.worktreePath,
        branch: row.branch,
      };
    }

    /** Kill a session and wait until it no longer counts as live in its worktree. */
    async function killSession(sessionId) {
      await page.evaluate((id) => window.api.terminal.kill(id), sessionId).catch(() => {});
      const idx = liveSessionIds.indexOf(sessionId);
      if (idx !== -1) liveSessionIds.splice(idx, 1);
    }

    // ---- UI helpers (mirror done-flow-smoke) -------------------------------
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

    // === 1. Discovery + merge ==============================================
    let mergeTicket = null;
    await attempt(
      1,
      'Discovery + merge: a branch-only ticket whose PR is found MERGED gets pr_url stamped, prState="merged", archiveReady, reason="pr-merged", a pr_merged event, and the "Archive & clean" primary on the rail',
      async () => {
        const t = await seedWorktreeTicket("Retention merge ticket");
        mergeTicket = t;

        // Make the shim report a MERGED PR for THIS ticket's branch only.
        await fs.appendFile(mergedFile, `${t.branch}\n`);

        // Drive the poll until the merge propagates into the composed state.
        const state = await waitUntil(
          "retention state to reach archive-ready (pr-merged)",
          async () => {
            const s = await pollAndRead(t.ticketId);
            return s && s.archiveReady ? s : null;
          },
          { timeout: 20000 },
        );

        const prUrlStamped = state.prUrl === MERGED_PR_URL;
        const prStateMerged = state.prState === "merged";
        const archiveReady = state.archiveReady === true;
        const reasonMerged = state.reason === "pr-merged";

        // The pr_merged event landed (automation) with the merged PR url.
        const events = await eventsFor(t.ticketId);
        const mergedEvent = events.find(
          (e) => e.payload.kind === "pr_merged" && e.payload.url === MERGED_PR_URL,
        );

        // The rail shows "Archive & clean" as the adaptive primary (DOM check).
        await openDetail(t.displayId);
        await expandDetailsDrawer();
        const archiveButtonShown = await waitUntil(
          '"Archive & clean" primary button',
          async () =>
            (await page
              .locator("aside")
              .getByRole("button", { name: "Archive & clean", exact: true })
              .count()) >= 1,
          { timeout: 10000 },
        )
          .then(() => true)
          .catch(() => false);

        const ok =
          prUrlStamped &&
          prStateMerged &&
          archiveReady &&
          reasonMerged &&
          mergedEvent !== undefined &&
          archiveButtonShown;
        return {
          ok,
          detail:
            `prUrlStamped=${prUrlStamped} prState=${JSON.stringify(state.prState)} ` +
            `archiveReady=${archiveReady} reason=${JSON.stringify(state.reason)} ` +
            `prMergedEvent=${mergedEvent !== undefined} archiveButtonShown=${archiveButtonShown}`,
        };
      },
    );

    // === 2. Keep exempts ====================================================
    await attempt(
      2,
      "Keep exempts: setKeep(true) → keep=true & archiveReady=false; un-keep → archiveReady returns (the pin is a hard, immediate exemption)",
      async () => {
        if (!mergeTicket) return { ok: false, detail: "no merge ticket from step 1" };
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
        // The merged observation still stands, so readiness returns immediately.
        const keepOff = setOff.ok && unkept.keep === false && unkept.archiveReady === true;

        const ok = keepOn && keepOff;
        return {
          ok,
          detail:
            `keepOn(keep=${kept.keep},ready=${kept.archiveReady}) ` +
            `keepOff(keep=${unkept.keep},ready=${unkept.archiveReady})`,
        };
      },
    );

    // === 3. Archive & clean (happy path) ====================================
    await attempt(
      3,
      "Archive & clean (clean worktree): result ok, worktree dir removed from disk, branch ref survives in the project repo, ticket archived",
      async () => {
        if (!mergeTicket) return { ok: false, detail: "no merge ticket from step 1" };
        const { ticketId, worktreeDir, branch, sessionId } = mergeTicket;

        // Sanity: the worktree is clean before we dispose of it.
        const cleanBefore = (await gitOut(worktreeDir, ["status", "--porcelain"])).length === 0;

        // The IPC has a liveness guard — the session must be gone first.
        await killSession(sessionId);

        // Retry past the liveness guard (no mutation until it clears), then act.
        const result = await waitUntil(
          "archiveAndClean past the liveness guard",
          async () => {
            const r = await page.evaluate(
              (tid) => window.api.retention.archiveAndClean(tid),
              ticketId,
            );
            if (!r.ok && typeof r.error === "string" && r.error.includes("Close the terminal")) {
              return null; // session still winding down — retry
            }
            return r;
          },
          { timeout: 15000 },
        );
        const resultOk = result.ok === true;

        // The checkout is gone from disk…
        const worktreeGone = !(await pathExists(worktreeDir));
        // …but the branch ref survives in the project repo (retained, #16).
        const branchSurvives = (await gitOut(projectPath, ["branch", "--list", branch])).length > 0;

        // The ticket is archived: present in listArchived, absent from the live board.
        const archived = await page.evaluate(
          async ({ pid, tid }) => {
            const res = await window.api.tickets.listArchived(pid);
            return res.ok ? res.tickets.some((t) => t.id === tid) : false;
          },
          { pid: projectId, tid: ticketId },
        );
        const goneFromBoard = (await ticketRow(ticketId)) === undefined;
        const events = await eventsFor(ticketId);
        const archivedEvent = events.some((e) => e.payload.kind === "archived");

        const ok =
          cleanBefore &&
          resultOk &&
          worktreeGone &&
          branchSurvives &&
          archived &&
          goneFromBoard &&
          archivedEvent;
        return {
          ok,
          detail:
            `cleanBefore=${cleanBefore} resultOk=${resultOk} worktreeGone=${worktreeGone} ` +
            `branchSurvives=${branchSurvives} archived=${archived} goneFromBoard=${goneFromBoard} ` +
            `archivedEvent=${archivedEvent}`,
        };
      },
    );

    // === 4. Dirty refusal ===================================================
    await attempt(
      4,
      "Dirty refusal: archiveAndClean on a worktree with uncommitted work refuses (error names the dirty refusal), the worktree dir survives, and the ticket is NOT archived",
      async () => {
        const t = await seedWorktreeTicket("Retention dirty ticket");

        // Dirty the worktree with an uncommitted (untracked, non-ignored) file.
        await fs.writeFile(join(t.worktreeDir, "unsaved-work.txt"), "in progress\n");
        const dirtyBefore = (await gitOut(t.worktreeDir, ["status", "--porcelain"])).length > 0;

        // Clear the liveness guard so we reach the dirty check itself.
        await killSession(t.sessionId);

        const result = await waitUntil(
          "archiveAndClean past the liveness guard",
          async () => {
            const r = await page.evaluate(
              (tid) => window.api.retention.archiveAndClean(tid),
              t.ticketId,
            );
            if (!r.ok && typeof r.error === "string" && r.error.includes("Close the terminal")) {
              return null; // session still winding down — retry
            }
            return r;
          },
          { timeout: 15000 },
        );

        const refused = result.ok === false;
        const errorNamesDirty =
          refused &&
          typeof result.error === "string" &&
          result.error.includes("Worktree has uncommitted work");

        // The worktree survives on disk and the ticket stays on the board.
        const worktreeSurvives = await pathExists(t.worktreeDir);
        const notArchived = await page.evaluate(
          async ({ pid, tid }) => {
            const res = await window.api.tickets.listArchived(pid);
            return res.ok ? !res.tickets.some((x) => x.id === tid) : false;
          },
          { pid: projectId, tid: t.ticketId },
        );
        const stillOnBoard = (await ticketRow(t.ticketId)) !== undefined;

        const ok =
          dirtyBefore &&
          refused &&
          errorNamesDirty &&
          worktreeSurvives &&
          notArchived &&
          stillOnBoard;
        return {
          ok,
          detail:
            `dirtyBefore=${dirtyBefore} refused=${refused} errorNamesDirty=${errorNamesDirty} ` +
            `error=${JSON.stringify(refused ? result.error : null)} ` +
            `worktreeSurvives=${worktreeSurvives} notArchived=${notArchived} stillOnBoard=${stillOnBoard}`,
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
