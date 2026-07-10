/**
 * End-to-end acceptance smoke for the Ghostty config adapter (issue #18).
 * Drives the REAL packaged renderer through Playwright against an ISOLATED
 * $HOME (so the owner's actual Ghostty config never interferes and is never
 * touched) and asserts the three acceptance criteria:
 *
 *   1. `theme = "Front End Delight"` in the config → a fresh session renders
 *      in that theme's colors (canvas pixels, not DOM — the terminal is a
 *      WebGPU canvas, so we screenshot a patch of empty background).
 *   2. Editing the config file re-themes LIVE terminals without a restart
 *      (fs.watch → IPC push → applyTheme).
 *   3. `macos-option-as-alt = left` → Option-left+b produces ESC-prefixed
 *      input, proven by piping raw stdin through `od -c` into a probe file.
 *
 * Plus one check beyond issue #18: GPU device-loss recovery. A hidden window
 * loading chrome://gpucrash kills the shared GPU process for real; the app
 * must rotate its restty session, rebuild the renderer (a fresh WebGPU
 * context), toast the user, and keep both the pixels and the shell alive.
 *
 * Like terminal-smoke.mjs this is a MANUALLY-RUN smoke (display + built app):
 *
 *   pnpm -C apps/desktop run build
 *   node apps/desktop/e2e/ghostty-config-smoke.mjs
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import zlib from "node:zlib";
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

const SCRATCH =
  process.env.VOLLI_SMOKE_DIR ?? (await fs.mkdtemp(join(os.tmpdir(), "volli-ghostty-smoke-")));
await fs.mkdir(SCRATCH, { recursive: true });
console.log("scratch:", SCRATCH, "\n");

// Front End Delight's background per restty's builtin catalog.
const FED_BG = { r: 27, g: 28, b: 29 };
// The app's token fallback background (--background #111111).
const TOKEN_BG = { r: 17, g: 17, b: 17 };
// The loud live-reload override, unmistakable against both of the above.
const LIVE_BG = { r: 0x77, g: 0x22, b: 0xaa };

const results = [];
function check(n, label, ok, detail = "") {
  const status = ok ? "PASS" : "FAIL";
  results.push({ n, ok });
  console.log(`  [${status}] ${n}. ${label}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- minimal PNG decode (Playwright screenshots: 8-bit RGBA, no interlace) --

/** Average color of every pixel in a small screenshot PNG buffer. */
function averagePngColor(buffer) {
  let pos = 8; // skip signature
  let width = 0;
  let height = 0;
  let bpp = 4;
  const idat = [];
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString("ascii", pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      const interlace = data[12];
      // 6 = RGBA, 2 = RGB — Playwright emits either depending on the surface.
      if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) {
        throw new Error(`unexpected PNG format: depth=${bitDepth} color=${colorType}`);
      }
      bpp = colorType === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      idat.push(data);
    }
    pos += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const prior = Buffer.alloc(stride);
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    // Unfilter in place (per PNG spec).
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prior[x];
      const c = x >= bpp ? prior[x - bpp] : 0;
      let value = line[x];
      if (filter === 1) value = (value + a) & 0xff;
      else if (filter === 2) value = (value + b) & 0xff;
      else if (filter === 3) value = (value + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value = (value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      line[x] = value;
    }
    line.copy(prior);
    for (let x = 0; x < stride; x += bpp) {
      sumR += line[x];
      sumG += line[x + 1];
      sumB += line[x + 2];
    }
  }
  const count = width * height;
  return { r: sumR / count, g: sumG / count, b: sumB / count };
}

const colorDistance = (a, b) =>
  Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
const fmt = (c) => `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`;

// ---- terminal helpers (mirrors terminal-smoke.mjs) ---------------------------

async function focusTerminal(page) {
  const box = await visibleCanvasBox(page);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(200);
}

async function visibleCanvasBox(page) {
  const box = await page.evaluate(() => {
    const visible = Array.from(document.querySelectorAll("canvas")).find(
      (c) => c.offsetParent !== null && c.clientWidth > 0 && c.clientHeight > 0,
    );
    if (!visible) return null;
    const r = visible.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  if (!box) throw new Error("no visible terminal canvas");
  return box;
}

/**
 * Average color of an empty-background patch of the visible terminal: a
 * square inset from the bottom-right corner, far from prompt text (top-left)
 * and from the scrollbar edge.
 */
async function terminalBackgroundColor(page, shotPath) {
  const box = await visibleCanvasBox(page);
  const clip = {
    x: box.x + box.width - 120,
    y: box.y + box.height - 120,
    width: 80,
    height: 80,
  };
  const buffer = await page.screenshot({ clip, path: shotPath });
  return averagePngColor(buffer);
}

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
  await sleep(2200); // let restty boot the shell, resolve fonts, and paint
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
  // The owner's real config, verbatim (acceptance criterion 1).
  await fs.writeFile(configPath, 'theme = "Front End Delight"\nmacos-option-as-alt = left\n');

  const wsDir = await fs.realpath(await fs.mkdtemp(join(SCRATCH, "ws-")));
  const probe = join(SCRATCH, "alt-probe.txt");
  await fs.rm(probe, { force: true });

  const app = await _electron.launch({
    executablePath: ELECTRON,
    args: [APP_DIR],
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
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
    // Spy on canvas context acquisition from the next load onward, so the
    // device-loss check can prove a NEW webgpu context was created on rebuild.
    await page.addInitScript(() => {
      window.volliCtxSpy = [];
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        const ctx = orig.call(this, type, ...rest);
        window.volliCtxSpy.push({ type, ok: ctx != null });
        return ctx;
      };
    });
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    // === 1. Fresh session renders in Front End Delight ======================
    await page.getByText("Sessions", { exact: true }).click();
    await waitForLiveCanvas(page);
    const bootColor = await terminalBackgroundColor(page, join(SCRATCH, "01-fed.png"));
    const fedDistance = colorDistance(bootColor, FED_BG);
    check(
      1,
      'theme = "Front End Delight" applied on boot',
      fedDistance <= 5 && fedDistance < colorDistance(bootColor, TOKEN_BG),
      `bg=${fmt(bootColor)} expected≈${fmt(FED_BG)} (token fallback ${fmt(TOKEN_BG)})`,
    );

    // === 2. Config edit re-themes the LIVE terminal, no restart =============
    await fs.writeFile(
      configPath,
      'theme = "Front End Delight"\nbackground = #7722aa\nmacos-option-as-alt = left\n',
    );
    // fs.watch debounce is 250ms; poll the pixels rather than sleeping blind.
    let liveColor = null;
    let rethemed = false;
    const start = Date.now();
    while (Date.now() - start < 8000) {
      liveColor = await terminalBackgroundColor(page, join(SCRATCH, "02-live.png"));
      // Runtime applyTheme paints through restty's linear-space blend, which
      // rounds a few units off the exact sRGB value — unlike the init path.
      if (colorDistance(liveColor, LIVE_BG) <= 16) {
        rethemed = true;
        break;
      }
      await sleep(400);
    }
    check(
      2,
      "config edit re-themes the live terminal (fs.watch → push → applyTheme)",
      rethemed,
      `bg=${liveColor ? fmt(liveColor) : "n/a"} expected≈${fmt(LIVE_BG)}`,
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

    // === 4. GPU device loss: session rotates, renderer rebuilds, shell lives =
    const webgpuCtxCount = () =>
      page.evaluate(() => window.volliCtxSpy.filter((e) => e.type === "webgpu" && e.ok).length);
    const ctxBefore = await webgpuCtxCount();
    // Crash the REAL shared GPU process from a throwaway hidden window.
    await app.evaluate(({ BrowserWindow }) => {
      const crasher = new BrowserWindow({ show: false });
      void crasher.loadURL("chrome://gpucrash");
    });

    let toastSeen = false;
    try {
      await page
        .getByText("Display driver reset", { exact: false })
        .first()
        .waitFor({ timeout: 15000 });
      toastSeen = true;
    } catch {
      // fall through — the ctx/pixel/shell assertions below still report
    }
    let rebuilt = false;
    try {
      await page.waitForFunction(
        (n) => window.volliCtxSpy.filter((e) => e.type === "webgpu" && e.ok).length > n,
        ctxBefore,
        { timeout: 15000 },
      );
      rebuilt = true;
    } catch {
      // reported below
    }
    // Poll the pixels: the rebuilt renderer re-resolves fonts via Local Font
    // Access and repaints over a few seconds after the GPU process restarts.
    let postCrashColor = { r: -1, g: -1, b: -1 };
    let pixelsAlive = false;
    const crashStart = Date.now();
    while (Date.now() - crashStart < 12000) {
      postCrashColor = await terminalBackgroundColor(page, join(SCRATCH, "04-post-crash.png"));
      if (colorDistance(postCrashColor, LIVE_BG) <= 16) {
        pixelsAlive = true;
        break;
      }
      await sleep(500);
    }

    // The shell (main-process PTY) must be untouched: run a fresh probe.
    const crashProbe = join(SCRATCH, "crash-probe.txt");
    await fs.rm(crashProbe, { force: true });
    await focusTerminal(page);
    await page.keyboard.type(`echo alive > ${crashProbe}`);
    await page.keyboard.press("Enter");
    const crashText = await waitForFileContains(crashProbe, "alive");
    check(
      4,
      "GPU crash: toast + renderer rebuilt (new WebGPU ctx) + pixels + shell alive",
      toastSeen && rebuilt && pixelsAlive && crashText !== null,
      `toast=${toastSeen} rebuilt=${rebuilt} bg=${fmt(postCrashColor)} shell=${crashText !== null}`,
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
