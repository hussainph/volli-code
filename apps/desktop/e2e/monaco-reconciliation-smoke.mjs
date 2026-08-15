/**
 * Focused packaged proof for VC-110 live Monaco reconciliation.
 *
 * Proves ten checks through the built Electron app and real filesystem watchers:
 *   1. A clean open File model adopts an external write in place without
 *      losing focus/cursor/scroll, and the inspected Change row becomes Updated.
 *   1b. An external edit that prepends lines above the caret keeps the caret
 *      with its text (line number shifts by the inserted count, no viewport
 *      jump) — the minimal-edit invariant, distinct from same-line-count #1.
 *   2. No filesystem event opens or focuses a tab.
 *   2b. A clean model parked behind another tab maps its saved caret/viewport
 *       through a prepended disk update without making the old baseline
 *       undoable or saveable.
 *   2c. A clean File parked behind its same-path Diff maps its saved
 *       caret/viewport after the mounted Diff positively adopts the prepend.
 *   3. Disjoint human/agent edits merge into one dirty registry model.
 *   4. File and Diff deliberately opened for the same path share that model.
 *   5. A local save echo stays quiet in ticket recency — proved positively by
 *      confirming the watcher still delivers a real external edit to a
 *      different, previously-inspected file while the saved file stays quiet.
 *   6. Overlap keeps exact local and disk versions behind one accessible,
 *      non-modal, persistent affordance with consequence-labelled actions.
 *   7. Reopening Diff clears Updated and reproduces the same conflict result.
 *
 *   env -u ELECTRON_RUN_AS_NODE node apps/desktop/e2e/monaco-reconciliation-smoke.mjs
 *
 * MANUALLY-RUN (needs a display + the built app); NOT wired into `vp test`.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { createTicketViaBridge } from "./lib/agent-kit.mjs";
import {
  assertBuiltRendererLoaded,
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
const TARGET = "src/reconcile.ts";
const PROJECT = { id: "reconciliation-proj", name: "Monaco Reconciliation", prefix: "MR" };
const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-reconciliation-");
const { must, summarize } = createRunner();

const baselineLines = Array.from({ length: 80 }, (_, index) => {
  if (index === 0) return 'export const overlap = "baseline";';
  if (index === 5) return "export const changeSet = 0;";
  if (index === 24) return 'export const cleanAgent = "baseline";';
  if (index === 29) return 'export const diskOnly = "baseline";';
  return `export const line${index + 1} = ${index + 1};`;
});
const BASE = `${baselineLines.join("\n")}\n`;
const initialLines = [...baselineLines];
initialLines[5] = "export const changeSet = 1;";
const INITIAL = `${initialLines.join("\n")}\n`;
const cleanLines = [...initialLines];
cleanLines[24] = 'export const cleanAgent = "adopted";';
const CLEAN_DISK = `${cleanLines.join("\n")}\n`;
const PARKED_OLD_LINE = "export const changeSet = 1;";
const PARKED_DISK_LINE = "export const changeSet = 2;";
const PARKED_UNDO_CONTROL = "§";
const parkedLines = [...cleanLines];
parkedLines[5] = PARKED_DISK_LINE;
const PARKED_BASE_DISK = `${parkedLines.join("\n")}\n`;
const disjointLines = [...parkedLines];
disjointLines[29] = 'export const diskOnly = "agent";';
const DISJOINT_DISK = `${disjointLines.join("\n")}\n`;
const HUMAN_MERGED_LINE = 'export const overlap = "human merged";';
const HUMAN_CONFLICT_LINE = 'export const overlap = "human conflict";';
const AGENT_CONFLICT_LINE = 'export const overlap = "agent conflict";';

// Fixtures for step 1b: an external edit that changes line COUNT (prepends
// above the caret) rather than same-line-count fixtures like CLEAN_DISK/
// DISJOINT_DISK above — the invariant under minimal-edit application is that
// the caret follows its TEXT, not its old absolute line number.
const PREPEND_COUNT = 6;
const PREPEND_LINES = Array.from(
  { length: PREPEND_COUNT },
  (_, index) => `// prepended banner line ${index + 1}`,
);
const PREPEND_DISK = `${PREPEND_LINES.join("\n")}\n${CLEAN_DISK}`;
const PARKED_PREPEND_DISK = `${PREPEND_LINES.join("\n")}\n${PARKED_BASE_DISK}`;
const KNOWN_ANCHOR_TEXT = "export const line12 = 12;";

// A second, independent file used by step 2b to release every TARGET view and
// by step 5 to prove the watcher pipeline stays alive after a save, rather
// than proving a negative with a bare timeout.
const SECOND_TARGET = "src/sentinel.ts";
const SENTINEL_BASE = 'export const sentinel = "seen";\n';
const SENTINEL_EXTERNAL = 'export const sentinel = "changed by watcher";\n';

async function git(cwd, args) {
  return execFileAsync("git", args, { cwd });
}

async function readTicketTabs(page, ticketId) {
  return page.evaluate(async (tid) => {
    const boot = await window.api.data.bootstrap();
    if (!boot.ok) return null;
    const raw = boot.data.appState["volli:workspace"];
    if (typeof raw !== "string") return null;
    const parsed = JSON.parse(raw);
    for (const ui of Object.values(parsed?.state?.byProject ?? {})) {
      const tabs = ui?.ticketTabs?.[tid];
      if (tabs) return tabs;
    }
    return null;
  }, ticketId);
}

function fileHost(page) {
  return page.locator('[data-monaco-status="ready"]').first();
}

async function readFileState(page) {
  return fileHost(page).evaluate((host) => {
    const editor = host.querySelector(".monaco-editor");
    const scroll = host.querySelector(".monaco-scrollable-element");
    const cursor = host.querySelector(".cursor");
    return {
      dirty: host.getAttribute("data-monaco-dirty"),
      stale: host.getAttribute("data-monaco-stale"),
      focused: host.contains(document.activeElement),
      scrollTop: scroll?.scrollTop ?? null,
      cursorTop: cursor instanceof HTMLElement ? cursor.style.top : null,
      cursorLeft: cursor instanceof HTMLElement ? cursor.style.left : null,
      lines: Array.from(editor?.querySelectorAll(".view-line") ?? [])
        .map((line) => (line.textContent ?? "").replace(/\u00a0/g, " "))
        .join("\n"),
    };
  });
}

async function waitFileText(page, needle, dirty = null) {
  return waitUntil(
    `File Monaco to contain ${JSON.stringify(needle)}`,
    async () => {
      const state = await readFileState(page);
      if (!state.lines.includes(needle)) return null;
      if (dirty !== null && state.dirty !== String(dirty)) return null;
      return state;
    },
    { timeout: 20000 },
  );
}

async function waitStableFileViewState(page, label) {
  let previous = null;
  let stablePolls = 0;
  return waitUntil(
    label,
    async () => {
      const state = await readFileState(page);
      const signature = JSON.stringify({
        focused: state.focused,
        scrollTop: state.scrollTop,
        cursorTop: state.cursorTop,
        cursorLeft: state.cursorLeft,
      });
      if (signature === previous) stablePolls += 1;
      else stablePolls = 0;
      previous = signature;
      return stablePolls >= 2 ? state : null;
    },
    { timeout: 5000, interval: 100 },
  );
}

/** A bounded quiescence check for commands whose correct result is no mutation. */
async function waitStableFileDocument(page, label) {
  let previous = null;
  let stablePolls = 0;
  return waitUntil(
    label,
    async () => {
      const state = await readFileState(page);
      const signature = JSON.stringify({
        dirty: state.dirty,
        stale: state.stale,
        lines: state.lines,
      });
      if (signature === previous) stablePolls += 1;
      else stablePolls = 0;
      previous = signature;
      return stablePolls >= 2 ? state : null;
    },
    { timeout: 5000, interval: 100 },
  );
}

/** Requires the expected disk bytes to stay exact across consecutive polls. */
async function waitStableDiskText(path, expected, label) {
  let stablePolls = 0;
  return waitUntil(
    label,
    async () => {
      const value = await fs.readFile(path, "utf8");
      if (value !== expected) {
        stablePolls = 0;
        return null;
      }
      stablePolls += 1;
      return stablePolls >= 3 ? value : null;
    },
    { timeout: 5000, interval: 100 },
  );
}

/**
 * Matches SOURCE_MODE_OPTIONS.lineHeight in monaco-file-editor.tsx. The
 * caret's `top` is its model-line offset inside `.lines-content`; Monaco puts
 * the editor's real scroll offset on that exact node as a negative `top`.
 * Both are config/source-backed coordinates rather than whichever generic
 * `.monaco-scrollable-element` happens to come first in the subtree.
 */
const LINE_HEIGHT_PX = 21;

/**
 * Reads one visible source line through Monaco's exact editor DOM hierarchy.
 * The nearby anchor stays in the ordinary viewport, so the direct view-line
 * whose numeric model-row `top` equals the direct primary caret's `top` must be
 * present. Counts are returned too: a changed Monaco DOM contract fails loudly
 * instead of silently selecting an unrelated descendant.
 */
async function caretModelState(page) {
  return fileHost(page).evaluate((host) => {
    const linesContents = host.querySelectorAll(
      ".monaco-editor .monaco-scrollable-element.editor-scrollable > .lines-content",
    );
    const linesContent = linesContents.length === 1 ? linesContents[0] : null;
    if (!(linesContent instanceof HTMLElement)) {
      return {
        ready: false,
        linesContentCount: linesContents.length,
        cursorCount: 0,
        mappedLineCount: 0,
      };
    }
    const cursors = Array.from(
      linesContent.querySelectorAll(":scope > .cursors-layer > .cursor"),
    ).filter((candidate) => candidate instanceof HTMLElement);
    const cursor = cursors.length === 1 ? cursors[0] : null;
    const top = cursor instanceof HTMLElement ? Number.parseFloat(cursor.style.top) : Number.NaN;
    const mappedLines = Array.from(
      linesContent.querySelectorAll(":scope > .view-lines > .view-line"),
    ).filter(
      (candidate) =>
        candidate instanceof HTMLElement && Number.parseFloat(candidate.style.top) === top,
    );
    const mappedLine = mappedLines.length === 1 ? mappedLines[0] : null;
    return {
      ready: cursor !== null && mappedLine !== null && Number.isFinite(top),
      linesContentCount: linesContents.length,
      cursorCount: cursors.length,
      mappedLineCount: mappedLines.length,
      top,
      scrollTop: -Number.parseFloat(linesContent.style.top || "0"),
      text: (mappedLine?.textContent ?? "").replace(/\u00a0/g, " "),
    };
  });
}

async function waitCaretModelState(page, label, options = {}) {
  try {
    return await waitUntil(
      label,
      async () => {
        const state = await caretModelState(page);
        return state.ready ? state : null;
      },
      options,
    );
  } catch (error) {
    const state = await caretModelState(page);
    throw new Error(
      `${label}: Monaco editor DOM contract unavailable (${JSON.stringify(state)}): ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

async function replaceFirstLine(page, text) {
  const editor = fileHost(page).locator(".monaco-editor");
  await editor.click();
  await page.keyboard.press("Meta+ArrowUp");
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.type(text);
  await waitFileText(page, text, true);
}

async function findInFile(page, text) {
  await fileHost(page).locator(".monaco-editor").click();
  await page.keyboard.press("Meta+f");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  return waitFileText(page, text);
}

async function readDiffState(page) {
  return page.evaluate(() => {
    const host = document.querySelector('[data-monaco-diff-status="ready"]');
    const modified =
      host?.querySelector(".editor.modified .monaco-editor") ??
      [...(host?.querySelectorAll(".monaco-editor") ?? [])].at(-1) ??
      null;
    return {
      ready: host !== null,
      dirty: host?.getAttribute("data-monaco-diff-dirty") ?? null,
      lines: Array.from(modified?.querySelectorAll(".view-line") ?? [])
        .map((line) => (line.textContent ?? "").replace(/\u00a0/g, " "))
        .join("\n"),
    };
  });
}

async function findInDiff(page, text) {
  const host = page.locator('[data-monaco-diff-status="ready"]').first();
  const modified = host.locator(".monaco-editor").last();
  await modified.click();
  await page.keyboard.press("Meta+f");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  return waitUntil(
    `Diff Monaco to contain ${JSON.stringify(text)}`,
    async () => {
      const state = await readDiffState(page);
      return state.lines.includes(text) ? state : null;
    },
    { timeout: 15000 },
  );
}

/**
 * Opens `path` (defaults to the main TARGET) from the ticket rail's Files
 * mode. `pin` double-clicks instead of single-clicking so the tab lands
 * persistent (decision #56) instead of in the one replaceable preview slot —
 * used when a second file must stay open alongside TARGET's own tab.
 */
async function openFileFromRail(aside, path = TARGET, { pin = false } = {}) {
  await aside.getByTestId("ticket-rail-tab-files").click();
  await waitUntil(
    "Files list",
    async () => (await aside.getByTestId("ticket-files-list").count()) === 1,
  );
  const src = aside.locator('[data-testid="ticket-files-row"][data-path="src"]');
  if ((await src.count()) === 1) await src.click();
  const row = aside.locator(`[data-testid="ticket-files-row"][data-path="${path}"]`);
  await waitUntil(`${path} Files row`, async () => (await row.count()) === 1);
  if (pin) await row.dblclick();
  else await row.click();
}

async function main() {
  const fakeHome = join(scratch, "home");
  await fs.mkdir(fakeHome, { recursive: true });
  await Promise.all(
    [".zshenv", ".zprofile", ".zshrc", ".zlogin"].map((name) =>
      fs.writeFile(join(fakeHome, name), "# isolated Monaco smoke shell\n"),
    ),
  );
  // Seed a bounded launch PATH; login bootstrap may legitimately augment it.
  const safePath = "/usr/bin:/bin:/usr/sbin:/sbin";
  const app = await launch({
    dbPath,
    userDataDir,
    extraEnv: {
      HOME: fakeHome,
      PATH: safePath,
      ZDOTDIR: fakeHome,
      VOLLI_WORKTREE_HOME_DIR: fakeHome,
    },
  });

  try {
    await assertProfileIsolated(app, userDataDir);
    const launchIsolation = await app.evaluate(() => ({
      home: process.env.HOME ?? null,
      zdotDir: process.env.ZDOTDIR ?? null,
    }));
    if (launchIsolation.home !== fakeHome || launchIsolation.zdotDir !== fakeHome) {
      throw new Error(
        `smoke launch environment was not isolated: ${JSON.stringify(launchIsolation)}`,
      );
    }
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    assertBuiltRendererLoaded(page);
    await sleep(600);

    const projectPath = await makeGitRepo(scratch, "reconciliation-project-");
    await fs.mkdir(join(projectPath, "src"), { recursive: true });
    await fs.writeFile(join(projectPath, TARGET), BASE);
    await fs.writeFile(join(projectPath, SECOND_TARGET), SENTINEL_BASE);
    await git(projectPath, ["add", "-A"]);
    await git(projectPath, ["commit", "-q", "-m", "seed reconciliation file"]);

    await seedProjects(page, [{ ...PROJECT, path: projectPath }]);
    const { byName } = await readSeededProjects(page);
    const projectId = byName[PROJECT.name]?.id;
    if (!projectId) throw new Error("seeded project missing after import");

    const { ticketId, displayId } = await createTicketViaBridge(page, PROJECT.name, {
      status: "todo",
      title: "Monaco reconciliation proof",
      priority: "medium",
    });
    const createResult = await page.evaluate(
      ({ workspaceId, cwd, tid }) =>
        window.api.terminal.create({
          workspaceId,
          cwd,
          cols: 80,
          rows: 24,
          ticket: { ticketId: tid },
        }),
      {
        workspaceId: projectId,
        cwd: projectPath,
        tid: ticketId,
      },
    );
    if (!createResult.ok) throw new Error(`terminal.create failed: ${createResult.error}`);
    if (
      createResult.session.launchKind !== "shell" ||
      createResult.session.activeHarnessId !== null
    ) {
      throw new Error(
        `worktree materializer launched an agent: ${JSON.stringify({
          launchKind: createResult.session.launchKind,
          activeHarnessId: createResult.session.activeHarnessId,
        })}`,
      );
    }

    const ticket = await waitUntil(
      "ticket worktree",
      async () => {
        const tickets = await page.evaluate(async (pid) => {
          const boot = await window.api.data.bootstrap();
          return boot.ok ? (boot.data.ticketsByProject?.[pid] ?? []) : [];
        }, projectId);
        const row = tickets.find((candidate) => candidate.id === ticketId);
        return row?.worktreePath ? row : null;
      },
      { timeout: 30000 },
    );
    const worktreeDir = ticket.worktreePath;
    if (createResult.session.cwd !== worktreeDir) {
      throw new Error(
        `shell session did not materialize the ticket worktree: session=${createResult.session.cwd} ticket=${worktreeDir}`,
      );
    }
    const targetPath = join(worktreeDir, TARGET);
    await fs.writeFile(targetPath, INITIAL);

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    const card = page.locator("article").filter({
      has: page.locator("span.font-mono", { hasText: new RegExp(`^${displayId}$`) }),
    });
    await waitUntil("ticket card", async () => (await card.count()) === 1);
    await card.dblclick();
    const aside = page.locator("aside");
    await waitUntil("ticket rail", async () => (await aside.count()) === 1);
    await openFileFromRail(aside);
    await waitFileText(page, "export const changeSet = 1;", false);

    await aside.getByTestId("ticket-rail-tab-changes").click();
    const changeRow = aside.locator(`[data-testid="ticket-changes-row"][data-path="${TARGET}"]`);
    await waitUntil("reconciliation Change row", async () => (await changeRow.count()) === 1);

    await must(
      1,
      "clean external update adopts in place and preserves editor view state",
      async () => {
        const editor = fileHost(page).locator(".monaco-editor");
        await editor.click();
        await page.keyboard.press("Meta+ArrowUp");
        for (let index = 0; index < 20; index += 1) await page.keyboard.press("ArrowDown");
        await page.keyboard.press("End");
        const before = await waitStableFileViewState(
          page,
          "cursor to settle before external write",
        );
        const tabsBefore = await readTicketTabs(page, ticketId);

        await sleep(20);
        await fs.writeFile(targetPath, CLEAN_DISK);
        await waitFileText(page, 'export const cleanAgent = "adopted";', false);
        const after = await waitStableFileViewState(page, "cursor to settle after external write");
        const tabsAfter = await readTicketTabs(page, ticketId);
        const updated = await waitUntil(
          "Updated marker after inspected external write",
          async () =>
            (await changeRow.getByTestId("ticket-changes-updated").count()) === 1 ? true : null,
        );

        const sameTabs = JSON.stringify(tabsBefore) === JSON.stringify(tabsAfter);
        const stableView =
          before.focused &&
          after.focused &&
          before.scrollTop === after.scrollTop &&
          before.cursorTop === after.cursorTop &&
          before.cursorLeft === after.cursorLeft;
        return {
          ok: stableView && sameTabs && updated === true,
          detail: `focus=${before.focused}→${after.focused} scroll=${before.scrollTop}→${after.scrollTop} cursor=${before.cursorTop}/${before.cursorLeft}→${after.cursorTop}/${after.cursorLeft} tabsStable=${sameTabs}`,
        };
      },
    );

    // Step 1 above uses same-line-count fixtures, so an absolute-position
    // restore and a minimal caret-follows-text reconciliation are
    // indistinguishable there. This step isolates the real invariant: an
    // external edit that changes line COUNT above the caret must move the
    // caret with its text (same content, shifted line number), not leave it
    // pinned to its old absolute line.
    await must(
      "1b",
      "external edit prepending lines above the caret keeps it with its text, not its old line",
      async () => {
        // Stay near the top so both the original and shifted line are inside the
        // ordinary viewport; this assertion is about caret mapping, not Monaco's
        // separate find/reveal or far-offscreen virtualization behavior.
        const anchorLine = fileHost(page)
          .locator(
            ".monaco-editor .monaco-scrollable-element.editor-scrollable > " +
              ".lines-content > .view-lines > .view-line",
          )
          .filter({ hasText: KNOWN_ANCHOR_TEXT });
        await waitUntil(
          "one visible nearby anchor line",
          async () => ((await anchorLine.count()) === 1 ? true : null),
          { timeout: 3000, interval: 50 },
        );
        await anchorLine.click();
        await page.keyboard.press("Home");
        const before = await waitCaretModelState(page, "caret model state before prepended edit", {
          timeout: 3000,
          interval: 50,
        });
        if (before.text !== KNOWN_ANCHOR_TEXT) {
          throw new Error(
            `caret did not reach the nearby anchor before the write: ${JSON.stringify(before)}`,
          );
        }
        const expectedTop =
          before?.top != null ? before.top + PREPEND_COUNT * LINE_HEIGHT_PX : null;

        await sleep(20);
        await fs.writeFile(targetPath, PREPEND_DISK);
        const after = await waitUntil(
          "caret to follow its text after a prepended external edit",
          async () => {
            const state = await caretModelState(page);
            return state.ready &&
              state.text === KNOWN_ANCHOR_TEXT &&
              expectedTop !== null &&
              state.top != null &&
              Math.abs(state.top - expectedTop) < 1
              ? state
              : null;
          },
          { timeout: 20000 },
        );
        // The caret's own on-screen row is EXPECTED to move (new content
        // pushed it down) — that is not a scroll-jump. The invariant is that
        // the viewport's scroll position itself does not jump to some
        // unrelated place; it either holds steady or is corrected by a
        // deliberate reveal, never left arbitrary.
        const scrollStable =
          before?.scrollTop != null &&
          after?.scrollTop != null &&
          before.scrollTop === after.scrollTop;

        // Undo the prepend so the first-line-based steps below see the same
        // layout they were written against.
        await sleep(20);
        await fs.writeFile(targetPath, CLEAN_DISK);
        await waitUntil(
          "caret to return to its original line once the prepend is undone",
          async () => {
            const state = await caretModelState(page);
            return state.ready &&
              state.text === KNOWN_ANCHOR_TEXT &&
              before?.top != null &&
              state.top != null &&
              Math.abs(state.top - before.top) < 1
              ? state
              : null;
          },
          { timeout: 20000 },
        );

        // This step deliberately navigated to a far-away anchor line and left
        // the viewport scrolled there. Monaco's virtualized rendering only
        // keeps visible lines in the DOM, and the steps below assert on text
        // near the top of the file — jump back so their `waitFileText` calls
        // find real rendered `.view-line`s instead of timing out on content
        // that is simply off-screen.
        await fileHost(page).locator(".monaco-editor").click();
        await page.keyboard.press("Meta+ArrowUp");

        return {
          ok:
            before.text === KNOWN_ANCHOR_TEXT &&
            after?.text === KNOWN_ANCHOR_TEXT &&
            after?.top != null &&
            expectedTop !== null &&
            Math.abs(after.top - expectedTop) < 1 &&
            scrollStable,
          detail: `mapped line stable=${after?.text === KNOWN_ANCHOR_TEXT} top=${before?.top}→${after?.top} (expected ${expectedTop}, +${PREPEND_COUNT} lines) scroll=${before?.scrollTop}→${after?.scrollTop}`,
        };
      },
    );

    await must(
      2,
      "deliberate Diff open clears Updated without duplicate or automatic tabs",
      async () => {
        await changeRow.click();
        const tabs = await waitUntil(
          "Diff tab deliberately active",
          async () => {
            const next = await readTicketTabs(page, ticketId);
            return next?.active === `diff:${TARGET}` ? next : null;
          },
          { timeout: 20000 },
        );
        await findInDiff(page, 'export const cleanAgent = "adopted";');
        const updatedCount = await changeRow.getByTestId("ticket-changes-updated").count();
        return {
          ok:
            updatedCount === 0 && (tabs.diffs?.filter((path) => path === TARGET).length ?? 0) === 1,
          detail: `active=${tabs.active} diffs=${JSON.stringify(tabs.diffs)} updated=${updatedCount}`,
        };
      },
    );

    await must(
      "2b",
      "parked clean File maps caret/viewport through a prepend with no stale undo or save clobber",
      async () => {
        // Give the TARGET File a saved position whose text has a clear identity,
        // then activate an independent File so every TARGET surface unmounts
        // and its clean registry entry/model is genuinely parked.
        await openFileFromRail(aside);
        const anchorLine = fileHost(page)
          .locator(
            ".monaco-editor .monaco-scrollable-element.editor-scrollable > " +
              ".lines-content > .view-lines > .view-line",
          )
          .filter({ hasText: KNOWN_ANCHOR_TEXT });
        await waitUntil(
          "one visible parked anchor line",
          async () => ((await anchorLine.count()) === 1 ? true : null),
          { timeout: 3000, interval: 50 },
        );
        await anchorLine.click();
        await page.keyboard.press("Home");
        const beforePark = await waitCaretModelState(page, "caret state before parking", {
          timeout: 3000,
          interval: 50,
        });
        if (beforePark.text !== KNOWN_ANCHOR_TEXT) {
          throw new Error(`caret missed parked anchor: ${JSON.stringify(beforePark)}`);
        }

        await openFileFromRail(aside, SECOND_TARGET, { pin: true });
        const parked = await waitUntil(
          `${SECOND_TARGET} File tab and editor to be active`,
          async () => {
            const tabs = await readTicketTabs(page, ticketId);
            const activeTab = page.getByRole("tab", { name: "sentinel.ts", exact: true });
            const file = await readFileState(page);
            return tabs?.active === `file:${SECOND_TARGET}` &&
              (await activeTab.getAttribute("aria-selected")) === "true" &&
              file.lines.includes(SENTINEL_BASE.trim())
              ? { file, tabs }
              : null;
          },
        );

        await fs.writeFile(targetPath, PARKED_PREPEND_DISK);
        await waitStableDiskText(
          targetPath,
          PARKED_PREPEND_DISK,
          "parked prepended write to settle on disk",
        );

        // Reopening reads the new disk revision and reacquires the parked model.
        // The new bytes are a clean baseline, not an edit the user may undo.
        await openFileFromRail(aside);
        const adopted = await waitFileText(page, PARKED_DISK_LINE, false);
        const reacquiredTabs = await waitUntil(`${TARGET} File tab to be active`, async () => {
          const tabs = await readTicketTabs(page, ticketId);
          // File previews carry this marker; the deliberately coexisting Diff
          // has the same accessible label but no preview marker. Assert both
          // states so this observes the File tab rather than depending on DOM
          // order between the two surfaces.
          const fileTab = page.locator(
            '[role="tab"][aria-label="reconcile.ts"][data-preview="true"]',
          );
          const diffTab = page.locator(
            '[role="tab"][aria-label="reconcile.ts"]:not([data-preview])',
          );
          return tabs?.active === `file:${TARGET}` &&
            (await fileTab.count()) === 1 &&
            (await fileTab.getAttribute("aria-selected")) === "true" &&
            (await diffTab.count()) === 1 &&
            (await diffTab.getAttribute("aria-selected")) === "false"
            ? tabs
            : null;
        });
        const expectedTop = beforePark.top + PREPEND_COUNT * LINE_HEIGHT_PX;
        const expectedScrollTop = beforePark.scrollTop + PREPEND_COUNT * LINE_HEIGHT_PX;
        const mappedView = await waitUntil(
          "parked caret and viewport anchor to follow their text through the prepend",
          async () => {
            const state = await caretModelState(page);
            return state.ready &&
              state.text === KNOWN_ANCHOR_TEXT &&
              Math.abs(state.top - expectedTop) < 1 &&
              Math.abs(state.scrollTop - expectedScrollTop) < 1
              ? state
              : null;
          },
          { timeout: 20000 },
        );
        const oldBeforeUndo = adopted.lines.includes(PARKED_OLD_LINE);

        // Positive control: prove Cmd-Z reaches this reacquired Monaco by
        // undoing one disposable character first. Keep it to one character:
        // Monaco's language features may split paired punctuation (such as a
        // block-comment close) into a separate undo element. Only the following
        // Cmd-Z is expected to be a no-op at the adopted disk baseline.
        const editor = fileHost(page).locator(".monaco-editor");
        await editor.click();
        await page.keyboard.press("Meta+ArrowUp");
        await page.keyboard.press("Home");
        await page.keyboard.insertText(PARKED_UNDO_CONTROL);
        const edited = await waitFileText(page, PARKED_UNDO_CONTROL, true);
        await page.keyboard.press("Meta+z");
        const afterControlUndo = await waitUntil(
          "positive undo control to restore the adopted clean baseline",
          async () => {
            const state = await readFileState(page);
            return state.dirty === "false" &&
              !state.lines.includes(PARKED_UNDO_CONTROL) &&
              state.lines.includes(PARKED_DISK_LINE)
              ? state
              : null;
          },
          { timeout: 5000, interval: 100 },
        );

        await page.keyboard.press("Meta+z");
        const afterBaselineUndo = await waitStableFileDocument(
          page,
          "parked baseline to remain clean and unchanged after Cmd-Z",
        );

        await page.keyboard.press("Meta+s");
        const afterSave = await waitStableFileDocument(
          page,
          "parked baseline to remain clean after Cmd-S",
        );
        const diskAfterSave = await waitStableDiskText(
          targetPath,
          PARKED_PREPEND_DISK,
          "Cmd-S to leave the adopted disk bytes unchanged",
        );

        const controlWorked =
          edited.dirty === "true" &&
          edited.lines.includes(PARKED_UNDO_CONTROL) &&
          afterControlUndo.dirty === "false" &&
          !afterControlUndo.lines.includes(PARKED_UNDO_CONTROL);
        const baselineUndoWasNoop =
          afterBaselineUndo.lines === afterControlUndo.lines &&
          afterBaselineUndo.lines.includes(PARKED_DISK_LINE) &&
          !afterBaselineUndo.lines.includes(PARKED_OLD_LINE) &&
          afterBaselineUndo.dirty === "false";
        const saveKeptDisk =
          afterSave.lines.includes(PARKED_DISK_LINE) &&
          afterSave.dirty === "false" &&
          diskAfterSave === PARKED_PREPEND_DISK;
        const viewMapped =
          mappedView.text === KNOWN_ANCHOR_TEXT &&
          Math.abs(mappedView.top - expectedTop) < 1 &&
          Math.abs(mappedView.scrollTop - expectedScrollTop) < 1;
        return {
          ok:
            parked.tabs.active === `file:${SECOND_TARGET}` &&
            reacquiredTabs.active === `file:${TARGET}` &&
            viewMapped &&
            !oldBeforeUndo &&
            controlWorked &&
            baselineUndoWasNoop &&
            saveKeptDisk,
          detail: `parkedActive=${parked.tabs.active} reacquiredActive=${reacquiredTabs.active} viewMapped=${viewMapped} caret=${beforePark.top}→${mappedView.top} (expected ${expectedTop}) scroll=${beforePark.scrollTop}→${mappedView.scrollTop} (expected ${expectedScrollTop}) adopted=${adopted.lines.includes(PARKED_DISK_LINE)} oldBeforeUndo=${oldBeforeUndo} controlWorked=${controlWorked} baselineUndoNoop=${baselineUndoWasNoop} dirtyAfterUndo=${afterBaselineUndo.dirty} saveKeptDisk=${saveKeptDisk} diskExact=${diskAfterSave === PARKED_PREPEND_DISK}`,
        };
      },
    );

    // Restore the same-line baseline expected by the disjoint/conflict steps
    // below; this reset is an ordinary live clean update, not another parked
    // adoption under test.
    await sleep(20);
    await fs.writeFile(targetPath, PARKED_BASE_DISK);
    await waitStableDiskText(targetPath, PARKED_BASE_DISK, "parked prepend cleanup on disk");
    await waitUntil(
      "parked prepend cleanup in File model",
      async () => {
        const state = await readFileState(page);
        return state.dirty === "false" &&
          state.lines.includes(PARKED_DISK_LINE) &&
          !state.lines.includes(PREPEND_LINES[0])
          ? state
          : null;
      },
      { timeout: 20000 },
    );

    await must(
      "2c",
      "same-path Diff adopts a clean parked update before File restores mapped view state",
      async () => {
        // Save a File view against the un-prepended clean baseline, then park
        // that view behind the already-open Diff for the exact same path.
        const anchorLine = fileHost(page)
          .locator(
            ".monaco-editor .monaco-scrollable-element.editor-scrollable > " +
              ".lines-content > .view-lines > .view-line",
          )
          .filter({ hasText: KNOWN_ANCHOR_TEXT });
        await waitUntil(
          "one visible File anchor before same-path Diff",
          async () => ((await anchorLine.count()) === 1 ? true : null),
          { timeout: 3000, interval: 50 },
        );
        await anchorLine.click();
        await page.keyboard.press("Home");
        const beforePark = await waitCaretModelState(
          page,
          "caret state before parking behind same-path Diff",
          { timeout: 3000, interval: 50 },
        );
        if (beforePark.text !== KNOWN_ANCHOR_TEXT) {
          throw new Error(
            `caret missed File anchor before same-path Diff: ${JSON.stringify(beforePark)}`,
          );
        }

        await aside.getByTestId("ticket-rail-tab-changes").click();
        await changeRow.click();
        const parked = await waitUntil(
          "same-path Diff active and ready with File host released",
          async () => {
            const tabs = await readTicketTabs(page, ticketId);
            const diffReady =
              (await page.locator('[data-monaco-diff-status="ready"]').count()) === 1;
            const fileHostCount = await fileHost(page).count();
            return tabs?.active === `diff:${TARGET}` && diffReady && fileHostCount === 0
              ? { diffReady, fileHostCount, tabs }
              : null;
          },
          { timeout: 20000 },
        );

        // Monaco only renders the modified Diff viewport. Force it to the top
        // so the subsequent positive watcher observation sees both the newly
        // prepended first line and the changed baseline line before File opens.
        const modifiedDiff = page
          .locator('[data-monaco-diff-status="ready"]')
          .locator(".editor.modified .monaco-editor")
          .first();
        await modifiedDiff.click();
        await page.keyboard.press("Meta+ArrowUp");
        await waitUntil(
          "modified Diff viewport at the clean baseline top",
          async () => {
            const state = await readDiffState(page);
            return state.ready && state.lines.includes(baselineLines[0]) ? state : null;
          },
          { timeout: 5000, interval: 50 },
        );

        await sleep(20);
        await fs.writeFile(targetPath, PARKED_PREPEND_DISK);
        await waitStableDiskText(
          targetPath,
          PARKED_PREPEND_DISK,
          "same-path Diff prepended write to settle on disk",
        );
        const diffAdopted = await waitUntil(
          "clean same-path Diff to visibly adopt both prepended and changed lines",
          async () => {
            const state = await readDiffState(page);
            return state.ready &&
              state.dirty === "false" &&
              state.lines.includes(PREPEND_LINES[0]) &&
              state.lines.includes(PARKED_DISK_LINE)
              ? state
              : null;
          },
          { timeout: 20000 },
        );

        // Only after the still-mounted Diff proves the watcher/model update do
        // we reopen File and inspect its independently saved view state.
        await openFileFromRail(aside);
        const adoptedFile = await waitFileText(page, PARKED_DISK_LINE, false);
        const expectedTop = beforePark.top + PREPEND_COUNT * LINE_HEIGHT_PX;
        const expectedScrollTop = beforePark.scrollTop + PREPEND_COUNT * LINE_HEIGHT_PX;
        const mappedView = await waitUntil(
          "same-path parked File caret and viewport to follow their text",
          async () => {
            const state = await caretModelState(page);
            return state.ready &&
              state.text === KNOWN_ANCHOR_TEXT &&
              Math.abs(state.top - expectedTop) < 1 &&
              Math.abs(state.scrollTop - expectedScrollTop) < 1
              ? state
              : null;
          },
          { timeout: 20000 },
        );

        const diffObservedBeforeFile =
          diffAdopted.dirty === "false" &&
          diffAdopted.lines.includes(PREPEND_LINES[0]) &&
          diffAdopted.lines.includes(PARKED_DISK_LINE);
        const fileMapped =
          adoptedFile.lines.includes(PARKED_DISK_LINE) &&
          mappedView.text === KNOWN_ANCHOR_TEXT &&
          Math.abs(mappedView.top - expectedTop) < 1 &&
          Math.abs(mappedView.scrollTop - expectedScrollTop) < 1;
        return {
          ok:
            parked.tabs.active === `diff:${TARGET}` &&
            parked.diffReady &&
            parked.fileHostCount === 0 &&
            diffObservedBeforeFile &&
            fileMapped,
          detail: `parkedActive=${parked.tabs.active} diffReady=${parked.diffReady} fileHosts=${parked.fileHostCount} diffObservedBeforeFile=${diffObservedBeforeFile} caret=${beforePark.top}→${mappedView.top} (expected ${expectedTop}) scroll=${beforePark.scrollTop}→${mappedView.scrollTop} (expected ${expectedScrollTop})`,
        };
      },
    );

    // Leave the same-line baseline expected by the disjoint/conflict checks.
    await sleep(20);
    await fs.writeFile(targetPath, PARKED_BASE_DISK);
    await waitStableDiskText(targetPath, PARKED_BASE_DISK, "same-path Diff cleanup on disk");
    await waitUntil(
      "same-path Diff cleanup in File model",
      async () => {
        const state = await readFileState(page);
        return state.dirty === "false" &&
          state.lines.includes(PARKED_DISK_LINE) &&
          !state.lines.includes(PREPEND_LINES[0])
          ? state
          : null;
      },
      { timeout: 20000 },
    );

    await openFileFromRail(aside);
    await waitFileText(page, 'export const cleanAgent = "adopted";', false);
    await aside.getByTestId("ticket-rail-tab-changes").click();

    await must(
      3,
      "disjoint human and agent edits reconcile into one dirty File model",
      async () => {
        await replaceFirstLine(page, HUMAN_MERGED_LINE);
        await sleep(20);
        await fs.writeFile(targetPath, DISJOINT_DISK);
        await waitUntil(
          "dirty merged File model",
          async () => {
            const state = await readFileState(page);
            return state.dirty === "true" && state.stale === "false" ? state : null;
          },
          { timeout: 20000 },
        );
        const local = await findInFile(page, HUMAN_MERGED_LINE);
        const disk = await findInFile(page, 'export const diskOnly = "agent";');
        return {
          ok: local.dirty === "true" && disk.dirty === "true",
          detail: `local=${local.lines.includes(HUMAN_MERGED_LINE)} disk=${disk.lines.includes('diskOnly = "agent"')} dirty=${disk.dirty}`,
        };
      },
    );

    await must(
      4,
      "Diff deliberately opened for the path shares the merged dirty model",
      async () => {
        await changeRow.click();
        const local = await findInDiff(page, HUMAN_MERGED_LINE);
        const disk = await findInDiff(page, 'export const diskOnly = "agent";');
        return {
          ok: local.dirty === "true" && disk.dirty === "true",
          detail: `local=${local.lines.includes(HUMAN_MERGED_LINE)} disk=${disk.lines.includes('diskOnly = "agent"')} dirty=${disk.dirty}`,
        };
      },
    );

    await openFileFromRail(aside);
    await findInFile(page, HUMAN_MERGED_LINE);
    await aside.getByTestId("ticket-rail-tab-changes").click();

    await must(
      5,
      "known local-save echo advances baseline without marking Updated, proved against a live watcher",
      async () => {
        await fileHost(page).locator(".monaco-editor").click();
        await page.keyboard.press("Meta+s");
        await waitUntil(
          "File model clean after save",
          async () => ((await readFileState(page)).dirty === "false" ? true : null),
          { timeout: 15000 },
        );
        const onDisk = await fs.readFile(targetPath, "utf8");

        // A bare timeout here would only prove the badge stayed quiet for a
        // while, which can't tell "the save echo was recognized" apart from
        // "the watcher pipeline died". Instead: open a second, independent
        // file once (recording its own inspect baseline), write a REAL
        // external edit to it, and wait for ITS Updated badge — that proves
        // the watcher round-tripped after our save. Only then check the
        // saved file's own row is still quiet.
        await openFileFromRail(aside, SECOND_TARGET, { pin: true });
        await waitFileText(page, 'export const sentinel = "seen";', false);
        await aside.getByTestId("ticket-rail-tab-changes").click();
        const sentinelRow = aside.locator(
          `[data-testid="ticket-changes-row"][data-path="${SECOND_TARGET}"]`,
        );
        await sleep(20);
        await fs.writeFile(join(worktreeDir, SECOND_TARGET), SENTINEL_EXTERNAL);
        await waitUntil(
          "sentinel Updated marker after its own external write",
          async () =>
            (await sentinelRow.getByTestId("ticket-changes-updated").count()) === 1 ? true : null,
          { timeout: 20000 },
        );

        // Restore TARGET as the active tab for the steps below, without
        // leaving the rail anywhere but Changes.
        await openFileFromRail(aside);
        await waitFileText(page, HUMAN_MERGED_LINE, false);
        await aside.getByTestId("ticket-rail-tab-changes").click();

        const updatedCount = await changeRow.getByTestId("ticket-changes-updated").count();
        return {
          ok:
            onDisk.includes(HUMAN_MERGED_LINE) &&
            onDisk.includes('export const diskOnly = "agent";') &&
            updatedCount === 0,
          detail: `localOnDisk=${onDisk.includes(HUMAN_MERGED_LINE)} agentOnDisk=${onDisk.includes('diskOnly = "agent"')} watcherProvedLive=true updated=${updatedCount}`,
        };
      },
    );

    await must(
      6,
      "overlap preserves exact local and disk versions behind one non-modal affordance",
      async () => {
        await replaceFirstLine(page, HUMAN_CONFLICT_LINE);
        const diskLines = (await fs.readFile(targetPath, "utf8")).split("\n");
        diskLines[0] = AGENT_CONFLICT_LINE;
        const agentDisk = diskLines.join("\n");
        await sleep(20);
        await fs.writeFile(targetPath, agentDisk);

        const affordance = page.getByTestId("live-reconciliation-conflict");
        await waitUntil("conflict affordance", async () => (await affordance.count()) === 1, {
          timeout: 20000,
        });
        const local = await findInFile(page, HUMAN_CONFLICT_LINE);
        const exactDisk = await fs.readFile(targetPath, "utf8");
        await sleep(700);
        const stillVisible = (await affordance.count()) === 1;
        const dialogCount = await page.getByRole("dialog").count();
        const useDisk = await affordance
          .getByRole("button", { name: "Use disk and discard draft" })
          .count();
        const overwrite = await affordance
          .getByRole("button", { name: "Overwrite disk with draft" })
          .count();
        return {
          ok:
            local.lines.includes(HUMAN_CONFLICT_LINE) &&
            exactDisk === agentDisk &&
            stillVisible &&
            dialogCount === 0 &&
            useDisk === 1 &&
            overwrite === 1,
          detail: `localExact=${local.lines.includes(HUMAN_CONFLICT_LINE)} diskExact=${exactDisk === agentDisk} persistent=${stillVisible} dialogs=${dialogCount} actions=${useDisk}/${overwrite}`,
        };
      },
    );

    await must(
      7,
      "reopening Diff clears Updated and reproduces the shared conflict result",
      async () => {
        const updatedBefore = await waitUntil("Updated marker after overlap", async () =>
          (await changeRow.getByTestId("ticket-changes-updated").count()) === 1 ? true : null,
        );
        await changeRow.click();
        const local = await findInDiff(page, HUMAN_CONFLICT_LINE);
        const affordance = page.getByTestId("live-reconciliation-conflict");
        await waitUntil("Diff conflict affordance", async () => (await affordance.count()) === 1, {
          timeout: 15000,
        });
        const updatedAfter = await changeRow.getByTestId("ticket-changes-updated").count();
        return {
          ok: updatedBefore === true && local.dirty === "true" && updatedAfter === 0,
          detail: `updatedBefore=${updatedBefore} sharedLocal=${local.lines.includes(HUMAN_CONFLICT_LINE)} dirty=${local.dirty} updatedAfter=${updatedAfter}`,
        };
      },
    );
  } finally {
    await app.close().catch(() => {});
    await cleanup();
  }

  process.exit(summarize());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
