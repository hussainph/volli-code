/**
 * VC-291 — deterministic terminal reflow matrix.
 *
 * Executes the ticket's reflow matrix against the REAL built app (Restty canvas
 * renderer, live PTY), exactly as the manually-run e2e smokes drive it: text is
 * typed into the focused canvas and asserted through shell side effects, while
 * renderer-side state is read from the DOM (`.restty-native-scroll-host`) and
 * captured as screenshots for visual marker verification.
 *
 * Cases (each on a newly seeded pane, `--runs` times):
 *   control   — wait 10s, no layout change.
 *   resize    — wide↔narrow window ×3 legs each, then restore.
 *   focus     — enter/leave terminal focus 10× (⌥⌘Return) on a TICKET terminal
 *               (the audit's observed path: ticket-detail.tsx refit).
 *   hsplit    — Shift-⌘-D split, divider dragged 25/50/75% and back, ×3.
 *   vsplit    — ⌘-D split, same drag matrix.
 *   hideshow  — Home terminal tab ↔ Board ×10, then terminal tab ↔ terminal
 *               tab ×10 (HOME surface), plus a ticket detail ↔ board variant.
 *   gpu       — only with --webgl2: ≥17 live terminals, then the focus and
 *               hideshow actions repeated. The WebGL2 fallback is FORCED by
 *               stubbing navigator.gpu in an init script — there is no
 *               checked-in launcher (harness gap, filed with VC-291).
 *
 * Every checkpoint records: stty grid (typed in-pane), scroll host
 * {scrollTop, scrollHeight, clientHeight} of the SEEDED pane, devicePixelRatio,
 * visible canvas count, console-error count, and screenshots of the seeded
 * pane's scroll host at scrollTop=0 / 50% / max. The seed is the ticket's exact
 * REFLOW block (tee'd to /tmp/volli-reflow-<ts>.txt, kept).
 *
 *   Run:
 *     pnpm run build
 *     node apps/desktop/e2e/reflow-matrix-smoke.mjs <evidenceDir> [--cases=…] [--runs=N]
 *                                                     [--webgl2] [--surface=ticket|home]
 *
 * NOT wired into `vp test` — needs a display + the built app.
 */
import { execFile, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

import {
  APP_DIR,
  REPO,
  evidenceDir,
  launch,
  makeGitRepo,
  makeScratch,
  startTerminalSession,
  waitUntil,
} from "./lib/smoke-kit.mjs";

// ---- args -------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const EVIDENCE = resolve(argv.find((a) => !a.startsWith("--")) ?? evidenceDir("vc291-matrix"));
await fs.mkdir(EVIDENCE, { recursive: true });
const FORCE_WEBGL2 = flag("webgl2");
const RUNS = Number(opt("runs", "3"));
const SURFACE = opt("surface", "ticket"); // ticket | home
const PANES_PER_RUN = Number(opt("panes-per-run", "0")); // GPU-pressure row
const CASES = opt("cases", "control,resize,focus,hsplit,vsplit,hideshow")
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- tiny PNG decoder (RGBA/RGB, 8-bit, non-interlaced) ---------------------
// Used for the automated "ink at top of scrollback" signal so a lost
// REFLOW-BEGIN leaves a numeric trace, not only a screenshot to eyeball.

function decodePng(buf) {
  const b = buf;
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error("not a png");
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString("ascii", off + 4, off + 8);
    const data = b.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`unsupported png (depth=${bitDepth} color=${colorType} interlace=${interlace})`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  const bpp = channels;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const src = raw.subarray(rowStart, rowStart + stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const bb = prev ? prev[x] : 0;
      const c = x >= bpp && prev ? prev[x - bpp] : 0;
      let v = src[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + bb) & 0xff;
      else if (filter === 3) v = (v + ((a + bb) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + bb - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - bb);
        const pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? bb : c)) & 0xff;
      }
      cur[x] = v;
    }
  }
  return { width, height, channels, data: out };
}

/** Fraction of "ink" (non-background pixels) in the top `px` rows of a png. */
async function topInkRatio(path, px = 400) {
  try {
    const { width, height, channels, data } = decodePng(await fs.readFile(path));
    const rows = Math.min(px, height);
    let ink = 0;
    let total = 0;
    // Background is a near-uniform dark wash in the default theme; ink is any
    // pixel far from the modal colour. Modal over a sample grid is cheap and
    // theme-agnostic.
    const samples = [];
    for (let y = 0; y < rows; y += 7) {
      for (let x = 0; x < width; x += 11) {
        const i = (y * width + x) * channels;
        samples.push(`${data[i] >> 3},${data[i + 1] >> 3},${data[i + 2] >> 3}`);
      }
    }
    const modal = new Map();
    for (const s of samples) modal.set(s, (modal.get(s) ?? 0) + 1);
    let bestKey = "0,0,0";
    let bestN = -1;
    for (const [k, n] of modal) if (n > bestN) ((bestN = n), (bestKey = k));
    const [mr, mg, mb] = bestKey.split(",").map(Number);
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * channels;
        const d = Math.abs(data[i] - mr) + Math.abs(data[i + 1] - mg) + Math.abs(data[i + 2] - mb);
        if (d > 90) ink += 1;
        total += 1;
      }
    }
    return Number((ink / total).toFixed(5));
  } catch (error) {
    return `decode-failed: ${error.message}`;
  }
}

// ---- run metadata ------------------------------------------------------------

const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
const sys = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
};

const RUN_CONFIG = {
  ticket: "VC-291 reflow matrix",
  startedAt: new Date().toISOString(),
  commit: gitCommit,
  appVersion: JSON.parse(await fs.readFile(join(APP_DIR, "package.json"), "utf8")).version,
  macOS: sys("sw_vers", ["-productVersion"]),
  macOSBuild: sys("sw_vers", ["-buildVersion"]),
  displays: sys("system_profiler", ["SPDisplaysDataType"]),
  externalMonitorAttached: (sys("system_profiler", ["SPDisplaysDataType"]) ?? "").includes("Connection Type: HDMI") ||
    /Resolution:/gm.test((sys("system_profiler", ["SPDisplaysDataType"]) ?? "").replace(/Resolution:\s*2560 x 1600 Retina/, "")),
  shell: process.env.SHELL ?? "unknown",
  forcedBackend: FORCE_WEBGL2 ? "webgl2 (navigator.gpu stubbed via init script)" : "auto (production default)",
  cases: CASES,
  runsPerCase: RUNS,
  surface: SURFACE,
  node: process.version,
};
RUN_CONFIG.forcedBackend = FORCE_WEBGL2
  ? "webgl2 (navigator.gpu stubbed via init script)"
  : "auto (production default)";
RUN_CONFIG.fontWorkaround =
  "queryLocalFonts stubbed to serve real SFNSMono.ttf bytes (Local Font Access hangs under automation on this macOS/Electron combo; see harness header)";
await fs.writeFile(join(EVIDENCE, "run-config.json"), JSON.stringify(RUN_CONFIG, null, 2));

// The ticket's seed block, verbatim, plus one instrumentation line that
// reports the chosen reference-file path back to the harness.
const SEED_SCRIPT = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "volli-reflow-seed-")));
const SEED_PATH = join(SEED_SCRIPT, "seed.sh");
const BASELINE_POINTER = join(SEED_SCRIPT, "baseline-path.txt");
const READY_PROBE = join(SEED_SCRIPT, "ready.txt");
await fs.writeFile(
  SEED_PATH,
  `#!/bin/sh
log="/tmp/volli-reflow-$(date +%s).txt"
{
  printf 'REFLOW-BEGIN\\n'
  for n in $(seq -w 1 30); do
    printf 'REFLOW-SHORT-%s\\n' "$n"
    printf 'REFLOW-LONG-%s-' "$n"
    printf '%*s' 240 '' | tr ' ' x
    printf '-END\\n'
  done
  printf 'REFLOW-PWD-'; pwd
  printf 'REFLOW-END\\n'
} | tee "$log"
printf 'REFLOW-BASELINE=%s\\n' "$log"
printf '%s' "$log" > ${BASELINE_POINTER}
`,
);

// ---- app boot ----------------------------------------------------------------

const { scratch, cleanup, dbPath, userDataDir } = await makeScratch("vc291-matrix-");
const projectDir = await makeGitRepo(scratch, "project-");
const PROBE_FILE = join(EVIDENCE, "stty-probe.txt");
await fs.writeFile(PROBE_FILE, "");

const app = await launch({ dbPath, userDataDir });
const page = await app.firstWindow();
const consoleLog = [];
page.on("console", (m) => consoleLog.push({ t: Date.now(), type: m.type(), text: m.text() }));
page.on("pageerror", (e) => consoleLog.push({ t: Date.now(), type: "pageerror", text: e.message }));
await page.waitForLoadState("domcontentloaded");

// LOCAL FONT ACCESS WORKAROUND (recorded in run-config.json): on this
// macOS/Electron combination under Playwright, window.queryLocalFonts() never
// resolves — not with a quiet window, not with a focused one, not after user
// gestures — which wedges restty's init before any renderer exists (no GPU
// context, no painting, no input encoding; the repo's own terminal-smoke.mjs
// fails its keystroke checks for the same reason). The harness therefore serves
// restty the real system mono font bytes (SFNSMono.ttf) through a FontData-shaped
// stub, so the renderer runs with a real installed face. Everything downstream
// (WebGPU/WebGL2, VT parser, scrollback, refit, PTY) is production code.
const FONT_PATH = "/System/Library/Fonts/SFNSMono.ttf";
const fontB64 = execFileSync("base64", ["-i", FONT_PATH], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
}).trim();
await page.addInitScript(
  (b64) => {
    window.__VC291_FONT_B64 = b64;
    window.__VC291_FONT_FAMILIES = [
      "SF Mono",
      "Menlo",
      "Apple Symbols",
      "STIX Two Math",
      "Apple Color Emoji",
      "Monaco",
      "Courier New",
    ];
  },
  fontB64,
);
await page.addInitScript(() => {
  if (window.queryLocalFonts) {
    const b64 = window.__VC291_FONT_B64;
    const families = window.__VC291_FONT_FAMILIES;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    window.queryLocalFonts = async () =>
      families.map((family) => ({
        family,
        style: "Regular",
        weight: 400,
        blob: async () => new Blob([bytes.slice()], { type: "font/ttf" }),
      }));
  }
});

// Context spy (backend truth) + optional WebGL2 forcing, installed before the
// renderer boots restty — persists across the reload below. Same technique as
// terminal-smoke.mjs's spy.
await page.addInitScript(() => {
  window.volliCtxSpy = [];
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = orig.call(this, type, ...rest);
    window.volliCtxSpy.push({ type, ok: ctx != null });
    return ctx;
  };
});
if (FORCE_WEBGL2) {
  await page.addInitScript(() => {
    try {
      Object.defineProperty(Navigator.prototype, "gpu", { get: () => undefined, configurable: true });
    } catch {
      /* best effort */
    }
  });
}

await seedProject(page, { id: "vc291-project", name: "VC291", path: projectDir });

// Canonical window geometry so every run starts identically. Recorded, along
// with the display scale, in the run log.
const winInfo = await app.evaluate(({ BrowserWindow, screen }) => {
  const win = BrowserWindow.getAllWindows()[0];
  win.setContentSize(1280, 832);
  const b = win.getContentBounds();
  const display = screen.getDisplayMatching(b);
  return { x: b.x, y: b.y, width: b.width, height: b.height, scale: display.scaleFactor };
});
/** Seed the scratch project through the legacy-envelope import. smoke-kit's
 * `seedProjects` reloads the instant the envelope is written, which races this
 * app's first boot (the import never lands); the same write with a settle
 * delay before AND after the reload imports reliably, so that is what this
 * harness does. */
async function seedProject(page, project) {
  await sleep(1500); // let the app's first boot finish before the envelope lands
  await page.evaluate((p) => {
    localStorage.setItem(
      "volli:projects",
      JSON.stringify({
        state: {
          projects: [
            {
              id: p.id,
              name: p.name,
              path: p.path,
              ticketPrefix: "VC",
              colorIndex: 0,
              createdAt: Date.now(),
            },
          ],
          selectedProjectId: p.id,
        },
        version: 1,
      }),
    );
  }, project);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await waitUntil(
    "project import",
    async () => {
      const names = await page
        .evaluate(async () => {
          const boot = await window.api.data.bootstrap();
          return boot.ok ? boot.data.projects.map((p) => p.name) : null;
        })
        .catch(() => null);
      return names !== null && names.includes(project.name);
    },
    { timeout: 20000 },
  );
}

const MATRIX = { meta: { ...RUN_CONFIG, window: winInfo }, runs: [] };
const ev = (run, event) => {
  event.at = Date.now();
  run.events.push(event);
  console.log(
    `  [${run.case} r${run.run}] ${event.t}${event.grid ? ` grid=${event.grid}` : ""}${
      event.scroll ? ` scroll=${JSON.stringify(event.scroll)}` : ""
    }${event.note ? ` — ${event.note}` : ""}`,
  );
};

// ---- terminal plumbing ---------------------------------------------------------

async function visibleCanvasRects() {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("canvas"))
      .filter((c) => c.offsetParent !== null && c.clientWidth > 0 && c.clientHeight > 0)
      .map((c) => {
        const r = c.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })
      .toSorted((a, b) => a.y - b.y || a.x - b.x),
  );
}

async function focusCanvasAt(index = 0) {
  const rects = await visibleCanvasRects();
  const r = rects[index];
  if (!r) throw new Error(`visible canvas ${index} missing (count=${rects.length})`);
  await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
  await sleep(250);
  return r;
}

/** The seeded pane's scroll host state. `paneIndex` selects among visible
 * `[data-terminal-pane-id]` roots (spatial order); falls back to the single
 * `[data-terminal-renderer]` when a surface renders no pane ids. */
function readScrollHost(paneIndex = 0) {
  return page.evaluate((idx) => {
    let roots = Array.from(document.querySelectorAll("[data-terminal-pane-id]")).filter(
      (el) => el.offsetParent !== null,
    );
    if (roots.length === 0)
      roots = Array.from(document.querySelectorAll("[data-terminal-renderer]")).filter(
        (el) => el.offsetParent !== null,
      );
    roots = roots.toSorted(
      (a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y ||
        a.getBoundingClientRect().x - b.getBoundingClientRect().x,
    );
    const root = roots[idx];
    if (!root) return null;
    const host = root.querySelector(".restty-native-scroll-host");
    const renderer = root.matches("[data-terminal-renderer]")
      ? root
      : root.querySelector("[data-terminal-renderer]");
    const box = (host ?? renderer ?? root).getBoundingClientRect();
    return {
      paneId: root.getAttribute("data-terminal-pane-id") ?? root.getAttribute("data-terminal-renderer"),
      scrollTop: host ? host.scrollTop : null,
      scrollHeight: host ? host.scrollHeight : null,
      clientHeight: host ? host.clientHeight : null,
      clip: { x: box.x, y: box.y, width: box.width, height: box.height },
      dpr: window.devicePixelRatio,
    };
  }, paneIndex);
}

async function setScrollFraction(paneIndex, fraction) {
  await page.evaluate(
    ({ idx, f }) => {
      let roots = Array.from(document.querySelectorAll("[data-terminal-pane-id]")).filter(
        (el) => el.offsetParent !== null,
      );
      if (roots.length === 0)
        roots = Array.from(document.querySelectorAll("[data-terminal-renderer]")).filter(
          (el) => el.offsetParent !== null,
        );
      const host = roots[idx]?.querySelector(".restty-native-scroll-host");
      if (!host) return;
      host.scrollTop = Math.round(f * (host.scrollHeight - host.clientHeight));
    },
    { idx: paneIndex, f: fraction },
  );
  await sleep(280);
}

/** Scroll the pane to an absolute offset (px). */
async function setScrollTop(paneIndex, top) {
  await page.evaluate(
    ({ idx, t }) => {
      let roots = Array.from(document.querySelectorAll("[data-terminal-pane-id]")).filter(
        (el) => el.offsetParent !== null,
      );
      if (roots.length === 0)
        roots = Array.from(document.querySelectorAll("[data-terminal-renderer]")).filter(
          (el) => el.offsetParent !== null,
        );
      const host = roots[idx]?.querySelector(".restty-native-scroll-host");
      if (host) host.scrollTop = t;
    },
    { idx: paneIndex, t: top },
  );
  await sleep(260);
}

/** Scroll state + WHICH pane it came from: every claim about retained
 * scrollback has to name the pane it measured, or a newly-created terminal
 * that stole the active tab reads as "the seeded pane lost everything". */
const scrollOf = (host) =>
  host && {
    paneId: host.paneId,
    top: host.scrollTop,
    max: host.scrollHeight - host.clientHeight,
    height: host.scrollHeight,
    client: host.clientHeight,
  };

let probeLines = 0;

/** The ticket PTY spawns only after the worktree ensure() lands, and writes
 * before that fail with "Unknown terminal session" toasts. So typing sessions
 * start with a side-effect handshake: `echo … > ready`, poll the file, refocus
 * and retry. Returns once the shell provably executed input. */
async function waitShellReady(label) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await fs.rm(READY_PROBE, { force: true });
    await focusCanvasAt(0);
    await page.keyboard.type(`echo ready-${label}-${attempt} > ${READY_PROBE}`);
    await page.keyboard.press("Enter");
    const got = await waitUntil(
      `shell ready (${label} #${attempt})`,
      async () => {
        try {
          return (await fs.readFile(READY_PROBE, "utf8")).includes(`ready-${label}-`) || null;
        } catch {
          return null;
        }
      },
      { timeout: 6000 },
    ).catch(() => null);
    if (got) return true;
  }
  return false;
}
/** Type a REFLOW-CHECK line + `stty size` into the FOCUSED pane; returns grid. */
async function sttyCheck(run, tag, note) {
  await page.keyboard.type(`echo REFLOW-CHECK-${tag}; stty size | tee -a ${PROBE_FILE}`);
  await page.keyboard.press("Enter");
  const grid = await waitUntil(
    `stty probe ${tag}`,
    async () => {
      const text = await fs.readFile(PROBE_FILE, "utf8");
      const lines = text.trim().split("\n").filter((l) => /^\d+ \d+$/.test(l));
      if (lines.length > probeLines) {
        probeLines = lines.length;
        return lines[lines.length - 1];
      }
      return null;
    },
    { timeout: 6000 },
  ).catch(() => null);
  return grid ?? "NO-RESPONSE";
}

/** Marker needles for the ticket's expected lines; matched against OCR text
 * with all whitespace stripped (fast-mode OCR inserts occasional spaces). */
const MARKERS = {
  begin: "REFLOW-BEGIN",
  short01: "REFLOW-SHORT-01",
  short15: "REFLOW-SHORT-15",
  long15: "REFLOW-LONG-15",
  end15: "-END",
  pwd: "REFLOW-PWD-",
  end: "REFLOW-END",
};

/** OCR one screenshot and report which markers are present. */
async function ocrMarkers(path) {
  const text = await new Promise((resolve) => {
    execFile(
      "osascript",
      ["-l", "JavaScript", join(APP_DIR, "e2e", "lib", "ocr.js"), path],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 30000 },
      (e, out) => resolve(e ? "" : out),
    );
  });
  const flat = text.replace(/\s+/g, "");
  const found = {};
  for (const [k, needle] of Object.entries(MARKERS)) found[k] = flat.includes(needle.replace(/\s+/g, ""));
  return { found, textLength: text.length, text };
}

/**
 * WHOLE-scrollback verification: step the pane from top to bottom in
 * ~85%-viewport increments, screenshot + OCR every step, and union the markers
 * found. Three fixed sample positions cannot answer "is this line still
 * reachable by scrolling" once an action has changed the scrollback height —
 * and the ticket's own REFLOW-CHECK lines change it on every checkpoint — so
 * every checkpoint that carries a verdict uses this instead of a spot check.
 */
async function fullSweep(run, label, paneIndex = 0) {
  const host0 = await readScrollHost(paneIndex);
  if (!host0 || host0.scrollHeight === null) return { shots: [], markers: {}, steps: 0 };
  const max = Math.max(0, host0.scrollHeight - host0.clientHeight);
  const step = Math.max(80, Math.floor(host0.clientHeight * 0.85));
  const tops = [];
  for (let top = 0; top < max; top += step) tops.push(top);
  tops.push(max);

  const shots = [];
  const markers = {};
  const whereFound = {};
  for (const [i, top] of tops.entries()) {
    await setScrollTop(paneIndex, top);
    const host = await readScrollHost(paneIndex);
    const name = `${run.case}-r${run.run}-${label}-s${String(i).padStart(2, "0")}.png`;
    await page.screenshot({ path: join(EVIDENCE, name), clip: host?.clip });
    const ocr = await ocrMarkers(join(EVIDENCE, name));
    await fs.writeFile(join(EVIDENCE, `${name}.txt`), ocr.text).catch(() => {});
    shots.push({ name, requestedTop: top, actualTop: host?.scrollTop });
    for (const [k, v] of Object.entries(ocr.found)) {
      if (v && whereFound[k] === undefined) whereFound[k] = host?.scrollTop ?? top;
      markers[k] = markers[k] || v;
    }
  }
  await setScrollFraction(paneIndex, 1);
  return { shots, markers, whereFound, steps: tops.length, scrollMax: max };
}

/** Screenshots of the seeded pane's scroll host at top/middle/bottom, each
 * OCR-verified for the ticket's marker lines. Cheap spot check for the legs
 * between actions; verdict checkpoints use fullSweep. */
async function sweep(run, label, paneIndex = 0) {
  const shots = [];
  const foundAny = {};
  for (const [pos, f] of [
    ["top", 0],
    ["mid", 0.5],
    ["bottom", 1],
  ]) {
    await setScrollFraction(paneIndex, f);
    const host = await readScrollHost(paneIndex);
    const name = `${run.case}-r${run.run}-${label}-${pos}.png`;
    await page.screenshot({ path: join(EVIDENCE, name), clip: host?.clip });
    const ocr = await ocrMarkers(join(EVIDENCE, name));
    await fs.writeFile(join(EVIDENCE, `${name}.txt`), ocr.text).catch(() => {});
    shots.push({ pos, name, scrollTop: host?.scrollTop, topInk: await topInkRatio(join(EVIDENCE, name)) });
    for (const [k, v] of Object.entries(ocr.found)) foundAny[k] = foundAny[k] || v;
  }
  await setScrollFraction(paneIndex, 1);
  return { shots, markers: foundAny };
}

// ---- seeding -------------------------------------------------------------------

/** Index of the tab holding the pane this run seeded, so a row that opens more
 * terminals can come back to it. Creating a terminal can move the active tab,
 * and measuring the wrong pane reads as "the seeded pane lost everything". */
let seedTabIndex = -1;

/** Create a fresh terminal on the active surface, select its tab (the
 * ticket detail does not always auto-switch to the new session tab, which
 * leaves the pane hidden and its canvas at 0×0), and seed the REFLOW block. */
async function seedRun(caseName, runNo) {
  await startTerminalSession(SURFACE === "ticket" ? page.locator("aside") : page);
  if (SURFACE === "ticket") {
    const strip = page.getByRole("tablist", { name: "Ticket tabs" }).getByRole("tab");
    await waitUntil("session tab to appear", async () => (await strip.count()) >= 2, {
      timeout: 45000,
    });
    await strip.last().click();
    await sleep(400);
    seedTabIndex = (await strip.count()) - 1;
  }
  await waitUntil(
    "seed terminal canvas",
    async () => {
      const rects = await visibleCanvasRects();
      return rects.length >= 1;
    },
    { timeout: 20000 },
  );
  await sleep(2400); // restty boot: fonts, wasm, first paint

  const run = { case: caseName, run: runNo, surface: SURFACE, startedAt: new Date().toISOString(), events: [] };
  MATRIX.runs.push(run);

  const ready = await waitShellReady(`${caseName}${runNo}`);
  if (!ready) {
    ev(run, { t: "shell-not-ready" });
    throw new Error(`shell never accepted input (${caseName} r${runNo})`);
  }
  await page.keyboard.type(`sh ${SEED_PATH}`);
  await page.keyboard.press("Enter");
  const refFile = await waitUntil(
    "reference file written",
    async () => {
      try {
        return (await fs.readFile(BASELINE_POINTER, "utf8")).trim() || null;
      } catch {
        return null;
      }
    },
    { timeout: 15000 },
  );
  run.referenceFile = refFile ?? "MISSING";
  await sleep(600);

  // Backend truth — read AFTER this run's pane is live, so the spy has seen
  // a context acquisition; re-read per run so a mid-run rebuild is visible.
  const backendNow = await page.evaluate(() => {
    const ctx = window.volliCtxSpy ?? [];
    return {
      webgpu: ctx.some((c) => c.type === "webgpu" && c.ok),
      webgl2: ctx.some((c) => c.type === "webgl2" && c.ok),
      navigatorGpu: typeof navigator?.gpu !== "undefined",
    };
  });
  MATRIX.meta.backend = backendNow;
  console.log(`  [backend after seed] ${JSON.stringify(backendNow)}`);

  const host = await readScrollHost(0);
  run.seededPaneId = host?.paneId ?? null;
  ev(run, {
    t: "seed-post",
    grid: await sttyCheck(run, `${caseName}-${runNo}-seedpost`),
    scroll: scrollOf(host),
    dpr: host?.dpr,
    shots: await fullSweep(run, "seedpost"),
  });
  return run;
}

// ---- case actions ----------------------------------------------------------------

async function caseControl(run) {
  await sleep(10_000);
  const host = await readScrollHost(0);
  ev(run, {
    t: "post-10s",
    grid: await sttyCheck(run, `${run.case}-${run.run}-post10s`),
    scroll: scrollOf(host),
    shots: await fullSweep(run, "post10s"),
  });
}

async function caseResize(run) {
  const legs = [];
  const wide = { w: winInfo.width + 560, h: winInfo.height };
  const narrow = { w: Math.max(640, winInfo.width - 460), h: winInfo.height };
  const set = ({ w, h }) =>
    app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setContentSize(size.w, size.h);
    }, { w, h });
  const sequence = [];
  for (let i = 0; i < 3; i += 1) sequence.push(["wide", wide], ["narrow", narrow]);
  sequence.push(["restore", { w: winInfo.width, h: winInfo.height }]);
  const swept = new Set();
  for (const [label, size] of sequence) {
    await set(size);
    await sleep(900);
    const host = await readScrollHost(0);
    await focusCanvasAt(0);
    const rec = {
      t: `resize-${label}`,
      size,
      grid: await sttyCheck(run, `${run.case}-${run.run}-${label}`),
      scroll: scrollOf(host),
    };
    if (!swept.has(label)) {
      swept.add(label);
      rec.shots = await sweep(run, `resize-${label}`);
    }
    legs.push(rec);
    ev(run, rec);
  }
  // Verdict checkpoint for this row: the whole scrollback, after the restore.
  await focusCanvasAt(0);
  const finalHost = await readScrollHost(0);
  ev(run, {
    t: "resize-final",
    grid: await sttyCheck(run, `${run.case}-${run.run}-final`),
    scroll: scrollOf(finalHost),
    shots: await fullSweep(run, "resizefinal"),
  });
}

async function caseFocus(run) {
  for (let i = 1; i <= 10; i += 1) {
    await page.keyboard.press("Alt+Meta+Enter"); // enter terminal focus
    await sleep(420);
    const exitCount = await page.getByRole("button", { name: "Exit terminal focus" }).count();
    // The grid WHILE focused: zen hides the chrome, so the pane is larger here
    // than on return. Recording both ends is what distinguishes "the grid moved
    // and came back" from "the grid never moved".
    const focusedHost = await readScrollHost(0);
    const focusedGrid = await sttyCheck(run, `${run.case}-${run.run}-c${i}-in`);
    await page.keyboard.press("Alt+Meta+Enter"); // leave terminal focus
    await sleep(420);
    const enterCount = await page.getByRole("button", { name: "Enter terminal focus" }).count();
    const host = await readScrollHost(0);
    ev(run, {
      t: `focus-cycle-${i}`,
      entered: exitCount === 1,
      exited: enterCount === 1,
      gridWhileFocused: focusedGrid,
      scrollWhileFocused: scrollOf(focusedHost),
      grid: await sttyCheck(run, `${run.case}-${run.run}-c${i}`),
      scroll: scrollOf(host),
    });
  }
  await focusCanvasAt(0);
  const host = await readScrollHost(0);
  ev(run, {
    t: "focus-post",
    grid: await sttyCheck(run, `${run.case}-${run.run}-post`),
    scroll: scrollOf(host),
    shots: await fullSweep(run, "focuspost"),
  });
}

async function caseSplit(run, direction) {
  // direction: "horizontal" = Shift-⌘-D (top/bottom), "vertical" = ⌘-D (side by side)
  await focusCanvasAt(0);
  await page.keyboard.press(direction === "horizontal" ? "Shift+Meta+KeyD" : "Meta+KeyD");
  await waitUntil(
    "two visible canvases after split",
    async () => (await visibleCanvasRects()).length >= 2,
    { timeout: 8000 },
  );
  await sleep(1500);
  ev(run, {
    t: "split-created",
    canvases: (await visibleCanvasRects()).length,
    grid: await sttyCheck(run, `${run.case}-${run.run}-split`),
  });
  // Grid of the NEW pane (canvas index 1).
  await focusCanvasAt(1);
  ev(run, { t: "split-newpane-grid", grid: await sttyCheck(run, `${run.case}-${run.run}-pane2`) });

  const sep = page.locator('[role="separator"]');
  const dragTo = async (fraction) => {
    // The divider can be mid-relayout right after a previous drag, and a
    // collapsed pane can leave it briefly unhittable. Retry rather than abort
    // the run: a missed leg is recorded, a thrown one costs every later run.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const target = sep.filter({ visible: true }).first();
      const box = await target.boundingBox().catch(() => null);
      if (box === null || box.width === 0 || box.height === 0) {
        await sleep(500);
        continue;
      }
      const parent = await target
        .evaluate((el) => {
          const r = el.parentElement.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        })
        .catch(() => null);
      if (parent === null) {
        await sleep(500);
        continue;
      }
      // A tall, narrow divider separates side-by-side panes (drag along X);
      // a wide, short divider separates stacked panes (drag along Y).
      const alongX = box.height > box.width;
      const point = alongX
        ? { x: parent.x + parent.width * fraction, y: box.y + box.height / 2 }
        : { x: box.x + box.width / 2, y: parent.y + parent.height * fraction };
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(point.x, point.y, { steps: 10 });
      await page.mouse.up();
      await sleep(700);
      return true;
    }
    ev(run, { t: "drag-failed", note: `divider not hittable at ${fraction}` });
    return false;
  };

  for (let cycle = 1; cycle <= 3; cycle += 1) {
    for (const f of [0.25, 0.5, 0.75, 0.5]) {
      await dragTo(f);
      const host = await readScrollHost(0); // original pane = spatial first
      await focusCanvasAt(0);
      ev(run, {
        t: `drag-c${cycle}-${Math.round(f * 100)}`,
        scroll: scrollOf(host),
        grid: await sttyCheck(run, `${run.case}-${run.run}-c${cycle}-${Math.round(f * 100)}`),
      });
    }
  }
  // Both grids + original-pane markers at the end.
  await focusCanvasAt(1);
  ev(run, { t: "split-final-pane2-grid", grid: await sttyCheck(run, `${run.case}-${run.run}-final2`) });
  await focusCanvasAt(0);
  const host = await readScrollHost(0);
  ev(run, {
    t: "split-final",
    grid: await sttyCheck(run, `${run.case}-${run.run}-final1`),
    scroll: scrollOf(host),
    shots: await fullSweep(run, "splitfinal"),
  });
}

const homeStrip = () => page.getByRole("tablist", { name: "Home tabs" });

async function caseHideshow(run) {
  // Part 1: terminal tab ↔ Board ×10.
  const boardTab = homeStrip().getByRole("tab", { name: "Board" });
  const termTab = homeStrip().getByRole("tab").filter({ hasNotText: "Board" }).first();
  for (let i = 1; i <= 10; i += 1) {
    await boardTab.click();
    await sleep(320);
    await termTab.click();
    await sleep(420);
  }
  let host = await readScrollHost(0);
  await focusCanvasAt(0);
  ev(run, {
    t: "hideshow-board10",
    grid: await sttyCheck(run, `${run.case}-${run.run}-board10`),
    scroll: scrollOf(host),
    shots: await fullSweep(run, "board10"),
  });

  // Part 2: second terminal tab, switch terminal ↔ terminal ×10.
  await startTerminalSession(page);
  await waitUntil("second home terminal", async () => (await visibleCanvasRects()).length >= 1, {
    timeout: 20000,
  });
  await sleep(2200);
  const termTabs = () => homeStrip().getByRole("tab").filter({ hasNotText: "Board" });
  for (let i = 1; i <= 10; i += 1) {
    const tabs = termTabs();
    await tabs.nth(1).click();
    await sleep(320);
    await tabs.nth(0).click();
    await sleep(420);
  }
  host = await readScrollHost(0);
  await focusCanvasAt(0);
  ev(run, {
    t: "hideshow-tabs10",
    grid: await sttyCheck(run, `${run.case}-${run.run}-tabs10`),
    scroll: scrollOf(host),
    shots: await fullSweep(run, "tabs10"),
  });
}

async function caseTicketHideshow(run) {
  // The audit's surface: ticket detail ↔ board ×10, then session tab ↔ session
  // tab ×10 inside the ticket.
  const strip = () => page.getByRole("tablist", { name: "Ticket tabs" }).getByRole("tab");
  for (let i = 1; i <= 10; i += 1) {
    // Home nav button, not Escape: it is present on every screen, while the
    // board card behind Escape can be off-screen on a crowded board.
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await sleep(420);
    await page.locator("article").filter({ hasText: "VC-1" }).first().dblclick({ timeout: 20000 });
    await sleep(520);
    if (seedTabIndex >= 0) {
      await strip().nth(seedTabIndex).click();
      await sleep(300);
    }
  }
  let host = await readScrollHost(0);
  await focusCanvasAt(0);
  ev(run, {
    t: "ticket-hideshow-board10",
    grid: await sttyCheck(run, `${run.case}-${run.run}-board10`),
    scroll: scrollOf(host),
    shots: await fullSweep(run, "board10"),
  });
  await startTerminalSession(page.locator("aside"));
  await waitUntil("second session tab", async () => (await strip().count()) >= 3, { timeout: 45000 });
  const otherTabIndex = (await strip().count()) - 1;
  await strip().nth(otherTabIndex).click();
  await sleep(2600);
  // Terminal tab ↔ terminal tab: the OTHER terminal and the seeded one, never
  // the doc tab (which shows no terminal at all).
  for (let i = 1; i <= 10; i += 1) {
    await strip().nth(otherTabIndex).click();
    await sleep(320);
    await strip().nth(seedTabIndex >= 0 ? seedTabIndex : 1).click();
    await sleep(420);
  }
  host = await readScrollHost(0);
  await focusCanvasAt(0);
  ev(run, {
    t: "ticket-hideshow-tabs10",
    grid: await sttyCheck(run, `${run.case}-${run.run}-tabs10`),
    scroll: scrollOf(host),
    shots: await fullSweep(run, "tabs10"),
  });
}

// ---- case registry + main --------------------------------------------------------

const CASE_FN = {
  control: caseControl,
  resize: caseResize,
  focus: caseFocus,
  hsplit: (run) => caseSplit(run, "horizontal"),
  vsplit: (run) => caseSplit(run, "vertical"),
  hideshow: SURFACE === "home" ? caseHideshow : caseTicketHideshow,
};

try {
  console.log(`evidence: ${EVIDENCE}`);
  console.log(`window: ${JSON.stringify(winInfo)}  surface: ${SURFACE}  cases: ${CASES.join(",")}`);

  // Backend truth for the whole run.
  await waitUntil(
    "renderer boot",
    async () =>
      (await page.evaluate(() => (window.volliCtxSpy ?? []).some((c) => c.type === "webgpu" || c.type === "webgl2"))),
    { timeout: 20000 },
  ).catch(() => {});
  const backendReport = await page.evaluate(() => {
    const ctx = window.volliCtxSpy ?? [];
    return {
      webgpu: ctx.some((c) => c.type === "webgpu" && c.ok),
      webgl2: ctx.some((c) => c.type === "webgl2" && c.ok),
      navigatorGpu: typeof navigator?.gpu !== "undefined",
    };
  });
  MATRIX.meta.backend = backendReport;
  console.log(`backend: ${JSON.stringify(backendReport)}`);

  if (SURFACE === "ticket") {
    // Seed one ticket, open its detail — the audit's surface.
    const seed = await page.evaluate(async () => {
      const boot = await window.api.data.bootstrap();
      if (!boot.ok) return boot;
      const project = boot.data.projects[0];
      return window.api.tickets.create({
        projectId: project.id,
        status: "todo",
        title: "VC-291 reflow matrix",
        priority: "medium",
      });
    });
    if (!seed.ok) throw new Error(`ticket seed failed: ${seed.error}`);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await waitUntil("board open", async () =>
      (await page.getByRole("button", { name: "New ticket", exact: true }).count()) > 0,
    );
    await page.locator("article").filter({ hasText: "VC-1" }).first().dblclick();
    await sleep(900);
  } else {
    await waitUntil("home board open", async () =>
      (await page.getByRole("button", { name: "New ticket", exact: true }).count()) > 0,
    );
  }

  for (const caseName of CASES) {
    for (let r = 1; r <= RUNS; r += 1) {
      let run = null;
      try {
        run = await seedRun(caseName, r);
        if (PANES_PER_RUN > 0) {
        // GPU-pressure row: keep the seeded pane open, add live terminals on
        // top of it, THEN run the case actions (ticket order).
        for (let i = 0; i < PANES_PER_RUN; i += 1) {
          await startTerminalSession(SURFACE === "ticket" ? page.locator("aside") : page);
          await sleep(1100);
        }
        const live = await page.evaluate(() => document.querySelectorAll("[data-terminal-renderer]").length);
        // Come back to the seeded pane: creating terminals moves the active
        // tab, and every later reading has to be about the pane that was seeded.
        if (SURFACE === "ticket" && seedTabIndex >= 0) {
          const strip = page.getByRole("tablist", { name: "Ticket tabs" }).getByRole("tab");
          await strip.nth(seedTabIndex).click();
          await sleep(1200);
        }
        const back = await readScrollHost(0);
        ev(run, {
          t: "pressure-panes-created",
          liveTerminalHosts: live,
          scroll: scrollOf(back),
          backOnSeededPane: back?.paneId === run.seededPaneId,
        });
        await sleep(2500);
      }
        await CASE_FN[caseName](run);
        run.finishedAt = new Date().toISOString();
      } catch (error) {
        // One bad run must not cost the other runs of this row their evidence.
        const record = run ?? { case: caseName, run: r, surface: SURFACE, events: [] };
        if (run === null) MATRIX.runs.push(record);
        record.error = String(error?.message ?? error);
        record.finishedAt = new Date().toISOString();
        console.error(`  [${caseName} r${r}] RUN FAILED: ${record.error}`);
      }
    }
  }
} catch (error) {
  MATRIX.meta.fatal = String(error?.stack ?? error);
  console.error("FATAL:", error);
} finally {
  MATRIX.meta.consoleErrors = consoleLog.filter((l) => l.type === "error" || l.type === "pageerror");
  MATRIX.meta.consoleAll = consoleLog;
  await fs.writeFile(join(EVIDENCE, "matrix.json"), JSON.stringify(MATRIX, null, 2));
  await fs.copyFile(SEED_PATH, join(EVIDENCE, "seed.sh")).catch(() => {});
  await page.screenshot({ path: join(EVIDENCE, "final-window.png") }).catch(() => {});
  await app.close().catch(() => {});
  // Keep the ticket's reference files: copy every /tmp/volli-reflow-*.txt in.
  const kept = [];
  for (const run of MATRIX.runs) {
    if (run.referenceFile?.startsWith("/tmp/")) {
      const dest = join(EVIDENCE, `reference-${run.case}-r${run.run}.txt`);
      await fs.copyFile(run.referenceFile, dest).catch(() => {});
      kept.push(dest);
    }
  }
  console.log(`\nmatrix written: ${join(EVIDENCE, "matrix.json")}`);
  console.log(`reference files kept: ${kept.length} (originals untouched in /tmp)`);
  if (cleanup) await cleanup();
}
