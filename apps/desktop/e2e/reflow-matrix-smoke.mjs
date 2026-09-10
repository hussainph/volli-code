/**
 * VC-291 — deterministic terminal reflow matrix.
 *
 * Executes the ticket's matrix against the REAL built app (restty canvas
 * renderer, live PTY). Terminal text is not in the DOM, so markers are read by
 * screenshotting the pane and OCRing it through the macOS Vision framework;
 * shell state is read through side effects, the way the repo's other terminal
 * smokes do it.
 *
 * Cases (each on a newly seeded pane, `--runs` times):
 *   control   — wait 10s, no layout change.
 *   resize    — wide↔narrow ×3, then restore; a checkpoint on EVERY leg.
 *   focus     — enter/leave terminal focus 10× (⌥⌘Return); a checkpoint on
 *               EVERY return. This is the audit's observed path.
 *   hsplit    — Shift-⌘-D, divider dragged 25/50/75/50 ×3; a checkpoint on
 *               every drag, recording BOTH pane grids and which pane is active.
 *   vsplit    — ⌘-D, same drag matrix.
 *   hideshow  — terminal ↔ Board ×10, then terminal tab ↔ terminal tab ×10;
 *               a checkpoint on EVERY return.
 *   (with --panes-per-run) the GPU-pressure row: N further live terminals are
 *               created on top of the seeded pane before the case runs.
 *
 * WHAT A CHECKPOINT OWES (the ticket's list, and why)
 * ---------------------------------------------------
 * At every action boundary this records the grid, the scroll offset and
 * maximum, the identity of the pane it measured, which pane is active, whether
 * the viewport is still anchored to the bottom (a checked boolean, not a note),
 * a screenshot of the pane EXACTLY AS IT STANDS, and a full-scrollback marker
 * sweep. The at-rest screenshot comes first, before any sweep or refit could
 * repaint the pane — a transient failure that a later resize recovers must
 * still leave evidence behind.
 *
 * The sweep restores the scroll position it found, so measuring the viewport
 * does not destroy the drift the matrix exists to observe.
 *
 * SEED
 * ----
 * The seed is built by `lib/vc291-seed.mjs` and VALIDATED against the intended
 * 63-line sequence before any case action runs. A first pass at this
 * investigation ran the entire matrix on a seed whose `-END` was eaten as a
 * printf option, producing 33 lines, and reported a clean negative result from
 * it. A run whose seed does not verify is aborted and recorded as failed.
 *
 *   Run:
 *     pnpm run build
 *     node apps/desktop/e2e/reflow-matrix-smoke.mjs <evidenceDir> [--cases=…] [--runs=N]
 *                                                   [--webgl2] [--surface=ticket|home]
 *                                                   [--panes-per-run=N]
 *
 * Exits non-zero if any run failed. NOT part of the CI smoke lane (see the
 * deny-list in `apps/desktop/scripts/run-smokes.mjs`): it needs a display, the
 * Vision OCR bridge, and the better part of an hour.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";

import {
  evidenceDir,
  launch,
  makeGitRepo,
  makeScratch,
  startTerminalSession,
  waitUntil,
} from "./lib/smoke-kit.mjs";
import {
  captureAtRest,
  captureConsole,
  collectRunMetadata,
  focusCanvasAt,
  foldConsole,
  fullSweep,
  installContextSpy,
  installFontWorkaround,
  isAnchoredAtBottom,
  paneReading,
  readBackend,
  readPane,
  seedProject,
  seedTicketAndOpen,
  sleep,
  visibleCanvasRects,
} from "./lib/vc291-harness.mjs";
import { parseBaselinePointer, seedScript, verifySeedReference } from "./lib/vc291-seed.mjs";

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
const SURFACE = opt("surface", "ticket");
const PANES_PER_RUN = Number(opt("panes-per-run", "0"));
const CASES = opt("cases", "control,resize,focus,hsplit,vsplit,hideshow")
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);

// ---- run metadata -----------------------------------------------------------

const metadata = await collectRunMetadata();
const RUN_CONFIG = {
  ticket: "VC-291 reflow matrix",
  startedAt: new Date().toISOString(),
  ...metadata,
  cases: CASES,
  runsPerCase: RUNS,
  surface: SURFACE,
  panesPerRun: PANES_PER_RUN,
  // What the analyzer must hold this evidence set to. Declared up front, so a
  // row cannot pick a lower bar after seeing its own result.
  expectBackend: FORCE_WEBGL2 ? "webgl2" : "webgpu",
  minLiveTerminals: PANES_PER_RUN > 0 ? PANES_PER_RUN + 1 : 0,
  forcedBackend: FORCE_WEBGL2
    ? "webgl2 (navigator.gpu hidden by an init script — harness-only lever, VC-348)"
    : "auto (production default)",
};

// ---- seed -------------------------------------------------------------------

const SEED_DIR = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "volli-reflow-seed-")));
const READY_PROBE = join(SEED_DIR, "ready.txt");
const PROBE_FILE = join(EVIDENCE, "stty-probe.txt");
await fs.writeFile(PROBE_FILE, "");

/**
 * A seed script, a pointer and a token unique to ONE seeded pane.
 *
 * The first pass reused one pointer file for every run and never cleared it,
 * so a run whose own write had not landed adopted the previous run's reference
 * file — two of every three committed references belonged to another pane. The
 * token is baked into the log name AND into the pointer's contents, and the
 * reader refuses a pointer that is not its own.
 */
async function makeSeed(caseName, runNo) {
  const token = `${caseName}${runNo}${Date.now().toString(36)}`.replace(/[^A-Za-z0-9]/g, "");
  const scriptPath = join(SEED_DIR, `seed-${token}.sh`);
  const pointerPath = join(SEED_DIR, `baseline-${token}.txt`);
  await fs.rm(pointerPath, { force: true });
  await fs.writeFile(scriptPath, seedScript({ pointerPath, token }));
  return { token, scriptPath, pointerPath };
}

// ---- app boot ---------------------------------------------------------------

const { scratch, cleanup, dbPath, userDataDir } = await makeScratch("vc291-matrix-");
const projectDir = await makeGitRepo(scratch, "project-");

const app = await launch({ dbPath, userDataDir });
const page = await app.firstWindow();
const consoleLog = captureConsole(page);
await page.waitForLoadState("domcontentloaded");

RUN_CONFIG.fontWorkaround = (await installFontWorkaround(page)).workaround;
await installContextSpy(page, { forceWebgl2: FORCE_WEBGL2 });
await seedProject(page, { path: projectDir });

// Canonical window geometry so every run starts identically.
const winInfo = await app.evaluate(({ BrowserWindow, screen }) => {
  const win = BrowserWindow.getAllWindows()[0];
  win.setContentSize(1280, 832);
  const bounds = win.getContentBounds();
  const display = screen.getDisplayMatching(bounds);
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    scaleFactor: display.scaleFactor,
    displayId: display.id,
    displaySize: display.size,
  };
});
RUN_CONFIG.window = winInfo;
await fs.writeFile(join(EVIDENCE, "run-config.json"), JSON.stringify(RUN_CONFIG, null, 2));

const MATRIX = { meta: { ...RUN_CONFIG }, runs: [] };
const ev = (run, event) => {
  event.at = Date.now();
  run.events.push(event);
  console.log(
    `  [${run.case} r${run.run}] ${event.t}` +
      `${event.grid ? ` grid=${event.grid}` : ""}` +
      `${event.scroll ? ` scroll=${event.scroll.top}/${event.scroll.max}` : ""}` +
      `${event.anchoredAtBottom === undefined ? "" : ` anchored=${event.anchoredAtBottom}`}` +
      `${event.note ? ` — ${event.note}` : ""}`,
  );
};

// ---- shell plumbing ---------------------------------------------------------

let probeLines = 0;

/**
 * The ticket PTY spawns only after the worktree ensure() lands, and writes
 * before that fail with "Unknown terminal session" toasts. So a typing session
 * starts with a side-effect handshake: `echo … > ready`, poll, refocus, retry.
 */
async function waitShellReady(label) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await fs.rm(READY_PROBE, { force: true });
    await focusCanvasAt(page, 0);
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
async function sttyCheck(tag) {
  await page.keyboard.type(`echo REFLOW-CHECK-${tag}; stty size | tee -a ${PROBE_FILE}`);
  await page.keyboard.press("Enter");
  const grid = await waitUntil(
    `stty probe ${tag}`,
    async () => {
      const text = await fs.readFile(PROBE_FILE, "utf8");
      const lines = text
        .trim()
        .split("\n")
        .filter((l) => /^\d+ \d+$/.test(l));
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

/** Ask the pane which shell it is actually running — metadata, measured. */
async function probePaneShell() {
  const out = join(SEED_DIR, "shell.txt");
  await fs.rm(out, { force: true });
  await page.keyboard.type(
    `{ ps -p $$ -o comm= ; echo "$0" ; /bin/sh -c 'echo sh=$0' ; } > ${out}`,
  );
  await page.keyboard.press("Enter");
  const text = await waitUntil(
    "pane shell probe",
    async () => {
      try {
        const t = (await fs.readFile(out, "utf8")).trim();
        return t.length > 0 ? t : null;
      } catch {
        return null;
      }
    },
    { timeout: 8000 },
  ).catch(() => null);
  return text ?? "unavailable";
}

// ---- checkpoints ------------------------------------------------------------

/**
 * One action-boundary checkpoint.
 *
 * Order matters and is the whole point:
 *   1. read the pane — the truth at the boundary, before anything touches it;
 *   2. answer the anchoring question as a boolean, from that reading;
 *   3. screenshot the pane AT REST — the durable record of a transient state;
 *   4. sweep the whole scrollback for markers, then restore the scroll;
 *   5. only now type the stty probe, which grows the buffer.
 */
async function checkpoint(
  run,
  label,
  { role = "boundary", paneIndex = 0, sweep = true, extra = {} } = {},
) {
  const pane = await readPane(page, paneIndex);
  const anchored = isAnchoredAtBottom(pane);
  const name = `${run.case}-r${run.run}-${label}`;
  const atRest = await captureAtRest(page, { evidenceDir: EVIDENCE, name, paneIndex });
  const shots = sweep
    ? await fullSweep(page, { evidenceDir: EVIDENCE, name, paneIndex })
    : undefined;
  await focusCanvasAt(page, paneIndex);
  const grid = await sttyCheck(`${run.case}-${run.run}-${label}`);
  const event = {
    t: label,
    role,
    grid,
    scroll: paneReading(pane),
    anchoredAtBottom: anchored,
    activePaneId: pane?.focusedPaneId ?? null,
    ringActivePaneId: pane?.ringActivePaneId ?? null,
    onSeededPane: run.seededPaneId ? pane?.paneId === run.seededPaneId : null,
    atRest,
    ...(shots ? { shots } : {}),
    ...extra,
  };
  ev(run, event);
  return event;
}

/** The tab strip that owns this surface's session tabs. */
const sessionTabs = () =>
  SURFACE === "ticket"
    ? page.getByRole("tablist", { name: "Ticket tabs" }).getByRole("tab")
    : homeStrip().getByRole("tab");

/**
 * Select the tab holding THIS run's seeded pane, and prove it.
 *
 * A remembered tab index is not enough: creating another terminal can reorder
 * or shift the strip, and the first attempt at this row switched to a
 * neighbouring tab for all ten cycles of part 2 while recording readings as if
 * they were the seeded pane's. So the index is a fast path only — the pane id
 * is the acceptance test, and a failure to find it aborts the run rather than
 * quietly measuring the wrong terminal.
 */
async function selectSeededTab(run) {
  const tabs = sessionTabs();
  const count = await tabs.count();
  const order = [
    ...(seedTabIndex >= 0 && seedTabIndex < count ? [seedTabIndex] : []),
    ...Array.from({ length: count }, (_, i) => i),
  ];
  for (const index of order) {
    await tabs
      .nth(index)
      .click()
      .catch(() => {});
    await sleep(320);
    const pane = await readPane(page, 0);
    if (pane?.paneId === run.seededPaneId) {
      seedTabIndex = index;
      return index;
    }
  }
  throw new Error(`could not return to the seeded pane ${run.seededPaneId} (${count} tabs)`);
}

/** A terminal tab that is NOT the seeded one, for terminal ↔ terminal switching. */
async function findOtherTerminalTab(run) {
  const tabs = sessionTabs();
  const count = await tabs.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    if (index === seedTabIndex) continue;
    await tabs
      .nth(index)
      .click()
      .catch(() => {});
    await sleep(320);
    const pane = await readPane(page, 0);
    if (pane?.paneId && pane.paneId !== run.seededPaneId) return index;
  }
  throw new Error("no second terminal tab to switch to");
}

/** The other pane's grid, for split rows: focus it, probe, and say which. */
async function otherPaneGrid(run, label, paneIndex) {
  const pane = await readPane(page, paneIndex);
  await focusCanvasAt(page, paneIndex);
  const grid = await sttyCheck(`${run.case}-${run.run}-${label}`);
  return { paneId: pane?.paneId ?? null, grid, scroll: paneReading(pane) };
}

// ---- seeding ----------------------------------------------------------------

/** Tab index of the pane this run seeded, so a row that opens more terminals
 * can come back to it. */
let seedTabIndex = -1;

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
    async () => (await visibleCanvasRects(page)).length >= 1,
    {
      timeout: 20000,
    },
  );
  await sleep(2400); // restty boot: fonts, wasm, first paint

  const run = {
    case: caseName,
    run: runNo,
    surface: SURFACE,
    startedAt: new Date().toISOString(),
    events: [],
  };
  MATRIX.runs.push(run);

  if (!(await waitShellReady(`${caseName}${runNo}`))) {
    throw new Error(`shell never accepted input (${caseName} r${runNo})`);
  }
  if (!MATRIX.meta.paneShell) MATRIX.meta.paneShell = await probePaneShell();

  const { token, scriptPath, pointerPath } = await makeSeed(caseName, runNo);
  run.referenceToken = token;
  await page.keyboard.type(`sh ${scriptPath}`);
  await page.keyboard.press("Enter");
  const pointed = await waitUntil(
    "reference file written",
    async () => {
      try {
        const parsed = parseBaselinePointer(await fs.readFile(pointerPath, "utf8"), token);
        return parsed.ok ? parsed : null;
      } catch {
        return null;
      }
    },
    { timeout: 20000 },
  ).catch(() => null);
  if (!pointed) throw new Error(`seed never reported its reference file (${caseName} r${runNo})`);
  run.referenceFile = pointed.path;

  // THE GATE: no case action runs until the seed is provably the intended
  // 63-line sequence. Anything else measures the wrong thing.
  const referenceText = await fs.readFile(pointed.path, "utf8");
  const verdict = verifySeedReference(referenceText);
  run.seedVerification = {
    ok: verdict.ok,
    lineCount: verdict.lineCount,
    shortsSeen: verdict.shortsSeen,
    longsSeen: verdict.longsSeen,
    pwd: verdict.pwd,
    problems: verdict.problems,
  };
  if (!verdict.ok) {
    throw new Error(
      `seed did not produce the intended sequence: ${verdict.problems.slice(0, 3).join("; ")}`,
    );
  }
  console.log(
    `  [${caseName} r${runNo}] seed verified: ${verdict.lineCount} lines, pwd=${verdict.pwd}`,
  );
  await sleep(600);

  // Backend truth, re-read per run so a mid-run rebuild is visible.
  MATRIX.meta.backend = await readBackend(page);
  console.log(`  [backend after seed] ${JSON.stringify(MATRIX.meta.backend)}`);

  const pane = await readPane(page, 0);
  run.seededPaneId = pane?.paneId ?? null;
  // Measured cell metrics — the run's effective font size, without asking the
  // renderer to describe itself.
  run.paneMetrics = { clip: pane?.clip ?? null, dpr: pane?.dpr ?? null };
  await checkpoint(run, "seedpost", { role: "seed" });
  return run;
}

// ---- cases ------------------------------------------------------------------

async function caseControl(run) {
  await sleep(10_000);
  await checkpoint(run, "post10s", { role: "boundary" });
  await checkpoint(run, "final", { role: "final" });
}

async function caseResize(run) {
  const wide = { w: winInfo.width + 560, h: winInfo.height };
  const narrow = { w: Math.max(640, winInfo.width - 460), h: winInfo.height };
  const set = (size) =>
    app.evaluate(({ BrowserWindow }, s) => {
      BrowserWindow.getAllWindows()[0].setContentSize(s.w, s.h);
    }, size);

  const sequence = [];
  for (let i = 1; i <= 3; i += 1) sequence.push([`wide${i}`, wide], [`narrow${i}`, narrow]);
  sequence.push(["restore", { w: winInfo.width, h: winInfo.height }]);

  // A checkpoint on EVERY leg — the ticket asks for the grid after each one,
  // and a leg that is only sampled the first time cannot show a drift that
  // starts on the third.
  for (const [label, size] of sequence) {
    await set(size);
    await sleep(900);
    await checkpoint(run, `resize-${label}`, { role: "boundary", extra: { size } });
  }
  await checkpoint(run, "resize-final", { role: "final" });
}

async function caseFocus(run) {
  for (let i = 1; i <= 10; i += 1) {
    await page.keyboard.press("Alt+Meta+Enter"); // enter terminal focus
    await sleep(420);
    const enteredZen =
      (await page.getByRole("button", { name: "Exit terminal focus" }).count()) === 1;
    // The grid WHILE focused: zen hides the chrome, so the pane is larger here
    // than on return. Recording both ends distinguishes "the grid moved and
    // came back" from "the grid never moved".
    const focusedPane = await readPane(page, 0);
    const gridWhileFocused = await sttyCheck(`${run.case}-${run.run}-c${i}-in`);

    await page.keyboard.press("Alt+Meta+Enter"); // leave terminal focus
    await sleep(420);
    const leftZen =
      (await page.getByRole("button", { name: "Enter terminal focus" }).count()) === 1;

    await checkpoint(run, `focus-return-${i}`, {
      role: "boundary",
      extra: {
        cycle: i,
        enteredZen,
        leftZen,
        gridWhileFocused,
        scrollWhileFocused: paneReading(focusedPane),
        anchoredWhileFocused: isAnchoredAtBottom(focusedPane),
      },
    });
  }
  await checkpoint(run, "focus-final", { role: "final" });
}

async function caseSplit(run, direction) {
  await focusCanvasAt(page, 0);
  await page.keyboard.press(direction === "horizontal" ? "Shift+Meta+KeyD" : "Meta+KeyD");
  await waitUntil(
    "two visible canvases after split",
    async () => (await visibleCanvasRects(page)).length >= 2,
    {
      timeout: 8000,
    },
  );
  await sleep(1500);
  const newPane = await otherPaneGrid(run, "split-newpane", 1);
  ev(run, {
    t: "split-created",
    role: "note",
    canvases: (await visibleCanvasRects(page)).length,
    newPane,
  });

  const separator = page.locator('[role="separator"]');
  const dragTo = async (fraction) => {
    // The divider can be mid-relayout right after a previous drag, and a
    // collapsed pane can leave it briefly unhittable. Retry rather than abort:
    // a missed leg is recorded, a thrown one costs every later run.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const target = separator.filter({ visible: true }).first();
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
      // A tall, narrow divider separates side-by-side panes (drag along X); a
      // wide, short divider separates stacked panes (drag along Y).
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
    return false;
  };

  for (let cycle = 1; cycle <= 3; cycle += 1) {
    for (const fraction of [0.25, 0.5, 0.75, 0.5]) {
      const dragged = await dragTo(fraction);
      const label = `drag-c${cycle}-${Math.round(fraction * 100)}`;
      // Both grids and which pane is active, at every drag: the ticket asks
      // for the second pane's geometry too, and reading only the original
      // cannot tell a divider that moved from one that did not.
      const second = await otherPaneGrid(run, `${label}-pane2`, 1);
      await checkpoint(run, label, {
        role: "boundary",
        extra: { fraction, dragged, secondPane: second },
      });
    }
  }
  await checkpoint(run, "split-final", { role: "final" });
}

const homeStrip = () => page.getByRole("tablist", { name: "Home tabs" });

async function caseHideshowHome(run) {
  // Part 1: the ticket's exact row — Home tab from the terminal to Board and
  // back, ten times, with a checkpoint on every return. Coming back is
  // VERIFIED against the seeded pane's id rather than trusted to a tab index.
  const boardTab = homeStrip().getByRole("tab", { name: "Board" });
  for (let i = 1; i <= 10; i += 1) {
    await boardTab.click();
    await sleep(320);
    await selectSeededTab(run);
    await sleep(420);
    await checkpoint(run, `board-return-${i}`, {
      role: "boundary",
      extra: { cycle: i, leg: "board" },
    });
  }

  // Part 2: a second terminal tab, then terminal ↔ terminal ten times.
  const tabsBefore = await sessionTabs().count();
  await startTerminalSession(page);
  await waitUntil(
    "second home terminal tab",
    async () => (await sessionTabs().count()) > tabsBefore,
    {
      timeout: 45000,
    },
  );
  await sleep(2200);
  await selectSeededTab(run);
  const otherTabIndex = await findOtherTerminalTab(run);
  for (let i = 1; i <= 10; i += 1) {
    await sessionTabs().nth(otherTabIndex).click();
    await sleep(320);
    await selectSeededTab(run);
    await sleep(420);
    await checkpoint(run, `tab-return-${i}`, { role: "boundary", extra: { cycle: i, leg: "tab" } });
  }
  await checkpoint(run, "hideshow-final", { role: "final" });
}

async function caseHideshowTicket(run) {
  // The audit's surface: ticket detail ↔ board ×10, then session tab ↔ session
  // tab ×10 inside the ticket.
  for (let i = 1; i <= 10; i += 1) {
    // The Home nav button, not Escape: it is present on every screen, while
    // the board card behind Escape can be off-screen on a crowded board.
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await sleep(420);
    await page.locator("article").filter({ hasText: "VC-1" }).first().dblclick({ timeout: 20000 });
    await sleep(520);
    await selectSeededTab(run);
    await sleep(300);
    await checkpoint(run, `board-return-${i}`, {
      role: "boundary",
      extra: { cycle: i, leg: "board" },
    });
  }

  const tabsBefore = await sessionTabs().count();
  await startTerminalSession(page.locator("aside"));
  await waitUntil("second session tab", async () => (await sessionTabs().count()) > tabsBefore, {
    timeout: 45000,
  });
  await sleep(2600);
  await selectSeededTab(run);
  const otherTabIndex = await findOtherTerminalTab(run);
  for (let i = 1; i <= 10; i += 1) {
    await sessionTabs().nth(otherTabIndex).click();
    await sleep(320);
    await selectSeededTab(run);
    await sleep(420);
    await checkpoint(run, `tab-return-${i}`, { role: "boundary", extra: { cycle: i, leg: "tab" } });
  }
  await checkpoint(run, "hideshow-final", { role: "final" });
}

const CASE_FN = {
  control: caseControl,
  resize: caseResize,
  focus: caseFocus,
  hsplit: (run) => caseSplit(run, "horizontal"),
  vsplit: (run) => caseSplit(run, "vertical"),
  hideshow: SURFACE === "home" ? caseHideshowHome : caseHideshowTicket,
};

// ---- main -------------------------------------------------------------------

try {
  console.log(`evidence: ${EVIDENCE}`);
  console.log(`window: ${JSON.stringify(winInfo)}  surface: ${SURFACE}  cases: ${CASES.join(",")}`);

  await waitUntil(
    "renderer boot",
    async () =>
      page.evaluate(() =>
        (window.volliCtxSpy ?? []).some((c) => c.type === "webgpu" || c.type === "webgl2"),
      ),
    { timeout: 20000 },
  ).catch(() => {});
  MATRIX.meta.backend = await readBackend(page);
  console.log(`backend: ${JSON.stringify(MATRIX.meta.backend)}`);

  if (SURFACE === "ticket") await seedTicketAndOpen(page, "VC-291 reflow matrix");
  else {
    await waitUntil(
      "home board open",
      async () => (await page.getByRole("button", { name: "New ticket", exact: true }).count()) > 0,
    );
  }

  for (const caseName of CASES) {
    for (let r = 1; r <= RUNS; r += 1) {
      let run = null;
      try {
        run = await seedRun(caseName, r);

        if (PANES_PER_RUN > 0) {
          // GPU-pressure row: keep the seeded pane open, add live terminals on
          // top of it, THEN run the case actions (the ticket's order).
          for (let i = 0; i < PANES_PER_RUN; i += 1) {
            await startTerminalSession(SURFACE === "ticket" ? page.locator("aside") : page);
            await sleep(1100);
          }
          // Come back to the seeded pane: creating 16 terminals moves the
          // active tab, and every later reading must be about the pane that
          // was seeded. Verified by pane id, not by a remembered index.
          await selectSeededTab(run);
          await sleep(1200);
          const back = await readPane(page, 0);
          ev(run, {
            t: "pressure-panes-created",
            role: "note",
            liveTerminalHosts: back?.liveTerminalHosts ?? 0,
            scroll: paneReading(back),
            backOnSeededPane: back?.paneId === run.seededPaneId,
          });
          await sleep(2500);
        }

        await CASE_FN[caseName](run);
        run.finishedAt = new Date().toISOString();
      } catch (error) {
        // One bad run must not cost the other runs of this row their evidence,
        // but it must be recorded as failed and it must change the exit code.
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
  const folded = foldConsole(consoleLog);
  MATRIX.meta.consoleByLevel = folded.byLevel;
  MATRIX.meta.contextMessages = folded.contextMessages;
  MATRIX.meta.consoleErrors = consoleLog.filter(
    (l) => l.type === "error" || l.type === "pageerror",
  );
  MATRIX.meta.consoleAll = consoleLog;
  MATRIX.meta.finishedAt = new Date().toISOString();
  await fs.writeFile(join(EVIDENCE, "matrix.json"), JSON.stringify(MATRIX, null, 2));
  await page.screenshot({ path: join(EVIDENCE, "final-window.png") }).catch(() => {});
  await app.close().catch(() => {});

  // Keep each run's own reference file, named after the run it belongs to.
  let kept = 0;
  for (const run of MATRIX.runs) {
    if (!run.referenceFile) continue;
    const dest = join(EVIDENCE, `reference-${run.case}-r${run.run}.txt`);
    await fs
      .copyFile(run.referenceFile, dest)
      .then(() => (kept += 1))
      .catch(() => {});
  }

  const failed = MATRIX.runs.filter((r) => r.error);
  console.log(`\nmatrix written: ${join(EVIDENCE, "matrix.json")}`);
  console.log(`reference files kept: ${kept}/${MATRIX.runs.length}`);
  if (folded.contextMessages.length > 0) {
    console.log(`GPU context/device console messages: ${folded.contextMessages.length}`);
  }
  if (MATRIX.meta.fatal || failed.length > 0) {
    console.error(
      `\nMATRIX FAILED: ${failed.length} run(s) failed${MATRIX.meta.fatal ? " + a fatal error" : ""}`,
    );
    for (const run of failed) console.error(`  - ${run.case} r${run.run}: ${run.error}`);
    process.exitCode = 1;
  } else if (MATRIX.runs.length === 0) {
    console.error("\nMATRIX FAILED: no runs were produced");
    process.exitCode = 1;
  } else {
    console.log(`\nMATRIX OK: ${MATRIX.runs.length} run(s), no run-level failures`);
    console.log("(this is not the verdict — run analyze-vc291.mjs for that)");
  }
  if (cleanup) await cleanup();
}
