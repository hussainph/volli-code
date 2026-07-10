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
  for (const p of [probeA, probeB, probeA2]) await fs.rm(p, { force: true });

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

    // === 7. Renderer backend =================================================
    backendReport = await page.evaluate(() => {
      const ctx = window.volliCtxSpy || [];
      return {
        webgpu: ctx.some((c) => c.type === "webgpu" && c.ok),
        webgl2: ctx.some((c) => c.type === "webgl2" && c.ok),
        navigatorGpu: typeof navigator.gpu !== "undefined",
      };
    });
    check(
      7,
      "Renderer is a real GPU canvas backend",
      backendReport.webgpu || backendReport.webgl2,
      `webgpu=${backendReport.webgpu} webgl2=${backendReport.webgl2} navigator.gpu=${backendReport.navigatorGpu}`,
    );
  } finally {
    await app.close();
  }

  // === 8. Clean teardown: no orphaned login shells ==========================
  let after = loginShellCount();
  for (let i = 0; i < 20 && after > baseline; i++) {
    await sleep(250);
    after = loginShellCount();
  }
  check(
    8,
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
