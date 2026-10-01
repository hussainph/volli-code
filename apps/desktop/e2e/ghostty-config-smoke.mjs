/**
 * End-to-end acceptance smoke for the Ghostty config adapter (issue #18).
 * Drives the REAL packaged renderer through Playwright against an ISOLATED
 * $HOME (so the owner's actual Ghostty config never interferes and is never
 * touched) and asserts the three acceptance criteria:
 *
 *   1. `theme = "Smoke Probe"` in the config, with a matching theme FILE in the
 *      user's own `~/.config/ghostty/themes/` → a fresh session renders in that
 *      file's colors.
 *
 *      The theme is written into the isolated $HOME by this script rather than
 *      named out of a bundled catalog (VC-413): the app ships no theme catalog,
 *      and the user's own disk is now the only place terminal theme colors come
 *      from. That makes this criterion a stronger test than it was — it exercises
 *      the theme-directory probe in `main/ghostty-config.ts` end to end, instead
 *      of a name lookup in a table.
 *   2. Editing the config file re-themes LIVE terminals without a restart
 *      (fs.watch → IPC push → applyAppearance).
 *   3. `macos-option-as-alt = left` → Option-left+b produces ESC-prefixed
 *      input, proven by piping raw stdin through `od -c` into a probe file.
 *
 * The colors are READ OFF THE DOM (VC-107): xterm's DOM renderer writes the
 * theme background onto the `.xterm` element and the foreground onto
 * `.xterm-rows`, so the assertion is the exact color the theme names. It used
 * to screenshot a patch of the GPU canvas and average the pixels, which is why
 * this probe was quarantined as flaky — a sample taken before first paint read
 * the window's own background and failed for reasons that had nothing to do
 * with the config chain. A DOM read cannot be early: the attribute is either
 * the theme's color or it is not there yet.
 *
 * A fourth check went with that renderer: GPU device-loss recovery, which
 * crashed the shared GPU process and asserted the session rotation that
 * rebuilt every terminal. The DOM renderer has no device to lose, and the
 * rotation machinery is deleted.
 *
 * Like terminal-smoke.mjs this is a MANUALLY-RUN smoke (display + built app):
 *
 *   pnpm run build
 *   node apps/desktop/e2e/ghostty-config-smoke.mjs
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { launch as launchSmokeApp } from "./lib/smoke-kit.mjs";

const SCRATCH =
  process.env.VOLLI_SMOKE_DIR ?? (await fs.mkdtemp(join(os.tmpdir(), "volli-ghostty-smoke-")));
await fs.mkdir(SCRATCH, { recursive: true });
console.log("scratch:", SCRATCH, "\n");

/**
 * The theme this smoke writes into the isolated $HOME, and the colors it names.
 * Its own values, owned by this file — a theme read off the user's disk is the
 * whole point of criterion 1, so inventing one here is more honest than
 * borrowing somebody's.
 */
const PROBE_THEME = "Smoke Probe";
const PROBE_THEME_FILE = "background = #1b2f3a\nforeground = #c8d8e0\n";
const PROBE_BG = "rgb(27, 47, 58)";
const PROBE_FG = "rgb(200, 216, 224)";
// The loud live-reload override, unmistakable against the theme above.
const LIVE_BG = "rgb(119, 34, 170)";

const results = [];
function check(n, label, ok, detail = "") {
  const status = ok ? "PASS" : "FAIL";
  results.push({ n, ok });
  console.log(`  [${status}] ${n}. ${label}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- terminal helpers (mirrors terminal-smoke.mjs) ---------------------------

async function focusTerminal(page) {
  const box = await visibleTerminalBox(page);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(200);
}

async function visibleTerminalBox(page) {
  const box = await page.evaluate(() => {
    const visible = Array.from(document.querySelectorAll(".xterm")).find(
      (element) =>
        element.offsetParent !== null && element.clientWidth > 0 && element.clientHeight > 0,
    );
    if (!visible) return null;
    const rect = visible.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  if (!box) throw new Error("no visible terminal");
  return box;
}

/**
 * The colors the visible terminal is actually rendering with. xterm's DOM
 * renderer puts the theme background on the `.xterm` element itself and the
 * theme foreground on `.xterm-rows`, so these are the theme's own values as
 * the browser resolved them — not an average of whatever happened to be
 * painted when a screenshot was taken.
 */
async function terminalColors(page) {
  return page.evaluate(() => {
    const terminal = Array.from(document.querySelectorAll(".xterm")).find(
      (element) =>
        element.offsetParent !== null && element.clientWidth > 0 && element.clientHeight > 0,
    );
    if (!terminal) return null;
    const rows = terminal.querySelector(".xterm-rows");
    return {
      background: getComputedStyle(terminal).backgroundColor,
      foreground: rows === null ? null : getComputedStyle(rows).color,
    };
  });
}

/** Poll until the terminal's background is `expected`; returns the last read. */
async function waitForTerminalBackground(page, expected, timeoutMs = 8000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await terminalColors(page);
    if (last?.background === expected) return last;
    await sleep(250);
  }
  return last;
}

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
  await sleep(2200); // let the shell boot, resolve fonts, and paint
}

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

// ---- main --------------------------------------------------------------------

async function main() {
  // Isolated $HOME: the app reads $XDG_CONFIG_HOME/ghostty/config and
  // ~/Library/Application Support/... via os.homedir(), both of which honor
  // these env overrides — the owner's real config stays untouched.
  const home = await fs.realpath(await fs.mkdtemp(join(SCRATCH, "home-")));
  const ghosttyDir = join(home, ".config", "ghostty");
  await fs.mkdir(ghosttyDir, { recursive: true });
  const configPath = join(ghosttyDir, "config");
  // The user's own theme file, in the directory ghostty itself probes — the
  // only place a named theme resolves from now (VC-413).
  await fs.mkdir(join(ghosttyDir, "themes"), { recursive: true });
  await fs.writeFile(join(ghosttyDir, "themes", PROBE_THEME), PROBE_THEME_FILE);
  await fs.writeFile(configPath, `theme = "${PROBE_THEME}"\nmacos-option-as-alt = left\n`);

  const wsDir = await fs.realpath(await fs.mkdtemp(join(SCRATCH, "ws-")));
  const probe = join(SCRATCH, "alt-probe.txt");
  await fs.rm(probe, { force: true });

  // `--user-data-dir` relocates Electron's profile, which the HOME override
  // alone does NOT do on macOS. Two things depend on it. The app would
  // otherwise open the real <userData>/volli.db, whose non-empty state makes
  // bootstrap's firstRun false and skips the localStorage import this smoke's
  // project seeding relies on — VOLLI_DB_PATH answers that on its own. The
  // second is why the flag is here: the single-instance lock is keyed on the
  // profile, so sharing it with a running `pnpm dev` made this smoke quit at
  // launch with exit code 0 and no window. It now runs alongside the dev app,
  // the same way the other smokes do (see lib/smoke-kit.mjs `launch`).
  const userDataDir = join(home, "user-data");
  await fs.mkdir(userDataDir, { recursive: true });

  const app = await launchSmokeApp({
    dbPath: join(userDataDir, "volli.db"),
    userDataDir,
    extraEnv: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
    },
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    await page.evaluate((path) => {
      localStorage.setItem(
        "volli:projects",
        JSON.stringify({
          state: {
            projects: [
              {
                id: "ws-ghostty",
                name: "Ghostty Config",
                path,
                ticketPrefix: "GHO",
                colorIndex: 0,
                createdAt: Date.now(),
              },
            ],
            selectedProjectId: "ws-ghostty",
          },
          version: 1,
        }),
      );
    }, wsDir);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    // === 1. Fresh session renders in the user's own theme file ==============
    // The surface's default Session is a structured chat (which, with no
    // default model in this profile, refuses into the empty state), so the
    // terminal under test is minted explicitly through the session-start
    // control's caret. `.first()` because an empty surface mounts the control
    // twice (tab strip + empty state).
    await page.getByText("Home", { exact: true }).click();
    await page.getByLabel("Other things to open").first().click();
    await page.getByRole("menuitem", { name: /^Terminal/ }).click();
    await waitForLiveTerminal(page);
    const bootColors = await waitForTerminalBackground(page, PROBE_BG);
    check(
      1,
      `theme = "${PROBE_THEME}" resolved from the user's own themes directory on boot`,
      bootColors?.background === PROBE_BG && bootColors.foreground === PROBE_FG,
      `bg=${bootColors?.background ?? "n/a"} fg=${bootColors?.foreground ?? "n/a"} expected bg=${PROBE_BG} fg=${PROBE_FG}`,
    );

    // === 2. Config edit re-themes the LIVE terminal, no restart =============
    await fs.writeFile(
      configPath,
      `theme = "${PROBE_THEME}"\nbackground = #7722aa\nmacos-option-as-alt = left\n`,
    );
    // fs.watch debounces 250ms; poll the rendered color rather than sleeping.
    const liveColors = await waitForTerminalBackground(page, LIVE_BG);
    check(
      2,
      "config edit re-themes the live terminal (fs.watch → push → applyAppearance)",
      liveColors?.background === LIVE_BG,
      `bg=${liveColors?.background ?? "n/a"} expected=${LIVE_BG}`,
    );

    // === 3. Option-left+b emits ESC b (macos-option-as-alt = left) ==========
    await focusTerminal(page);
    // `od -c` prints raw stdin bytes; ESC renders as octal 033. Canonical-mode
    // buffering flushes on the Ctrl+D EOF.
    await page.keyboard.type(`od -c > ${probe}`);
    await page.keyboard.press("Enter");
    await sleep(600);
    await page.keyboard.press("Alt+b");
    await sleep(300);
    await page.keyboard.press("Control+d");
    await page.keyboard.press("Control+d"); // second EOF ends od when line isn't empty
    const odText = await waitForFileContains(probe, "033");
    check(
      3,
      "Option-left+b produces ESC-prefixed input (od sees 033 b)",
      odText !== null && odText.includes("033") && /033\s+b/.test(odText),
      `od=${JSON.stringify(odText?.split("\n")[0] ?? null)}`,
    );

    await page.screenshot({ path: join(SCRATCH, "03-final.png") });
  } finally {
    await app.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed` +
      (failed.length ? ` — FAILED: ${failed.map((f) => f.n).join(", ")}` : ""),
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
