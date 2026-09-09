/**
 * VC-291 — VoiceOver/AX, selection+copy, and find checks for the terminal.
 *
 * Independent of the reflow matrix: boots a fresh app, seeds a terminal with
 * the ticket's REFLOW block, then runs:
 *   A. Accessibility: DOM roles/names of the terminal host + canvas, Tab-focus
 *      behaviour, the Chromium AX tree snapshot, and a macOS System Events AX
 *      query (what VoiceOver would see). Best-effort VoiceOver toggle attempt,
 *      honestly recorded when the harness lacks permission.
 *   B. Selection + copy: drag-select REFLOW-SHORT-01 through the end of the
 *      first long line, ⌘C, `pbpaste`, exact comparison. Keyboard-selection
 *      attempt. Repeated after a focus/split/hide-show cycle.
 *   C. Find: ⌘F with the terminal focused, ⌘K quick-open — does anything
 *      search terminal output?
 *
 *   Run: node apps/desktop/e2e/reflow-a11y-smoke.mjs <evidenceDir>
 */
import { execFile, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const argv = process.argv.slice(2);
const EVIDENCE = resolve(argv.find((a) => !a.startsWith("--")) ?? evidenceDir("vc291-a11y"));
await fs.mkdir(EVIDENCE, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Same handshake as the matrix harness: prove the shell executes input
 * before typing the seed (ticket PTYs spawn after a worktree ensure()). */
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
const RECORD = { meta: { startedAt: new Date().toISOString() }, checks: [] };
const note = (id, payload) => {
  RECORD.checks.push({ id, at: Date.now(), ...payload });
  console.log(`  [${id}] ${JSON.stringify(payload).slice(0, 400)}`);
};

// Same seed as the matrix harness.
const SEED_DIR = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "volli-reflow-seed-")));
const SEED_PATH = join(SEED_DIR, "seed.sh");
const BASELINE_POINTER = join(SEED_DIR, "baseline-path.txt");
const READY_PROBE = join(SEED_DIR, "ready.txt");
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

const { scratch, cleanup, dbPath, userDataDir } = await makeScratch("vc291-a11y-");
const projectDir = await makeGitRepo(scratch, "project-");

const app = await launch({ dbPath, userDataDir });
const page = await app.firstWindow();
const consoleLog = [];
page.on("console", (m) => consoleLog.push({ t: Date.now(), type: m.type(), text: m.text() }));
page.on("pageerror", (e) => consoleLog.push({ t: Date.now(), type: "pageerror", text: e.message }));
await page.waitForLoadState("domcontentloaded");

// Same Local Font Access workaround as the matrix harness (see its header):
// queryLocalFonts never resolves under automation on this macOS/Electron
// combo, wedging restty init; serve the real SFNSMono.ttf bytes instead.
const fontB64 = execFileSync("base64", ["-i", "/System/Library/Fonts/SFNSMono.ttf"], {
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
await sleep(1500);
await page.evaluate((path) => {
  localStorage.setItem(
    "volli:projects",
    JSON.stringify({
      state: {
        projects: [
          {
            id: "vc291-project",
            name: "VC291",
            path,
            ticketPrefix: "VC",
            colorIndex: 0,
            createdAt: Date.now(),
          },
        ],
        selectedProjectId: "vc291-project",
      },
      version: 1,
    }),
  );
}, projectDir);
await page.reload();
await page.waitForLoadState("domcontentloaded");
await waitUntil("project import", async () => {
  const names = await page
    .evaluate(async () => {
      const boot = await window.api.data.bootstrap();
      return boot.ok ? boot.data.projects.map((p) => p.name) : null;
    })
    .catch(() => null);
  return names !== null && names.includes("VC291");
}, { timeout: 20000 });
await waitUntil("board open", async () =>
  (await page.getByRole("button", { name: "New ticket", exact: true }).count()) > 0,
);
const seed = await page.evaluate(async () => {
  const boot = await window.api.data.bootstrap();
  const project = boot.data.projects[0];
  return window.api.tickets.create({
    projectId: project.id,
    status: "todo",
    title: "VC-291 a11y probe",
    priority: "medium",
  });
});
if (!seed.ok) throw new Error(`ticket seed failed: ${seed.error}`);
await page.reload();
await page.waitForLoadState("domcontentloaded");
await waitUntil("board open again", async () =>
  (await page.getByRole("button", { name: "New ticket", exact: true }).count()) > 0,
);
await page.locator("article").filter({ hasText: "VC-1" }).first().dblclick();
await sleep(900);

await startTerminalSession(page.locator("aside"));
{
  const strip = page.getByRole("tablist", { name: "Ticket tabs" }).getByRole("tab");
  await waitUntil("session tab to appear", async () => (await strip.count()) >= 2, {
    timeout: 45000,
  });
  await strip.last().click();
  await sleep(400);
}
await waitUntil(
  "terminal canvas",
  async () => {
    const c = await page.evaluate(() =>
      Array.from(document.querySelectorAll("canvas")).some(
        (el) => el.offsetParent !== null && el.clientWidth > 0,
      ),
    );
    return c;
  },
  { timeout: 20000 },
);
await sleep(2600);
await app.evaluate(({ BrowserWindow }) => {
  BrowserWindow.getAllWindows()[0].setContentSize(1280, 832);
});

const clickCanvas = async (fx = 0.5, fy = 0.5) => {
  const r = await page.evaluate(() => {
    const c = Array.from(document.querySelectorAll("canvas")).find(
      (el) => el.offsetParent !== null && el.clientWidth > 0 && el.clientHeight > 0,
    );
    if (!c) return null;
    const b = c.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  });
  if (!r) throw new Error("no visible canvas");
  await page.mouse.click(r.x + r.width * fx, r.y + r.height * fy);
  await sleep(250);
  return r;
};

await waitShellReady();
await page.keyboard.type(`sh ${SEED_PATH}`);
await page.keyboard.press("Enter");
const referenceFile = await waitUntil(
  "seed reference",
  async () => {
    try {
      return (await fs.readFile(BASELINE_POINTER, "utf8")).trim() || null;
    } catch {
      return null;
    }
  },
  { timeout: 15000 },
);
RECORD.meta.referenceFile = referenceFile;
await sleep(800);

const scrollHostInfo = () =>
  page.evaluate(() => {
    const host = Array.from(document.querySelectorAll(".restty-native-scroll-host")).find(
      (el) => el.offsetParent !== null,
    );
    if (!host) return null;
    const b = host.getBoundingClientRect();
    return {
      scrollTop: host.scrollTop,
      scrollHeight: host.scrollHeight,
      clientHeight: host.clientHeight,
      clip: { x: b.x, y: b.y, width: b.width, height: b.height },
    };
  });

const setScroll = async (f) => {
  await page.evaluate((frac) => {
    const host = Array.from(document.querySelectorAll(".restty-native-scroll-host")).find(
      (el) => el.offsetParent !== null,
    );
    if (host) host.scrollTop = Math.round(frac * (host.scrollHeight - host.clientHeight));
  }, f);
  await sleep(300);
};

// =====================================================================
// A. Accessibility
// =====================================================================
{
  // A1 — DOM truth of the terminal host + canvas.
  const dom = await page.evaluate(() => {
    const host = document.querySelector("[data-terminal-renderer]");
    const canvas = host?.querySelector("canvas");
    const attrs = (el) =>
      el
        ? {
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute("role"),
            ariaLabel: el.getAttribute("aria-label"),
            ariaRoleDescription: el.getAttribute("aria-roledescription"),
            tabIndex: el.getAttribute("tabindex"),
            title: el.getAttribute("title"),
            textContentLength: el.textContent?.length ?? 0,
          }
        : null;
    return {
      host: attrs(host),
      hostChildren: host ? Array.from(host.children).map((c) => c.className) : [],
      canvas: attrs(canvas),
      innerTextOfHost: host?.innerText?.length ?? 0,
    };
  });
  note("A1-dom-terminal", dom);

  // A2 — focus behaviour: click terminal, then Tab from chrome.
  await clickCanvas();
  const afterClick = await page.evaluate(() => ({
    activeElement: document.activeElement?.tagName ?? "none",
    activeClass: document.activeElement?.className?.slice?.(0, 120) ?? "",
    activeRole: document.activeElement?.getAttribute?.("role") ?? "",
    activeAria: document.activeElement?.getAttribute?.("aria-label") ?? "",
  }));
  note("A2-focus-after-click", afterClick);

  await page.keyboard.press("Escape"); // leave any input state
  await sleep(150);
  const focusWalk = [];
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press("Tab");
    await sleep(90);
    const el = await page.evaluate(() => ({
      tag: document.activeElement?.tagName ?? "none",
      cls: (document.activeElement?.className ?? "").toString().slice(0, 100),
      aria: document.activeElement?.getAttribute?.("aria-label") ?? "",
    }));
    focusWalk.push(el);
  }
  note("A3-tab-walk", { walk: focusWalk });

  // A4 — Chromium AX tree (what an AT would read through Chromium).
  let axTree = null;
  try {
    if (page.accessibility?.snapshot) {
      axTree = await page.accessibility.snapshot({ interestingOnly: false });
    }
  } catch (error) {
    axTree = `snapshot-failed: ${error.message}`;
  }
  const axFindings = axTree
    ? await (async (tree) => {
        const hits = [];
        const walk = (node, depth) => {
          if (!node || typeof node !== "object") return;
          const s = `${node.role ?? ""} ${node.name ?? ""}`;
          if (/terminal|REFLOW|canvas|PWD/i.test(s)) hits.push({ depth, role: node.role, name: node.name });
          for (const child of node.children ?? []) walk(child, depth + 1);
        };
        walk(tree, 0);
        return { total: JSON.stringify(tree).length, hits: hits.slice(0, 40) };
      })(axTree)
    : { available: false };
  await fs
    .writeFile(join(EVIDENCE, "chromium-ax-tree.json"), JSON.stringify(axTree, null, 2))
    .catch(() => {});
  note("A4-chromium-ax", axFindings);

  // A5 — macOS System Events AX query (the tree VoiceOver reads).
  let sysEvents = null;
  try {
    sysEvents = execFileSync(
      "osascript",
      [
        "-e",
        `tell application "System Events"
           set procs to name of every process
           set target to missing value
           repeat with p in procs
             if p is "Electron" or p is "Volli" or p contains "volli" then set target to p
           end repeat
           if target is missing value then return "no-electron-process"
           tell process target
             set frontmost to true
             delay 0.3
             set w to window 1
             set acc to accessibility description of w
             set roled to role description of w
             set kids to {}
             repeat with e in (UI elements of w)
               try
                 set end of kids to (role description of e) & ":" & (description of e)
               on error
                 try
                   set end of kids to (role description of e) as text
                 end try
               end try
             end repeat
             return roled & " | " & acc & " || " & (kids as text)
           end tell
         end tell`,
      ],
      { encoding: "utf8", timeout: 20000 },
    ).trim();
  } catch (error) {
    sysEvents = `refused: ${String(error.message).split("\n")[0]}`;
  }
  note("A5-system-events-window", { result: sysEvents });

  // Deep dump attempt: full window contents, filtered for REFLOW text.
  let deepDump = null;
  try {
    deepDump = execFileSync(
      "osascript",
      [
        "-e",
        `tell application "System Events"
           set target to missing value
           repeat with p in (name of every process)
             if p is "Electron" or p is "Volli" then set target to p
           end repeat
           if target is missing value then return "no-electron-process"
           tell process target
             set allText to {}
             set ec to entire contents of window 1
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
             return joined
           end tell
         end tell`,
      ],
      { encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1024 * 1024 },
    ).trim();
  } catch (error) {
    deepDump = `refused: ${String(error.message).split("\n")[0]}`;
  }
  const hasReflowInAX = typeof deepDump === "string" && /REFLOW/.test(deepDump);
  await fs.writeFile(join(EVIDENCE, "system-events-values.txt"), deepDump ?? "").catch(() => {});
  note("A6-system-events-entire-contents", {
    bytes: deepDump?.length ?? 0,
    containsREFLOW: hasReflowInAX,
    refused: deepDump?.startsWith("refused:"),
  });

  // A7 — VoiceOver toggle attempt (Command-F5). Honest record either way.
  let voToggle = "not-attempted";
  try {
    execFileSync(
      "osascript",
      ["-e", 'tell application "System Events" to key code 96 using command down'],
      { encoding: "utf8", timeout: 10000 },
    );
    await sleep(2500);
    const voRunning = execFileSync("pgrep", ["-x", "VoiceOver"], { encoding: "utf8" }).trim();
    voToggle = `toggled; VoiceOver pid=${voRunning}`;
    // Read what VO would announce, if VO AppleScript is permitted.
    let voText = null;
    try {
      voText = execFileSync(
        "osascript",
        ["-e", 'tell application "VoiceOver" to get the description of the cursor'],
        { encoding: "utf8", timeout: 8000 },
      ).trim();
    } catch (error) {
      voText = `refused: ${String(error.message).split("\n")[0]}`;
    }
    note("A7-voiceover-cursor", { voText });
    execFileSync(
      "osascript",
      ["-e", 'tell application "System Events" to key code 96 using command down'],
      { encoding: "utf8", timeout: 10000 },
    );
    await sleep(1200);
  } catch (error) {
    voToggle = `refused: ${String(error.message).split("\n")[0]}`;
  }
  note("A7-voiceover-toggle", { result: voToggle });
}

// =====================================================================
// B. Selection + copy
// =====================================================================
const pbpaste = () => {
  try {
    return execFileSync("pbpaste", { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
};

async function dragSelectAndCopy(label) {
  // Scroll to the very top: REFLOW-BEGIN is row 0, REFLOW-SHORT-01 row 1, the
  // first long line wraps rows 2..4 at these widths.
  await setScroll(0);
  const host = await scrollHostInfo();
  const rows = 45; // typical grid; refined below via canvas/stty not needed —
  // we select generously: from row 1 left edge to row 4 right edge.
  const rowH = host.clip.height / rows;
  const x0 = host.clip.x + 6;
  const y0 = host.clip.y + rowH * 1.5;
  const x1 = host.clip.x + host.clip.width - 6;
  const y1 = host.clip.y + rowH * 4.5;
  await page.screenshot({ path: join(EVIDENCE, `copy-${label}-before.png`), clip: host.clip });
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 12 });
  await sleep(200);
  await page.screenshot({ path: join(EVIDENCE, `copy-${label}-selected.png`), clip: host.clip });
  await page.mouse.up();
  await sleep(250);
  const before = pbpaste();
  await page.keyboard.press("Meta+c");
  await sleep(700);
  const after = pbpaste();
  await fs.writeFile(join(EVIDENCE, `clipboard-${label}.txt`), after ?? "").catch(() => {});
  const expected =
    "REFLOW-SHORT-01\nREFLOW-LONG-01-" + "x".repeat(240) + "-END";
  const got = (after ?? "").replace(/\r\n/g, "\n").replace(/\n$/, "");
  const exact = got === expected;
  note(`B-copy-${label}`, {
    clipboardBytes: after?.length ?? 0,
    changedFromBefore: after !== before,
    exactMatch: exact,
    first120: (after ?? "").slice(0, 120),
    endsWithEnd: (after ?? "").trimEnd().endsWith("-END"),
  });
  await setScroll(1);
  return { exact, got };
}

async function keyboardSelectAttempt(label) {
  await setScroll(0);
  await clickCanvas(0.1, 0.12); // near REFLOW-BEGIN area
  const before = pbpaste();
  for (let i = 0; i < 5; i += 1) await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Meta+c");
  await sleep(600);
  const after = pbpaste();
  note(`B-keyboard-select-${label}`, {
    clipboardChanged: after !== before,
    clipboardPreview: (after ?? "").slice(0, 80),
  });
}

await dragSelectAndCopy("unsplit");
await keyboardSelectAttempt("unsplit");

// Cycle: focus enter/leave, hide/show, split — then repeat the copy check.
await page.keyboard.press("Alt+Meta+Enter");
await sleep(600);
await page.keyboard.press("Alt+Meta+Enter");
await sleep(600);
await page.keyboard.press("Escape"); // ticket detail → board
await sleep(700);
await page.locator("article").filter({ hasText: "VC-1" }).first().dblclick();
await sleep(900);
await clickCanvas();
await page.keyboard.press("Shift+Meta+KeyD"); // horizontal split
await waitUntil("split canvases", async () => {
  const n = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll("canvas")).filter(
        (el) => el.offsetParent !== null && el.clientWidth > 0,
      ).length,
  );
  return n >= 2;
}, { timeout: 8000 });
await sleep(1500);
await dragSelectAndCopy("after-cycle");
await keyboardSelectAttempt("after-cycle");

// =====================================================================
// C. Find
// =====================================================================
{
  await clickCanvas();
  // C1 — ⌘F with the terminal focused: does any find UI open?
  await page.keyboard.press("Meta+f");
  await sleep(900);
  const afterCmdF = await page.evaluate(() => ({
    dialogs: document.querySelectorAll("[role=dialog]").length,
    findbars: Array.from(document.querySelectorAll("input,[contenteditable]"))
      .filter((el) => el.offsetParent !== null)
      .map((el) => el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? "")
      .filter(Boolean)
      .slice(0, 8),
  }));
  await page.keyboard.press("Escape");
  await sleep(300);
  note("C1-cmd-f-terminal-focused", afterCmdF);

  // C2 — quick-open (⌘K): app-chrome search; does it see terminal output?
  await page.keyboard.press("Meta+k");
  await sleep(700);
  await page.keyboard.type("REFLOW-SHORT-01");
  await sleep(1200);
  await page.screenshot({ path: join(EVIDENCE, "find-quickopen.png") });
  const qoText = await page.evaluate(() => document.body.innerText.slice(0, 4000));
  note("C2-quickopen", {
    mentionsREFLOW: /REFLOW/.test(qoText),
    optionCount: await page
      .evaluate(() => document.querySelectorAll("[role=option], [cmdk-item]").length)
      .catch(() => -1),
  });
  await page.keyboard.press("Escape");
  await sleep(300);

  // C3 — restty's own search UI: reachable through the app at all?
  // (shortcuts:false at createRestty; nothing else mounts it — verified in
  // source. Record the DOM absence.)
  const searchUi = await page.evaluate(
    () => document.querySelectorAll("[class*=search], [class*=find], [data-search]").length,
  );
  note("C3-dom-search-uis", { count: searchUi });
}

RECORD.meta.consoleErrors = consoleLog.filter((l) => l.type === "error" || l.type === "pageerror");
await fs.writeFile(join(EVIDENCE, "a11y.json"), JSON.stringify(RECORD, null, 2));
await page.screenshot({ path: join(EVIDENCE, "final-window.png") }).catch(() => {});
await app.close().catch(() => {});
console.log(`\nevidence: ${EVIDENCE}`);
if (referenceFile) {
  await fs.copyFile(referenceFile, join(EVIDENCE, "reference-a11y.txt")).catch(() => {});
  console.log(`reference: ${referenceFile}`);
}
if (cleanup) await cleanup();
