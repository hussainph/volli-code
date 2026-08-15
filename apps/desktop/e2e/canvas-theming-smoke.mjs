/**
 * End-to-end acceptance smoke for the CANVAS theming system
 * (docs/plans/arc-theming-migration.md). Replaces `theming-smoke.mjs`, which
 * entered every one of its 27 cases through the theme picker that migration
 * deleted — the assertions mostly survived, the harness did not.
 *
 * What changed, and what did not:
 *
 *   • ENTRY. There is no picker and no theme catalogue. A scope stores a
 *     `Canvas` (1–3 positioned stops + vibrancy + grain) and an `Appearance`
 *     (light | dark | auto), each independently overridable per workspace. So
 *     the canvas is seeded by AUTHORING one through the real editor on
 *     Settings → Appearance (swatch, vibrancy, grain, a dragged stop), and the
 *     appearance by the Mode control beside it.
 *   • THE WINDOW BACKGROUND IS NOT `--background` ANY MORE. It is the canvas's
 *     BASE FILL (`windowBackground` → `baseFillHex`), and with a canvas armed
 *     the two differ deliberately — the card's rung is no longer what Chromium
 *     paints at the window edge. Checks 3/7 assert both halves of that: equal to
 *     the base fill, AND different from `--background`.
 *   • BOTH MODES SHIP. `class="dark"` is unpinned, so every token table is now
 *     two tables, and `color-scheme` has to move with them or native form
 *     controls stay dark on a light canvas.
 *   • FIRST PAINT IS A HINT, NOT A MEDIA QUERY. Main reads the `first-paint`
 *     row synchronously at window construction, sets `BrowserWindow`'s
 *     background from it, and passes the resolved mode to preload via
 *     `additionalArguments`; preload stamps the class before any page script.
 *     Check 14 boots with that hint at `light` and samples the first ~20 frames
 *     for a dark one.
 *   • AND NEITHER IS `auto`. The renderer cannot read the system's mode at all:
 *     Chromium resolves `prefers-color-scheme` against the root element's used
 *     `color-scheme`, which this app stamps, so the query answers with the mode
 *     already painted. `nativeTheme` in main is the source — over
 *     `additionalArguments` for the first answer and over an event for every
 *     one after. Checks 24/25 are the two halves of that: main and the window
 *     agree on `auto`, and a forced `themeSource` repaints the live window.
 *
 * The eleven ghostty / relaunch / scope-precedence assertions are carried over
 * from the deleted smoke close to verbatim — those surfaces were meant to
 * survive the migration untouched, so proving they did is the point.
 *
 * MANUALLY RUN (needs a display + the built app); CI does not run it:
 *
 *   pnpm -w run build
 *   node apps/desktop/e2e/canvas-theming-smoke.mjs
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { APCAcontrast, sRGBtoY } from "apca-w3";

import {
  assertProfileIsolated,
  createRunner,
  launch,
  makeGitRepo,
  makeScratch,
  pathExists,
  readFileSafe,
  readSeededProjects,
  seedProjects,
  sleep,
  waitUntil,
} from "./lib/smoke-kit.mjs";

/**
 * The canvas pipeline's output for the SHIPPED DEFAULT canvas
 * (`DEFAULT_CANVAS` — one ember pool at 68%/30%, vibrancy 0.6, grain 0.15), in
 * each mode. The THIRD independent pin on these values: `derive.test.ts` pins
 * them against the color math, `globals.css` authors them for first paint, and
 * this table proves the running app actually renders them. All three move
 * together or one of them fails.
 *
 * Veils are included because `applyThemeTokens` writes them in the same pass —
 * a veil left behind freezes the sidebar on the previous canvas's rung.
 */
const DARK = {
  "--rail": "#170f0b",
  "--background": "#1c1310",
  "--card": "#211815",
  "--popover": "#251b18",
  "--muted": "#271d1a",
  "--accent": "#2d2220",
  "--sidebar": "#211815",
  "--foreground": "#e8e4e2",
  "--muted-foreground": "#bdbab8",
  "--sidebar-foreground": "#d0cdcb",
  "--border": "#312623",
  "--border-strong": "#423632",
  "--sidebar-border": "#2d241f",
  "--primary": "#d37550",
  "--primary-foreground": "#ffffff",
  "--primary-text": "#fc9a74",
  "--ring": "#d37550",
  "--destructive": "#ffa49f",
  "--destructive-foreground": "#290b0b",
  "--positive": "#27d496",
  "--positive-foreground": "#001c10",
  "--attention": "#ffaa2f",
  "--attention-foreground": "#221200",
  "--info": "#65c6ff",
  "--info-foreground": "#001827",
  "--sidebar-veil": "rgb(123 105 111 / 0.1)",
  "--sidebar-accent-veil": "rgb(153 124 131 / 0.1)",
  "--sidebar-border-veil": "rgb(153 144 121 / 0.1)",
  "--canvas-ink": "#fbf1ed",
  "--canvas-ink-label": "#d2c8c5",
  "--canvas-ink-muted": "#b6aca9",
  "--lift-1": "transparent",
  "--lift-2": "rgb(251 241 237 / 0.03)",
  "--label-ink": "#d5d1cf",
};

const LIGHT = {
  "--rail": "#edd1c6",
  "--background": "#fdded2",
  "--card": "#f4d4c8",
  "--popover": "#f7d8cc",
  "--muted": "#eacabd",
  "--accent": "#dab9ad",
  "--sidebar": "#e2c3b7",
  "--foreground": "#120906",
  "--muted-foreground": "#514541",
  "--sidebar-foreground": "#080302",
  "--border": "#d8b6a9",
  "--border-strong": "#d5b2a5",
  "--sidebar-border": "#ddbbad",
  "--primary": "#d37550",
  "--primary-foreground": "#ffffff",
  "--primary-text": "#9c441e",
  "--ring": "#d37550",
  "--destructive": "#9b1e28",
  "--destructive-foreground": "#ffffff",
  "--positive": "#005f40",
  "--positive-foreground": "#ffffff",
  "--attention": "#764900",
  "--attention-foreground": "#ffffff",
  "--info": "#005880",
  "--info-foreground": "#ffffff",
  "--sidebar-veil": "rgb(127 69 48 / 0.1)",
  "--sidebar-accent-veil": "rgb(146 95 83 / 0.1)",
  "--sidebar-border-veil": "rgb(176 115 83 / 0.1)",
  "--canvas-ink": "#1c110d",
  "--canvas-ink-label": "#392c28",
  "--canvas-ink-muted": "#4c3f3a",
  "--lift-1": "transparent",
  "--lift-2": "rgb(253 222 210 / 0.175)",
  "--label-ink": "#2f2521",
};

/** The default canvas's base fill per mode — what the WINDOW edge is painted. */
const BASE_FILL = { dark: "#481600", light: "#ff9970" };

/**
 * Swatches from the editor's own palette.
 *
 * All three live on `CANVAS_SWATCH_PAGES[1]`, the page the ember default sits
 * on — and that is a requirement, not a convenience: the swatch grid FOLLOWS the
 * primary, so a hex from the other page is simply not on screen and its locator
 * would never resolve. Each is far enough round the wheel from the last that
 * every derived token moves visibly.
 */
const AUTHORED_HEX = "#2e6f8e"; // global, authored in check 12
const WORKSPACE_HEX = "#4a7d5b"; // workspace A's override, check 16
const REGLOBAL_HEX = "#c53d43"; // the app-wide change of check 20
const AUTHORED_VIBRANCY = "0.9";
const AUTHORED_GRAIN = "0.4";

/**
 * Typed into the hex field and then Escaped, in check 13 — deliberately NOT one
 * of the swatches above, and far enough from the authored primary that a canvas
 * still wearing it is unmistakable.
 */
const ABANDONED_HEX = "#7a2ea8";

/** A ghostty theme with an unmistakable name, for proving a real overlay write. */
const OVERLAY_THEME = "Aardvark Blue";

/**
 * Comfortably past the 300ms crossfade (renderer/src/theme/scope-transition.ts).
 * Spent only to prove the view transition has torn itself down, so a generous
 * margin costs one wait per use.
 */
const SCOPE_SETTLE_MS = 700;

/**
 * `--theme-scope-crossfade` at rest and under reduced motion (globals.css).
 * Read back off the RUNNING pseudo-element animations rather than off the custom
 * property, so a half of the swap that armed against some timing of its own
 * instead of the shared one fails here.
 */
const CROSSFADE = { ms: 300, css: "0.3s" };
const REDUCED_MOTION_CROSSFADE = { ms: 120, css: "0.12s" };

/** The user's own ghostty config — seeded, then asserted byte-identical (#67). */
const USER_GHOSTTY_CONFIG = `# The user's own ghostty config. Volli must NEVER write this file.
theme = Dracula
font-size = 13
cursor-style = bar
`;

const hexToRgb = (hex) => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

/** APCA Lc via apca-w3 itself — deliberately a different implementation than the generator's. */
const lc = (textHex, bgHex) =>
  Math.abs(Number(APCAcontrast(sRGBtoY(hexToRgb(textHex)), sRGBtoY(hexToRgb(bgHex)))));

/** One sRGB channel, linearized. */
const linearize = (channel) => {
  const v = channel / 255;
  return v <= 0.040_45 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** OKLCH lightness, for the border floor (APCA low-clips below Lc ~10 and cannot see a border). */
function oklchL(hex) {
  const [r, g, b] = hexToRgb(hex).map(linearize);
  const l = Math.cbrt(0.412_221_470_8 * r + 0.536_332_536_3 * g + 0.051_445_992_9 * b);
  const m = Math.cbrt(0.211_903_498_2 * r + 0.680_699_545_1 * g + 0.107_396_956_6 * b);
  const s = Math.cbrt(0.088_302_461_9 * r + 0.281_718_837_6 * g + 0.629_978_700_5 * b);
  return 0.210_454_255_3 * l + 0.793_617_785 * m - 0.004_072_046_8 * s;
}

/**
 * The best Lc ANY ink can score on `surface` — pure black or pure white,
 * whichever wins.
 *
 * Needed because one declared floor is physically unreachable and the engine
 * clamps rather than throwing (arc-theming-migration.md §7.1): at light's
 * settled spread `--sidebar` lands at L 0.840, where even black scores 74.8
 * against a floor of 75. So the assertion that can actually be kept is "meets
 * its floor, or is AT its surface's ceiling" — which still catches anything
 * short for a reason other than physics.
 */
const ceilingOn = (surface) => Math.max(lc("#000000", surface), lc("#ffffff", surface));

/**
 * One custom property, in a form the golden tables can be compared against.
 *
 * Two normalizations, and both are answering the same fact: the tables above are
 * transcribed from `globals.css`, which is GENERATED and then run through the
 * repo formatter, while the values read back here are what the pipeline wrote at
 * runtime. `vp fmt` trims trailing zeros in CSS numbers, so the stylesheet says
 * `0.03` where the pipeline emits `0.0300` — the same CSS value, printed twice.
 * Whitespace inside a value is the same story. Normalizing both sides compares
 * the COLOR rather than the spelling; a token that actually moved still fails.
 */
const normalizeToken = (value) =>
  value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\d*\.\d+/g, (number) => String(Number(number)));

/** Every named custom property, as the running document computes it. */
async function readAppliedTokens(page, names) {
  const raw = await page.evaluate((tokenNames) => {
    const styles = getComputedStyle(document.documentElement);
    const out = {};
    for (const name of tokenNames) out[name] = styles.getPropertyValue(name);
    return out;
  }, names);
  return Object.fromEntries(
    Object.entries(raw).map(([name, value]) => [name, normalizeToken(value)]),
  );
}

/** Polls one custom property until it reaches `expected` (or times out), returning what it settled on. */
async function waitForToken(page, name, expected, { timeout = 5000 } = {}) {
  await waitUntil(
    `${name} → ${expected}`,
    async () => (await readAppliedTokens(page, [name]))[name] === expected,
    { timeout },
  ).catch(() => {});
  return (await readAppliedTokens(page, [name]))[name];
}

/** Every diff between the golden table and what the document actually renders. */
function tokenDrift(table, applied) {
  return Object.entries(table)
    .filter(([name, expected]) => applied[name] !== expected)
    .map(([name, expected]) => `${name}: expected ${expected}, got ${applied[name] || "(unset)"}`);
}

/**
 * The base fill of whatever gradient is on screen — the LAST hex in `--canvas`.
 *
 * `canvasBackground` emits `<grain?>, <pool gradients…>, <base fill>`, and the
 * grain layer is a percent-encoded data URI that contains no literal `#rrggbb`,
 * so the last match is unambiguously the fill. Read rather than assumed so the
 * window-background checks keep working against an AUTHORED canvas, whose fill
 * no table here could know.
 */
function baseFillOf(canvasValue) {
  return canvasValue.match(/#[0-9a-f]{6}/g)?.at(-1) ?? null;
}

/** `<html>`'s mode class and the `color-scheme` that must move with it. */
const readMode = (page) =>
  page.evaluate(() => ({
    classes: [...document.documentElement.classList],
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
  }));

/**
 * `nativeTheme.shouldUseDarkColors` — what the SYSTEM is asking for, read in
 * main.
 *
 * The only honest reading of it. Chromium resolves the renderer's
 * `matchMedia("(prefers-color-scheme: dark)")` against the root element's used
 * `color-scheme`, and this app stamps that itself, so in the renderer that query
 * reports the mode already painted. Measured on a Dark-mode Mac with the root in
 * light: this said `true`, the renderer's query said `false` — which is what
 * made `auto` resolve to whatever was already on screen, forever.
 */
const systemPrefersDark = (app) =>
  app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);

/** The renderer's own query — kept only as the evidence that it cannot be trusted. */
const rendererMediaQuery = (page) =>
  page.evaluate(() => window.matchMedia("(prefers-color-scheme: dark)").matches);

/**
 * Drives a real OS appearance flip.
 *
 * `nativeTheme.themeSource` is the documented override, and setting it moves
 * `shouldUseDarkColors` AND fires `updated` — the same event a user flipping
 * System Settings produces, which is the whole path under test. `"system"` puts
 * the app back on the host's own answer.
 */
const forceThemeSource = (app, source) =>
  app.evaluate(({ nativeTheme }, value) => {
    nativeTheme.themeSource = value;
    return nativeTheme.shouldUseDarkColors;
  }, source);

/** The window's own edge color, as Chromium paints it before/around the document. */
const readWindowBackground = (app) =>
  app
    .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor())
    .then((value) => value.toLowerCase());

/**
 * The window edge once it has caught up with `expected`.
 *
 * Main repaints it from the `first-paint` hint the renderer writes after every
 * paint, so the edge trails the document by one IPC round trip. Polling rather
 * than sleeping keeps the check about the value and not about the latency —
 * and it still fails, on the value it settled on, if the write never arrives.
 */
const settledWindowBackground = (app, expected) =>
  waitUntil(
    `the window edge → ${expected}`,
    async () => ((await readWindowBackground(app)) === expected ? expected : null),
    { timeout: 6000 },
  ).catch(() => readWindowBackground(app));

// ---- navigation -------------------------------------------------------------

/** Opens Settings → Appearance from the sidebar footer. */
async function openAppearanceSettings(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page
    .getByRole("navigation", { name: "Settings categories" })
    .getByRole("button", { name: "Appearance", exact: true })
    .click();
  // Assert on a CONTROL, never on helper copy — the copy is free to be rewritten
  // (and this branch already stripped a pass of it).
  await page.getByTestId("appearance-mode").waitFor();
}

/** Configure → Appearance for whichever project is selected. */
async function openProjectAppearance(page) {
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Configure categories" })
    .getByRole("button", { name: "Appearance", exact: true })
    .click();
  // Present in every state of the pane, and only once this project's scope has
  // hydrated (it renders a loading note with a Retry button until then).
  await page.getByTestId("project-appearance-canvas-mode").waitFor();
}

/** One segmented control's button for `choice` (`data-choice` on the segment). */
const segment = (page, testId, choice) =>
  page.getByTestId(testId).locator(`[data-choice="${choice}"]`);

/** The terminal theme row's trigger — distinct from the editor picker on the same page. */
const terminalThemeTrigger = (page) =>
  page.getByRole("button", { name: "Terminal theme", exact: true });

const terminalThemeSearch = (page) =>
  page.getByRole("combobox", { name: "Search terminal themes" });

async function pickTerminalTheme(page, name) {
  await terminalThemeTrigger(page).click();
  await terminalThemeSearch(page).waitFor();
  await terminalThemeSearch(page).fill(name);
  await page.getByRole("option", { name, exact: true }).first().click();
}

// ---- the canvas editor ------------------------------------------------------

/**
 * Sets the editor's native 0–1 track (Vibrancy) to an exact value and settles it.
 *
 * The native value setter plus a bubbling `input` event, rather than a mouse
 * drag on the track: React's `onChange` IS the `input` event, so this is the
 * same signal a drag produces, and it is the only way to land on an exact value
 * — a click on the track lands wherever the thumb geometry puts it, and the
 * assertion would have to be a tolerance instead of a number. The drag gesture
 * itself is exercised on the PAD, where position is the thing being tested.
 *
 * `blur()` is the settle: `UnitSlider` writes on pointerup, keyup or blur, and a
 * synthetic input event produces none of the first two. It has to be FOCUSED
 * first or `blur()` is a no-op — React's `onBlur` rides `focusout`, which an
 * unfocused element never dispatches, and the observed failure is a preview that
 * paints and is never written.
 */
async function setSlider(page, label, value) {
  const slider = page.getByRole("slider", { name: label, exact: true });
  await slider.evaluate((element, next) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    element.focus();
    setter?.call(element, next);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.blur();
  }, value);
}

/** The fine and coarse arrow steps, mirroring `UNIT_STEP` / `UNIT_STEP_COARSE`. */
const DIAL_STEP = 0.01;
const DIAL_STEP_COARSE = 0.05;
/** Comfortably more presses than 0→1 at the fine step; a guard, never a budget. */
const DIAL_MAX_PRESSES = 140;

/**
 * Sets the editor's ROTARY 0–1 control (Grain) and settles it.
 *
 * Grain is not an `<input type="range">` and deliberately never was — it is a
 * `div[role="slider"]` whose face carries the grain texture at its current
 * amount, driven by pointer BEARING (see `GrainDial`). So `setSlider` above
 * cannot reach it: there is no `value` property to set and no `input` event to
 * fire, and pointing at it would mean computing an angle to land on a number.
 *
 * Arrow keys are the honest way in. `unitStepForKey` answers both axes at a
 * fine step and a coarse one with Shift, so this walks the value in whichever
 * step closes the remaining distance and reads `aria-valuenow` back between
 * presses rather than counting on arithmetic — the dial's own readout is what a
 * user would check, and it is rounded to the same two decimals the assertions
 * are written in. Each `keyup` is its own commit (`onKeyUp={onSettle}`), so
 * unlike the track there is nothing left to settle at the end.
 */
async function setDial(page, label, value) {
  const dial = page.getByRole("slider", { name: label, exact: true });
  await dial.scrollIntoViewIfNeeded();
  await dial.focus();
  const target = Number(value);
  for (let press = 0; press < DIAL_MAX_PRESSES; press += 1) {
    const now = Number(await dial.getAttribute("aria-valuenow"));
    const gap = target - now;
    if (Math.abs(gap) < DIAL_STEP / 2) return;
    const coarse = Math.abs(gap) >= DIAL_STEP_COARSE;
    await page.keyboard.press(`${coarse ? "Shift+" : ""}${gap > 0 ? "ArrowRight" : "ArrowLeft"}`);
  }
  throw new Error(`${label} never reached ${value}`);
}

/**
 * Authors a canvas through the REAL editor: a preset swatch, the track and the dial.
 *
 * Each control has its own commit contract and all three are exercised, because
 * they fail independently — a swatch is one click and one write, the track
 * previews on every `input` and writes once on release, the dial writes per
 * arrow press.
 */
async function authorCanvas(page, { hex, vibrancy, grain }) {
  await page.getByRole("button", { name: hex, exact: true }).first().click();
  await waitUntil(`the canvas to adopt ${hex}`, async () => {
    const stored = await storedGlobalCanvas(page);
    return stored?.stops[stored.primaryIndex]?.hex === hex;
  });

  await setSlider(page, "Vibrancy", vibrancy);
  await setDial(page, "Grain", grain);
  await waitUntil("both controls to persist", async () => {
    const stored = await storedGlobalCanvas(page);
    return (
      stored !== null &&
      Math.abs(stored.vibrancy - Number(vibrancy)) < 0.005 &&
      Math.abs(stored.grain - Number(grain)) < 0.005
    );
  });
}

/**
 * Drags the primary orb across the pad.
 *
 * Scrolled into view first because `boundingBox()` reports viewport coordinates
 * whether or not the element is ON screen — the terminal rows above pushed this
 * pane down, and a synthetic press at a negative y lands on nothing at all.
 *
 * Several moves rather than one: nothing happens until the pointer has cleared
 * `CLICK_SLOP`, and a single jump is reported as a CLICK (which promotes the
 * stop instead of moving it).
 */
async function dragPrimaryStop(page, { dx, dy }) {
  const orb = page.getByTestId("canvas-stop-orb-0");
  await orb.scrollIntoViewIfNeeded();
  const box = await orb.boundingBox();
  if (box === null) throw new Error("the primary orb has no box");
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await sleep(80);
  for (const fraction of [0.25, 0.6, 1]) {
    await page.mouse.move(from.x + dx * fraction, from.y + dy * fraction, { steps: 6 });
    await sleep(60);
  }
  await page.mouse.up();
}

// ---- stored state -----------------------------------------------------------

/**
 * What is actually IN the database, straight from main — independent of
 * whatever the renderer currently believes. The canvas and appearance ride the
 * bootstrap payload (there is deliberately no `canvas.state()` read), the global
 * pair as `app_state` rows and a workspace's as columns on its `projects` row.
 */
const storedTheme = (page) =>
  page.evaluate(async () => {
    const boot = await window.api.data.bootstrap();
    if (!boot.ok) throw new Error(`bootstrap: ${boot.error}`);
    // Cannot be hoisted, whatever the rule believes: this whole callback is
    // serialized and evaluated inside the RENDERER, so it can reference nothing
    // declared outside itself (same constraint as smoke-kit's readDocumentLine).
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const parse = (raw) => {
      if (raw === undefined || raw === null || raw.length === 0) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    };
    const projects = {};
    for (const project of boot.data.projects) {
      projects[project.id] = {
        canvas: project.themeCanvas ?? null,
        appearance: project.themeAppearance ?? null,
      };
    }
    const selectedRaw = boot.data.appState["volli:projects-ui"];
    return {
      canvas: parse(boot.data.appState.theme),
      appearance: boot.data.appState.appearance ?? null,
      firstPaint: parse(boot.data.appState["first-paint"]),
      projects,
      selectedProjectId: parse(selectedRaw)?.selectedProjectId ?? null,
    };
  });

const storedGlobalCanvas = (page) => storedTheme(page).then((state) => state.canvas);

// ---- the crossfade ----------------------------------------------------------

/**
 * Arms an in-page recorder for the scope crossfade, from now until it is read.
 *
 * The swap is a VIEW TRANSITION (renderer/src/theme/scope-transition.ts): the
 * tokens move once, inside the update callback, and what animates afterwards is
 * two captures of the window crossfading on the compositor. So there is no
 * attribute to observe any more — the honest evidence is the engine's own, and
 * there are two independent readings of it:
 *
 *   • `:root:active-view-transition` matches for exactly as long as one is
 *     running, so a rising edge is one swap. Counting edges is what tells a
 *     single flip from a flip that armed twice, which used to read as a stutter.
 *   • `document.getAnimations()` reports the pseudo-element animations Chromium
 *     built, with their RESOLVED durations. `--theme-scope-crossfade` is
 *     resolved nowhere else, so this is the only honest reading of the
 *     reduced-motion collapse — and every animation on the swap is checked, not
 *     just one, because the fades and Chromium's own `plus-lighter` blend all
 *     take their timing from the same author rule and a half that kept the UA's
 *     0.25s would show as a dip near the end of every swap.
 *
 * A poll would be racing a ~300ms window, so the sampler runs on
 * `requestAnimationFrame` — roughly eighteen samples inside the shortest swap
 * this can be asked about, and seven inside the reduced-motion one.
 *
 * IT WAITS FOR THE DOCUMENT TO BE AT REST FIRST, and that is a correctness fix
 * rather than tidiness. Consecutive checks flip the mode ~400ms apart while the
 * crossfade is 300ms, so a recorder installed the instant the previous check
 * finished could otherwise catch the tail of that flip and grade it as this
 * one's.
 */
async function watchScopeRepaint(page) {
  await page.waitForFunction(
    () => !document.documentElement.matches(":active-view-transition"),
    undefined,
    { timeout: 5000 },
  );
  await page.evaluate(() => {
    cancelAnimationFrame(window.volliRepaint?.raf ?? 0);
    const started = performance.now();
    const state = { runs: [], anims: [] };
    let wasActive = false;
    const tick = () => {
      const active = document.documentElement.matches(":active-view-transition");
      // The rising edge only: one entry per swap, however many frames it spans.
      if (active && !wasActive) state.runs.push(Math.round(performance.now() - started));
      wasActive = active;
      for (const animation of document.getAnimations()) {
        const pseudo = animation.effect?.pseudoElement ?? "";
        if (!pseudo.includes("view-transition")) continue;
        const key = `${pseudo}|${animation.animationName}`;
        if (state.anims.some((entry) => entry.key === key)) continue;
        state.anims.push({
          key,
          pseudo,
          name: animation.animationName,
          duration: animation.effect.getTiming().duration,
        });
      }
      window.volliRepaint.raf = requestAnimationFrame(tick);
    };
    window.volliRepaint = { state, raf: 0 };
    tick();
  });
}

/** The crossfade trace since {@link watchScopeRepaint}, plus what is running now. */
const readScopeRepaint = (page) =>
  page.evaluate(() => {
    const state = window.volliRepaint?.state ?? { runs: [], anims: [] };
    const oldHalf = getComputedStyle(document.documentElement, "::view-transition-old(root)");
    const newHalf = getComputedStyle(document.documentElement, "::view-transition-new(root)");
    return {
      runs: state.runs,
      anims: state.anims,
      active: document.documentElement.matches(":active-view-transition"),
      // The declared side of the same facts, which survives the swap being over.
      resolved: {
        oldDuration: oldHalf.animationDuration,
        newDuration: newHalf.animationDuration,
        oldTiming: oldHalf.animationTimingFunction,
        newTiming: newHalf.animationTimingFunction,
        oldBlend: oldHalf.mixBlendMode,
        newBlend: newHalf.mixBlendMode,
      },
    };
  });

/** Did the swap actually run a view transition? */
const crossfaded = (trace) => trace.runs.length >= 1;

/**
 * …and exactly ONE. A flip that armed twice would land the second crossfade as
 * the first finished, which reads as a stutter — the defect the old
 * attribute-counting check existed to catch, in the one form the engine can
 * still be asked about directly.
 */
const crossfadedOnce = (trace) => trace.runs.length === 1;

/**
 * Every animation the swap built, at the shared duration.
 *
 * Not a count: how many pseudo-elements Chromium animates for a root-only
 * transition is an engine detail (measured in Electron 43: the two fades, the
 * group, and a `plus-lighter` blend on each half — five). What must hold for
 * every one of them is that it took its timing from `--theme-scope-crossfade`;
 * a second timing anywhere fails here however many animations there were.
 */
const crossfadeRanFor = (trace, expected) =>
  trace.anims.length >= 1 &&
  trace.anims.every((entry) => entry.duration === expected.ms) &&
  trace.resolved.oldDuration === expected.css &&
  trace.resolved.newDuration === expected.css;

/**
 * The blend is load-bearing, not decoration: the two captures are stacked, so
 * ordinary compositing dips the whole window toward the backdrop at the
 * midpoint. Additive blending sums two ramps that are complements of the same
 * eased progress, so the sum is exactly 1 at every frame.
 */
const crossfadeBlendsAdditively = (trace) =>
  trace.resolved.oldBlend === "plus-lighter" && trace.resolved.newBlend === "plus-lighter";

/**
 * Records every value `--background` settles on from now until it is read.
 *
 * `theme/apply.ts` writes the whole token set onto the root's inline style, so a
 * MutationObserver on that attribute sees every repaint — a bounce through
 * another canvas and back cannot slip between two polls, which is exactly what
 * the #123 regression looked like from the outside.
 */
async function watchBackgroundPaints(page) {
  await page.evaluate(() => {
    window.volliPaintObserver?.disconnect();
    const paints = [];
    window.volliPaints = paints;
    const record = () => {
      const value = document.documentElement.style
        .getPropertyValue("--background")
        .trim()
        .toLowerCase();
      // Deduped against the last entry: one repaint writes every token, so the
      // observer fires many times for a single swap.
      if (value !== "" && paints.at(-1) !== value) paints.push(value);
    };
    const observer = new MutationObserver(record);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    window.volliPaintObserver = observer;
    record();
  });
}

const readBackgroundPaints = (page) => page.evaluate(() => window.volliPaints ?? []);

// ---- first paint ------------------------------------------------------------

/**
 * Samples the mode class and `--background` on the first ~20 animation frames
 * of the NEXT document load in this page.
 *
 * Installed as an init script, which Chromium evaluates at document-start —
 * before any page script, and long before the first paint (which cannot happen
 * until the stylesheet has loaded and layout has run). So frame 0's reading is a
 * genuine "what did the very first frame carry", and the whole point of the
 * `first-paint` hint is that it already says `light`.
 *
 * An empty `--background` is NOT a failure: it means the stylesheet has not
 * applied yet, and what the user sees in that gap is `BrowserWindow`'s own
 * background color, which main set from the same hint (asserted separately). A
 * DARK `--background` in any frame is the flash.
 */
async function armFirstPaintTrace(page) {
  await page.addInitScript(() => {
    const frames = [];
    window.volliFirstPaint = frames;
    const record = () => {
      const root = document.documentElement;
      frames.push({
        classes: root === null ? [] : [...root.classList],
        background: (root === null ? "" : getComputedStyle(root).getPropertyValue("--background"))
          .trim()
          .toLowerCase(),
      });
    };
    record();
    let n = 0;
    const tick = () => {
      record();
      n += 1;
      if (n < 20) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const readFirstPaintTrace = (page) => page.evaluate(() => window.volliFirstPaint ?? []);

// ---- per-project scope ------------------------------------------------------

/**
 * The two seeded workspaces. Names chosen for DISTINCT monograms ("AL"/"BE") —
 * the rail tile's accessible name is its monogram, so two projects that
 * initialled the same would make the tile locator ambiguous.
 */
const PROJECT_A = { id: "smoke-canvas-a", name: "Alpha", prefix: "ALP", monogram: "AL" };
const PROJECT_B = { id: "smoke-canvas-b", name: "Beta", prefix: "BET", monogram: "BE" };

/**
 * One workspace's rail tile. `.and(a real <button>)` because dnd-kit's sortable
 * wrapper ALSO carries `role="button"` and inherits the tile's accessible name,
 * so the name alone matches two elements — and the wrapper does nothing on click.
 */
const projectTile = (page, project) =>
  page.getByRole("button", { name: project.monogram, exact: true }).and(page.locator("button"));

const selectProject = (page, project) => projectTile(page, project).click();

// ---- run --------------------------------------------------------------------

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-canvas-theming-smoke-");
const home = join(scratch, "home");
const ghosttyDir = join(home, ".config", "ghostty");
await fs.mkdir(ghosttyDir, { recursive: true });
const userConfigPath = join(ghosttyDir, "config");
await fs.writeFile(userConfigPath, USER_GHOSTTY_CONFIG);
const userConfigBefore = await fs.readFile(userConfigPath, "utf8");

const overlayPath = join(userDataDir, "volli", "ghostty", "config");

const { check, attempt, summarize } = createRunner();

console.log("scratch:", scratch, "\n");

const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
let app = await launch({ dbPath, userDataDir, extraEnv: env });
let page = await app.firstWindow();
await assertProfileIsolated(app, userDataDir);
await page.waitForLoadState("domcontentloaded");
await sleep(1200);

try {
  // ---- 1. the generated canvas token set, in DARK --------------------------
  // The appearance is pinned explicitly rather than left on `auto`: `auto`
  // resolves against the DEVELOPER'S system, so a table asserted under it would
  // pass or fail depending on whose Mac ran the smoke.
  await openAppearanceSettings(page);
  await segment(page, "appearance-mode", "dark").click();
  await waitForToken(page, "--background", DARK["--background"]);

  await attempt(1, "every generated token reaches the live DOM in dark", async () => {
    const applied = await readAppliedTokens(page, Object.keys(DARK));
    const drift = tokenDrift(DARK, applied);
    return { ok: drift.length === 0, detail: drift.slice(0, 6).join(" · ") };
  });

  await attempt(2, "APCA/ΔL floors hold on the applied dark values (per apca-w3)", async () => {
    const t = await readAppliedTokens(page, Object.keys(DARK));
    const failures = [];
    const floor = (label, actual, min) => {
      if (actual < min) failures.push(`${label} ${actual.toFixed(1)} < ${min}`);
    };
    floor("foreground Lc", lc(t["--foreground"], t["--background"]), 90);
    floor("muted-foreground Lc", lc(t["--muted-foreground"], t["--background"]), 60);
    floor("sidebar-foreground Lc", lc(t["--sidebar-foreground"], t["--sidebar"]), 75);
    floor("primary-foreground Lc", lc(t["--primary-foreground"], t["--primary"]), 60);
    floor("primary-text Lc", lc(t["--primary-text"], t["--background"]), 60);
    floor("canvas-ink Lc", lc(t["--canvas-ink"], t["--card"]), 60);
    floor("border ΔL", Math.abs(oklchL(t["--border"]) - oklchL(t["--background"])), 0.02);
    floor("rail ΔL", Math.abs(oklchL(t["--rail"]) - oklchL(t["--background"])), 0.015);
    return { ok: failures.length === 0, detail: failures.join(" · ") };
  });

  await attempt(3, "the window edge follows the canvas BASE FILL, not --background", async () => {
    const { "--canvas": canvas, "--background": background } = await readAppliedTokens(page, [
      "--canvas",
      "--background",
    ]);
    const fill = baseFillOf(canvas);
    // The edge is repainted from the first-paint hint the renderer writes on
    // every paint, so this waits on the round trip rather than sampling it —
    // and in doing so also proves that write reaches main.
    const windowBg = await settledWindowBackground(app, fill);
    return {
      // Both halves: the window IS the fill, AND the fill is genuinely not the
      // card rung — with a canvas armed those differ deliberately, and a check
      // that only asserted equality would still pass if the canvas collapsed.
      ok: fill === BASE_FILL.dark && windowBg === fill && windowBg !== background,
      detail: `window=${windowBg} fill=${fill} --background=${background}`,
    };
  });

  // ---- 2. the other mode ---------------------------------------------------
  await attempt(4, "Light paints the whole window, class and color-scheme with it", async () => {
    await segment(page, "appearance-mode", "light").click();
    const applied = await waitForToken(page, "--background", LIGHT["--background"]);
    const mode = await readMode(page);
    const tokens = await readAppliedTokens(page, Object.keys(LIGHT));
    const drift = tokenDrift(LIGHT, tokens);
    return {
      ok:
        applied === LIGHT["--background"] &&
        mode.classes.includes("light") &&
        !mode.classes.includes("dark") &&
        // Without this, every native form control (range inputs, scrollbars,
        // the caret) keeps rendering dark on a light canvas.
        mode.colorScheme === "light" &&
        drift.length === 0,
      detail: `classes=${JSON.stringify(mode.classes)} color-scheme=${mode.colorScheme} drift=${drift.slice(0, 4).join(" · ") || "none"}`,
    };
  });

  await attempt(5, "APCA/ΔL floors hold on the applied light values", async () => {
    const t = await readAppliedTokens(page, Object.keys(LIGHT));
    const failures = [];
    // `--sidebar-foreground` on `--sidebar` is the ONE floor light's settled
    // spread puts physically out of reach (§7.1): `--sidebar` lands at L 0.840
    // where even pure black scores 74.8 against a declared 75. So the assertion
    // is "meets the floor, or is at its surface's ceiling" — which still fails
    // anything short for a reason other than physics, and would name a NEW
    // capped token if a retune ever created one.
    const floor = (label, text, surface, min) => {
      const actual = lc(t[text], t[surface]);
      if (actual >= min) return;
      const ceiling = ceilingOn(t[surface]);
      if (actual >= ceiling - 0.5) return;
      failures.push(`${label} ${actual.toFixed(1)} < ${min} (ceiling ${ceiling.toFixed(1)})`);
    };
    floor("foreground", "--foreground", "--background", 90);
    floor("muted-foreground", "--muted-foreground", "--background", 60);
    floor("sidebar-foreground", "--sidebar-foreground", "--sidebar", 75);
    floor("primary-foreground", "--primary-foreground", "--primary", 60);
    floor("primary-text", "--primary-text", "--background", 60);
    floor("canvas-ink", "--canvas-ink", "--card", 60);
    const borderDelta = Math.abs(oklchL(t["--border"]) - oklchL(t["--background"]));
    const railDelta = Math.abs(oklchL(t["--rail"]) - oklchL(t["--background"]));
    if (borderDelta < 0.02) failures.push(`border ΔL ${borderDelta.toFixed(4)} < 0.02`);
    if (railDelta < 0.015) failures.push(`rail ΔL ${railDelta.toFixed(4)} < 0.015`);
    return {
      ok: failures.length === 0,
      detail:
        failures.join(" · ") ||
        `sidebar Lc ${lc(t["--sidebar-foreground"], t["--sidebar"]).toFixed(1)} at ceiling ${ceilingOn(t["--sidebar"]).toFixed(1)}`,
    };
  });

  await attempt(6, "the window edge follows the LIGHT base fill", async () => {
    const { "--canvas": canvas, "--background": background } = await readAppliedTokens(page, [
      "--canvas",
      "--background",
    ]);
    const fill = baseFillOf(canvas);
    const windowBg = await settledWindowBackground(app, fill);
    return {
      ok: fill === BASE_FILL.light && windowBg === fill && windowBg !== background,
      detail: `window=${windowBg} fill=${fill} --background=${background}`,
    };
  });

  // ---- 3. the crossfade ----------------------------------------------------
  await attempt(7, "a mode flip crossfades once, and cleans up after itself", async () => {
    await watchScopeRepaint(page);
    await segment(page, "appearance-mode", "dark").click();
    await waitForToken(page, "--background", DARK["--background"]);
    const during = await readScopeRepaint(page);
    await sleep(SCOPE_SETTLE_MS);
    const after = await readScopeRepaint(page);
    return {
      ok:
        crossfaded(during) &&
        // The engine owns the teardown, and this is where that claim is kept
        // honest: nothing may still be running once the swap has settled.
        after.active === false &&
        crossfadedOnce(after) &&
        crossfadeRanFor(after, CROSSFADE) &&
        crossfadeBlendsAdditively(after),
      detail: `runs=${JSON.stringify(after.runs)} active=${after.active} anims=${JSON.stringify(after.anims)} resolved=${JSON.stringify(after.resolved)}`,
    };
  });

  await attempt(8, "reduced motion collapses the crossfade to its short ease", async () => {
    // HIG: nothing here translates or scales, so the accessible treatment is the
    // shortest honest ease rather than a hard cut. The media query moves ONE
    // custom property and every animation on the swap reads it — a duration of
    // 300 on any of them means a half of the crossfade has a timing of its own.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await watchScopeRepaint(page);
    await segment(page, "appearance-mode", "light").click();
    await waitForToken(page, "--background", LIGHT["--background"]);
    const during = await readScopeRepaint(page);
    await sleep(SCOPE_SETTLE_MS);
    const after = await readScopeRepaint(page);
    await page.emulateMedia({ reducedMotion: null });
    return {
      ok:
        crossfaded(during) &&
        crossfadedOnce(after) &&
        crossfadeRanFor(after, REDUCED_MOTION_CROSSFADE),
      detail: `runs=${JSON.stringify(after.runs)} anims=${JSON.stringify(after.anims)} resolved=${JSON.stringify(after.resolved)} expected=${JSON.stringify(REDUCED_MOTION_CROSSFADE)}`,
    };
  });

  // ---- 4. the ghostty surfaces, which were meant to survive untouched -------
  await attempt(9, "committing a terminal theme writes Volli's own overlay", async () => {
    await openAppearanceSettings(page);
    await pickTerminalTheme(page, OVERLAY_THEME);
    const written = await waitUntil("overlay written", () => pathExists(overlayPath)).then(
      () => true,
      () => false,
    );
    const text = (await readFileSafe(overlayPath)) ?? "";
    return {
      ok: written && text.includes(`theme = ${OVERLAY_THEME}`),
      detail: written ? text.split("\n").at(-2) : "overlay never appeared",
    };
  });

  await attempt(10, "the user's own ghostty config is byte-identical (#67)", async () => {
    const after = await fs.readFile(userConfigPath, "utf8");
    return {
      ok: after === userConfigBefore,
      detail: after === userConfigBefore ? "unchanged" : "MUTATED — decision #67 violated",
    };
  });

  await attempt(11, "a Volli write preserves hand-written keys and comments (#68)", async () => {
    const handEdited = `${(await readFileSafe(overlayPath)) ?? ""}
# my own note
cursor-style = block
`;
    await fs.writeFile(overlayPath, handEdited);

    await pickTerminalTheme(page, "Nord");
    await waitUntil("overlay rewritten", async () =>
      ((await readFileSafe(overlayPath)) ?? "").includes("theme = Nord"),
    );

    const text = (await readFileSafe(overlayPath)) ?? "";
    const keptComment = text.includes("# my own note");
    const keptKey = text.includes("cursor-style = block");
    const themeOnce = text.split("\n").filter((l) => l.trim().startsWith("theme =")).length === 1;
    return {
      ok: keptComment && keptKey && themeOnce,
      detail: `comment=${keptComment} key=${keptKey} themeSetOnce=${themeOnce}`,
    };
  });

  // ---- 5. authoring a canvas through the real editor ------------------------
  await attempt(12, "the canvas editor repaints live and persists what it painted", async () => {
    const before = await readAppliedTokens(page, ["--canvas", "--primary", "--background"]);
    await authorCanvas(page, {
      hex: AUTHORED_HEX,
      vibrancy: AUTHORED_VIBRANCY,
      grain: AUTHORED_GRAIN,
    });
    await dragPrimaryStop(page, { dx: -90, dy: 40 });

    const stored = await waitUntil("the dragged stop to persist", async () => {
      const canvas = await storedGlobalCanvas(page);
      const stop = canvas?.stops[canvas.primaryIndex];
      return stop !== undefined && Math.abs(stop.x - 0.68) > 0.02 ? canvas : null;
    });
    const after = await readAppliedTokens(page, ["--canvas", "--primary", "--background"]);

    return {
      ok:
        stored.stops[stored.primaryIndex].hex === AUTHORED_HEX &&
        Math.abs(stored.vibrancy - Number(AUTHORED_VIBRANCY)) < 0.005 &&
        Math.abs(stored.grain - Number(AUTHORED_GRAIN)) < 0.005 &&
        after["--primary"] !== before["--primary"] &&
        after["--canvas"] !== before["--canvas"] &&
        after["--background"] !== before["--background"],
      detail: `stored=${JSON.stringify(stored)} --primary ${before["--primary"]}→${after["--primary"]}`,
    };
  });

  await attempt(13, "Escape in the hex field abandons the edit instead of saving it", async () => {
    // `cancelPreview` is the store's abandon path and had NO caller anywhere, so
    // the editor could only ever finish an edit by committing it: Escape put the
    // FIELD back to the stored hex and then called the commit path beside it,
    // persisting the colour the user was backing out of. Both halves are checked
    // — the window has to return to what is stored, and what is stored must not
    // have moved. Only reachable from the real app: the renderer's unit tests
    // render to static markup and cannot press a key.
    const field = page.getByRole("textbox", { name: "Primary colour hex" });
    const before = await readAppliedTokens(page, ["--background"]);
    const storedBefore = await storedGlobalCanvas(page);
    const keptHex = storedBefore.stops[storedBefore.primaryIndex].hex;

    await field.click();
    await field.fill(ABANDONED_HEX);
    const previewed = await waitUntil("the typed colour to paint", async () => {
      const now = await readAppliedTokens(page, ["--background"]);
      return now["--background"] === before["--background"] ? null : now["--background"];
    });

    await page.keyboard.press("Escape");

    const restored = await waitUntil("the abandoned preview to come off", async () => {
      const now = await readAppliedTokens(page, ["--background"]);
      return now["--background"] === before["--background"] ? now["--background"] : null;
    }).catch(async () => (await readAppliedTokens(page, ["--background"]))["--background"]);
    const storedAfter = await storedGlobalCanvas(page);

    return {
      ok:
        previewed !== before["--background"] &&
        restored === before["--background"] &&
        storedAfter.stops[storedAfter.primaryIndex].hex === keptHex &&
        (await field.inputValue()) === keptHex,
      detail: `painted ${before["--background"]}→${previewed}→${restored} stored=${storedAfter.stops[storedAfter.primaryIndex].hex}`,
    };
  });

  // ---- 6. first paint, and what survived the restart ------------------------
  const beforeRelaunch = {
    tokens: await readAppliedTokens(page, [...Object.keys(LIGHT), "--canvas"]),
    stored: await storedTheme(page),
  };
  await app.close();
  app = await launch({ dbPath, userDataDir, extraEnv: env });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await attempt(14, "first paint carries the stored mode, with no dark frame", async () => {
    // The earliest moment this runner can observe the LAUNCHED window. It is
    // already past first paint, so on its own it proves the end state, not the
    // absence of a flash.
    const earliest = await readMode(page);
    const windowBg = await readWindowBackground(app);

    // The frame sample. Installed as an init script (document-start, before any
    // page script and long before layout can paint) and read across a real
    // document load, so frame 0 is a genuine first frame: preload has to have
    // stamped the class by then, because nothing else can have run.
    //
    // A reload rather than a second launch, and the difference is worth being
    // honest about: it re-runs the preload stamp against a freshly-parsed
    // document with no class on it, which is the mechanism under test, but it
    // reuses a window main already constructed — so the BrowserWindow half is
    // proven by the reading above, not by the trace.
    await armFirstPaintTrace(page);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1500);
    const frames = await readFirstPaintTrace(page);
    // The very first sample is taken before `<html>` exists at all — an init
    // script runs ahead of the parser, so `document.documentElement` is still
    // null and there is nothing to have stamped yet. The claim under test is
    // about the first frame that HAS a root, which is the first frame that could
    // possibly have been painted.
    const rooted = frames.filter((frame) => frame.classes.length > 0 || frame.background !== "");
    const darkFrames = rooted.filter(
      (frame) => frame.classes.includes("dark") || frame.background === DARK["--background"],
    );
    const stored = await storedTheme(page);
    const fill = baseFillOf((await readAppliedTokens(page, ["--canvas"]))["--canvas"]);

    return {
      ok:
        earliest.classes.includes("light") &&
        earliest.colorScheme === "light" &&
        windowBg === fill &&
        windowBg === stored.firstPaint?.background &&
        stored.firstPaint?.appearance === "light" &&
        rooted.length > 0 &&
        rooted[0].classes.includes("light") &&
        darkFrames.length === 0,
      detail: `earliest=${JSON.stringify(earliest)} window=${windowBg} fill=${fill} hint=${JSON.stringify(stored.firstPaint)} frames=${frames.length}/${rooted.length} rooted firstRooted=${JSON.stringify(rooted[0] ?? null)} darkFrames=${darkFrames.length}`,
    };
  });

  await attempt(15, "the committed canvas and appearance survive a relaunch", async () => {
    const tokens = await readAppliedTokens(page, [...Object.keys(LIGHT), "--canvas"]);
    const drifted = Object.entries(beforeRelaunch.tokens)
      .filter(([name, value]) => tokens[name] !== value)
      .map(([name]) => name);
    const stored = await storedTheme(page);
    return {
      ok:
        drifted.length === 0 &&
        stored.appearance === "light" &&
        JSON.stringify(stored.canvas) === JSON.stringify(beforeRelaunch.stored.canvas),
      detail: `drifted=${drifted.join(", ") || "nothing"} appearance=${stored.appearance} canvas=${JSON.stringify(stored.canvas)}`,
    };
  });

  // ---- 7. scope precedence -------------------------------------------------
  const projectDirs = {
    [PROJECT_A.id]: await makeGitRepo(scratch, "alpha-"),
    [PROJECT_B.id]: await makeGitRepo(scratch, "beta-"),
  };
  await seedProjects(page, [
    { ...PROJECT_A, path: projectDirs[PROJECT_A.id] },
    { ...PROJECT_B, path: projectDirs[PROJECT_B.id] },
  ]);
  const { byName } = await readSeededProjects(page);
  const projectAId = byName[PROJECT_A.name]?.id ?? null;
  const projectBId = byName[PROJECT_B.name]?.id ?? null;
  // Fail here rather than inside the first check: a seed that never booted would
  // otherwise be reported as a theme failure, naming the wrong cause.
  if (projectAId === null || projectBId === null) {
    throw new Error(`seeded projects did not boot: ${JSON.stringify(Object.keys(byName))}`);
  }

  const globalCanvasToken = (await readAppliedTokens(page, ["--canvas"]))["--canvas"];
  const globalBackground = (await readAppliedTokens(page, ["--background"]))["--background"];

  await attempt(16, "two seeded workspaces both start out inheriting", async () => {
    const applied = await waitForToken(page, "--background", globalBackground);
    const stored = await storedTheme(page);
    return {
      ok:
        applied === globalBackground &&
        stored.projects[projectAId]?.canvas === null &&
        stored.projects[projectAId]?.appearance === null &&
        stored.projects[projectBId]?.canvas === null &&
        stored.projects[projectBId]?.appearance === null,
      detail: `--background=${applied} rows=${JSON.stringify(stored.projects)}`,
    };
  });

  let projectBackground = null;
  await attempt(17, "Configure → Appearance overrides ONE workspace's canvas", async () => {
    await selectProject(page, PROJECT_A);
    await openProjectAppearance(page);
    // Custom opens on whatever the workspace is ALREADY wearing — the app-wide
    // canvas — so the switch alone must not change a pixel. Only the edit after
    // it may.
    await segment(page, "project-appearance-canvas-mode", "custom").click();
    const pinned = await waitUntil("the workspace row to take a canvas", async () => {
      const stored = await storedTheme(page);
      return stored.projects[projectAId]?.canvas ?? null;
    });
    const unchanged = (await readAppliedTokens(page, ["--canvas"]))["--canvas"];

    await page.getByRole("button", { name: WORKSPACE_HEX, exact: true }).first().click();
    projectBackground = await waitUntil(
      "the workspace canvas to repaint",
      async () => {
        const value = (await readAppliedTokens(page, ["--background"]))["--background"];
        return value === globalBackground ? null : value;
      },
      { timeout: 6000 },
    );

    const stored = await storedTheme(page);
    return {
      ok:
        JSON.stringify(pinned) === JSON.stringify(beforeRelaunch.stored.canvas) &&
        unchanged === globalCanvasToken &&
        stored.projects[projectAId]?.canvas?.stops[0]?.hex === WORKSPACE_HEX &&
        // The other workspace was never touched.
        stored.projects[projectBId]?.canvas === null &&
        // …and neither was the global row.
        JSON.stringify(stored.canvas) === JSON.stringify(beforeRelaunch.stored.canvas),
      detail: `pinnedOnCustom=${unchanged === globalCanvasToken} A=${JSON.stringify(stored.projects[projectAId])} B=${JSON.stringify(stored.projects[projectBId])}`,
    };
  });

  await attempt(18, "switching to an inheriting workspace reverts, eased", async () => {
    await watchScopeRepaint(page);
    await selectProject(page, PROJECT_B);
    const applied = await waitForToken(page, "--background", globalBackground, { timeout: 8000 });
    const during = await readScopeRepaint(page);
    await sleep(SCOPE_SETTLE_MS);
    const after = await readScopeRepaint(page);
    return {
      ok: applied === globalBackground && crossfaded(during) && after.active === false,
      detail: `--background=${applied} runs=${JSON.stringify(after.runs)} active=${after.active}`,
    };
  });

  await attempt(19, "switching back re-applies the overriding workspace's canvas", async () => {
    await selectProject(page, PROJECT_A);
    const applied = await waitForToken(page, "--background", projectBackground, { timeout: 8000 });
    // Read the row too, so a failure says WHICH of the two is wrong. The scope a
    // selection announces is built from the `projects` row the projects store is
    // holding (stores/projects.ts's selected-project listener reads
    // `project.themeCanvas`), and `setProjectCanvas` never pushes the fresh row
    // that the write returns back into that store — so a canvas overridden this
    // session is correct in the database and stale in memory until a relaunch
    // re-bootstraps it. Check 19 is the other half of the same evidence: after a
    // restart the very same override paints.
    const stored = await storedTheme(page);
    return {
      ok: applied === projectBackground,
      detail: `--background=${applied} (workspace canvas paints ${projectBackground}) storedRow=${JSON.stringify(stored.projects[projectAId])}`,
    };
  });

  // ---- 8. the override must be live ON BOOT, and survive a global write -----
  await app.close();
  app = await launch({ dbPath, userDataDir, extraEnv: env });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await attempt(20, "a restored workspace selection boots INTO its override (#123)", async () => {
    // Nothing is clicked here on purpose: the app restores the persisted
    // selection itself, and the window must already be wearing that workspace's
    // canvas. The regression this pins hydrated the global scope and never
    // re-read it for the restored workspace — correct in the database, invisible
    // in the window.
    const applied = await waitForToken(page, "--background", projectBackground, { timeout: 10000 });
    const stored = await storedTheme(page);
    return {
      ok: applied === projectBackground && stored.selectedProjectId === projectAId,
      detail: `--background=${applied} selected=${stored.selectedProjectId === projectAId ? "Alpha" : JSON.stringify(stored.selectedProjectId)}`,
    };
  });

  await attempt(
    21,
    "an app-wide canvas change leaves the overriding workspace alone (#123)",
    async () => {
      await openAppearanceSettings(page);
      // Record the paints rather than sampling the end state: the regression was
      // a BOUNCE (main answered a global write with the GLOBAL scope and the
      // store adopts a payload whole), and a final-value check would grade a
      // window that visibly flickered as passing.
      await watchBackgroundPaints(page);
      await watchScopeRepaint(page);

      await page.getByRole("button", { name: REGLOBAL_HEX, exact: true }).first().click();
      const globalCanvas = await waitUntil("the global canvas to change", async () => {
        const stored = await storedTheme(page);
        return stored.canvas?.stops[stored.canvas.primaryIndex]?.hex === REGLOBAL_HEX
          ? stored.canvas
          : null;
      });
      await sleep(SCOPE_SETTLE_MS);

      const paints = await readBackgroundPaints(page);
      const armed = await readScopeRepaint(page);
      const stored = await storedTheme(page);
      // At most ONE excursion is tolerated, and measured runs show zero. The
      // editor's every-edit-previews-first contract (canvas-editor.tsx)
      // deliberately outranks both scopes, so pressing a swatch on the app-wide
      // editor could in principle flash the picked canvas over a workspace
      // override — but `commit()` runs the preview and the write in ONE task, so
      // the whole excursion is inside a single style recalc and never reaches a
      // frame. The bug this pins was a TERMINAL excursion: a departure that
      // never comes back. So the trace must END on the workspace's canvas, and
      // any departure must be one and the same look rather than a bounce.
      const excursions = [...new Set(paints.filter((value) => value !== projectBackground))];
      return {
        ok:
          globalCanvas !== null &&
          paints.at(-1) === projectBackground &&
          excursions.length <= 1 &&
          // No scope changed, so the crossfade has no business running.
          !crossfaded(armed) &&
          stored.projects[projectAId]?.canvas?.stops[0]?.hex === WORKSPACE_HEX,
        detail: `paints=${JSON.stringify(paints)} crossfadeRuns=${JSON.stringify(armed.runs)} A=${JSON.stringify(stored.projects[projectAId]?.canvas?.stops)}`,
      };
    },
  );

  await attempt(22, "Inherit puts the workspace back on the app-wide canvas", async () => {
    await openProjectAppearance(page);
    await segment(page, "project-appearance-canvas-mode", "inherit").click();
    const stored = await waitUntil("the workspace row to clear", async () => {
      const state = await storedTheme(page);
      return state.projects[projectAId]?.canvas === null ? state : null;
    });
    const applied = await waitUntil(
      "the window to repaint to the app-wide canvas",
      async () => {
        const value = (await readAppliedTokens(page, ["--background"]))["--background"];
        return value !== projectBackground ? value : null;
      },
      { timeout: 8000 },
    );
    const pressed = await segment(page, "project-appearance-canvas-mode", "inherit").getAttribute(
      "aria-pressed",
    );
    // "Somewhere else" is not the claim — the claim is that A now paints what
    // any inheriting workspace paints. B has never been overridden, so it is the
    // reference: an all-inheriting workspace must read EXACTLY like one that was
    // never touched, or a retained canvas would leave A overridden next boot.
    await selectProject(page, PROJECT_B);
    const onB = await waitUntil(
      "workspace B to settle on the app-wide canvas",
      async () => {
        const value = (await readAppliedTokens(page, ["--background"]))["--background"];
        return value === applied ? value : null;
      },
      { timeout: 8000 },
    ).catch(async () => (await readAppliedTokens(page, ["--background"]))["--background"]);
    return {
      ok:
        stored.projects[projectAId]?.canvas === null &&
        applied !== projectBackground &&
        onB === applied &&
        pressed === "true",
      detail: `--background=${applied} (was ${projectBackground}); inheriting Beta paints ${onB}; row=${JSON.stringify(stored.projects[projectAId])} aria-pressed=${pressed}`,
    };
  });

  await attempt(23, "the user's own ghostty config is STILL byte-identical (#67)", async () => {
    // Re-asserted after two relaunches and a workspace scope: every one of those
    // is another chance to touch a file Volli must never touch.
    const after = await fs.readFile(userConfigPath, "utf8");
    return {
      ok: after === userConfigBefore,
      detail: after === userConfigBefore ? "unchanged" : "MUTATED — decision #67 violated",
    };
  });

  // ---- 9. `auto`, and the flip only main can see ---------------------------
  // Every check above pinned the mode explicitly, precisely so its table would
  // not depend on whose Mac ran the smoke. These two are about the mode nobody
  // pins, and they are the only ones that CAN'T assert a colour: what they
  // assert is that main and the window agree, whichever way the host is set.
  await attempt(24, "on `auto`, main's nativeTheme and the painted mode agree", async () => {
    // The disagreement this pins is what shipped. `auto` was resolved in the
    // renderer from `matchMedia("(prefers-color-scheme: dark)")`, which Chromium
    // answers from the root element's used `color-scheme` — stamped by this very
    // app — so it read back the mode already painted. Picking Auto after an
    // explicit light or dark therefore repainted nothing at all, whatever the
    // system said.
    await openAppearanceSettings(page);
    await segment(page, "appearance-mode", "auto").click();
    const prefersDark = await systemPrefersDark(app);
    const expected = prefersDark ? "dark" : "light";
    const mode = await waitUntil(
      `the window to resolve \`auto\` to ${expected}`,
      async () => {
        const now = await readMode(page);
        return now.classes.includes(expected) ? now : null;
      },
      { timeout: 8000 },
    ).catch(() => readMode(page));
    const query = await rendererMediaQuery(page);
    const stored = await storedTheme(page);
    return {
      ok:
        mode.classes.includes(expected) &&
        !mode.classes.includes(prefersDark ? "light" : "dark") &&
        mode.colorScheme === expected &&
        // `auto` is what is STORED; only its resolution moved. A window that
        // agreed with main by quietly persisting a resolved mode would be the
        // one bug this whole design exists to make unrepresentable.
        stored.appearance === "auto",
      detail: `nativeTheme.shouldUseDarkColors=${prefersDark} painted=${JSON.stringify(mode)} stored=${stored.appearance} · the renderer's own media query says ${query}`,
    };
  });

  await attempt(25, "a system flip repaints an `auto` window, with no reload", async () => {
    // `themeSource` is the documented way to move `shouldUseDarkColors` and it
    // fires `updated`, which is the exact event a user flipping System Settings
    // produces — so this exercises the real path end to end: main's listener,
    // the fan-out, the preload subscription, the store's change guard, a paint.
    const before = await readMode(page);
    const flipTo = before.classes.includes("dark") ? "light" : "dark";
    // A marker only a document load could clear. The claim is that the RUNNING
    // window repainted; a reload would satisfy every colour assertion below
    // while proving nothing about the live subscription.
    await page.evaluate(() => {
      window.volliNoReload = true;
    });
    const background = (await readAppliedTokens(page, ["--background"]))["--background"];

    await forceThemeSource(app, flipTo);
    const after = await waitUntil(
      `the window to repaint to ${flipTo}`,
      async () => {
        const now = await readMode(page);
        return now.classes.includes(flipTo) ? now : null;
      },
      { timeout: 8000 },
    ).catch(() => readMode(page));
    const repainted = (await readAppliedTokens(page, ["--background"]))["--background"];
    const sameDocument = await page.evaluate(() => window.volliNoReload === true);
    const stored = await storedTheme(page);

    // Back to the host's own answer, so nothing after this runs under a forced
    // system mode.
    await forceThemeSource(app, "system");

    return {
      ok:
        after.classes.includes(flipTo) &&
        after.colorScheme === flipTo &&
        // The class alone is not a repaint: the derived token set has to have
        // moved with it, or every surface keeps the other mode's colours.
        repainted !== background &&
        sameDocument &&
        stored.appearance === "auto",
      detail: `${JSON.stringify(before)} → ${JSON.stringify(after)}; --background ${background}→${repainted}; sameDocument=${sameDocument} stored=${stored.appearance}`,
    };
  });
} catch (error) {
  check("!", "smoke crashed", false, String(error?.stack ?? error));
} finally {
  await app.close().catch(() => {});
}

const exitCode = summarize();
await cleanup();
process.exit(exitCode);
