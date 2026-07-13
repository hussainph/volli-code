/**
 * End-to-end acceptance smoke for Volli's terminal system (libghostty/restty +
 * node-pty). Drives the REAL packaged renderer through Playwright: two separate
 * workspaces, each with its own scoped terminal session, cwd = that workspace's
 * path, running concurrently and cleanly isolated.
 *
 * The terminal is a WebGPU/WebGL2 canvas — its text is NOT in the DOM. So every
 * assertion about shell behaviour is made through SIDE EFFECTS: keystrokes are
 * typed into the focused canvas and we poll for the file the shell writes. cwd
 * correctness is proven by echoing `$PWD` into that file.
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

import { _electron } from "playwright-core";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const APP_DIR = join(REPO, "apps", "desktop");
const ELECTRON = join(
  APP_DIR,
  "node_modules",
  "electron",
  "dist",
  "Electron.app",
  "Contents",
  "MacOS",
  "Electron",
);

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

// ---- terminal interaction (via real canvas, no DOM text) -------------------

/** Focus the single VISIBLE terminal canvas by clicking its centre. */
async function focusTerminal(page) {
  const box = await page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll("canvas"));
    // The active tab's view is the only one not display:none (offsetParent set)
    // and with a real measured size.
    const visible = canvases.find(
      (c) => c.offsetParent !== null && c.clientWidth > 0 && c.clientHeight > 0,
    );
    if (!visible) return null;
    const r = visible.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!box) throw new Error("no visible terminal canvas to focus");
  await page.mouse.click(box.x, box.y);
  await sleep(200);
}

/** Focus a visible terminal canvas by its left-to-right, top-to-bottom index. */
/** Rects of visible terminal canvases, spatially ordered (top-left first). */
async function visibleCanvasRects(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("canvas"))
      .filter(
        (canvas) =>
          canvas.offsetParent !== null && canvas.clientWidth > 0 && canvas.clientHeight > 0,
      )
      .map((canvas) => {
        const rect = canvas.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })
      .sort((a, b) => a.y - b.y || a.x - b.x),
  );
}

/** A viewport point inside the `index`-th visible canvas, at box fractions
 *  (fx, fy). Throws if that canvas is absent so callers can't silently target
 *  the wrong pane. */
async function visibleCanvasPointAt(page, index, fx = 0.5, fy = 0.5) {
  const rects = await visibleCanvasRects(page);
  const rect = rects[index];
  if (!rect)
    throw new Error(`visible terminal canvas ${index} does not exist (count=${rects.length})`);
  return { x: rect.x + rect.width * fx, y: rect.y + rect.height * fy };
}

async function focusTerminalAt(page, index) {
  const point = await visibleCanvasPointAt(page, index);
  await page.mouse.click(point.x, point.y);
  await sleep(200);
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

/** Number of session tabs the selected workspace shows (close buttons ≙ tabs). */
async function tabCount(page) {
  return page.locator('[aria-label^="Close Terminal"]').count();
}

/** Wait for a live terminal canvas with a real (non-zero) size to appear. */
async function waitForLiveCanvas(page, timeoutMs = 20000) {
  await page.waitForFunction(
    () => {
      const c = Array.from(document.querySelectorAll("canvas")).find(
        (el) => el.offsetParent !== null,
      );
      return c && c.clientWidth > 0 && c.clientHeight > 0;
    },
    { timeout: timeoutMs },
  );
  // Give restty a beat to boot the shell, measure, and paint the prompt.
  await sleep(2200);
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
  const app = await _electron.launch({ executablePath: ELECTRON, args: [APP_DIR] });
  let backendReport = { webgpu: false, webgl2: false, navigatorGpu: false };

  try {
    const page = await app.firstWindow();
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
    await page.waitForLoadState("domcontentloaded");

    // Spy on canvas context acquisition BEFORE the app boots restty, so we can
    // report which renderer backend actually won. addInitScript persists across
    // the reload below.
    await page.addInitScript(() => {
      window.volliCtxSpy = [];
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        const ctx = orig.call(this, type, ...rest);
        window.volliCtxSpy.push({ type, ok: ctx != null });
        return ctx;
      };
    });

    // Seed two workspaces + select alpha, then reload so persisted state (and
    // the getContext spy) take effect from a clean boot.
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

    // === 1. Workspace A: open Sessions, get a terminal, probe cwd ===========
    await page.getByText("Sessions", { exact: true }).click();
    await waitForLiveCanvas(page); // first-visit auto-creates a session
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
    // Nav is remembered per-workspace and defaults to Board, so a fresh
    // workspace opens on Board — click Sessions to reveal its terminal surface.
    await page.getByText("BC", { exact: true }).click(); // Beta Cove monogram
    await page.getByText("Sessions", { exact: true }).click();
    await waitForLiveCanvas(page); // auto-creates beta's first session
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
    await page.getByText("Sessions", { exact: true }).click();
    await waitForLiveCanvas(page);
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

    // === 4. Keep-alive across nav: A → Board → Sessions, history intact =====
    await page.getByText("Board", { exact: true }).click();
    await sleep(500);
    await page.getByText("Sessions", { exact: true }).click();
    await waitForLiveCanvas(page);
    const aTabs3 = await tabCount(page);
    await focusTerminal(page);
    // No re-cd: if the same shell survived, $PWD is still ws-alpha.
    await runInTerminal(page, `echo third-$PWD >> ${probeA}`);
    const aThird = await waitForFileContains(probeA, `third-${alphaDir}`);
    await page.screenshot({ path: shot("04-after-nav-return.png") });
    check(
      4,
      "Keep-alive across nav (Board↔Sessions): same shell, cwd intact",
      aThird !== null && aThird.includes(`third-${alphaDir}`) && aTabs3 === 1,
      `tabs=${aTabs3}`,
    );

    // === 5. Second tab in A: "+" → two tabs, each its own live shell ========
    await page.getByLabel("New session").click();
    await page.waitForFunction(
      () => document.querySelectorAll('[aria-label^="Close Terminal"]').length === 2,
      { timeout: 10000 },
    );
    await waitForLiveCanvas(page); // tab 2 becomes active on create
    const aTabs4 = await tabCount(page);
    await page.screenshot({ path: shot("05-two-tabs.png") });

    // Probe from the freshly-focused tab 2.
    await focusTerminal(page);
    await runInTerminal(page, `echo tab2-$PWD > ${probeA2}`);
    const a2Text = await waitForFileContains(probeA2, alphaDir);

    // Switch back to tab 1 and confirm ITS shell still responds.
    await page.getByText("Terminal 1", { exact: true }).click();
    await sleep(600);
    await focusTerminal(page);
    await runInTerminal(page, `echo tab1again-$PWD >> ${probeA}`);
    const a1Again = await waitForFileContains(probeA, `tab1again-${alphaDir}`);
    check(
      5,
      "Second tab in A: two live shells, tab2 cwd ok, tab1 still responds",
      a2Text !== null &&
        a2Text.includes(`tab2-${alphaDir}`) &&
        aTabs4 === 2 &&
        a1Again !== null &&
        a1Again.includes(`tab1again-${alphaDir}`),
      `tabs=${aTabs4}`,
    );

    // === 6. Split panes: each leaf owns an independent shell + renderer ====
    // This is the architecture boundary used by Ghostty/cmux: splitting a
    // surface creates a fresh terminal surface/PTY. A second canvas wired to
    // the original PTY is not a split — input/output from both panes aliases.
    await runInTerminal(page, `echo $$ > ${splitRootPid}`);
    await waitForFileContains(splitRootPid, "", 3000);
    await page.keyboard.press("Meta+d");
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll("canvas")).filter(
          (canvas) =>
            canvas.offsetParent !== null && canvas.clientWidth > 0 && canvas.clientHeight > 0,
        ).length === 2,
      { timeout: 10000 },
    );
    await sleep(800);
    await focusTerminalAt(page, 1);
    await runInTerminal(page, `echo $$ > ${splitChildPid}`);
    const rootPid = (await waitForFileContains(splitRootPid, "", 3000))?.trim() ?? null;
    const childPid = (await waitForFileContains(splitChildPid, "", 5000))?.trim() ?? null;
    await page.screenshot({ path: shot("06-independent-split.png") });
    check(
      6,
      "Split right: two visible panes own two independent shell sessions",
      rootPid !== null && childPid !== null && rootPid !== childPid,
      `rootPid=${JSON.stringify(rootPid)} childPid=${JSON.stringify(childPid)}`,
    );

    // === 7. Keyboard split focus: Cmd+Option+arrows route input spatially ===
    await page.keyboard.press("Meta+Alt+ArrowLeft");
    await sleep(300);
    await runInTerminal(page, `echo $$ > ${focusedLeftPid}`);
    const leftFocusedPid = (await waitForFileContains(focusedLeftPid, "", 5000))?.trim() ?? null;
    await page.keyboard.press("Meta+Alt+ArrowRight");
    await sleep(300);
    await runInTerminal(page, `echo $$ > ${focusedRightPid}`);
    const rightFocusedPid = (await waitForFileContains(focusedRightPid, "", 5000))?.trim() ?? null;
    check(
      7,
      "Cmd+Option+arrow keys move focus and route input to the adjacent split",
      leftFocusedPid === rootPid && rightFocusedPid === childPid,
      `left=${JSON.stringify(leftFocusedPid)} right=${JSON.stringify(rightFocusedPid)}`,
    );

    // === 8. Pane-local font zoom: focused grid changes, sibling/UI don't ===
    await focusTerminalAt(page, 0);
    await runInTerminal(page, `stty size > ${rootGridBeforePath}`);
    const rootGridBefore =
      (await waitForFileContains(rootGridBeforePath, "", 5000))?.trim() ?? null;
    await focusTerminalAt(page, 1);
    await runInTerminal(page, `stty size > ${childGridBeforePath}`);
    const childGridBefore =
      (await waitForFileContains(childGridBeforePath, "", 5000))?.trim() ?? null;
    const chromeBefore = await page.evaluate(() => ({
      dpr: window.devicePixelRatio,
      sessionsFontSize: getComputedStyle(
        Array.from(document.querySelectorAll("*")).find(
          (element) => element.textContent === "Sessions" && element.children.length === 0,
        ),
      ).fontSize,
    }));

    await page.keyboard.press("Meta+Equal");
    await sleep(1000);
    await runInTerminal(page, `stty size > ${childGridAfterPath}`);
    const childGridAfter =
      (await waitForFileContains(childGridAfterPath, "", 5000))?.trim() ?? null;
    await focusTerminalAt(page, 0);
    await runInTerminal(page, `stty size > ${rootGridAfterPath}`);
    const rootGridAfter = (await waitForFileContains(rootGridAfterPath, "", 5000))?.trim() ?? null;
    const chromeAfter = await page.evaluate(() => ({
      dpr: window.devicePixelRatio,
      sessionsFontSize: getComputedStyle(
        Array.from(document.querySelectorAll("*")).find(
          (element) => element.textContent === "Sessions" && element.children.length === 0,
        ),
      ).fontSize,
    }));
    const [childRowsBefore, childColsBefore] = terminalGrid(childGridBefore);
    const [childRowsAfter, childColsAfter] = terminalGrid(childGridAfter);
    check(
      8,
      "Cmd+ zooms only the focused split pane, not its sibling or Volli chrome",
      childRowsAfter < childRowsBefore &&
        childColsAfter < childColsBefore &&
        rootGridAfter === rootGridBefore &&
        JSON.stringify(chromeAfter) === JSON.stringify(chromeBefore),
      `child=${childGridBefore}→${childGridAfter} root=${rootGridBefore}→${rootGridAfter} chrome=${JSON.stringify(chromeAfter)}`,
    );

    // === 9. Renderer backend =================================================
    backendReport = await page.evaluate(() => {
      const ctx = window.volliCtxSpy || [];
      return {
        webgpu: ctx.some((c) => c.type === "webgpu" && c.ok),
        webgl2: ctx.some((c) => c.type === "webgl2" && c.ok),
        navigatorGpu: typeof navigator.gpu !== "undefined",
      };
    });
    check(
      9,
      "Renderer is a real GPU canvas backend",
      backendReport.webgpu || backendReport.webgl2,
      `webgpu=${backendReport.webgpu} webgl2=${backendReport.webgl2} navigator.gpu=${backendReport.navigatorGpu}`,
    );

    // === 10. Mouse reporting reaches the PTY ================================
    // The probe enables DECSET 1000 + SGR 1006 and records raw stdin bytes.
    // This is the same protocol Claude Code's TUI relies on for clickable UI
    // and wheel input; checking the PTY bytes avoids canvas/OCR ambiguity.
    await focusTerminalAt(page, 0);
    await runInTerminal(
      page,
      `node ${join(APP_DIR, "e2e", "mouse-report-probe.mjs")} ${mouseReportPath} ${mouseReadyPath}`,
    );
    await waitForFileContains(mouseReadyPath, "ready", 5000);
    // The readiness file is written immediately after stdout.write(DECSET),
    // while node-pty batches output for up to one frame. Wait until restty has
    // consumed the mode sequences before generating pointer input.
    await sleep(250);
    // Target the SAME canvas focusTerminalAt(page, 0) just focused — the probe
    // runs in that pane, so pointer input must land there too.
    const mouseBox = await visibleCanvasPointAt(page, 0, 0.7, 0.6);
    await page.mouse.click(mouseBox.x, mouseBox.y);
    await page.mouse.wheel(0, 180);
    const mouseHex = await waitForFileContains(mouseReportPath, "1b5b3c", 5000);
    await page.keyboard.press("Control+c");
    await sleep(400);
    const hasMouseDown = /1b5b3c303b[0-9a-f]+4d/.test(mouseHex ?? "");
    const hasMouseWheel = /1b5b3c(?:3634|3635)3b[0-9a-f]+4d/.test(mouseHex ?? "");
    check(
      10,
      "Canvas click + wheel become SGR mouse reports at the PTY",
      hasMouseDown && hasMouseWheel,
      `down=${hasMouseDown} wheel=${hasMouseWheel} raw=${JSON.stringify(mouseHex?.trim() ?? null)}`,
    );

    // === 11. Normal-screen wheel scrolls restty's viewport ==================
    const readScrollHost = () =>
      page.evaluate(() => {
        const host = Array.from(document.querySelectorAll(".restty-native-scroll-host")).find(
          (element) => element.offsetParent !== null,
        );
        return host ? { top: host.scrollTop, max: host.scrollHeight - host.clientHeight } : null;
      });
    await runInTerminal(page, "seq 1 500");
    await sleep(1000);
    const scrollBefore = await readScrollHost();
    await page.mouse.move(mouseBox.x, mouseBox.y);
    await page.mouse.wheel(0, -600);
    await sleep(300);
    const scrollAfter = await readScrollHost();
    check(
      11,
      "Wheel scrolls ordinary terminal scrollback",
      scrollBefore !== null && scrollAfter !== null && scrollAfter.top < scrollBefore.top,
      `before=${JSON.stringify(scrollBefore)} after=${JSON.stringify(scrollAfter)}`,
    );

    // Keep a visual artifact for the ambiguous-symbol presentation regression:
    // U+23FA must use the active ANSI green from the text font, not Apple's
    // blue color-emoji glyph. The pure transformer has deterministic unit
    // coverage; this screenshot covers the actual GPU font-selection result.
    await runInTerminal(page, "printf '\\033[32m⏺\\033[0m symbol-probe\\n'");
    await page.mouse.move(mouseBox.x, mouseBox.y);
    await page.mouse.wheel(0, 100_000);
    await sleep(500);
    await page.screenshot({ path: shot("07-symbol-presentation.png") });
  } finally {
    await app.close();
  }

  // === 12. Clean teardown: no orphaned login shells =========================
  let after = loginShellCount();
  for (let i = 0; i < 20 && after > baseline; i++) {
    await sleep(250);
    after = loginShellCount();
  }
  check(
    12,
    "Clean teardown: no orphaned login shells after quit",
    after <= baseline,
    `baseline=${baseline} after=${after}`,
  );

  // Fatal renderer errors (WASM/CSP/data-URI) invalidate the whole run.
  const fatal = consoleErrors.filter((e) =>
    /wasm|WebAssembly|Content Security|CSP|data: URI|not base64|Refused to/i.test(e),
  );
  check(0, "No fatal renderer console errors (WASM/CSP)", fatal.length === 0, fatal.join(" | "));

  console.log("\nScreenshots:");
  console.log(`  ${join(SCRATCH, "01-workspace-a-terminal.png")}  — Workspace A live terminal`);
  console.log(`  ${join(SCRATCH, "02-workspace-b-terminal.png")}  — Workspace B live terminal`);
  console.log(`  ${join(SCRATCH, "04-after-nav-return.png")}      — A after Board↔Sessions nav`);
  console.log(`  ${join(SCRATCH, "05-two-tabs.png")}              — A with two session tabs`);
  console.log(`  ${join(SCRATCH, "06-independent-split.png")}      — two independent split panes`);
  console.log(`  ${join(SCRATCH, "07-symbol-presentation.png")}     — U+23FA text presentation`);
  console.log(
    `\nRenderer backend: ${backendReport.webgpu ? "WebGPU" : backendReport.webgl2 ? "WebGL2" : "UNKNOWN"}` +
      ` (webgpu=${backendReport.webgpu} webgl2=${backendReport.webgl2} navigator.gpu=${backendReport.navigatorGpu})`,
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
