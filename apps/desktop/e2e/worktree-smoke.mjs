/**
 * E2e smoke for git-worktree-backed ticket sessions (worktree-support spec).
 *
 * A ticket with `usesWorktree` (the default) boots its FIRST session in an
 * isolated git worktree: main runs an `ensure` pipeline on session create —
 * resolve identity, `git worktree add` under `$VOLLI_WORKTREE_HOME_DIR` (or
 * `~` if unset — this smoke ALWAYS overrides it to a scratch dir so a dev's
 * real `~/.volli/worktrees` is never touched), copy gitignored files matching
 * the built-in `.worktreeinclude` defaults (`.env*`, `.claude/settings.local.json`)
 * into the new checkout, stamp the ticket row's `worktreePath`/`branch`/
 * `baseBranch`, and record a `worktree_changed` event. If the project has a
 * `setup_command` AND the worktree was freshly created, the session's shell
 * first runs `<setup>; printf '\n__VOLLI_SETUP_DONE:%d__\n' $?` and only on
 * exit 0 types the held harness command; a non-zero exit records a
 * `worktree_failed` event (`stage: "setup"`) and the harness is never typed.
 *
 * Rather than driving the composer's "Create & start" dialog, each scenario
 * calls the SAME contract the composer button calls
 * (`window.api.terminal.create({ ticket: { ticketId, kickoff } })` — see
 * `session-create.ts`'s `createRequest`) directly over the bridge. This
 * exercises the identical main-process ensure/sentinel/held-harness code
 * path with far less flake than clicking through composer UI, and lets us
 * read back the exact `sessionId`/`session.cwd` the create call resolves
 * with instead of scraping the DOM. No fake harness is installed — the
 * default `claude-code` harness binary doesn't exist on the test PATH, so
 * the held command (once typed) fails with a shell "command not found"; that
 * failure is expected and irrelevant to the assertions here, which only care
 * about ORDER (sentinel before the typed command) and the worktree/db/event
 * side effects.
 *
 * The terminal renders to a WebGPU canvas (text isn't in the DOM), so PTY
 * output is read the same way agent-pty-env-smoke does: a page-side listener
 * buffers `terminal.onData` per session id. That listener is registered
 * BEFORE any session is created (Electron IPC events aren't buffered for a
 * not-yet-attached listener), so no early bytes are lost racing the moment a
 * scenario learns its session's id.
 *
 * The worktree directory itself is located on disk (searched under
 * `$VOLLI_WORKTREE_HOME_DIR/.volli/worktrees/**` for a dir named
 * `<DISPLAY-ID>-<slug>`) rather than assumed to equal whatever
 * `session.cwd` reports — the two are then cross-checked as their own
 * assertion, so a wrong assumption about either surfaces as a failure
 * instead of silently mis-locating fixtures.
 *
 *   Run:
 *     vp run --filter @volli/desktop build
 *     node apps/desktop/e2e/worktree-smoke.mjs
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
  readFileSafe,
  readSeededProjects,
  seedProjects,
  sleep,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const execFileAsync = promisify(execFile);

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-worktree-smoke-");
const { attempt, summarize } = createRunner();

const PROJECT = { id: "worktree-project", name: "Worktree Project", prefix: "WT" };
const DEFAULT_HARNESS_ID = "claude-code";
const ENV_MARKER = "VOLLI_ENV_MARKER=smoke-scenario-1";

// ---- slug/branch mirror ------------------------------------------------
// Mirrors packages/shared/src/ticket-branch.ts's pure slugify/ticketBranchName
// exactly (no Node deps there either) so this standalone script can predict a
// ticket's branch name for scenario 3 without importing the workspace package.
const MAX_SLUG_LENGTH = 48;
function slugify(text) {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, "");
}
function ticketBranchName(ticketId, title) {
  const slug = slugify(title);
  return slug ? `volli/${ticketId}-${slug}` : `volli/${ticketId}`;
}

// ---- small local helpers ------------------------------------------------

async function git(cwd, args) {
  return execFileAsync("git", args, { cwd });
}

/** Strip ANSI escapes + normalize CR so buffers can be substring-matched cleanly. */
function clean(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
}

/**
 * Search `root` for a directory named `<needle>-*` (or exactly `needle`),
 * returning its absolute path, or null if `root` doesn't exist yet / no
 * match is found. Ground truth for "where did the ensure pipeline actually
 * put the worktree" — independent of any assumption about `session.cwd`.
 */
async function findWorktreeDir(root, needle) {
  let entries;
  try {
    entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  } catch {
    return null;
  }
  const hit = entries.find(
    (e) => e.isDirectory() && (e.name === needle || e.name.startsWith(`${needle}-`)),
  );
  if (!hit) return null;
  return join(hit.parentPath ?? hit.path, hit.name);
}

/** Whether any path entry under `root` contains `needle` as a substring. */
async function anyPathContains(root, needle) {
  let entries;
  try {
    entries = await fs.readdir(root, { recursive: true });
  } catch {
    return false;
  }
  return entries.some((entry) => entry.includes(needle));
}

async function main() {
  const fakeHome = join(scratch, "home");
  await fs.mkdir(fakeHome, { recursive: true });
  const worktreesRoot = join(fakeHome, ".volli", "worktrees");

  const app = await launch({
    dbPath,
    userDataDir,
    extraEnv: { VOLLI_WORKTREE_HOME_DIR: fakeHome },
  });

  const liveSessionIds = [];

  try {
    await assertProfileIsolated(app, userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1000);

    // ---- fixture repo: initial commit, a committed .gitignore covering
    // .env*, and an UNCOMMITTED (gitignored) .env with a known marker — the
    // ensure pipeline's copy step is what should carry it into the worktree.
    const projectPath = await makeGitRepo(scratch, "worktree-");
    await fs.writeFile(join(projectPath, ".gitignore"), ".env*\n");
    await git(projectPath, ["add", ".gitignore"]);
    await git(projectPath, ["commit", "-q", "-m", "add gitignore"]);
    await fs.writeFile(join(projectPath, ".env"), `${ENV_MARKER}\n`);

    // seedProjects() reloads the page internally, which would wipe any
    // earlier-registered listener/global — so the catch-all PTY buffer is
    // registered AFTER seeding, but still well before any session exists.
    await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
    const { byName } = await readSeededProjects(page);
    const projectId = byName[PROJECT.name]?.id;
    if (!projectId) throw new Error("seeded project missing after import");

    // Catch-all PTY buffer, keyed by session id, registered before any
    // session exists (see module doc comment on the ordering requirement).
    await page.evaluate(() => {
      window.volliSmokeBuffers = {};
      window.api.terminal.onData((event) => {
        window.volliSmokeBuffers[event.sessionId] =
          (window.volliSmokeBuffers[event.sessionId] ?? "") + event.data;
      });
    });
    const bufferFor = (sessionId) =>
      page.evaluate((id) => window.volliSmokeBuffers[id] ?? "", sessionId).then(clean);

    async function setSetupCommand(setupCommand) {
      return page.evaluate(
        ({ id, cmd }) => window.api.projects.update({ id, baseBranch: null, setupCommand: cmd }),
        { id: projectId, cmd: setupCommand },
      );
    }

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

    // === 1. Happy path: worktree created, .env copied, setup ran IN the
    // worktree (not main), ticket + event stamped, sentinel gates the harness.
    await attempt(
      1,
      "Happy path: fresh worktree on volli/<id>-<slug>, .env copied in, setup ran in the worktree only, ticket+worktree_changed event stamped, harness held until sentinel",
      async () => {
        const setRes = await setSetupCommand("touch .volli-setup-ran");
        if (!setRes.ok) return { ok: false, detail: `setup_command set failed: ${setRes.error}` };

        const title = "Worktree happy path ticket";
        const { ticketId, displayId } = await createTicketViaBridge(page, PROJECT.name, {
          title,
          status: "todo",
        });

        const created = await bootSession(ticketId, title);
        if (!created.ok) return { ok: false, detail: `terminal.create failed: ${created.error}` };
        liveSessionIds.push(created.sessionId);
        const sessionId = created.sessionId;
        const reportedCwd = created.session.cwd;

        const output = await waitUntil(
          "setup sentinel __VOLLI_SETUP_DONE:0__",
          async () => {
            const text = await bufferFor(sessionId);
            return text.includes("__VOLLI_SETUP_DONE:0__") ? text : null;
          },
          { timeout: 30000 },
        ).catch(() => null);
        const sentinelOk = output !== null;

        const worktreeDir = await findWorktreeDir(worktreesRoot, displayId);
        const dirExists = worktreeDir !== null;
        const cwdMatches = dirExists && reportedCwd === worktreeDir;

        let branch = null;
        let branchOk = false;
        if (dirExists) {
          try {
            const { stdout } = await git(worktreeDir, ["branch", "--show-current"]);
            branch = stdout.trim();
            branchOk = branch.startsWith(`volli/${displayId}`);
          } catch {
            branchOk = false;
          }
        }

        const envText = dirExists ? await readFileSafe(join(worktreeDir, ".env")) : null;
        const envOk = envText !== null && envText.includes(ENV_MARKER);

        const setupInWorktree = dirExists
          ? await fs
              .access(join(worktreeDir, ".volli-setup-ran"))
              .then(() => true)
              .catch(() => false)
          : false;
        const setupNotInMain = await fs
          .access(join(projectPath, ".volli-setup-ran"))
          .then(() => false)
          .catch(() => true);

        const row = await ticketRow(ticketId);
        const ticketStamped =
          row !== undefined &&
          dirExists &&
          row.worktreePath === worktreeDir &&
          row.branch === branch &&
          typeof row.baseBranch === "string" &&
          row.baseBranch.length > 0;

        const events = await eventsFor(ticketId);
        const changedEvent = events.find(
          (e) =>
            e.payload.kind === "worktree_changed" &&
            dirExists &&
            e.payload.to.worktreePath === worktreeDir &&
            e.payload.to.branch === branch,
        );
        const eventOk = changedEvent !== undefined;

        const sentinelIdx = sentinelOk ? output.indexOf("__VOLLI_SETUP_DONE:0__") : -1;
        const titleIdx = sentinelOk ? output.indexOf(title) : -1;
        const harnessAfterSentinel = sentinelOk && titleIdx !== -1 && titleIdx > sentinelIdx;

        const ok =
          sentinelOk &&
          dirExists &&
          cwdMatches &&
          branchOk &&
          envOk &&
          setupInWorktree &&
          setupNotInMain &&
          ticketStamped &&
          eventOk &&
          harnessAfterSentinel;
        return {
          ok,
          detail:
            `sentinel=${sentinelOk} dirExists=${dirExists} cwdMatches=${cwdMatches} ` +
            `branch=${JSON.stringify(branch)} branchOk=${branchOk} envOk=${envOk} ` +
            `setupInWorktree=${setupInWorktree} setupNotInMain=${setupNotInMain} ` +
            `ticketStamped=${ticketStamped} worktreeChangedEvent=${eventOk} harnessAfterSentinel=${harnessAfterSentinel}`,
        };
      },
    );

    // === 2. Setup failure: non-zero exit gates off the harness and records
    // a worktree_failed(stage:"setup") event.
    await attempt(
      2,
      "Setup failure: non-zero setup exit is recorded as the sentinel, the harness is never typed, and a worktree_failed(stage:setup) event lands",
      async () => {
        const setRes = await setSetupCommand("exit 7");
        if (!setRes.ok) return { ok: false, detail: `setup_command flip failed: ${setRes.error}` };

        const title = "Worktree setup-fail ticket";
        const { ticketId } = await createTicketViaBridge(page, PROJECT.name, {
          title,
          status: "todo",
        });

        const created = await bootSession(ticketId, title);
        if (!created.ok) return { ok: false, detail: `terminal.create failed: ${created.error}` };
        liveSessionIds.push(created.sessionId);
        const sessionId = created.sessionId;

        const output = await waitUntil(
          "setup sentinel __VOLLI_SETUP_DONE:7__",
          async () => {
            const text = await bufferFor(sessionId);
            return text.includes("__VOLLI_SETUP_DONE:7__") ? text : null;
          },
          { timeout: 30000 },
        ).catch(() => null);
        const sentinelOk = output !== null;

        // Give a buggy "type it anyway" a real window to show up before we
        // assert its absence, rather than checking the instant the sentinel lands.
        await sleep(1500);
        const settledOutput = sentinelOk ? await bufferFor(sessionId) : "";
        const harnessHeld = sentinelOk && !settledOutput.includes(title);

        const events = await eventsFor(ticketId);
        const failedEvent = events.find(
          (e) => e.payload.kind === "worktree_failed" && e.payload.stage === "setup",
        );
        const eventOk = failedEvent !== undefined;

        const ok = sentinelOk && harnessHeld && eventOk;
        return {
          ok,
          detail: `sentinel7=${sentinelOk} harnessHeld=${harnessHeld} worktreeFailedSetupEvent=${eventOk}`,
        };
      },
    );

    // === 3. Hard-fail: the ticket's own computed branch is already checked
    // out in the MAIN checkout — no fallback, session creation must error.
    await attempt(
      3,
      "Hard-fail (no main-checkout fallback): branch collision with the main checkout surfaces an error and creates no worktree dir / no session",
      async () => {
        const title = "Worktree branch-collision ticket";
        const { ticketId, displayId } = await createTicketViaBridge(page, PROJECT.name, {
          title,
          status: "todo",
        });
        const branch = ticketBranchName(displayId, title);

        // Force the collision: check the ticket's own future branch out in
        // the MAIN checkout before the ensure pipeline ever runs.
        await git(projectPath, ["checkout", "-b", branch]);

        const created = await bootSession(ticketId, title);
        if (created.ok) liveSessionIds.push(created.sessionId);

        const surfacedError =
          created.ok === false && typeof created.error === "string" && created.error.length > 0;

        const noWorktreeDir = !(await anyPathContains(worktreesRoot, displayId));

        const sessions = await page.evaluate(
          (tid) => window.api.sessions.listForTicket({ ticketId: tid }),
          ticketId,
        );
        const noSession = sessions.ok && sessions.sessions.length === 0;

        const ok = surfacedError && noWorktreeDir && noSession;
        return {
          ok,
          detail: `error=${JSON.stringify(created.ok ? null : created.error)} noWorktreeDir=${noWorktreeDir} noSession=${noSession}`,
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
