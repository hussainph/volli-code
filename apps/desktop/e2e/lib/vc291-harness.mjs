/**
 * VC-291 — plumbing shared by the reflow matrix and the accessibility probe.
 *
 * These two harnesses started as copies of each other and drifted: the same
 * font workaround, the same project seeding, the same scroll-host reader and
 * the same seed script existed twice, and when the seed turned out to be
 * malformed BOTH had to be wrong in the same way for the results to agree —
 * which is exactly what happened. Everything with one correct answer lives
 * here now.
 *
 * Scope note: this is desktop end-to-end plumbing — Electron, Playwright,
 * macOS Vision OCR, AppleScript. It stays inside `apps/desktop/e2e/lib/` and
 * nothing here belongs in a shared domain package.
 */
import { execFile, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { APP_DIR, REPO, waitUntil } from "./smoke-kit.mjs";
import { findExpectedLines } from "./vc291-seed.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Non-fatal system probe: a missing tool must not abort an evidence run. */
export const sys = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).trim();
  } catch {
    return "unavailable";
  }
};

// ---------------------------------------------------------------------------
// Run metadata
// ---------------------------------------------------------------------------

/**
 * Facts about the machine and build under test.
 *
 * Everything here is MEASURED. The first pass recorded `shell: "unknown"`
 * (it read `process.env.SHELL`, which Electron's launch env does not carry)
 * and inferred an external monitor from a string-replace heuristic that
 * counted the built-in panel twice. Both are read properly now, and the shell
 * that matters — the one inside the PTY — is asked in the pane itself, by
 * `probePaneShell`.
 */
export async function collectRunMetadata({ extra = {} } = {}) {
  const displays = sys("system_profiler", ["SPDisplaysDataType", "-json"]);
  let displayList = [];
  try {
    const parsed = JSON.parse(displays);
    displayList = (parsed.SPDisplaysDataType ?? []).flatMap((gpu) =>
      (gpu.spdisplays_ndrvs ?? []).map((d) => ({
        // `_name` and `_spdisplays_resolution` are system_profiler's own JSON
        // keys; the leading underscore is theirs, not this codebase's.
        /* eslint-disable no-underscore-dangle */
        name: d._name,
        resolution: d._spdisplays_resolution ?? d.spdisplays_resolution ?? null,
        /* eslint-enable no-underscore-dangle */
        main: d.spdisplays_main === "spdisplays_yes",
        connection: d.spdisplays_connection_type ?? null,
        virtual: d.spdisplays_virtual_device === "spdisplays_yes",
      })),
    );
  } catch {
    displayList = [];
  }
  const physical = displayList.filter((d) => !d.virtual);

  return {
    commit: sys("git", ["-C", REPO, "rev-parse", "HEAD"]),
    commitShort: sys("git", ["-C", REPO, "rev-parse", "--short", "HEAD"]),
    branch: sys("git", ["-C", REPO, "rev-parse", "--abbrev-ref", "HEAD"]),
    treeDirty: sys("git", ["-C", REPO, "status", "--porcelain"]) !== "",
    appVersion: JSON.parse(await fs.readFile(join(APP_DIR, "package.json"), "utf8")).version,
    electron:
      JSON.parse(await fs.readFile(join(APP_DIR, "package.json"), "utf8")).devDependencies
        ?.electron ?? null,
    macOS: sys("sw_vers", ["-productVersion"]),
    macOSBuild: sys("sw_vers", ["-buildVersion"]),
    hardware: sys("sysctl", ["-n", "machdep.cpu.brand_string"]),
    displays: displayList,
    displayCount: physical.length,
    externalMonitorAttached: physical.some((d) => !d.main),
    node: process.version,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Renderer instrumentation
// ---------------------------------------------------------------------------

/**
 * LOCAL FONT ACCESS WORKAROUND (VC-347).
 *
 * On macOS 26 + this Electron under Playwright, `window.queryLocalFonts()`
 * never settles — no resolve, no reject. restty awaits it during init, so no
 * renderer is ever created: no GPU context, nothing painted, keystrokes
 * swallowed. The repo's own `terminal-smoke.mjs` is red for the same reason.
 *
 * The stub serves restty the REAL system mono face's bytes, so the renderer
 * runs against a real installed font. Everything downstream of font loading —
 * WebGPU/WebGL2, the VT parser, scrollback, refit, the PTY — is production
 * code. Recorded in every run-config.json, and filed as VC-347.
 */
export async function installFontWorkaround(page, fontPath = "/System/Library/Fonts/SFNSMono.ttf") {
  const fontB64 = execFileSync("base64", ["-i", fontPath], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
  await page.addInitScript(
    (payload) => {
      if (!window.queryLocalFonts) return;
      const bytes = Uint8Array.from(atob(payload.b64), (c) => c.charCodeAt(0));
      window.queryLocalFonts = async () =>
        payload.families.map((family) => ({
          family,
          style: "Regular",
          weight: 400,
          blob: async () => new Blob([bytes.slice()], { type: "font/ttf" }),
        }));
    },
    {
      b64: fontB64,
      families: [
        "SF Mono",
        "Menlo",
        "Apple Symbols",
        "STIX Two Math",
        "Apple Color Emoji",
        "Monaco",
        "Courier New",
      ],
    },
  );
  return { fontPath, workaround: `queryLocalFonts stubbed with real ${fontPath} bytes (VC-347)` };
}

/**
 * Record which canvas backend the renderer actually acquired, and optionally
 * force the WebGL2 fallback by hiding `navigator.gpu`.
 *
 * Forcing is harness-only: the product has no supported lever (VC-348). A row
 * that claims to have exercised WebGL2 must prove it through `readBackend`,
 * never through the flag alone.
 */
export async function installContextSpy(page, { forceWebgl2 = false } = {}) {
  await page.addInitScript(() => {
    window.volliCtxSpy = [];
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function getContext(type, ...rest) {
      const ctx = original.call(this, type, ...rest);
      window.volliCtxSpy.push({ type, ok: ctx != null });
      return ctx;
    };
  });
  if (forceWebgl2) {
    await page.addInitScript(() => {
      try {
        Object.defineProperty(Navigator.prototype, "gpu", {
          get: () => undefined,
          configurable: true,
        });
      } catch {
        /* best effort: a locked-down prototype leaves WebGPU in place, and
           readBackend then reports the truth rather than the intent */
      }
    });
  }
}

export const readBackend = (page) =>
  page.evaluate(() => {
    const ctx = window.volliCtxSpy ?? [];
    return {
      webgpu: ctx.some((c) => c.type === "webgpu" && c.ok),
      webgl2: ctx.some((c) => c.type === "webgl2" && c.ok),
      navigatorGpu: typeof navigator?.gpu !== "undefined",
      contexts: ctx.length,
    };
  });

/** Every console line, at every level — the WebGL eviction signal is a warning. */
export function captureConsole(page) {
  const lines = [];
  page.on("console", (m) => lines.push({ t: Date.now(), type: m.type(), text: m.text() }));
  page.on("pageerror", (e) => lines.push({ t: Date.now(), type: "pageerror", text: e.message }));
  return lines;
}

/** Fold a console log by level, and pull out GPU context/device messages. */
export function foldConsole(lines) {
  const byLevel = {};
  for (const l of lines) byLevel[l.type] = (byLevel[l.type] ?? 0) + 1;
  const contextMessages = lines.filter((l) =>
    /too many active webgl|context will be lost|context lost|device.*lost|driver reset|restored/i.test(
      l.text ?? "",
    ),
  );
  return { byLevel, contextMessages, total: lines.length };
}

// ---------------------------------------------------------------------------
// Project + ticket seeding
// ---------------------------------------------------------------------------

/**
 * Seed the scratch project through the legacy-envelope import.
 *
 * smoke-kit's `seedProjects` reloads the instant the envelope is written,
 * which races this app's first boot and drops the import; a settle delay
 * before AND after the reload lands it reliably.
 */
export async function seedProject(page, { id = "vc291-project", name = "VC291", path }) {
  await sleep(1500);
  await page.evaluate(
    (p) => {
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
    },
    { id, name, path },
  );
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
      return names !== null && names.includes(name);
    },
    { timeout: 20000 },
  );
}

export async function seedTicketAndOpen(page, title) {
  await waitUntil(
    "board open",
    async () => (await page.getByRole("button", { name: "New ticket", exact: true }).count()) > 0,
  );
  const seed = await page.evaluate(async (t) => {
    const boot = await window.api.data.bootstrap();
    if (!boot.ok) return boot;
    return window.api.tickets.create({
      projectId: boot.data.projects[0].id,
      status: "todo",
      title: t,
      priority: "medium",
    });
  }, title);
  if (!seed.ok) throw new Error(`ticket seed failed: ${seed.error}`);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await waitUntil(
    "board open again",
    async () => (await page.getByRole("button", { name: "New ticket", exact: true }).count()) > 0,
  );
  await page.locator("article").filter({ hasText: "VC-1" }).first().dblclick();
  await sleep(900);
}

// ---------------------------------------------------------------------------
// Terminal pane geometry
// ---------------------------------------------------------------------------

/** Visible terminal canvases, in spatial (top-left first) order. */
export const visibleCanvasRects = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("canvas"))
      .filter((c) => c.offsetParent !== null && c.clientWidth > 0 && c.clientHeight > 0)
      .map((c) => {
        const r = c.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })
      .toSorted((a, b) => a.y - b.y || a.x - b.x),
  );

export async function focusCanvasAt(page, index = 0) {
  const rects = await visibleCanvasRects(page);
  const rect = rects[index];
  if (!rect) throw new Error(`visible canvas ${index} missing (count=${rects.length})`);
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await sleep(250);
  return rect;
}

/**
 * The state of one terminal pane's scroll host, and WHICH pane it is.
 *
 * Every claim about retained scrollback has to name the pane it measured: a
 * newly created terminal that stole the active tab otherwise reads as "the
 * seeded pane lost everything".
 */
export function readPane(page, paneIndex = 0) {
  return page.evaluate((idx) => {
    // These helpers are serialized into the page: they cannot be hoisted out
    // of the evaluate callback, which is what the rule would have us do.
    // eslint-disable-next-line unicorn/consistent-function-scoping
    const visible = (sel) =>
      Array.from(document.querySelectorAll(sel)).filter((el) => el.offsetParent !== null);
    let roots = visible("[data-terminal-pane-id]");
    if (roots.length === 0) roots = visible("[data-terminal-renderer]");
    roots = roots.toSorted((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return ra.y - rb.y || ra.x - rb.x;
    });
    const root = roots[idx];
    if (!root) return null;
    const host = root.querySelector(".restty-native-scroll-host");
    const renderer = root.matches("[data-terminal-renderer]")
      ? root
      : root.querySelector("[data-terminal-renderer]");
    const box = (host ?? renderer ?? root).getBoundingClientRect();
    // Serialized into the page; it cannot live in this module's scope.
    // eslint-disable-next-line unicorn/consistent-function-scoping
    const idOf = (el) =>
      el?.getAttribute?.("data-terminal-pane-id") ??
      el?.getAttribute?.("data-terminal-renderer") ??
      null;

    // Which pane the app considers active, two independent ways: the pane
    // holding DOM focus, and the pane the split layout rings as active.
    const focusedPaneId = idOf(
      document.activeElement?.closest?.("[data-terminal-pane-id],[data-terminal-renderer]"),
    );
    const ringed = visible("[data-terminal-pane-id]").filter((el) =>
      el.className.includes("ring-primary"),
    );

    return {
      paneId: idOf(root),
      paneIndex: idx,
      paneCount: roots.length,
      scrollTop: host ? host.scrollTop : null,
      scrollHeight: host ? host.scrollHeight : null,
      clientHeight: host ? host.clientHeight : null,
      clip: { x: box.x, y: box.y, width: box.width, height: box.height },
      dpr: window.devicePixelRatio,
      focusedPaneId,
      ringActivePaneId: ringed.length === 1 ? idOf(ringed[0]) : null,
      liveTerminalHosts: document.querySelectorAll("[data-terminal-renderer]").length,
    };
  }, paneIndex);
}

/** A pane reading folded for the record. */
export function paneReading(pane) {
  if (!pane) return null;
  const max = pane.scrollHeight === null ? null : pane.scrollHeight - pane.clientHeight;
  return {
    paneId: pane.paneId,
    top: pane.scrollTop,
    max,
    height: pane.scrollHeight,
    client: pane.clientHeight,
    dpr: pane.dpr,
    focusedPaneId: pane.focusedPaneId,
    ringActivePaneId: pane.ringActivePaneId,
    paneCount: pane.paneCount,
  };
}

/**
 * Is the viewport still following the bottom? A checked boolean, so anchoring
 * is a recorded RESULT rather than something a reader infers from two numbers.
 *
 * `anchorTolerance` is about one text row: the host settles a pixel or two off
 * the exact bottom after a refit even when it IS following the tail.
 */
export const isAnchoredAtBottom = (pane, { anchorTolerance = 16 } = {}) => {
  if (!pane || pane.scrollHeight === null) return undefined;
  const max = pane.scrollHeight - pane.clientHeight;
  return max <= 0 ? true : pane.scrollTop >= max - anchorTolerance;
};

export async function setScrollTop(page, paneIndex, top) {
  await page.evaluate(
    ({ idx, t }) => {
      // Serialized into the page; it cannot live in this module's scope.
      // eslint-disable-next-line unicorn/consistent-function-scoping
      const visible = (sel) =>
        Array.from(document.querySelectorAll(sel)).filter((el) => el.offsetParent !== null);
      let roots = visible("[data-terminal-pane-id]");
      if (roots.length === 0) roots = visible("[data-terminal-renderer]");
      roots = roots.toSorted((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return ra.y - rb.y || ra.x - rb.x;
      });
      const host = roots[idx]?.querySelector(".restty-native-scroll-host");
      if (host) host.scrollTop = t;
    },
    { idx: paneIndex, t: top },
  );
  await sleep(240);
}

// ---------------------------------------------------------------------------
// Reading canvas text
// ---------------------------------------------------------------------------

/** OCR one image through the macOS Vision framework (canvas text is not DOM). */
export const ocrImage = (path) =>
  new Promise((resolve) => {
    execFile(
      "osascript",
      ["-l", "JavaScript", join(APP_DIR, "e2e", "lib", "ocr.js"), path],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 30000 },
      (error, out) => resolve(error ? "" : out),
    );
  });

/**
 * Step the seeded pane through its WHOLE scrollback, screenshot and OCR every
 * step, and union the expected lines found.
 *
 * Two properties this owes the ticket:
 *
 *  - "reachable by scrolling" is answered for the entire buffer, not for three
 *    sampled viewports, because the REFLOW-CHECK probes grow the buffer at
 *    every checkpoint.
 *  - the user's scroll position is RESTORED afterwards and the restoration is
 *    reported, so measuring the viewport does not destroy the very drift the
 *    matrix is trying to observe.
 */
export async function fullSweep(page, { evidenceDir, name, paneIndex = 0, keepText = true }) {
  const before = await readPane(page, paneIndex);
  if (!before || before.scrollHeight === null) {
    return { steps: 0, markers: {}, shots: [], restored: null, unreadable: "no scroll host" };
  }
  const max = Math.max(0, before.scrollHeight - before.clientHeight);
  const step = Math.max(80, Math.floor(before.clientHeight * 0.85));
  const tops = [];
  for (let top = 0; top < max; top += step) tops.push(top);
  tops.push(max);

  const shots = [];
  const markers = {};
  const detail = {};
  const whereFound = {};
  for (const [i, top] of tops.entries()) {
    await setScrollTop(page, paneIndex, top);
    const at = await readPane(page, paneIndex);
    const file = `${name}-s${String(i).padStart(2, "0")}.png`;
    await page.screenshot({ path: join(evidenceDir, file), clip: at?.clip });
    const text = await ocrImage(join(evidenceDir, file));
    if (keepText) await fs.writeFile(join(evidenceDir, `${file}.txt`), text).catch(() => {});
    const { found, detail: d } = findExpectedLines(text);
    shots.push({ file, requestedTop: top, actualTop: at?.scrollTop, ocrChars: text.length });
    for (const [k, v] of Object.entries(found)) {
      if (v && whereFound[k] === undefined) whereFound[k] = at?.scrollTop ?? top;
      if (v && (d[k]?.fill ?? 0) > (detail[k]?.fill ?? 0)) detail[k] = d[k];
      markers[k] = markers[k] || v;
    }
  }

  // Put the viewport back where the user (and the previous checkpoint) had it.
  await setScrollTop(page, paneIndex, before.scrollTop);
  const after = await readPane(page, paneIndex);
  return {
    steps: tops.length,
    markers,
    detail,
    whereFound,
    shots,
    scrollMax: max,
    restored: after ? { wanted: before.scrollTop, got: after.scrollTop } : null,
  };
}

/**
 * A single screenshot of the pane exactly as it stands, with no scrolling.
 *
 * This is what makes a transient failure durable: it is taken at the action
 * boundary, before any sweep, resize or refit could repaint the pane and hide
 * what the user would have seen.
 */
export async function captureAtRest(page, { evidenceDir, name, paneIndex = 0 }) {
  const pane = await readPane(page, paneIndex);
  const file = `${name}-atrest.png`;
  await page.screenshot({ path: join(evidenceDir, file), clip: pane?.clip }).catch(() => {});
  const text = await ocrImage(join(evidenceDir, file));
  await fs.writeFile(join(evidenceDir, `${file}.txt`), text).catch(() => {});
  const { found } = findExpectedLines(text);
  return { file, visibleMarkers: found, ocrChars: text.length };
}
