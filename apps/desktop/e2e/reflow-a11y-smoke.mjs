/**
 * VC-291 — VoiceOver/AX, selection+copy, and find checks for the terminal.
 *
 * Boots a fresh app, seeds a terminal with the ticket's REFLOW block, and runs
 * the ticket's three accessibility questions in BOTH required states: a fresh
 * unsplit pane, and again after a split + terminal-focus + hide/show cycle.
 *
 *   A. Accessibility — DOM roles/names of the terminal host and canvas, what
 *      Tab does, and the macOS AX tree that VoiceOver actually reads, queried
 *      against THIS app's pid rather than whatever process happens to be named
 *      "Electron". VoiceOver is toggled and navigated; whatever cannot be
 *      captured is recorded as precisely unavailable rather than inferred.
 *   B. Selection + copy — a UNIQUE SENTINEL is placed on the clipboard before
 *      every attempt, so "the copy worked" can never be satisfied by a stale
 *      clipboard left over from an earlier state. What lands is unwrapped back
 *      into logical lines and compared with the seeded reference file exactly,
 *      including the long line's 240-character fill and its own `-END` tail.
 *   C. Find — ⌘F targeting the real "Find in scrollback" field, in both states,
 *      plus ⌘K quick-open for contrast.
 *
 * Everything here is a finding, not a pass/fail gate; the run only exits
 * non-zero when a check could not be ATTEMPTED, because a missing measurement
 * must not read as a clean result.
 *
 *   Run: node apps/desktop/e2e/reflow-a11y-smoke.mjs <evidenceDir>
 *
 * NOT part of the CI smoke lane (deny-listed in run-smokes.mjs): it toggles
 * VoiceOver, owns the system clipboard, and needs the macOS AX permission.
 */
import { execFileSync } from "node:child_process";
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
  captureConsole,
  collectRunMetadata,
  focusCanvasAt,
  foldConsole,
  installContextSpy,
  installFontWorkaround,
  ocrImage,
  readBackend,
  readPane,
  seedProject,
  seedTicketAndOpen,
  setScrollTop,
  sleep,
  visibleCanvasRects,
} from "./lib/vc291-harness.mjs";
import {
  copiedRunMatchesReference,
  longLine,
  parseBaselinePointer,
  seedScript,
  shortLine,
  unwrapCopiedText,
  verifySeedReference,
} from "./lib/vc291-seed.mjs";

const argv = process.argv.slice(2);
const EVIDENCE = resolve(argv.find((a) => !a.startsWith("--")) ?? evidenceDir("vc291-a11y"));
await fs.mkdir(EVIDENCE, { recursive: true });

const RECORD = {
  meta: { ticket: "VC-291 a11y/copy/find", startedAt: new Date().toISOString() },
  checks: [],
};
/** Evidence that must be GATHERED; a hole here fails the run. */
const required = new Map();
const note = (id, payload) => {
  RECORD.checks.push({ id, at: Date.now(), ...payload });
  console.log(`  [${id}] ${JSON.stringify(payload).slice(0, 400)}`);
  return payload;
};
const requires = (id, gathered, why) => {
  required.set(id, { gathered: Boolean(gathered), why });
  return gathered;
};

RECORD.meta = { ...RECORD.meta, ...(await collectRunMetadata()) };

// ---- seed -------------------------------------------------------------------

const SEED_DIR = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "volli-reflow-seed-")));
const READY_PROBE = join(SEED_DIR, "ready.txt");
const SEED_TOKEN = `a11y${Date.now().toString(36)}`;
const SEED_PATH = join(SEED_DIR, `seed-${SEED_TOKEN}.sh`);
const POINTER_PATH = join(SEED_DIR, `baseline-${SEED_TOKEN}.txt`);
await fs.rm(POINTER_PATH, { force: true });
await fs.writeFile(SEED_PATH, seedScript({ pointerPath: POINTER_PATH, token: SEED_TOKEN }));

// ---- app boot ---------------------------------------------------------------

const { scratch, cleanup, dbPath, userDataDir } = await makeScratch("vc291-a11y-");
const projectDir = await makeGitRepo(scratch, "project-");

const app = await launch({ dbPath, userDataDir });
const page = await app.firstWindow();
const consoleLog = captureConsole(page);
await page.waitForLoadState("domcontentloaded");

RECORD.meta.fontWorkaround = (await installFontWorkaround(page)).workaround;
await installContextSpy(page);
await seedProject(page, { path: projectDir });
await seedTicketAndOpen(page, "VC-291 a11y probe");

await startTerminalSession(page.locator("aside"));
{
  const strip = page.getByRole("tablist", { name: "Ticket tabs" }).getByRole("tab");
  await waitUntil("session tab to appear", async () => (await strip.count()) >= 2, {
    timeout: 45000,
  });
  await strip.last().click();
  await sleep(400);
}
await waitUntil("terminal canvas", async () => (await visibleCanvasRects(page)).length >= 1, {
  timeout: 20000,
});
await sleep(2600);
await app.evaluate(({ BrowserWindow }) => {
  BrowserWindow.getAllWindows()[0].setContentSize(1280, 832);
});
RECORD.meta.backend = await readBackend(page);

/** This app's own pid — every AppleScript query targets it, never a name. */
const APP_PID = app.process().pid;
RECORD.meta.appPid = APP_PID;

const clickCanvas = (index = 0) => focusCanvasAt(page, index);

async function waitShellReady() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await fs.rm(READY_PROBE, { force: true });
    await clickCanvas();
    await page.keyboard.type(`echo ready-a11y-${attempt} > ${READY_PROBE}`);
    await page.keyboard.press("Enter");
    const got = await waitUntil(
      `shell ready #${attempt}`,
      async () => {
        try {
          return (await fs.readFile(READY_PROBE, "utf8")).includes("ready-a11y-") || null;
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

await waitShellReady();
await page.keyboard.type(`sh ${SEED_PATH}`);
await page.keyboard.press("Enter");
const pointed = await waitUntil(
  "seed reference",
  async () => {
    try {
      const parsed = parseBaselinePointer(await fs.readFile(POINTER_PATH, "utf8"), SEED_TOKEN);
      return parsed.ok ? parsed : null;
    } catch {
      return null;
    }
  },
  { timeout: 20000 },
).catch(() => null);
if (!pointed) throw new Error("seed never reported its reference file");

const REFERENCE_TEXT = await fs.readFile(pointed.path, "utf8");
const REFERENCE_LINES = REFERENCE_TEXT.replace(/\r\n/g, "\n")
  .split("\n")
  .filter((l) => l !== "");
const seedVerdict = verifySeedReference(REFERENCE_TEXT);
RECORD.meta.referenceFile = pointed.path;
RECORD.meta.seedVerification = seedVerdict;
requires(
  "seed",
  seedVerdict.ok,
  "the seed must be the intended 63-line sequence before anything is measured",
);
if (!seedVerdict.ok) {
  throw new Error(
    `seed did not produce the intended sequence: ${seedVerdict.problems.slice(0, 3).join("; ")}`,
  );
}
console.log(`  [seed] verified ${seedVerdict.lineCount} lines, pwd=${seedVerdict.pwd}`);
await sleep(800);

// ---- helpers ----------------------------------------------------------------

const setScrollFraction = async (fraction) => {
  const pane = await readPane(page, 0);
  if (!pane || pane.scrollHeight === null) return;
  await setScrollTop(page, 0, Math.round(fraction * (pane.scrollHeight - pane.clientHeight)));
};

const pbpaste = () => {
  try {
    return execFileSync("pbpaste", { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
};
const pbcopy = (text) => {
  execFileSync("pbcopy", { input: text });
};

/** Ask the pane for its own grid, so selection geometry uses the true row height. */
async function paneGrid(label) {
  const probe = join(SEED_DIR, `grid-${label}.txt`);
  await fs.rm(probe, { force: true });
  await waitShellReady();
  await page.keyboard.type(`stty size > ${probe}`);
  await page.keyboard.press("Enter");
  const text = await waitUntil(
    "stty size",
    async () => {
      try {
        const t = (await fs.readFile(probe, "utf8")).trim();
        return /^\d+\s+\d+$/.test(t) ? t : null;
      } catch {
        return null;
      }
    },
    { timeout: 8000 },
  ).catch(() => null);
  const [rows, cols] = (text ?? "45 80").split(/\s+/).map(Number);
  note(`grid-${label}`, { grid: text, rows, cols });
  return { rows, cols, raw: text };
}

// ---- A. accessibility --------------------------------------------------------

/**
 * Query the macOS AX tree for THIS app's pid — never by process name, so the
 * probe cannot wander onto some other Electron app the developer has open.
 *
 * `theWindow` is resolved rather than assumed to be `window 1`: a transient
 * sheet or toast takes that slot, and when it did, the value dump came back
 * empty and the window's role description read "dialog" — an inconclusive
 * reading that could easily have been written up as "the AX tree is empty".
 * The main window is the one whose role description is "standard window".
 */
function axQuery(body, timeout = 30000) {
  try {
    return execFileSync(
      "osascript",
      [
        "-e",
        `tell application "System Events"
           set target to first process whose unix id is ${APP_PID}
           tell target
             set theWindow to missing value
             repeat with w in windows
               try
                 if (role description of w) is "standard window" then
                   set theWindow to w
                   exit repeat
                 end if
               end try
             end repeat
             if theWindow is missing value then set theWindow to window 1
             ${body}
           end tell
         end tell`,
      ],
      { encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024 },
    ).trim();
  } catch (error) {
    return `refused: ${String(error.message).split("\n")[0]}`;
  }
}

async function accessibilityChecks(state) {
  const dom = await page.evaluate(() => {
    // Serialized into the page; it cannot live in this module's scope.
    // eslint-disable-next-line unicorn/consistent-function-scoping
    const attrs = (el) =>
      el
        ? {
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute("role"),
            ariaLabel: el.getAttribute("aria-label"),
            ariaRoleDescription: el.getAttribute("aria-roledescription"),
            ariaHidden: el.getAttribute("aria-hidden"),
            tabIndex: el.getAttribute("tabindex"),
            title: el.getAttribute("title"),
            textContentLength: el.textContent?.length ?? 0,
          }
        : null;
    const host = document.querySelector("[data-terminal-renderer]");
    const canvas = host?.querySelector("canvas");
    const ime = host?.querySelector("textarea");
    return {
      host: attrs(host),
      canvas: attrs(canvas),
      imeTextarea: attrs(ime),
      hostChildren: host ? Array.from(host.children).map((c) => c.className) : [],
      innerTextOfHost: host?.innerText?.length ?? 0,
      // Everything the browser considers focusable inside the pane.
      focusableInsidePane: host
        ? Array.from(
            host.querySelectorAll("a[href],button,input,textarea,select,canvas,[tabindex]"),
          ).map((el) => ({
            tag: el.tagName.toLowerCase(),
            cls: String(el.className).slice(0, 80),
            tabIndex: el.getAttribute("tabindex"),
          }))
        : [],
    };
  });
  requires(`a11y-dom-${state}`, dom.host !== null, "the terminal host's DOM semantics");
  note(`A1-dom-${state}`, dom);

  await clickCanvas();
  note(
    `A2-focus-after-click-${state}`,
    await page.evaluate(() => ({
      activeElement: document.activeElement?.tagName ?? "none",
      activeClass: String(document.activeElement?.className ?? "").slice(0, 120),
      activeTabIndex: document.activeElement?.getAttribute?.("tabindex") ?? null,
      activeAria: document.activeElement?.getAttribute?.("aria-label") ?? "",
    })),
  );

  // Tab and Shift-Tab: a terminal legitimately consumes Tab (the shell wants it
  // for completion), so the question is not "does Tab move focus" but "is there
  // ANY keyboard way out of the pane".
  const walk = async (key, presses) => {
    const seen = [];
    for (let i = 0; i < presses; i += 1) {
      await page.keyboard.press(key);
      await sleep(90);
      seen.push(
        await page.evaluate(() => ({
          tag: document.activeElement?.tagName ?? "none",
          cls: String(document.activeElement?.className ?? "").slice(0, 80),
          insideTerminal: Boolean(document.activeElement?.closest?.("[data-terminal-renderer]")),
        })),
      );
    }
    return seen;
  };
  const tabWalk = await walk("Tab", 8);
  const shiftTabWalk = await walk("Shift+Tab", 8);
  const escapeThenTab = await (async () => {
    await page.keyboard.press("Escape");
    await sleep(150);
    return walk("Tab", 3);
  })();
  note(`A3-keyboard-exit-${state}`, {
    tabEverLeaves: tabWalk.some((s) => !s.insideTerminal),
    shiftTabEverLeaves: shiftTabWalk.some((s) => !s.insideTerminal),
    escapeThenTabLeaves: escapeThenTab.some((s) => !s.insideTerminal),
    tabWalk,
    shiftTabWalk,
  });
  requires(`a11y-keyboard-exit-${state}`, true, "whether keyboard focus can leave the pane");

  // Chromium's own AX snapshot, when the bundled Playwright exposes it.
  let axTree = null;
  try {
    axTree = page.accessibility?.snapshot
      ? await page.accessibility.snapshot({ interestingOnly: false })
      : null;
  } catch (error) {
    axTree = `snapshot-failed: ${error.message}`;
  }
  if (axTree && typeof axTree === "object") {
    await fs
      .writeFile(join(EVIDENCE, `chromium-ax-${state}.json`), JSON.stringify(axTree, null, 2))
      .catch(() => {});
  }
  note(`A4-chromium-ax-${state}`, {
    available: axTree !== null && typeof axTree === "object",
    detail: typeof axTree === "string" ? axTree : undefined,
    bytes: typeof axTree === "object" && axTree ? JSON.stringify(axTree).length : 0,
    mentionsSeededText:
      typeof axTree === "object" && axTree ? /REFLOW/.test(JSON.stringify(axTree)) : null,
  });

  // The macOS AX tree — what VoiceOver reads.
  const windowReport = axQuery(`
    set kids to {}
    repeat with e in (UI elements of theWindow)
      try
        set end of kids to (role description of e) & ":" & ((description of e) as text)
      on error
        try
          set end of kids to (role description of e) as text
        end try
      end try
    end repeat
    return (role description of theWindow) & " | " & ((accessibility description of theWindow) as text) & " | title=" & ((title of theWindow) as text) & " || " & (kids as text)`);
  note(`A5-ax-window-${state}`, { pid: APP_PID, result: windowReport });

  const dumpBody = `set allText to {}
     set ec to entire contents of theWindow
     repeat with e in ec
       try
         set v to value of e
         if v is not missing value and (count of characters of (v as text)) > 0 then set end of allText to (v as text)
       end try
     end repeat
     set joined to ""
     repeat with t in allText
       set joined to joined & "\\n" & t
     end repeat
     return joined`;
  let dump = axQuery(dumpBody, 90000);
  // An empty dump is inconclusive, not a finding: it means no element carried a
  // value, INCLUDING the chrome that certainly has one. Retry once before
  // reporting, and say whether the retry was needed.
  let dumpRetried = false;
  if (typeof dump === "string" && dump.length === 0) {
    dumpRetried = true;
    await sleep(1500);
    dump = axQuery(dumpBody, 90000);
  }
  await fs.writeFile(join(EVIDENCE, `ax-values-${state}.txt`), dump ?? "").catch(() => {});
  const refused = typeof dump === "string" && dump.startsWith("refused:");
  requires(`a11y-ax-dump-${state}`, !refused, "the macOS AX value dump VoiceOver would read");
  const usableDump = !refused && typeof dump === "string" && dump.length > 0;
  requires(
    `a11y-ax-dump-usable-${state}`,
    usableDump,
    "a non-empty macOS AX value dump; an empty one cannot distinguish 'no terminal text' from 'the query read nothing at all'",
  );
  note(`A6-ax-entire-contents-${state}`, {
    bytes: dump?.length ?? 0,
    retried: dumpRetried,
    // Chrome IS exposed — which is what makes the absence of terminal text a
    // finding rather than an empty measurement.
    exposesAppChrome: usableDump && /Toggle Sidebar|Settings|Home/.test(dump),
    containsSeededText: typeof dump === "string" && /REFLOW/.test(dump),
    containsShort01: typeof dump === "string" && dump.includes(shortLine(1)),
    refused,
    detail: refused ? dump : undefined,
  });
  return { dom, axDump: dump };
}

/** Send one AppleScript, reporting a refusal instead of throwing. */
const keystroke = (script) => {
  try {
    execFileSync("osascript", ["-e", script], { encoding: "utf8", timeout: 10000 });
    return "ok";
  } catch (error) {
    return `refused: ${String(error.message).split("\n")[0]}`;
  }
};

/** VoiceOver's pid, or "" when it is not running. */
const voRunning = () => {
  try {
    return execFileSync("pgrep", ["-x", "VoiceOver"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

/**
 * VoiceOver: toggle it, drive its cursor, and record what could and could not
 * be captured — precisely, because "VoiceOver announced nothing" and "the
 * harness could not read VoiceOver" are very different claims.
 */
async function voiceOverPass(state) {
  const result = { state, attempted: true };

  result.wasRunningBefore = voRunning() !== "";
  result.toggleOn = keystroke('tell application "System Events" to key code 96 using command down');
  await sleep(3000);
  result.pidAfterToggle = voRunning();
  result.started = result.pidAfterToggle !== "";

  if (result.started) {
    // Focus the terminal, then walk VoiceOver's cursor: VO-Right is
    // Control-Option-RightArrow (key code 124).
    await clickCanvas().catch(() => {});
    await sleep(500);
    result.navigation = [];
    for (let i = 0; i < 5; i += 1) {
      const moved = keystroke(
        'tell application "System Events" to key code 124 using {control down, option down}',
      );
      await sleep(700);
      // Reading the announcement needs VoiceOver's own AppleScript dictionary,
      // which is off unless "Allow VoiceOver to be controlled with AppleScript"
      // is enabled in VoiceOver Utility. Record the exact refusal.
      let spoken;
      try {
        spoken = execFileSync(
          "osascript",
          ["-e", 'tell application "VoiceOver" to return content of vo cursor as text'],
          { encoding: "utf8", timeout: 8000 },
        ).trim();
      } catch (error) {
        spoken = `unreadable: ${String(error.message).split("\n")[0]}`;
      }
      result.navigation.push({ step: i + 1, moved, spoken });
    }
    result.announcementsCaptured = result.navigation.some(
      (n) => !n.spoken.startsWith("unreadable:"),
    );
    result.whyUnavailable = result.announcementsCaptured
      ? null
      : 'VoiceOver AppleScript control is disabled by default ("Allow VoiceOver to be controlled with AppleScript", VoiceOver Utility → General). The harness can start and drive VoiceOver but cannot read back what it spoke.';
    keystroke('tell application "System Events" to key code 96 using command down');
    await sleep(1500);
    result.stoppedAfterwards = voRunning() === "";
  } else {
    result.whyUnavailable =
      "⌘F5 did not start VoiceOver from this process — System Events keystroke permission or the VoiceOver shortcut is unavailable to an automated run.";
  }
  requires(
    `a11y-voiceover-${state}`,
    true,
    "VoiceOver toggle + navigation attempt, captured or precisely refused",
  );
  return note(`A7-voiceover-${state}`, result);
}

// ---- B. selection + copy -----------------------------------------------------

async function copyChecks(state) {
  const { rows, cols } = await paneGrid(`copy-${state}`);
  await setScrollFraction(0);
  const pane = await readPane(page, 0);
  if (!pane) {
    requires(`copy-${state}`, false, "a visible pane to select in");
    return note(`B-copy-${state}`, { error: "no pane" });
  }
  const rowHeight = pane.clip.height / rows;

  // Find the row REFLOW-SHORT-01 sits on rather than assuming the seed starts
  // at row 0 — the prompt and the `sh seed.sh` echo come first.
  const beforeShot = join(EVIDENCE, `copy-${state}-before.png`);
  await page.screenshot({ path: beforeShot, clip: pane.clip });
  const topText = await ocrImage(beforeShot);
  const ocrRows = topText.split("\n");
  const shortIndex = ocrRows.findIndex((l) => l.replace(/\s+/g, "").includes(shortLine(1)));
  const startRow = shortIndex >= 0 ? shortIndex : 1;

  // A UNIQUE SENTINEL, so "the clipboard holds the right text" cannot be
  // satisfied by the previous state's copy still sitting there. The first pass
  // reported the post-cycle copy as working while its own record showed the
  // clipboard never changed.
  const sentinel = `VC291-SENTINEL-${state}-${Date.now().toString(36)}`;
  pbcopy(sentinel);
  const clipboardBefore = pbpaste();

  const x0 = pane.clip.x + 6;
  const y0 = pane.clip.y + rowHeight * (startRow + 0.5);
  const x1 = pane.clip.x + pane.clip.width - 6;
  // Down to the end of the long line that follows SHORT-01: at 86 columns a
  // 259-character line occupies three rows, so four rows covers both.
  const y1 = pane.clip.y + rowHeight * (startRow + 4.5);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 12 });
  await sleep(200);
  await page.screenshot({ path: join(EVIDENCE, `copy-${state}-selected.png`), clip: pane.clip });
  await page.mouse.up();
  await sleep(250);
  await page.keyboard.press("Meta+c");
  await sleep(800);

  const after = pbpaste();
  await fs.writeFile(join(EVIDENCE, `clipboard-${state}.txt`), after ?? "").catch(() => {});
  const replacedSentinel = after !== null && after !== clipboardBefore && !after.includes(sentinel);
  const logical = unwrapCopiedText(after ?? "", cols);
  const contiguity = replacedSentinel
    ? copiedRunMatchesReference(logical, REFERENCE_LINES)
    : { ok: false, reason: "clipboard still holds the sentinel — ⌘C copied nothing" };
  const longWanted = longLine(1);
  const longActual = logical.find((l) => l.startsWith("REFLOW-LONG-01-")) ?? null;

  requires(`copy-${state}`, true, "a selection + ⌘C attempt with a sentinel");
  return note(`B-copy-${state}`, {
    sentinel,
    replacedSentinel,
    clipboardBytes: after?.length ?? 0,
    grid: { rows, cols },
    startRow,
    logicalLines: logical.length,
    firstLogicalLine: logical[0] ?? null,
    matchesReferenceExactly: contiguity.ok,
    contiguity,
    // The tail is the check the malformed seed could never have passed.
    longLineExact: longActual === longWanted,
    longLineHasEndTail: Boolean(longActual?.endsWith("-END")),
    longLineFill: longActual ? (/^REFLOW-LONG-01-(x*)/.exec(longActual)?.[1]?.length ?? 0) : 0,
    longLineExpectedFill: 240,
    longLineActualPreview: longActual
      ? `${longActual.slice(0, 24)}…${longActual.slice(-12)}`
      : null,
  });
}

async function keyboardSelectAttempt(state) {
  await setScrollFraction(0);
  await clickCanvas();
  const sentinel = `VC291-KEYBOARD-${state}-${Date.now().toString(36)}`;
  pbcopy(sentinel);
  for (let i = 0; i < 5; i += 1) await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Meta+c");
  await sleep(700);
  const after = pbpaste();
  requires(`keyboard-select-${state}`, true, "a keyboard-selection attempt with a sentinel");
  return note(`B-keyboard-select-${state}`, {
    sentinel,
    clipboardStillSentinel: after === sentinel || Boolean(after?.includes(sentinel)),
    copiedAnything: after !== null && !after.includes(sentinel),
    preview: (after ?? "").slice(0, 80),
  });
}

// ---- C. find -----------------------------------------------------------------

/** The real field, by its accessible name — not "the first visible input". */
function findField() {
  return page
    .locator('input[aria-label="Find in scrollback"], input[placeholder="Find in scrollback"]')
    .filter({ visible: true })
    .first();
}

async function findChecks(state) {
  await clickCanvas();
  await page.keyboard.press("Meta+f");
  await sleep(900);
  const opened = await page.evaluate(() => ({
    dialogs: document.querySelectorAll("[role=dialog]").length,
    visibleFields: Array.from(document.querySelectorAll("input,[contenteditable]"))
      .filter((el) => el.offsetParent !== null)
      .map((el) => el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? "")
      .filter(Boolean)
      .slice(0, 8),
  }));
  const fieldCount = await findField().count();
  requires(`find-${state}`, true, "a ⌘F attempt with the terminal focused");
  note(`C1-cmd-f-${state}`, { ...opened, findInScrollbackFieldPresent: fieldCount > 0 });

  const results = [];
  for (const query of [shortLine(1), "REFLOW-PWD-"]) {
    const before = await readPane(page, 0);
    let typed = false;
    if ((await findField().count()) > 0) {
      await findField()
        .fill(query, { timeout: 5000 })
        .then(() => (typed = true))
        .catch(() => {});
    }
    if (!typed) {
      results.push({
        query,
        typed: false,
        why: "the Find in scrollback field was not present to type into",
      });
      continue;
    }
    await sleep(1200);
    await page.keyboard.press("Enter");
    await sleep(900);
    const after = await readPane(page, 0);
    const shot = join(EVIDENCE, `find-${state}-${query.replace(/[^A-Za-z0-9]/g, "")}.png`);
    await page.screenshot({ path: shot, clip: after?.clip });
    const paneText = await ocrImage(shot);
    const flat = paneText.replace(/\s+/g, "");
    results.push({
      query,
      typed: true,
      scrollBefore: before
        ? `${before.scrollTop}/${before.scrollHeight - before.clientHeight}`
        : null,
      scrollAfter: after ? `${after.scrollTop}/${after.scrollHeight - after.clientHeight}` : null,
      viewportMoved: before?.scrollTop !== after?.scrollTop,
      // The match itself must be on screen — not merely the query echoed in
      // the find bar, which sits outside this clip.
      matchVisibleInPane: flat.includes(query.replace(/\s+/g, "")),
      screenshot: shot,
    });
    await page.keyboard.press("Escape");
    await sleep(400);
    await clickCanvas();
    await page.keyboard.press("Meta+f");
    await sleep(700);
  }
  await page.keyboard.press("Escape");
  await sleep(300);
  note(`C2-find-queries-${state}`, { results });

  // ⌘K quick-open, for contrast: app chrome only?
  await page.keyboard.press("Meta+k");
  await sleep(700);
  await page.keyboard.type(shortLine(1));
  await sleep(1200);
  await page.screenshot({ path: join(EVIDENCE, `find-quickopen-${state}.png`) });
  const quickOpen = await page.evaluate(() => ({
    mentionsSeededText: /REFLOW/.test(document.body.innerText.slice(0, 8000)),
    optionCount: document.querySelectorAll("[role=option], [cmdk-item]").length,
  }));
  note(`C3-quickopen-${state}`, quickOpen);
  await page.keyboard.press("Escape");
  await sleep(300);
  return results;
}

// ---- run both states ---------------------------------------------------------

try {
  console.log("\n--- state: fresh unsplit pane ---");
  await accessibilityChecks("unsplit");
  await voiceOverPass("unsplit");
  await copyChecks("unsplit");
  await keyboardSelectAttempt("unsplit");
  await findChecks("unsplit");

  console.log("\n--- transition: terminal focus, hide/show, split ---");
  await clickCanvas();
  await page.keyboard.press("Alt+Meta+Enter");
  await sleep(700);
  await page.keyboard.press("Alt+Meta+Enter");
  await sleep(700);
  const cycle = { focus: true };
  try {
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await sleep(900);
    await page.locator("article").filter({ hasText: "VC-1" }).first().dblclick({ timeout: 15000 });
    await sleep(900);
    await page.getByRole("tablist", { name: "Ticket tabs" }).getByRole("tab").last().click();
    await sleep(900);
    cycle.hideShow = true;
  } catch (error) {
    cycle.hideShow = false;
    cycle.hideShowError = String(error).slice(0, 160);
  }
  await clickCanvas();
  await page.keyboard.press("Shift+Meta+KeyD");
  cycle.split = await waitUntil(
    "split canvases",
    async () => (await visibleCanvasRects(page)).length >= 2,
    { timeout: 8000 },
  )
    .then(() => true)
    .catch(() => false);
  await sleep(1500);
  requires(
    "cycle",
    cycle.focus && cycle.hideShow && cycle.split,
    "the split+focus+hide/show transition",
  );
  note("B-cycle-navigation", cycle);

  console.log("\n--- state: after split + focus + hide/show ---");
  await accessibilityChecks("after-cycle");
  await voiceOverPass("after-cycle");
  await copyChecks("after-cycle");
  await keyboardSelectAttempt("after-cycle");
  await findChecks("after-cycle");
} catch (error) {
  RECORD.meta.fatal = String(error?.stack ?? error);
  console.error("FATAL:", error);
} finally {
  const folded = foldConsole(consoleLog);
  RECORD.meta.consoleByLevel = folded.byLevel;
  RECORD.meta.contextMessages = folded.contextMessages;
  RECORD.meta.consoleErrors = consoleLog.filter(
    (l) => l.type === "error" || l.type === "pageerror",
  );
  RECORD.meta.required = Object.fromEntries(required);
  RECORD.meta.finishedAt = new Date().toISOString();
  await fs.writeFile(join(EVIDENCE, "a11y.json"), JSON.stringify(RECORD, null, 2));
  await page.screenshot({ path: join(EVIDENCE, "final-window.png") }).catch(() => {});
  await app.close().catch(() => {});
  await fs.copyFile(pointed.path, join(EVIDENCE, "reference-a11y.txt")).catch(() => {});

  const holes = [...required.entries()].filter(([, v]) => !v.gathered);
  console.log(`\nevidence: ${EVIDENCE}`);
  if (RECORD.meta.fatal || holes.length > 0) {
    console.error("\nA11Y PROBE FAILED to gather required evidence:");
    for (const [id, v] of holes) console.error(`  - ${id}: ${v.why}`);
    if (RECORD.meta.fatal) console.error(`  - fatal: ${String(RECORD.meta.fatal).split("\n")[0]}`);
    process.exitCode = 1;
  } else {
    console.log(
      `\nA11Y PROBE OK: ${required.size} required measurement(s) gathered, ${RECORD.checks.length} checks`,
    );
  }
  if (cleanup) await cleanup();
}
