/**
 * End-to-end acceptance smoke for Volli's terminal system (xterm.js + node-pty).
 * Drives the REAL packaged renderer through Playwright: two separate
 * workspaces, each with its own scoped terminal session, cwd = that workspace's
 * path, running concurrently and cleanly isolated.
 *
 * The terminal is xterm.js's DOM renderer (VC-107), so the grid IS in the DOM:
 * `.xterm` is one terminal and `.xterm-rows` holds its visible text. Shell
 * BEHAVIOUR is still asserted through side effects — keystrokes go into the
 * focused terminal and we poll for the file the shell writes, with cwd proven
 * by echoing `$PWD` into it — because a file written by the shell is evidence
 * the bytes reached the PTY, which rendered text alone is not. What the rows
 * text is for is the other half: that a terminal is still PAINTED, and painted
 * with the same content, after something moved it.
 *
 * This is a MANUALLY-RUN smoke (needs a display + the built app); it is NOT
 * wired into `vp test`.
 *
 *   Run:
 *     pnpm -C apps/desktop run build      # produce dist/ + dist-electron/
 *     node apps/desktop/e2e/terminal-smoke.mjs
 *
 *   Requires: playwright-core (devDependency of @volli/desktop).
 *   Exit code is non-zero if any numbered check fails.
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { launch as launchSmokeApp } from "./lib/smoke-kit.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const APP_DIR = join(REPO, "apps", "desktop");
// ---- tiny test harness -----------------------------------------------------

const results = [];
/** Record a numbered PASS/FAIL line; never throws so later steps still run. */
function check(n, label, ok, detail = "") {
  const status = ok ? "PASS" : "FAIL";
  results.push({ n, ok });
  console.log(`  [${status}] ${n}. ${label}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const terminalGrid = (value) => value?.split(/\s+/).map(Number) ?? [];

// ---- process baseline (orphan-shell check) ---------------------------------

/** How many `zsh -l` login shells are alive right now. */
function loginShellCount() {
  try {
    const out = execFileSync("/usr/bin/pgrep", ["-f", "zsh -l"], { encoding: "utf8" });
    return out.split("\n").filter((line) => line.trim().length > 0).length;
  } catch {
    // pgrep exits 1 with no matches.
    return 0;
  }
}

// ---- terminal interaction (one `.xterm` element per live terminal) --------

/**
 * Rects of the visible terminals, spatially ordered (top-left first).
 *
 * `.xterm` is xterm.js's own root: one per live terminal, and the element the
 * engine's persistent host holds. The active tab's view is the only one not
 * display:none (offsetParent set) and with a real measured size, which is what
 * keeps a background tab's terminal out of the ordering.
 */
async function visibleTerminalRects(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".xterm"))
      .filter(
        (element) =>
          element.offsetParent !== null && element.clientWidth > 0 && element.clientHeight > 0,
      )
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })
      .toSorted((a, b) => a.y - b.y || a.x - b.x),
  );
}

/** A viewport point inside the `index`-th visible terminal, at box fractions
 *  (fx, fy). Throws if that terminal is absent so callers can't silently target
 *  the wrong pane. */
async function visibleTerminalPointAt(page, index, fx = 0.5, fy = 0.5) {
  const rects = await visibleTerminalRects(page);
  const rect = rects[index];
  if (!rect) throw new Error(`visible terminal ${index} does not exist (count=${rects.length})`);
  return { x: rect.x + rect.width * fx, y: rect.y + rect.height * fy };
}

/** Focus the single VISIBLE terminal by clicking its centre. */
async function focusTerminal(page) {
  await focusTerminalAt(page, 0);
}

/** Focus a visible terminal by its left-to-right, top-to-bottom index. */
async function focusTerminalAt(page, index) {
  const point = await visibleTerminalPointAt(page, index);
  await page.mouse.click(point.x, point.y);
  await sleep(200);
}

/**
 * The rendered text of the `index`-th visible terminal, whitespace collapsed.
 *
 * `.xterm-rows` is the DOM renderer's grid: one div per visible row, each a run
 * of spans. `textContent` therefore runs the rows together with no separator,
 * so this is only ever asked whether it CONTAINS a marker — never what its
 * lines are.
 */
async function visibleRowsText(page, index = 0) {
  return page.evaluate((wanted) => {
    const terminals = Array.from(document.querySelectorAll(".xterm"))
      .filter(
        (element) =>
          element.offsetParent !== null && element.clientWidth > 0 && element.clientHeight > 0,
      )
      .toSorted((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return ra.y - rb.y || ra.x - rb.x;
      });
    const rows = terminals[wanted]?.querySelector(".xterm-rows");
    return rows === null || rows === undefined ? null : rows.textContent.replace(/\s+/g, " ");
  }, index);
}

/** Poll a visible terminal's rendered rows until they contain `needle`. */
async function waitForRowsContaining(page, needle, { index = 0, timeoutMs = 8000 } = {}) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await visibleRowsText(page, index);
    if (last?.includes(needle)) return last;
    await sleep(150);
  }
  return last;
}

/** Type a shell command into the focused terminal and submit it. */
async function runInTerminal(page, command) {
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

/** Poll a file until it contains `needle`, or time out. Returns text | null. */
async function waitForFileContains(path, needle, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const text = await fs.readFile(path, "utf8");
      if (text.includes(needle)) return text;
    } catch {
      // not written yet
    }
    await sleep(150);
  }
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Poll a file until its contents MATCH `pattern`, or time out. Returns the
 * trimmed text, or null.
 *
 * `waitForFileContains(path, "")` cannot express "wait for a real value":
 * every string contains the empty string, so it returns the first partial read
 * the poller happens to catch. That is why check 9 once reported `child=→` on
 * CI — it had captured a stray prompt glyph rather than `stty size` output, on
 * a runner slow enough for the redirect and the read to interleave. Waiting
 * for the SHAPE of the answer removes the race.
 */
async function waitForFileMatching(path, pattern, timeoutMs = 8000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await fs.readFile(path, "utf8");
      if (pattern.test(last.trim())) return last.trim();
    } catch {
      // not written yet
    }
    await sleep(150);
  }
  return last === null ? null : last.trim();
}

/** `stty size` output: "<rows> <cols>". */
const GRID_SHAPE = /^\d+\s+\d+$/;

/** Number of session tabs the selected workspace shows (close buttons ≙ tabs). */
async function tabCount(page) {
  return page.locator('[aria-label^="Close Terminal"]').count();
}

/** Wait for a live terminal with a real (non-zero) size and a painted grid. */
async function waitForLiveTerminal(page, timeoutMs = 20000) {
  await page.waitForFunction(
    () => {
      const element = Array.from(document.querySelectorAll(".xterm")).find(
        (candidate) => candidate.offsetParent !== null,
      );
      return (
        element &&
        element.clientWidth > 0 &&
        element.clientHeight > 0 &&
        element.querySelector(".xterm-rows") !== null
      );
    },
    { timeout: timeoutMs },
  );
  // Give the shell a beat to boot and paint its prompt.
  await sleep(2200);
}

/**
 * Boot a terminal tab through the session-start control's caret and wait for
 * its terminal. Home's session-start control starts a structured CHAT on a press
 * (a terminal is the companion kind, one caret away), so a PTY smoke mints
 * every terminal itself through that caret. `.first()` because the ticket
 * surfaces mount the same control too; `expectedTabs` pins the wait to this
 * create rather than a terminal an earlier tab painted.
 */
async function startTerminalTab(page, expectedTabs) {
  await page.getByLabel("Other things to open").first().click();
  await page.getByRole("menuitem", { name: /^Terminal/ }).click();
  await page.waitForFunction(
    (n) => document.querySelectorAll('[aria-label^="Close Terminal"]').length === n,
    expectedTabs,
    { timeout: 10000 },
  );
  await waitForLiveTerminal(page);
}

// ---- main ------------------------------------------------------------------

async function main() {
  const shot = (name) => join(SCRATCH, name);
  const baseline = loginShellCount();
  console.log(`login-shell baseline (pgrep 'zsh -l'): ${baseline}`);

  // Two real workspace dirs, each with a distinct marker file. realpath so the
  // seeded path matches node-pty's resolve() AND the shell's $PWD (macOS /tmp
  // is a symlink to /private/tmp).
  const alphaDir = await fs.realpath(await fs.mkdtemp(join(SCRATCH, "ws-alpha-")));
  const betaDir = await fs.realpath(await fs.mkdtemp(join(SCRATCH, "ws-beta-")));
  await fs.writeFile(join(alphaDir, "ALPHA_MARKER.txt"), "alpha\n");
  await fs.writeFile(join(betaDir, "BETA_MARKER.txt"), "beta\n");
  console.log("alpha:", alphaDir);
  console.log("beta: ", betaDir);

  const probeA = join(SCRATCH, "probe-a.txt");
  const probeB = join(SCRATCH, "probe-b.txt");
  const probeA2 = join(SCRATCH, "probe-a2.txt");
  const splitRootPid = join(SCRATCH, "split-root-pid.txt");
  const splitChildPid = join(SCRATCH, "split-child-pid.txt");
  const focusedLeftPid = join(SCRATCH, "focused-left-pid.txt");
  const focusedRightPid = join(SCRATCH, "focused-right-pid.txt");
  const rootGridBeforePath = join(SCRATCH, "root-grid-before.txt");
  const rootGridAfterPath = join(SCRATCH, "root-grid-after.txt");
  const childGridBeforePath = join(SCRATCH, "child-grid-before.txt");
  const childGridAfterPath = join(SCRATCH, "child-grid-after.txt");
  const dprGridBeforePath = join(SCRATCH, "dpr-grid-before.txt");
  const dprGridAfterPath = join(SCRATCH, "dpr-grid-after.txt");
  const keepAliveGridBeforePath = join(SCRATCH, "keepalive-grid-before.txt");
  const keepAliveGridAfterPath = join(SCRATCH, "keepalive-grid-after.txt");
  const mouseReportPath = join(SCRATCH, "mouse-report.txt");
  const mouseReadyPath = join(SCRATCH, "mouse-ready.txt");
  for (const p of [
    probeA,
    probeB,
    probeA2,
    splitRootPid,
    splitChildPid,
    focusedLeftPid,
    focusedRightPid,
    rootGridBeforePath,
    rootGridAfterPath,
    childGridBeforePath,
    childGridAfterPath,
    dprGridBeforePath,
    dprGridAfterPath,
    keepAliveGridBeforePath,
    keepAliveGridAfterPath,
    mouseReportPath,
    mouseReadyPath,
  ]) {
    await fs.rm(p, { force: true });
  }

  // Distinct two-word names → distinct monograms "AR" / "BC" (rail tiles carry
  // a duplicate accessible name from the dnd-kit wrapper, so we click the
  // monogram TEXT exactly).
  const projects = [
    {
      id: "ws-alpha",
      name: "Alpha Ridge",
      path: alphaDir,
      ticketPrefix: "ALR",
      colorIndex: 0,
      createdAt: Date.now(),
    },
    {
      id: "ws-beta",
      name: "Beta Cove",
      path: betaDir,
      ticketPrefix: "BEC",
      colorIndex: 3,
      createdAt: Date.now() + 1,
    },
  ];

  const consoleErrors = [];
  // The isolated profile owns the SQLite db in both development and packaged
  // runs. Its empty first-run state is what lets bootstrap import this smoke's
  // localStorage project fixture without touching the owner's data.
  // An isolated Chromium profile, for the db's reason and one more: sharing
  // <userData> with a Volli the owner already has open loses the
  // single-instance lock, so this launch quits at exit code 0 before its first
  // window. That surfaces only as "Target page, context or browser has been
  // closed" from launch() — which reads like a crash in the app under test.
  const profileDir = await fs.mkdtemp(join(os.tmpdir(), "volli-terminal-smoke-profile-"));
  const app = await launchSmokeApp({
    dbPath: join(profileDir, "volli.db"),
    userDataDir: profileDir,
  });

  try {
    const page = await app.firstWindow();
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
    await page.waitForLoadState("domcontentloaded");

    // Seed two workspaces + select alpha, then reload so persisted state takes
    // effect from a clean boot.
    await page.evaluate((projs) => {
      localStorage.setItem(
        "volli:projects",
        JSON.stringify({
          state: { projects: projs, selectedProjectId: projs[0].id },
          version: 1,
        }),
      );
    }, projects);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    // === 1. Workspace A: open Home, start a terminal, probe cwd ============
    await page.getByText("Home", { exact: true }).click();
    await startTerminalTab(page, 1); // a terminal is an explicit pick now
    const aTabs1 = await tabCount(page);
    await page.screenshot({ path: shot("01-workspace-a-terminal.png") });

    await focusTerminal(page);
    await runInTerminal(page, `echo A-$PWD > ${probeA}`);
    const aText = await waitForFileContains(probeA, alphaDir);
    check(
      1,
      "Workspace A terminal: keystroke→PTY→shell, cwd = ws-alpha",
      aText !== null && aText.includes(`A-${alphaDir}`) && aTabs1 === 1,
      `tabs=${aTabs1} probe=${JSON.stringify(aText?.trim() ?? null)}`,
    );

    // === 2. Workspace B: switch via rail, get its own terminal, probe cwd ===
    // Nav and the active Home tab are both remembered per-workspace and both
    // default to Home's Board tab, so a fresh workspace opens on the board —
    // click Home to be sure of the page, then mint its own terminal.
    await page.getByText("BC", { exact: true }).click(); // Beta Cove monogram
    await page.getByText("Home", { exact: true }).click();
    await startTerminalTab(page, 1); // beta's first terminal, explicitly
    const bTabs = await tabCount(page);
    await page.screenshot({ path: shot("02-workspace-b-terminal.png") });

    await focusTerminal(page);
    await runInTerminal(page, `echo B-$PWD > ${probeB}`);
    const bText = await waitForFileContains(probeB, betaDir);
    check(
      2,
      "Workspace B terminal: own session, cwd = ws-beta (A still live)",
      bText !== null && bText.includes(`B-${betaDir}`) && !bText.includes(alphaDir) && bTabs === 1,
      `tabs=${bTabs} probe=${JSON.stringify(bText?.trim() ?? null)}`,
    );

    // === 3. Isolation/concurrency: back in A, SAME session, no dup tab ======
    // Alpha remembers it was on Sessions, but re-assert to be robust.
    await page.getByText("AR", { exact: true }).click(); // Alpha Ridge monogram
    await page.getByText("Home", { exact: true }).click();
    await waitForLiveTerminal(page);
    const aTabs2 = await tabCount(page);
    await focusTerminal(page);
    await runInTerminal(page, `echo again-$PWD >> ${probeA}`);
    const aAppend = await waitForFileContains(probeA, `again-${alphaDir}`);
    check(
      3,
      "Isolation: A's original session still live, append arrived, no dup tab",
      aAppend !== null &&
        aAppend.includes(`again-${alphaDir}`) &&
        aAppend.includes(`A-${alphaDir}`) && // original line intact
        aTabs2 === 1,
      `tabs=${aTabs2}`,
    );

    // === 4. Keep-alive across a Home TAB switch, history intact ============
    // This used to be a nav round trip, Board ↔ Sessions. Those are one page
    // now (VC-54), so the same journey — the terminal surface goes away and
    // comes back — is a switch to Home's permanent Board tab and back. The nav
    // half of the old check lives on in `home-taxonomy-smoke.mjs` (Home ↔
    // Files), because both directions still have to keep the PTY mounted.
    const homeTabs = page.getByRole("tablist", { name: "Home tabs", exact: true });
    await homeTabs.getByRole("tab", { name: "Board" }).click();
    await sleep(500);
    await homeTabs
      .getByRole("tab", { name: /^Terminal/ })
      .first()
      .click();
    await waitForLiveTerminal(page);
    const aTabs3 = await tabCount(page);
    await focusTerminal(page);
    // No re-cd: if the same shell survived, $PWD is still ws-alpha.
    await runInTerminal(page, `echo third-$PWD >> ${probeA}`);
    const aThird = await waitForFileContains(probeA, `third-${alphaDir}`);
    await page.screenshot({ path: shot("04-after-nav-return.png") });
    check(
      4,
      "Keep-alive across a Home tab switch (Board↔Session): same shell, cwd intact",
      aThird !== null && aThird.includes(`third-${alphaDir}`) && aTabs3 === 1,
      `tabs=${aTabs3}`,
    );

    // === 5. Display-scale change: the grid survives a DPR-only change =======
    // Electron cannot be moved between physical monitors deterministically in
    // CI, so override only the DPR getter and dispatch the presentation-level
    // resize fallback the registry's watcher listens for. The terminal's CSS
    // box stays fixed, so a DOM-rendered grid must come through a scale change
    // UNCHANGED — same rows, same content — and must still paint what the shell
    // prints afterwards. (The renderer before this one kept its own backing
    // buffer here; Chromium owns device pixels for DOM text, so the thing worth
    // asserting is that nothing was blanked or reflowed.)
    await focusTerminal(page);
    await runInTerminal(page, "echo DPR-BEFORE-MARK");
    const rowsBeforeDpr = await waitForRowsContaining(page, "DPR-BEFORE-MARK");
    await runInTerminal(page, `stty size > ${dprGridBeforePath}`);
    const dprGridBefore = await waitForFileMatching(dprGridBeforePath, GRID_SHAPE, 5000);

    const dprReport = await page.evaluate(async () => {
      const originalDpr = window.devicePixelRatio;
      const forcedDpr = originalDpr === 1 ? 2 : 1;
      // Stash the descriptor for the restore below, which happens in a LATER
      // evaluate (the forced ratio has to survive a round trip through the
      // shell). Getting the restore wrong is not cosmetic: if `devicePixelRatio`
      // ends up `undefined`, every cell measurement downstream becomes NaN, and
      // a terminal whose cell size is NaN silently stops fitting and reports
      // NaN mouse coordinates — with nothing on screen or in the console saying
      // so.
      window.volliOriginalDprDescriptor = Object.getOwnPropertyDescriptor(
        window,
        "devicePixelRatio",
      );
      Object.defineProperty(window, "devicePixelRatio", {
        configurable: true,
        get: () => forcedDpr,
      });
      window.dispatchEvent(new Event("resize"));
      // Two frames: the engine refits now and once more on its settle frame.
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      return { originalDpr, forcedDpr };
    });
    await sleep(500);
    const rowsAfterDpr = await visibleRowsText(page);
    await runInTerminal(page, "echo DPR-AFTER-MARK");
    const rowsRepainted = await waitForRowsContaining(page, "DPR-AFTER-MARK");
    await runInTerminal(page, `stty size > ${dprGridAfterPath}`);
    const dprGridAfter = await waitForFileMatching(dprGridAfterPath, GRID_SHAPE, 5000);
    const dprRestored = await page.evaluate(() => {
      const original = window.volliOriginalDprDescriptor;
      delete window.volliOriginalDprDescriptor;
      if (original === undefined) delete window.devicePixelRatio;
      else Object.defineProperty(window, "devicePixelRatio", original);
      window.dispatchEvent(new Event("resize"));
      return window.devicePixelRatio;
    });
    await sleep(300);
    check(
      5,
      "A DPR-only display change leaves the rendered grid intact and still painting",
      rowsBeforeDpr !== null &&
        rowsBeforeDpr.includes("DPR-BEFORE-MARK") &&
        rowsAfterDpr !== null &&
        rowsAfterDpr.includes("DPR-BEFORE-MARK") &&
        rowsRepainted !== null &&
        rowsRepainted.includes("DPR-AFTER-MARK") &&
        dprGridBefore !== null &&
        dprGridAfter === dprGridBefore &&
        // The override really was undone: every later check measures cells
        // against this number.
        dprRestored === dprReport.originalDpr,
      `dpr=${JSON.stringify(dprReport)} restored=${dprRestored} grid=${dprGridBefore}→${dprGridAfter}`,
    );

    // === 6. Second tab in A: caret → two tabs, each its own live shell ======
    // The Board Session strip's control is a split button (press = chat, caret = the
    // kinds); this flow boots the terminal kind, so it takes the caret — the
    // same gesture startTerminalTab encodes. Tab 2 becomes active on create.
    await startTerminalTab(page, 2);
    const aTabs4 = await tabCount(page);
    await page.screenshot({ path: shot("06-two-tabs.png") });

    // Probe from the freshly-focused tab 2.
    await focusTerminal(page);
    await runInTerminal(page, `echo tab2-$PWD > ${probeA2}`);
    const a2Text = await waitForFileContains(probeA2, alphaDir);

    // Switch back to tab 1 and confirm ITS shell still responds. Scoped to
    // role="tab" — the sidebar's Active band now carries its own "Terminal 1"
    // row (a plain button) beside the strip's tab, and a bare text match
    // resolves to both.
    await page.getByRole("tab", { name: "Terminal 1", exact: true }).click();
    await sleep(600);
    await focusTerminal(page);
    await runInTerminal(page, `echo tab1again-$PWD >> ${probeA}`);
    const a1Again = await waitForFileContains(probeA, `tab1again-${alphaDir}`);
    check(
      6,
      "Second tab in A: two live shells, tab2 cwd ok, tab1 still responds",
      a2Text !== null &&
        a2Text.includes(`tab2-${alphaDir}`) &&
        aTabs4 === 2 &&
        a1Again !== null &&
        a1Again.includes(`tab1again-${alphaDir}`),
      `tabs=${aTabs4}`,
    );

    // === 7. Split panes: each leaf owns an independent shell + renderer ====
    // This is the architecture boundary used by Ghostty/cmux: splitting a
    // surface creates a fresh terminal surface/PTY. A second `.xterm` wired to
    // the original PTY is not a split — input/output from both panes aliases.
    await runInTerminal(page, `echo $$ > ${splitRootPid}`);
    await waitForFileContains(splitRootPid, "", 3000);
    await page.keyboard.press("Meta+d");
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll(".xterm")).filter(
          (element) =>
            element.offsetParent !== null && element.clientWidth > 0 && element.clientHeight > 0,
        ).length === 2,
      { timeout: 10000 },
    );
    await sleep(800);
    await focusTerminalAt(page, 1);
    await runInTerminal(page, `echo $$ > ${splitChildPid}`);
    const rootPid = (await waitForFileContains(splitRootPid, "", 3000))?.trim() ?? null;
    const childPid = (await waitForFileContains(splitChildPid, "", 5000))?.trim() ?? null;
    await page.screenshot({ path: shot("07-independent-split.png") });
    check(
      7,
      "Split right: two visible panes own two independent shell sessions",
      rootPid !== null && childPid !== null && rootPid !== childPid,
      `rootPid=${JSON.stringify(rootPid)} childPid=${JSON.stringify(childPid)}`,
    );

    // === 8. Keyboard split focus: Cmd+Option+arrows route input spatially ===
    await page.keyboard.press("Meta+Alt+ArrowLeft");
    await sleep(300);
    await runInTerminal(page, `echo $$ > ${focusedLeftPid}`);
    const leftFocusedPid = (await waitForFileContains(focusedLeftPid, "", 5000))?.trim() ?? null;
    await page.keyboard.press("Meta+Alt+ArrowRight");
    await sleep(300);
    await runInTerminal(page, `echo $$ > ${focusedRightPid}`);
    const rightFocusedPid = (await waitForFileContains(focusedRightPid, "", 5000))?.trim() ?? null;
    check(
      8,
      "Cmd+Option+arrow keys move focus and route input to the adjacent split",
      leftFocusedPid === rootPid && rightFocusedPid === childPid,
      `left=${JSON.stringify(leftFocusedPid)} right=${JSON.stringify(rightFocusedPid)}`,
    );

    // === 9. Pane-local font zoom: focused grid changes, sibling/UI don't ===
    await focusTerminalAt(page, 0);
    await runInTerminal(page, `stty size > ${rootGridBeforePath}`);
    const rootGridBefore = await waitForFileMatching(rootGridBeforePath, GRID_SHAPE, 5000);
    await focusTerminalAt(page, 1);
    await runInTerminal(page, `stty size > ${childGridBeforePath}`);
    const childGridBefore = await waitForFileMatching(childGridBeforePath, GRID_SHAPE, 5000);
    const chromeBefore = await page.evaluate(() => ({
      dpr: window.devicePixelRatio,
      // A chrome label that is NOT inside the terminal, to prove ⌘+ zoomed the
      // focused pane alone. "Sessions" was that label until VC-54 retired the
      // nav item; "Configure" is its surviving neighbour on the same row.
      navFontSize: getComputedStyle(
        Array.from(document.querySelectorAll("*")).find(
          (element) => element.textContent === "Configure" && element.children.length === 0,
        ),
      ).fontSize,
    }));

    await page.keyboard.press("Meta+Equal");
    await sleep(1000);
    await runInTerminal(page, `stty size > ${childGridAfterPath}`);
    const childGridAfter = await waitForFileMatching(childGridAfterPath, GRID_SHAPE, 5000);
    await focusTerminalAt(page, 0);
    await runInTerminal(page, `stty size > ${rootGridAfterPath}`);
    const rootGridAfter = await waitForFileMatching(rootGridAfterPath, GRID_SHAPE, 5000);
    const chromeAfter = await page.evaluate(() => ({
      dpr: window.devicePixelRatio,
      // A chrome label that is NOT inside the terminal, to prove ⌘+ zoomed the
      // focused pane alone. "Sessions" was that label until VC-54 retired the
      // nav item; "Configure" is its surviving neighbour on the same row.
      navFontSize: getComputedStyle(
        Array.from(document.querySelectorAll("*")).find(
          (element) => element.textContent === "Configure" && element.children.length === 0,
        ),
      ).fontSize,
    }));
    const [childRowsBefore, childColsBefore] = terminalGrid(childGridBefore);
    const [childRowsAfter, childColsAfter] = terminalGrid(childGridAfter);
    check(
      9,
      "Cmd+ zooms only the focused split pane, not its sibling or Volli chrome",
      childRowsAfter < childRowsBefore &&
        childColsAfter < childColsBefore &&
        rootGridAfter === rootGridBefore &&
        JSON.stringify(chromeAfter) === JSON.stringify(chromeBefore),
      `child=${childGridBefore}→${childGridAfter} root=${rootGridBefore}→${rootGridAfter} chrome=${JSON.stringify(chromeAfter)}`,
    );

    // === 10. Tab switch away and back: correct grid, no user resize =========
    // VC-107 acceptance #1, and the one assertion only a DOM-rendered terminal
    // can make: after the surface goes away and comes back, the rows on screen
    // still hold what the shell printed before the trip, and the shell's own
    // view of the grid has not moved. A renderer that measured a hidden host
    // would come back with a wrong grid until the user resized the window —
    // which is exactly the failure nobody can see in a screenshot, because the
    // screenshot is of a terminal that looks fine and is one `stty` wrong.
    await focusTerminalAt(page, 0);
    await runInTerminal(page, "echo KEEPALIVE-MARK");
    const rowsBeforeSwitch = await waitForRowsContaining(page, "KEEPALIVE-MARK");
    await runInTerminal(page, `stty size > ${keepAliveGridBeforePath}`);
    const keepAliveGridBefore = await waitForFileMatching(
      keepAliveGridBeforePath,
      GRID_SHAPE,
      5000,
    );

    await homeTabs.getByRole("tab", { name: "Board" }).click();
    await sleep(800);
    await homeTabs
      .getByRole("tab", { name: /^Terminal/ })
      .first()
      .click();
    await waitForLiveTerminal(page);
    // Read the rows BEFORE touching the mouse or the keyboard: any interaction
    // would be a chance to refit, and the claim is that none was needed.
    const rowsAfterSwitch = await visibleRowsText(page, 0);
    await page.screenshot({ path: shot("10-after-tab-return.png") });
    await focusTerminalAt(page, 0);
    await runInTerminal(page, `stty size > ${keepAliveGridAfterPath}`);
    const keepAliveGridAfter = await waitForFileMatching(keepAliveGridAfterPath, GRID_SHAPE, 5000);
    check(
      10,
      "Tab switch away and back: same rendered rows and the same grid, unresized",
      rowsBeforeSwitch !== null &&
        rowsBeforeSwitch.includes("KEEPALIVE-MARK") &&
        rowsAfterSwitch !== null &&
        rowsAfterSwitch.includes("KEEPALIVE-MARK") &&
        keepAliveGridBefore !== null &&
        keepAliveGridAfter === keepAliveGridBefore,
      `grid=${keepAliveGridBefore}→${keepAliveGridAfter} rows=${JSON.stringify(rowsAfterSwitch?.slice(-60) ?? null)}`,
    );

    // === 11. Mouse reporting reaches the PTY ================================
    // The probe enables DECSET 1000 + SGR 1006 and records raw stdin bytes.
    // This is the same protocol Claude Code's TUI relies on for clickable UI
    // and wheel input; checking the PTY bytes asserts the report itself rather
    // than anything the terminal happened to draw about it.
    await focusTerminalAt(page, 0);
    await runInTerminal(
      page,
      `node ${join(APP_DIR, "e2e", "mouse-report-probe.mjs")} ${mouseReportPath} ${mouseReadyPath}`,
    );
    await waitForFileContains(mouseReadyPath, "ready", 5000);
    // The readiness file is written immediately after stdout.write(DECSET),
    // while node-pty batches output for up to one frame. Wait until the
    // terminal has consumed the mode sequences before generating pointer input.
    await sleep(250);
    // Target the SAME terminal focusTerminalAt(page, 0) just focused — the probe
    // runs in that pane, so pointer input must land there too.
    const mouseBox = await visibleTerminalPointAt(page, 0, 0.7, 0.6);
    await page.mouse.click(mouseBox.x, mouseBox.y);
    await page.mouse.wheel(0, 180);
    const mouseHex = await waitForFileContains(mouseReportPath, "1b5b3c", 5000);
    await page.keyboard.press("Control+c");
    await sleep(400);
    const hasMouseDown = /1b5b3c303b[0-9a-f]+4d/.test(mouseHex ?? "");
    const hasMouseWheel = /1b5b3c(?:3634|3635)3b[0-9a-f]+4d/.test(mouseHex ?? "");
    check(
      11,
      "Click + wheel on the terminal become SGR mouse reports at the PTY",
      hasMouseDown && hasMouseWheel,
      `down=${hasMouseDown} wheel=${hasMouseWheel} raw=${JSON.stringify(mouseHex?.trim() ?? null)}`,
    );

    // === 12. Normal-screen wheel scrolls the terminal's own scrollback ======
    // xterm scrolls through its own scrollable element rather than a native
    // `scrollTop`, so the honest reading is the one the user has: which lines
    // are DRAWN. 500 lines in, the last one is on screen; a wheel up has to put
    // an earlier one there instead.
    await runInTerminal(page, 'seq -f "line-%g" 1 500');
    const rowsAtBottom = await waitForRowsContaining(page, "line-500", { timeoutMs: 10000 });
    await page.mouse.move(mouseBox.x, mouseBox.y);
    await page.mouse.wheel(0, -600);
    await sleep(400);
    const rowsScrolledBack = await visibleRowsText(page, 0);
    check(
      12,
      "Wheel scrolls ordinary terminal scrollback",
      rowsAtBottom !== null &&
        rowsAtBottom.includes("line-500") &&
        rowsScrolledBack !== null &&
        !rowsScrolledBack.includes("line-500") &&
        /line-\d+/.test(rowsScrolledBack),
      `bottom=${JSON.stringify(rowsAtBottom?.slice(-40) ?? null)} scrolled=${JSON.stringify(rowsScrolledBack?.slice(-40) ?? null)}`,
    );

    // Manual visual diagnostic for Claude-style status symbols. The codepoints
    // are in the DOM now, but which FACE the font stack picked for them — and
    // whether that face draws a tofu box — is a pixel question no DOM read can
    // answer, so this screenshot stays intentionally NOT a pass/fail assertion.
    // Inspect both the bare U+23FA and explicit U+23FA U+FE0E rows.
    await runInTerminal(
      page,
      "printf '\\033[32m⏺\\033[0m bare-symbol\\n\\033[36m⏺︎\\033[0m explicit-text-symbol\\n'",
    );
    await page.mouse.move(mouseBox.x, mouseBox.y);
    await page.mouse.wheel(0, 100_000);
    await sleep(500);
    await page.screenshot({ path: shot("08-symbol-presentation.png") });
  } finally {
    await app.close();
  }

  // === 13. Clean teardown: no orphaned login shells =========================
  let after = loginShellCount();
  for (let i = 0; i < 20 && after > baseline; i++) {
    await sleep(250);
    after = loginShellCount();
  }
  check(
    13,
    "Clean teardown: no orphaned login shells after quit",
    after <= baseline,
    `baseline=${baseline} after=${after}`,
  );

  // Fatal renderer errors (CSP/data-URI) invalidate the whole run. WASM is
  // still matched deliberately: the CSP no longer permits it, so a renderer
  // that tries to compile any is a dependency nobody meant to add.
  const fatal = consoleErrors.filter((e) =>
    /wasm|WebAssembly|Content Security|CSP|data: URI|not base64|Refused to/i.test(e),
  );
  check(0, "No fatal renderer console errors (CSP)", fatal.length === 0, fatal.join(" | "));

  console.log("\nScreenshots:");
  console.log(`  ${join(SCRATCH, "01-workspace-a-terminal.png")}  — Workspace A live terminal`);
  console.log(`  ${join(SCRATCH, "02-workspace-b-terminal.png")}  — Workspace B live terminal`);
  console.log(`  ${join(SCRATCH, "04-after-nav-return.png")}      — A after Board↔Sessions nav`);
  console.log(`  ${join(SCRATCH, "06-two-tabs.png")}              — A with two session tabs`);
  console.log(`  ${join(SCRATCH, "07-independent-split.png")}      — two independent split panes`);
  console.log(
    `  ${join(SCRATCH, "10-after-tab-return.png")}       — A after a Board↔Terminal round trip`,
  );
  console.log(
    `  ${join(SCRATCH, "08-symbol-presentation.png")}     — manual-only U+23FA bare + VS15 visual check (pixels not asserted)`,
  );
  const failures = results.filter((r) => !r.ok);
  console.log(
    `\n${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} CHECK(S) FAILED: ${failures.map((f) => f.n).join(", ")}`}`,
  );
  return failures.length === 0 ? 0 : 1;
}

// Scratch dir for probe files + screenshots. Override with VOLLI_SMOKE_DIR.
const SCRATCH =
  process.env.VOLLI_SMOKE_DIR ?? (await fs.mkdtemp(join(os.tmpdir(), "volli-terminal-smoke-")));
await fs.mkdir(SCRATCH, { recursive: true });
console.log("scratch:", SCRATCH, "\n");

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error("\nSMOKE ABORTED:", error?.stack ?? error);
  code = 1;
}
process.exit(code);
