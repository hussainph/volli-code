/**
 * End-to-end acceptance smoke for QUICK-OPEN — ⌘P fuzzy file search (VC-190,
 * plan §4.4). Drives the REAL packaged renderer through Playwright against a
 * scratch SQLite database (`VOLLI_DB_PATH`) + an isolated user-data dir, over a
 * REAL git repository and a REAL ticket worktree cut from it.
 *
 * The unit tests own the three pure decisions (`quick-open-model.test.ts`:
 * which checkout, what matches, preview-or-pin). What only a running app can
 * answer is everything between them — that the chord reaches the window at all,
 * that the scoped `volli:file-index` round trip returns the checkout the
 * surface is standing in, and that the store action a pick fires actually puts
 * the file in front of you.
 *
 *   1. ⌘P over Home opens the overlay and lists the MAIN checkout, ranked, with
 *      an empty query (an index, not a blank box waiting to be typed into).
 *   2. Typing narrows to one row, and Enter opens exactly ONE italic PREVIEW
 *      Home File tab (`data-preview="true"`) — the navigator's single click.
 *   3. A SECOND invoke of the file already in front PINS it
 *      (`data-preview="false"`) — the navigator's double click, re-asked for a
 *      list that closes on the first Enter.
 *   4. ⌘Enter opens straight into a PINNED tab, without the preview step.
 *   5. SCOPE FOLLOWS THE SURFACE: the same chord inside a Ticket workspace
 *      indexes THAT TICKET'S WORKTREE — a file written only into the worktree
 *      is offered, a file written only into Main is not.
 *   6. A pick lands in the surface it was invoked from: Enter previews into the
 *      TICKET's own tab strip, not Home's.
 *   7. ⌘Enter on a ticket file that is already open BUT NOT IN FRONT brings it
 *      to the front. The regression this check exists for: a bare `pinFile` is
 *      identity for an already-pinned tab and leaves `activeRelPath` alone for
 *      an already-open one, so quick-open pinning through `pinTicketFile` used
 *      to close the overlay having done nothing visible at all.
 *
 * Every assertion polls (expect-style waits); no bare sleep stands in for a
 * condition (the few fixed sleeps only pace UI settling, never assert).
 *
 * This is a MANUALLY-RUN smoke (it needs a display + the built app); it is NOT
 * wired into `vp test` and does NOT run in CI (CI minutes are rationed — see
 * CLAUDE.md). It is local proof for desktop-touching PRs.
 *
 *   Run (macOS ONLY — see below):
 *     vp run --filter @volli/desktop build   # produce dist/ + dist-electron/
 *     node apps/desktop/e2e/quick-open-smoke.mjs
 *
 *   Requires: playwright-core (devDependency of @volli/desktop), and macOS.
 *   Every check drives ⌘P / ⌘Enter, which are macOS keybindings — elsewhere
 *   they resolve to nothing and the checks would sit out their poll timeouts
 *   instead of reporting anything useful. (smoke-kit's ELECTRON path is a macOS
 *   `Electron.app` bundle too, so every smoke here is macOS-bound anyway.) The
 *   platform guard below turns that into an immediate, explanatory failure.
 *
 *   Exit code is non-zero if any numbered check fails.
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

// Fail fast rather than half-run: every check types a ⌘ chord, and the whole
// subject of this smoke is a chord. Bail before any scratch dir is allocated.
if (process.platform !== "darwin") {
  console.error(
    `quick-open-smoke is macOS-only (got platform "${process.platform}"): every check drives the ` +
      "⌘P / ⌘Enter keybindings, which do not exist on this platform.",
  );
  process.exit(1);
}

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-quick-open-smoke-");
const { attempt, must, summarize } = createRunner();

const PROJECT = { id: "quick-open-project", name: "Quick Open Project", prefix: "QO" };
const HARNESS_ID = "claude-code";

// ---- the seeded repository -------------------------------------------------
// Everything committed here exists in BOTH checkouts once the worktree is cut,
// so none of it could tell the two scopes apart. The two files that can are
// written after the cut: MAIN_ONLY into the main checkout and WORKTREE_ONLY
// into the worktree (both untracked — `git ls-files --others` lists them).
const ALPHA_TS = "src/alpha-widget.ts";
const BETA_TS = "src/beta-widget.ts";
const GAMMA_MD = "docs/gamma-notes.md";
const MAIN_FILE = "main-checkout-file.ts";
const MAIN_ONLY = "main-untracked-only.ts";
const WORKTREE_ONLY = "worktree-only-file.ts";
const WORKTREE_SECOND = "second-worktree-file.ts";

const git = (cwd, args) => execFileAsync("git", args, { cwd });

// ---- DOM helpers -----------------------------------------------------------

const quickOpenList = (page) => page.getByTestId("quick-open-list");

/** Every offered row's text, top-ranked first (label + its folder). */
async function quickOpenRows(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="quick-open-list"] [cmdk-item]')).map(
      (row) => (row.textContent ?? "").trim(),
    ),
  );
}

/**
 * Press ⌘P, wait for the overlay AND for its rows — the index is fetched fresh
 * per open (an IPC round trip), so an overlay that is on screen is not yet an
 * overlay with anything in it. Types `query` before waiting when given.
 */
async function openQuickOpen(page, query = "") {
  await page.keyboard.press("Meta+p");
  await waitUntil("quick-open overlay", async () => (await quickOpenList(page).count()) === 1);
  if (query !== "") {
    await page.keyboard.type(query);
    await sleep(150);
  }
  await waitUntil("quick-open rows", async () => (await quickOpenRows(page)).length > 0, {
    timeout: 15000,
  });
}

async function closeQuickOpen(page) {
  if ((await quickOpenList(page).count()) === 1) {
    await page.keyboard.press("Escape");
    await waitUntil("quick-open closed", async () => (await quickOpenList(page).count()) === 0);
  }
}

/** Home's File tabs, left to right — identity, preview state, selection. */
async function readHomeTabs(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="home-file-tab"]')).map((tab) => ({
      relPath: tab.getAttribute("data-rel-path"),
      preview: tab.getAttribute("data-preview"),
      active: tab.getAttribute("aria-selected") === "true",
    })),
  );
}

/**
 * The ticket strip's tabs. Read by label rather than by a `data-rel-path` hook,
 * which that strip does not carry — a File tab's label IS its basename there.
 */
async function readTicketTabs(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="tablist"] [role="tab"]')).map((tab) => ({
      label: (tab.textContent ?? "").trim(),
      preview: tab.getAttribute("data-preview"),
      active: tab.getAttribute("aria-selected") === "true",
    })),
  );
}

const ticketTab = (tabs, relPath) => tabs.find((tab) => tab.label.includes(relPath));

async function main() {
  const fakeHome = join(scratch, "home");
  await fs.mkdir(fakeHome, { recursive: true });

  const app = await launch({
    dbPath,
    userDataDir,
    extraEnv: { VOLLI_WORKTREE_HOME_DIR: fakeHome },
  });

  try {
    await assertProfileIsolated(app, userDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await sleep(800);

    const projectPath = await makeGitRepo(scratch, "quick-open-");
    await fs.mkdir(join(projectPath, "src"), { recursive: true });
    await fs.mkdir(join(projectPath, "docs"), { recursive: true });
    await fs.writeFile(join(projectPath, ALPHA_TS), "export const a = 1;\n");
    await fs.writeFile(join(projectPath, BETA_TS), "export const b = 1;\n");
    await fs.writeFile(join(projectPath, GAMMA_MD), "# gamma\n");
    await fs.writeFile(join(projectPath, MAIN_FILE), "export const m = 1;\n");
    await git(projectPath, ["add", "-A"]);
    await git(projectPath, ["commit", "-q", "-m", "seed files"]);

    await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
    const { byName } = await readSeededProjects(page);
    const projectId = byName[PROJECT.name]?.id;
    if (!projectId) throw new Error("seeded project missing after import");

    // ---- 1. The chord, and the Main index -----------------------------------
    await must(1, "⌘P over Home opens the overlay listing the MAIN checkout", async () => {
      await openQuickOpen(page);
      const rows = await quickOpenRows(page);
      return {
        ok: rows.some((row) => row.includes(MAIN_FILE)) && rows.length >= 4,
        detail: `rows=${rows.length} ${JSON.stringify(rows.slice(0, 5))}`,
      };
    });

    // ---- 2. Typing narrows; Enter PREVIEWS ----------------------------------
    await must(2, "typing narrows by name, and Enter opens ONE preview Home File tab", async () => {
      await page.keyboard.type("alphawid");
      await sleep(200);
      const rows = await quickOpenRows(page);
      await page.keyboard.press("Enter");
      await waitUntil("one Home File tab", async () => (await readHomeTabs(page)).length === 1);
      const tabs = await readHomeTabs(page);
      return {
        ok:
          rows.length === 1 &&
          rows[0].includes("alpha-widget.ts") &&
          tabs[0]?.relPath === ALPHA_TS &&
          tabs[0]?.preview === "true" &&
          tabs[0]?.active === true &&
          (await quickOpenList(page).count()) === 0,
        detail: `matched=${JSON.stringify(rows)} tabs=${JSON.stringify(tabs)}`,
      };
    });

    // ---- 3. A second invoke pins --------------------------------------------
    await attempt(3, "a second invoke of the file in front PINS it", async () => {
      await openQuickOpen(page, "alphawid");
      await page.keyboard.press("Enter");
      await waitUntil("tab pinned", async () => (await readHomeTabs(page))[0]?.preview === "false");
      const tabs = await readHomeTabs(page);
      return {
        ok: tabs.length === 1 && tabs[0].preview === "false" && tabs[0].active,
        detail: JSON.stringify(tabs),
      };
    });

    // ---- 4. ⌘Enter pins outright --------------------------------------------
    await attempt(4, "⌘⏎ opens a file straight into a PINNED tab", async () => {
      await openQuickOpen(page, "gammanotes");
      await page.keyboard.press("Meta+Enter");
      await waitUntil("second Home File tab", async () => (await readHomeTabs(page)).length === 2);
      const tabs = await readHomeTabs(page);
      const gamma = tabs.find((tab) => tab.relPath === GAMMA_MD);
      return {
        ok: gamma?.preview === "false" && gamma.active === true,
        detail: JSON.stringify(tabs),
      };
    });

    // ---- A real ticket worktree ---------------------------------------------
    const { ticketId, displayId } = await createTicketViaBridge(page, PROJECT.name, {
      status: "todo",
      title: "Quick-open scope proof",
      priority: "medium",
    });
    const created = await page.evaluate(
      ({ workspaceId, cwd, tid, harnessId }) =>
        window.api.terminal.create({
          workspaceId,
          cwd,
          cols: 80,
          rows: 24,
          ticket: { ticketId: tid, kickoff: { harnessId, prompt: "smoke" } },
        }),
      { workspaceId: projectId, cwd: projectPath, tid: ticketId, harnessId: HARNESS_ID },
    );
    if (!created.ok) throw new Error(`terminal.create failed: ${created.error}`);

    const row = await waitUntil(
      "ticket row stamped with worktreePath",
      async () => {
        const tickets = await page.evaluate(async (pid) => {
          const boot = await window.api.data.bootstrap();
          return boot.ok ? (boot.data.ticketsByProject?.[pid] ?? []) : [];
        }, projectId);
        const found = tickets.find((ticket) => ticket.id === ticketId);
        return found?.worktreePath ? found : null;
      },
      { timeout: 40000 },
    );
    const worktreeDir = row.worktreePath;
    await fs.writeFile(join(worktreeDir, WORKTREE_ONLY), "export const w = 1;\n");
    await fs.writeFile(join(worktreeDir, WORKTREE_SECOND), "export const s = 1;\n");
    // Into MAIN only, and only now: everything committed before the cut lives in
    // both checkouts and could not tell the two scopes apart.
    await fs.writeFile(join(projectPath, MAIN_ONLY), "export const mu = 1;\n");

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await waitUntil("app surface", () =>
      page.evaluate(() => document.querySelector("[data-volli-surface]") !== null),
    );
    // Home restored a File tab; the board (and its cards) sit behind the Board tab.
    const boardTab = page.locator('[role="tab"]', { hasText: "Board" }).first();
    await waitUntil("Board tab", async () => (await boardTab.count()) === 1);
    await boardTab.click();
    await sleep(400);
    const card = page.locator("article").filter({
      has: page.locator("span.font-mono", { hasText: new RegExp(`^${displayId}$`) }),
    });
    await waitUntil("ticket card", async () => (await card.count()) === 1);
    await card.dblclick();
    await waitUntil("ticket detail", async () => (await page.getByRole("tablist").count()) >= 1);

    // ---- 5. Scope follows the surface ---------------------------------------
    await attempt(5, "in the Ticket workspace ⌘P indexes THAT WORKTREE, not Main", async () => {
      await openQuickOpen(page);
      const rows = await quickOpenRows(page);
      const offersWorktreeFile = rows.some((r) => r.includes(WORKTREE_ONLY));
      const offersMainOnlyFile = rows.some((r) => r.includes(MAIN_ONLY));
      await closeQuickOpen(page);
      return {
        ok: offersWorktreeFile && !offersMainOnlyFile,
        detail: `worktreeOnly=${offersWorktreeFile} mainOnly=${offersMainOnlyFile} rows=${rows.length}`,
      };
    });

    // ---- 6. The pick lands in the surface it was invoked from ----------------
    await attempt(6, "Enter previews into the TICKET's own tab strip", async () => {
      await openQuickOpen(page, "worktreeonly");
      await page.keyboard.press("Enter");
      await waitUntil(
        "ticket File tab in front",
        async () => ticketTab(await readTicketTabs(page), WORKTREE_ONLY)?.active === true,
      );
      const tabs = await readTicketTabs(page);
      const tab = ticketTab(tabs, WORKTREE_ONLY);
      return { ok: tab?.preview === "true" && tab.active, detail: JSON.stringify(tabs) };
    });

    // ---- 7. ⌘⏎ on an open-but-behind ticket file brings it to the front ------
    await attempt(
      7,
      "⌘⏎ on a ticket file already open BUT BEHIND brings it to the front",
      async () => {
        await openQuickOpen(page, "worktreeonly");
        await page.keyboard.press("Meta+Enter");
        await waitUntil(
          "first file pinned",
          async () => ticketTab(await readTicketTabs(page), WORKTREE_ONLY)?.preview !== "true",
        );
        // Put another file in front, so the target is open-and-behind.
        await openQuickOpen(page, "secondworktree");
        await page.keyboard.press("Meta+Enter");
        await waitUntil(
          "second file in front",
          async () => ticketTab(await readTicketTabs(page), WORKTREE_SECOND)?.active === true,
        );
        await openQuickOpen(page, "worktreeonly");
        await page.keyboard.press("Meta+Enter");
        await waitUntil(
          "target back in front",
          async () => ticketTab(await readTicketTabs(page), WORKTREE_ONLY)?.active === true,
          { timeout: 8000 },
        );
        const tabs = await readTicketTabs(page);
        const target = ticketTab(tabs, WORKTREE_ONLY);
        return {
          ok: target?.active === true && target.preview !== "true",
          detail: JSON.stringify(tabs),
        };
      },
    );
  } finally {
    await app.close().catch(() => {});
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
