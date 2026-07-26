/**
 * End-to-end acceptance smoke for the theming engine, PR 1
 * (docs/plans/theming-engine.md). Drives the REAL packaged app through
 * Playwright against an ISOLATED $HOME and profile, and asserts the four
 * properties that the pure unit tests structurally cannot see:
 *
 *   1. The generated Ember token set is what the live DOM actually renders,
 *      and the main process's BrowserWindow background follows it (a token
 *      the application layer forgets to write keeps its authored fallback
 *      forever and no unit test notices).
 *   2. The APCA/OKLCH contrast floors hold against the values read back OUT
 *      of the running document — verified with `apca-w3`, never the
 *      generator's own math.
 *   3. Terminal theme preview is memory-only and revertible: highlighting a
 *      name repaints live terminals and writes NOTHING; committing writes the
 *      overlay; the choice survives a relaunch.
 *   4. Volli NEVER writes the user's own ghostty config (decision #67), and a
 *      Volli write preserves hand-written keys and comments in its own
 *      overlay (decision #68).
 *   5. PER-PROJECT overrides (#69/#72) resolve against the SELECTED project:
 *      an override paints only its own project, an inheriting project falls
 *      back to the global theme, the switch between them crossfades rather
 *      than cutting, the override is in force ON BOOT when the app restores a
 *      persisted selection, and Inherit really un-does it. The boot case is
 *      the whole point of issue #123 — the store used to hydrate the global
 *      scope and never re-read it for the restored project, so an override was
 *      correct in the database and invisible in the window.
 *   6. A GLOBAL theme pick made while an overriding project is selected leaves
 *      that project's window alone (#123's other half): the write used to be
 *      answered with the GLOBAL scope, the store adopts a payload whole, and
 *      every project silently went back to looking the same until you switched
 *      away and back. Asserted as a PAINT TRACE, because the failure was a
 *      bounce and a final-value check would grade a window that flickered as
 *      passing.
 *   7. The CANVAS layer (#124) obeys the same two rules, in the one place they
 *      can actually be seen: the Background row's hover-preview ends on EVERY
 *      way out of the list (Escape, an outside click, the pointer leaving), and
 *      a scope change — and only a scope change — crossfades the layer. The
 *      crossfade is a CSS animation on a mounted-then-dropped element, so a
 *      unit test can reach the decision but never the animation; both of the
 *      bugs these checks pin have already shipped once in this subsystem
 *      (2c84925, 124abab).
 *
 * Like terminal-smoke.mjs / ghostty-config-smoke.mjs this is a MANUALLY-RUN
 * smoke (needs a display + the built app) — CI does not run it:
 *
 *   pnpm -w run build        # NOT `pnpm -C apps/desktop run build` — the
 *                            # desktop package has no `build` script; the
 *                            # workspace root's is the one that produces
 *                            # dist/ + dist-electron/ (several sibling smokes
 *                            # still document the dead command).
 *   node apps/desktop/e2e/theming-smoke.mjs
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
 * The generator's output for the shipped Ember theme — the THIRD independent
 * pin on these values. `generate.test.ts` pins them against the color math and
 * globals.css authors them for first paint; this table proves the running app
 * actually renders them. All three must move together or one of these fails.
 */
const EMBER = {
  "--rail": "#0f0b09",
  "--background": "#15100e",
  "--card": "#1b1412",
  "--popover": "#1f1816",
  "--secondary": "#211a17",
  "--muted": "#211a17",
  "--accent": "#28201d",
  "--sidebar": "#1b1412",
  "--foreground": "#ebe3df",
  "--card-foreground": "#ebe3df",
  "--popover-foreground": "#ebe3df",
  "--secondary-foreground": "#ebe3df",
  "--muted-foreground": "#b9b0ad",
  "--accent-foreground": "#ebe3df",
  "--sidebar-foreground": "#d3cbc7",
  "--sidebar-accent": "#28201d",
  "--sidebar-accent-foreground": "#ebe3df",
  "--border": "#2d2421",
  "--border-hover": "#3b312d",
  "--border-strong": "#423834",
  "--input": "#2d2421",
  "--sidebar-border": "#29211d",
  "--primary": "#e8652a",
  "--primary-foreground": "#ffffff",
  "--primary-text": "#ff966c",
  "--ring": "#e8652a",
  "--sidebar-primary": "#e8652a",
  "--sidebar-primary-foreground": "#ffffff",
  "--sidebar-ring": "#e8652a",
  "--destructive": "#e5484d",
  "--destructive-foreground": "#ffffff",
};

/** Two more shipped themes, generated — the picker moves between these. */
const MIDNIGHT = { "--background": "#0f1117", "--primary": "#6589ff" };
const MOSS = { "--background": "#0f120f", "--primary": "#57a858" };

/** A ghostty theme with an unmistakable background, for proving a real palette swap. */
const PREVIEW_THEME = "Aardvark Blue";

/**
 * Comfortably past `SCOPE_REPAINT_HOLD_MS` (300ms crossfade + 40ms tail, see
 * renderer/src/theme/scope-transition.ts). Spent only to prove the crossfade
 * attribute comes back OFF, so a generous margin costs one wait per run.
 */
const SCOPE_TRANSITION_SETTLE_MS = 600;

/**
 * `--theme-scope-crossfade` at rest and under reduced motion (globals.css, and
 * `SCOPE_REPAINT.crossfade` next to it). Read back off the RUNNING animation
 * rather than off the custom property, so a canvas that armed against some
 * timing of its own instead of the shared one fails here.
 */
const SCOPE_CROSSFADE_MS = 300;
const REDUCED_MOTION_CROSSFADE_MS = 120;

/** The user's own ghostty config — seeded, then asserted byte-identical at the end. */
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

/** OKLCH lightness, for the border floor (APCA low-clips below Lc ~10 and cannot see a border at all). */
function oklchL(hex) {
  const [r, g, b] = hexToRgb(hex).map(linearize);
  const l = Math.cbrt(0.412_221_470_8 * r + 0.536_332_536_3 * g + 0.051_445_992_9 * b);
  const m = Math.cbrt(0.211_903_498_2 * r + 0.680_699_545_1 * g + 0.107_396_956_6 * b);
  const s = Math.cbrt(0.088_302_461_9 * r + 0.281_718_837_6 * g + 0.629_978_700_5 * b);
  return 0.210_454_255_3 * l + 0.793_617_785 * m - 0.004_072_046_8 * s;
}

/** Every themeable custom property, as the running document computes it. */
async function readAppliedTokens(page, names) {
  return page.evaluate((tokenNames) => {
    const styles = getComputedStyle(document.documentElement);
    const out = {};
    for (const name of tokenNames) out[name] = styles.getPropertyValue(name).trim().toLowerCase();
    return out;
  }, names);
}

/** Polls one custom property until it reaches `expected` (or times out), returning what it settled on. */
async function waitForToken(page, name, expected, { timeout = 4000 } = {}) {
  await waitUntil(
    `${name} → ${expected}`,
    async () => (await readAppliedTokens(page, [name]))[name] === expected,
    { timeout },
  ).catch(() => {});
  return (await readAppliedTokens(page, [name]))[name];
}

/**
 * Hovers a theme row and waits for its preview to paint, re-entering the row if
 * the first move didn't take.
 *
 * The picker previews on POINTERMOVE — cmdk selects the row the pointer moves
 * over and the app previews whatever is selected — and a small fraction of
 * hovers here land with no preview at all: the theme on screen does not change,
 * and no amount of waiting fixes it. Measured against the built app: 3 misses
 * across ~450 hover cycles, and the one caught with the pointer trace running
 * recovered the instant the pointer left and came back. A synthetic pointer
 * event that didn't take is not what these checks are about, so they retry
 * rather than report a working picker as broken.
 *
 * The pointer LEAVES the list before each retry: cmdk selects on crossing into
 * a row, and leaving also drops the highlight, so the retry is a real re-entry
 * and not a second no-op on an unchanged value. The caller still asserts that
 * the preview landed, so a picker that has genuinely stopped previewing fails
 * exactly as loudly as before.
 */
async function hoverThemeRow(page, name, expected) {
  let applied = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await page.mouse.move(8, 8);
    await page.getByRole("option", { name }).first().hover();
    applied = await waitForToken(page, "--background", expected, { timeout: 1500 });
    if (applied === expected) return applied;
  }
  return applied;
}

/** The terminal theme row's trigger — distinct from the app-theme picker on the same page. */
const terminalThemeTrigger = (page) => page.getByRole("button", { name: "Terminal theme" });

/** The terminal picker's own searchbox (the app-theme picker has one too). */
const themeSearch = (page) => page.getByRole("combobox", { name: "Search terminal themes" });

/** Opens the terminal theme popover. */
async function openTerminalThemeMenu(page) {
  await terminalThemeTrigger(page).click();
  await themeSearch(page).waitFor();
}

/** Opens Settings → Appearance from the sidebar footer. */
async function openAppearanceSettings(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page
    .getByRole("navigation", { name: "Settings categories" })
    .getByRole("button", { name: "Appearance", exact: true })
    .click();
  // The pane is up once its terminal half has rendered; assert on the control
  // itself rather than helper copy, which is free to be rewritten.
  await terminalThemeTrigger(page).waitFor();
}

// ---- per-project scope (#69/#72) -------------------------------------------

/**
 * The two seeded projects. Names are chosen for DISTINCT monograms ("AL"/"BE"),
 * because the rail tile's accessible name is its monogram — two projects that
 * initialled the same would make the tile locator ambiguous.
 */
const PROJECT_A = { id: "smoke-theme-a", name: "Alpha", prefix: "ALP", monogram: "AL" };
const PROJECT_B = { id: "smoke-theme-b", name: "Beta", prefix: "BET", monogram: "BE" };

/**
 * One project's rail tile. `.and(a real <button>)` because dnd-kit's sortable
 * wrapper ALSO carries `role="button"` and inherits the tile's accessible name,
 * so the name alone matches two elements — and the wrapper is the one that does
 * nothing on click.
 */
const projectTile = (page, project) =>
  page.getByRole("button", { name: project.monogram, exact: true }).and(page.locator("button"));

/** One segmented control's button for `choice` (`data-choice` on the segment). */
const segment = (page, testId, choice) =>
  page.getByTestId(testId).locator(`[data-choice="${choice}"]`);

/** Configure → Appearance for whichever project is selected. */
async function openProjectAppearance(page) {
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Configure categories" })
    .getByRole("button", { name: "Appearance", exact: true })
    .click();
  // The section header's own control — present in every state of the pane, and
  // only after this project's scope has actually hydrated (the pane renders a
  // loading note until then).
  await page.getByTestId("project-appearance-app-mode").waitFor();
}

/**
 * Clicks `project`'s rail tile. The scope read it kicks off is asynchronous, so
 * every caller's own `waitForToken` is what actually waits for the repaint —
 * there is no cheaper signal to poll, and inventing a test-only one would be
 * asserting on a hook rather than on the window.
 */
const selectProject = (page, project) => projectTile(page, project).click();

/**
 * Arms an in-page recorder for the scope crossfade, from now until it is read.
 *
 * A poll would be racing a ~340ms window; a MutationObserver cannot miss it,
 * because the attribute is SET and REMOVED as two separate mutations and the
 * observer gets a record for each. So this asserts the presence of the
 * crossfade deterministically rather than settling for the weaker
 * "absent once everything has settled" check.
 */
async function watchScopeTransition(page) {
  await page.evaluate(() => {
    window.volliScopeObserver?.disconnect();
    window.volliScopeSeen = false;
    const observer = new MutationObserver(() => {
      if (document.documentElement.getAttribute("data-theme-transition") === "scope") {
        window.volliScopeSeen = true;
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme-transition"],
    });
    window.volliScopeObserver = observer;
  });
}

/**
 * Records every value `--background` settles on from now until it is read.
 *
 * theme/apply.ts writes the whole token set onto the root element's inline
 * style, so a MutationObserver on that attribute sees every repaint — a bounce
 * through another theme and back cannot slip between two polls, which is
 * exactly what the #123 regression looked like from the outside.
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
    // Seeded with what is on screen right now, so the recording reads as a
    // trace rather than as a diff against an assumed starting point.
    record();
  });
}

/** The `--background` trace since {@link watchBackgroundPaints}, oldest first. */
const readBackgroundPaints = (page) => page.evaluate(() => window.volliPaints ?? []);

/** `{seen}` — did the crossfade arm at all; `{now}` — is it still armed. */
const readScopeTransition = (page) =>
  page.evaluate(() => ({
    seen: window.volliScopeSeen === true,
    now: document.documentElement.getAttribute("data-theme-transition"),
  }));

/**
 * One project's STORED theme state, straight from main — the database's answer,
 * independent of whatever the renderer currently believes. `theme` is the
 * global authored theme in every scope, so the project's own choice is read
 * from `projectOverride`.
 */
const themeStateFor = (page, projectId) =>
  page.evaluate(async (id) => {
    const result = await window.api.theme.state({ projectId: id });
    if (!result.ok) throw new Error(result.error);
    return {
      globalSlug: result.value.theme.slug,
      override: result.value.projectOverride,
      projectOverlayPath: result.value.terminal?.overlayPaths.project ?? null,
    };
  }, projectId);

// ---- the canvas layer (#124) ------------------------------------------------

/** The Background options, in the order the row lists them (theme-editor-model.ts). */
const CANVAS_OPTIONS = ["Solid", "Gradient", "Mesh"];

/**
 * What the canvas layer is painting right now, as one comparable string.
 *
 * The FIRST child is the canvas in force; a fade mounts a second one over it.
 * Both halves are read because a mesh's base fill lands in `background-color`
 * while its pools land in the image list — and the restore assertions want
 * "exactly what it was", not "close enough".
 */
const canvasPaint = (page) =>
  page.evaluate(() => {
    const layer = document.querySelector("[data-volli-canvas]")?.firstElementChild;
    if (layer === null || layer === undefined) return "(no canvas)";
    const computed = getComputedStyle(layer);
    return `${computed.backgroundImage} on ${computed.backgroundColor}`;
  });

/** Polls the canvas until `matches` holds, returning whatever it settled on. */
async function waitForCanvasPaint(page, matches, { timeout = 2500 } = {}) {
  await waitUntil("the canvas layer to repaint", async () => matches(await canvasPaint(page)), {
    timeout,
  }).catch(() => {});
  return canvasPaint(page);
}

/** A canvas paint value, trimmed to something a one-line check detail can carry. */
const short = (paint) => (paint.length > 72 ? `${paint.slice(0, 69)}…` : paint);

/**
 * Arms an in-page recorder for the canvas crossfade, from now until it is read.
 *
 * `animationstart`, not a poll of `getAnimations()`: the outgoing layer is
 * mounted and dropped inside ~340ms, so sampling for it is racing a window the
 * runner cannot see the start of, and a miss would read as "no crossfade". The
 * event fires exactly once per animation that really begins, and the duration is
 * read off the RUNNING animation at that instant — the only place
 * `--theme-scope-crossfade` has been resolved, and therefore the only honest way
 * to check the reduced-motion collapse.
 *
 * Listening on the canvas ROOT rather than the document: it contains the two
 * layers and nothing else, so no unrelated animation can land in the trace.
 */
async function watchCanvasFades(page) {
  await page.evaluate(() => {
    const root = document.querySelector("[data-volli-canvas]");
    if (window.volliCanvasFades !== undefined) {
      root.removeEventListener("animationstart", window.volliCanvasFades.handler);
    }
    const fades = [];
    const handler = (event) => {
      const running = event.target
        .getAnimations()
        .find((animation) => animation.animationName === event.animationName);
      fades.push({
        name: event.animationName,
        // The fade must be on the OUTGOING layer. One armed on the incoming one
        // would fade the new canvas out and leave the window on the old.
        outgoing: event.target.hasAttribute("data-volli-canvas-outgoing"),
        duration: running?.effect.getTiming().duration ?? null,
        playState: running?.playState ?? "(gone)",
      });
    };
    root.addEventListener("animationstart", handler);
    window.volliCanvasFades = { handler, fades };
  });
}

/** Every canvas animation that has started since {@link watchCanvasFades}, oldest first. */
const readCanvasFades = (page) => page.evaluate(() => window.volliCanvasFades?.fades ?? []);

/** The Background row's trigger — `aria-label`, so the name is the noun alone. */
const backgroundTrigger = (page) => page.getByRole("button", { name: "Background", exact: true });

/** Settings → Appearance → Customize, which is where the Background row lives. */
async function openThemeEditor(page) {
  await openAppearanceSettings(page);
  await page.getByRole("button", { name: "Customize", exact: true }).click();
  await backgroundTrigger(page).waitFor();
}

/**
 * Opens the Background popover, reopening the editor first if a previous check's
 * exit took it down with it. Escape belongs to the innermost dismissable thing,
 * and which one that is here is precisely what these checks are measuring — so
 * they assert on the RESTORE and let the editor's own lifetime be whatever it is.
 */
async function openBackgroundMenu(page) {
  if ((await backgroundTrigger(page).count()) === 0) await openThemeEditor(page);
  const trigger = backgroundTrigger(page);
  // Gated on the trigger's own state, not clicked unconditionally: a hover-
  // preview exit leaves the popover OPEN (walking away is not a dismissal), and
  // a second click there would toggle it shut under the next check.
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await page.getByRole("option", { name: "Mesh", exact: true }).first().waitFor();
}

/**
 * Hovers a Background row and waits for the app to repaint under it, re-entering
 * the row if the first move didn't take — {@link hoverThemeRow}'s shape, read
 * against the canvas layer instead of a token, for the same measured reason.
 */
async function hoverBackgroundRow(page, label, before) {
  let painted = before;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await page.mouse.move(8, 8);
    await page.getByRole("option", { name: label, exact: true }).first().hover();
    painted = await waitForCanvasPaint(page, (value) => value !== before, { timeout: 1500 });
    if (painted !== before) return painted;
  }
  return painted;
}

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-theming-smoke-");
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

try {
  // ---- 1. the generated theme is what actually renders ----------------------
  await attempt(1, "every generated Ember token reaches the live DOM", async () => {
    const applied = await readAppliedTokens(page, Object.keys(EMBER));
    const wrong = Object.entries(EMBER)
      .filter(([name, expected]) => applied[name] !== expected)
      .map(
        ([name, expected]) => `${name}: expected ${expected}, got ${applied[name] || "(unset)"}`,
      );
    return { ok: wrong.length === 0, detail: wrong.slice(0, 6).join(" · ") };
  });

  await attempt(
    2,
    "the window background follows --background (no launch/resize flash)",
    async () => {
      const windowBg = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].getBackgroundColor(),
      );
      return {
        ok: windowBg.toLowerCase() === EMBER["--background"],
        detail: `window=${windowBg} token=${EMBER["--background"]}`,
      };
    },
  );

  // ---- 2. contrast floors, measured on the live document --------------------
  await attempt(3, "APCA/ΔL floors hold on the applied values (per apca-w3)", async () => {
    const t = await readAppliedTokens(page, Object.keys(EMBER));
    const failures = [];
    const floor = (label, actual, min) => {
      if (actual < min) failures.push(`${label} ${actual.toFixed(1)} < ${min}`);
    };
    floor("foreground Lc", lc(t["--foreground"], t["--background"]), 90);
    floor("muted-foreground Lc", lc(t["--muted-foreground"], t["--background"]), 60);
    floor("sidebar-foreground Lc", lc(t["--sidebar-foreground"], t["--sidebar"]), 75);
    floor("primary-foreground Lc", lc(t["--primary-foreground"], t["--primary"]), 60);
    floor("primary-text Lc", lc(t["--primary-text"], t["--background"]), 60);
    floor("border ΔL", oklchL(t["--border"]) - oklchL(t["--background"]), 0.07);
    return { ok: failures.length === 0, detail: failures.join(" · ") };
  });

  // ---- 3. the picker: live preview, revert, commit --------------------------
  // Driven on the APP theme rather than the terminal, because app-surface
  // preview lands in CSS custom properties — readable straight out of the
  // running document, with no canvas to screenshot and no test-only hook.
  await openAppearanceSettings(page);

  await attempt(4, "moving through the picker previews the theme live", async () => {
    const applied = await hoverThemeRow(page, /Midnight/, MIDNIGHT["--background"]);
    return {
      ok: applied === MIDNIGHT["--background"],
      detail: `--background=${applied} (expected ${MIDNIGHT["--background"]})`,
    };
  });

  await attempt(5, "Escape restores the pre-preview theme exactly", async () => {
    await page.getByRole("combobox", { name: "Themes" }).press("Escape");
    const applied = await waitForToken(page, "--background", EMBER["--background"]);
    const full = await readAppliedTokens(page, Object.keys(EMBER));
    const drifted = Object.entries(EMBER).filter(([n, v]) => full[n] !== v);
    return {
      ok: applied === EMBER["--background"] && drifted.length === 0,
      detail:
        drifted.length > 0 ? `drifted: ${drifted.map(([n]) => n).join(", ")}` : "fully restored",
    };
  });

  await attempt(6, "the pointer leaving the picker ends a hover-preview", async () => {
    // Moss, not the Midnight of checks 4-5: Escape leaves that row SELECTED,
    // and cmdk no-ops on an unchanged value, so re-hovering it would preview
    // nothing and this check would grade a revert that never had anything to
    // revert. Hence the mid-state assertion too — half a check is worse here
    // than none, because it would pass whether or not hover still works.
    const previewed = await hoverThemeRow(page, /Moss/, MOSS["--background"]);
    // A hover has no Escape: walking away IS the "never mind". The corner is
    // outside the Command root, so this is the real pointerleave, not a click.
    await page.mouse.move(8, 8);
    const applied = await waitForToken(page, "--background", EMBER["--background"]);
    // The highlight has to go with it — a row left selected both lies about
    // what is on screen and makes cmdk swallow the re-entry onto that row.
    const stillSelected = await page.locator('[role="option"][aria-selected="true"]').count();
    return {
      ok:
        previewed === MOSS["--background"] &&
        applied === EMBER["--background"] &&
        stillSelected === 0,
      detail: `hover=${previewed} left=${applied} selected=${stillSelected}`,
    };
  });

  await attempt(7, "picking a theme commits it", async () => {
    await page.getByRole("option", { name: /Moss/ }).first().click();
    const applied = await waitForToken(page, "--background", MOSS["--background"]);
    return { ok: applied === MOSS["--background"], detail: `--background=${applied}` };
  });

  // ---- 4. the terminal overlay ---------------------------------------------
  await attempt(8, "committing a terminal theme writes Volli's own overlay", async () => {
    await openTerminalThemeMenu(page);
    await themeSearch(page).fill(PREVIEW_THEME);
    await page.getByRole("option", { name: PREVIEW_THEME, exact: true }).first().click();

    const written = await waitUntil("overlay written", () => pathExists(overlayPath)).then(
      () => true,
      () => false,
    );
    const text = (await readFileSafe(overlayPath)) ?? "";
    return {
      ok: written && text.includes(`theme = ${PREVIEW_THEME}`),
      detail: written ? text.split("\n").at(-2) : "overlay never appeared",
    };
  });

  // ---- 4. the user's own config is never touched ----------------------------
  await attempt(9, "the user's own ghostty config is byte-identical (#67)", async () => {
    const after = await fs.readFile(userConfigPath, "utf8");
    return {
      ok: after === userConfigBefore,
      detail: after === userConfigBefore ? "unchanged" : "MUTATED — decision #67 violated",
    };
  });

  await attempt(10, "a Volli write preserves hand-written keys and comments (#68)", async () => {
    // Hand-edit the overlay the way a user would, then make Volli rewrite one key.
    const handEdited = `${(await readFileSafe(overlayPath)) ?? ""}
# my own note
cursor-style = block
`;
    await fs.writeFile(overlayPath, handEdited);

    await openTerminalThemeMenu(page);
    await themeSearch(page).fill("Nord");
    await page.getByRole("option", { name: "Nord", exact: true }).first().click();
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

  // ---- 5. it survives a relaunch -------------------------------------------
  await app.close();
  app = await launch({ dbPath, userDataDir, extraEnv: env });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await attempt(11, "the committed terminal theme survives a relaunch", async () => {
    await openAppearanceSettings(page);
    const label = await terminalThemeTrigger(page).textContent();
    return {
      ok: label?.trim() === "Nord",
      detail: `trigger reads ${JSON.stringify(label?.trim())}`,
    };
  });

  await attempt(12, "the committed app theme survives a relaunch", async () => {
    // Moss, not Ember: proof that the commit persisted AND that the abandoned
    // Midnight preview never reached storage.
    const applied = await readAppliedTokens(page, ["--background", "--primary"]);
    return {
      ok:
        applied["--background"] === MOSS["--background"] &&
        applied["--primary"] === MOSS["--primary"],
      detail: JSON.stringify(applied),
    };
  });

  // ---- 6. per-project overrides (#69/#72) ----------------------------------
  // Everything above ran with NO projects, so "the theme" had exactly one
  // meaning. From here the app has two projects and Moss is the GLOBAL theme
  // every project inherits until it says otherwise.
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
  // Fail here rather than inside the first check: a seed that didn't boot would
  // otherwise reach main as `state({projectId: null})` and be reported as a
  // theme-read failure, naming the wrong cause.
  if (projectAId === null || projectBId === null) {
    throw new Error(`seeded projects did not boot: ${JSON.stringify(Object.keys(byName))}`);
  }

  await attempt(13, "two seeded projects both start out inheriting the global theme", async () => {
    const applied = await waitForToken(page, "--background", MOSS["--background"]);
    const [a, b] = await Promise.all([
      themeStateFor(page, projectAId),
      themeStateFor(page, projectBId),
    ]);
    return {
      ok: applied === MOSS["--background"] && a.override === null && b.override === null,
      detail: `--background=${applied} overrides=${JSON.stringify([a.override, b.override])}`,
    };
  });

  await attempt(14, "Configure → Appearance overrides ONE project's app theme", async () => {
    await selectProject(page, PROJECT_A);
    await openProjectAppearance(page);

    // Custom opens pre-selected on #72's auto-tint, which is itself a write —
    // so the window must leave Moss on this click alone, before any theme is
    // picked. (`--primary` is the seed's own channel; the tint reseeds from
    // the project's rail color, so this is where it shows first.)
    await segment(page, "project-appearance-app-mode", "custom").click();
    const tinted = await waitUntil(
      "auto-tint to repaint --primary",
      async () => {
        const value = (await readAppliedTokens(page, ["--primary"]))["--primary"];
        return value === MOSS["--primary"] ? null : value;
      },
      { timeout: 4000 },
    ).catch(() => null);

    // …then a named theme from the library, through the SAME picker Settings
    // mounts, handed a project scope (#73).
    await segment(page, "project-appearance-app-source", "theme").click();
    const picker = page.getByTestId("project-appearance-theme-picker");
    await picker.waitFor();
    await picker
      .getByRole("option", { name: /Midnight/ })
      .first()
      .click();

    const applied = await waitForToken(page, "--background", MIDNIGHT["--background"]);
    const stored = await themeStateFor(page, projectAId);
    return {
      ok:
        tinted !== null &&
        applied === MIDNIGHT["--background"] &&
        stored.override?.appThemeSlug === "midnight",
      detail: `autoTint --primary=${tinted} --background=${applied} stored=${JSON.stringify(stored.override)}`,
    };
  });

  await attempt(
    15,
    "switching to an inheriting project reverts to the global theme, eased",
    async () => {
      await watchScopeTransition(page);
      await selectProject(page, PROJECT_B);
      const applied = await waitForToken(page, "--background", MOSS["--background"]);
      const armed = await readScopeTransition(page);
      // The attribute's whole life is ~340ms, so "was it ever on" is recorded
      // by an observer rather than polled; "is it off now" is read after the
      // token has already settled, which is comfortably past the hold.
      await sleep(SCOPE_TRANSITION_SETTLE_MS);
      const after = await readScopeTransition(page);
      const untouched = await themeStateFor(page, projectBId);
      return {
        ok:
          applied === MOSS["--background"] &&
          armed.seen &&
          after.now === null &&
          untouched.override === null,
        detail: `--background=${applied} crossfadeArmed=${armed.seen} afterSettle=${JSON.stringify(after.now)}`,
      };
    },
  );

  await attempt(16, "switching back re-applies the overriding project's theme", async () => {
    await selectProject(page, PROJECT_A);
    const applied = await readAppliedTokens(page, ["--background", "--primary"]);
    const settled = await waitForToken(page, "--background", MIDNIGHT["--background"]);
    return {
      ok: settled === MIDNIGHT["--background"],
      detail: `--background=${settled} (first read ${applied["--background"]})`,
    };
  });

  // ---- 7. the headline bug: the override must be live ON BOOT (#123) -------
  await app.close();
  app = await launch({ dbPath, userDataDir, extraEnv: env });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await attempt(17, "a restored project selection boots INTO its override (#123)", async () => {
    // Nothing is clicked here on purpose. The app restores the persisted
    // selection by itself, and the window must already be wearing that
    // project's theme — the exact regression this branch fixes, where boot
    // hydrated the global scope and never re-read it for the restored project.
    const background = await waitForToken(page, "--background", MIDNIGHT["--background"]);
    const primary = (await readAppliedTokens(page, ["--primary"]))["--primary"];
    const selected = await page.evaluate(async () => {
      const boot = await window.api.data.bootstrap();
      if (!boot.ok) return null;
      const raw = boot.data.appState["volli:projects-ui"];
      return raw === undefined ? null : (JSON.parse(raw).selectedProjectId ?? null);
    });
    return {
      ok:
        background === MIDNIGHT["--background"] &&
        primary === MIDNIGHT["--primary"] &&
        selected === projectAId,
      detail: `--background=${background} --primary=${primary} selected=${selected === projectAId ? "Alpha" : JSON.stringify(selected)}`,
    };
  });

  await attempt(18, "Inherit puts the project back on the global theme", async () => {
    await openProjectAppearance(page);
    await segment(page, "project-appearance-app-mode", "inherit").click();
    const applied = await waitForToken(page, "--background", MOSS["--background"]);
    const stored = await themeStateFor(page, projectAId);
    const pressed = await segment(page, "project-appearance-app-mode", "inherit").getAttribute(
      "aria-pressed",
    );
    // An all-inheriting project must read EXACTLY like one that never set
    // anything — a retained seed here would leave it tinted on the next boot.
    return {
      ok: applied === MOSS["--background"] && stored.override === null && pressed === "true",
      detail: `--background=${applied} stored=${JSON.stringify(stored.override)} aria-pressed=${pressed}`,
    };
  });

  await attempt(19, "the terminal surface writes THIS project's ghostty overlay", async () => {
    // The one surface with no store setter: its source of truth is the file,
    // so the assertion is on the file. Custom pins what the chain already
    // resolves (Nord, from check 10's global overlay); picking another name
    // rewrites the project layer; Inherit REMOVES the key rather than writing
    // a default over the layer below (#67).
    await segment(page, "project-appearance-terminal-mode", "custom").click();
    const overlayPathA = await waitUntil("project overlay path", async () => {
      const state = await themeStateFor(page, projectAId);
      return state.projectOverlayPath;
    });
    const seeded = await waitUntil("project overlay seeded", async () =>
      ((await readFileSafe(overlayPathA)) ?? "").includes("theme = Nord"),
    ).then(
      () => true,
      () => false,
    );

    await page.getByRole("button", { name: "Project terminal theme", exact: true }).click();
    const search = page.getByRole("combobox", { name: "Search terminal themes" });
    await search.waitFor();
    await search.fill(PREVIEW_THEME);
    await page.getByRole("option", { name: PREVIEW_THEME, exact: true }).first().click();
    const repointed = await waitUntil("project overlay rewritten", async () =>
      ((await readFileSafe(overlayPathA)) ?? "").includes(`theme = ${PREVIEW_THEME}`),
    ).then(
      () => true,
      () => false,
    );
    // Volli's GLOBAL overlay is a different file and must not have moved.
    const globalStillNord = ((await readFileSafe(overlayPath)) ?? "").includes("theme = Nord");

    await segment(page, "project-appearance-terminal-mode", "inherit").click();
    // Line-wise, not `includes`: Volli's own header comment names the file, so
    // a substring match would keep passing after a key it never removed.
    const removed = await waitUntil("project overlay key removed", async () => {
      const text = (await readFileSafe(overlayPathA)) ?? "";
      return text.split("\n").some((line) => line.trim().startsWith("theme =")) ? null : true;
    }).then(
      () => true,
      () => false,
    );

    return {
      ok: seeded && repointed && globalStillNord && removed,
      detail: `seeded=${seeded} repointed=${repointed} globalOverlayIntact=${globalStillNord} inheritRemovedKey=${removed}`,
    };
  });

  await attempt(20, "the user's own ghostty config is STILL byte-identical (#67)", async () => {
    // Re-asserted after the project layer exists: a per-project write is one
    // more chance to touch a file Volli must never touch.
    const after = await fs.readFile(userConfigPath, "utf8");
    return {
      ok: after === userConfigBefore,
      detail: after === userConfigBefore ? "unchanged" : "MUTATED — decision #67 violated",
    };
  });

  // ---- 8. a GLOBAL write must not evict the project scope (#123) -----------
  // The other half of the same bug. Booting into an override was one way to
  // lose the project's theme; picking an app-wide one while that project was
  // selected was the other — main answered the write with the GLOBAL scope,
  // the store adopts a payload whole, and the window silently went back to
  // looking like everything else.
  await attempt(
    21,
    "an app-wide theme pick leaves an overriding project alone (#123)",
    async () => {
      // Check 18 put Alpha back on Inherit, so give it an override again — the
      // same route Configure offers: Custom, then a named theme.
      await openProjectAppearance(page);
      await segment(page, "project-appearance-app-mode", "custom").click();
      await segment(page, "project-appearance-app-source", "theme").click();
      const picker = page.getByTestId("project-appearance-theme-picker");
      await picker.waitFor();
      await picker
        .getByRole("option", { name: /Midnight/ })
        .first()
        .click();
      await waitForToken(page, "--background", MIDNIGHT["--background"]);

      await openAppearanceSettings(page);
      // Record the paints and the crossfade rather than sampling the end state:
      // the regression was a BOUNCE, and a final-value check alone would grade a
      // window that visibly flickered as passing. Armed AFTER the pane is up, so
      // the trace is the theme pick alone and not whatever navigating here did.
      await watchBackgroundPaints(page);
      await watchScopeTransition(page);

      // Scoped to the app-theme picker: this pane also mounts the editor and
      // terminal pickers, whose lists carry a row of the same name.
      const globalPicker = page.getByTestId("appearance-theme-picker");
      await globalPicker.waitFor();
      await globalPicker.getByRole("option", { name: /Ember/ }).first().click();
      // The write is what this check waits on — once it lands the window is
      // supposed to be doing nothing, so there is no repaint to poll for.
      const globalSlug = await waitUntil("the global theme to change", async () => {
        const state = await themeStateFor(page, projectAId);
        return state.globalSlug === "ember" ? state.globalSlug : null;
      }).catch(() => null);
      await sleep(SCOPE_TRANSITION_SETTLE_MS);

      const paints = await readBackgroundPaints(page);
      const armed = await readScopeTransition(page);
      const stored = await themeStateFor(page, projectAId);
      // An excursion into Ember is expected and is not the bug: highlighting a
      // row in the picker previews it live (check 4), and reaching the row to
      // click it highlights it. The bug is a TERMINAL excursion — a non-Midnight
      // paint after the commit that never comes back, the scope-less payload
      // landing on top of the correct re-resolve (observed as rose → moss →
      // rose → moss). So: the trace ends on Midnight, and every departure from
      // it was the previewed theme rather than some third look. Counting the
      // excursions instead would fail on an extra hover the click passed over.
      const excursions = paints.filter((value) => value !== MIDNIGHT["--background"]);
      return {
        ok:
          globalSlug === "ember" &&
          paints.at(-1) === MIDNIGHT["--background"] &&
          excursions.length >= 1 &&
          excursions.every((value) => value === EMBER["--background"]) &&
          // The scope never changed, so the crossfade has no business arming.
          !armed.seen &&
          stored.override?.appThemeSlug === "midnight",
        detail: `global=${globalSlug} paints=${JSON.stringify(paints)} crossfadeArmed=${armed.seen} stored=${JSON.stringify(stored.override)}`,
      };
    },
  );

  await attempt(22, "an inheriting project then paints the NEW global theme", async () => {
    // The write really was global — Beta inherits, so it must be wearing Ember
    // now, which is also what proves check 21 wasn't just a write that failed.
    await selectProject(page, PROJECT_B);
    const applied = await waitForToken(page, "--background", EMBER["--background"]);
    const stored = await themeStateFor(page, projectBId);
    return {
      ok: applied === EMBER["--background"] && stored.override === null,
      detail: `--background=${applied} override=${JSON.stringify(stored.override)}`,
    };
  });

  // ---- 9. the canvas layer (#124) ------------------------------------------
  // Beta is selected and inherits the global theme (Ember, from check 21), so
  // the editor opened here edits the look the whole app is currently wearing.
  await openThemeEditor(page);
  const committedCanvas = await canvasPaint(page);

  await attempt(23, "a Background hover repaints the canvas, and Escape puts it back", async () => {
    await openBackgroundMenu(page);
    const previewed = await hoverBackgroundRow(page, "Gradient", committedCanvas);
    // The search field is `sr-only` on a three-row list but still holds focus,
    // so this is the same keystroke a user makes — pressed on the page rather
    // than on a 1px box.
    await page.keyboard.press("Escape");
    const restored = await waitForCanvasPaint(page, (value) => value === committedCanvas);
    return {
      ok:
        previewed !== committedCanvas &&
        previewed.includes("linear-gradient") &&
        restored === committedCanvas,
      detail: `preview=${short(previewed)} restored=${restored === committedCanvas ? "exactly" : short(restored)}`,
    };
  });

  await attempt(24, "an outside click ends a Background preview", async () => {
    await openBackgroundMenu(page);
    // Arrowed, not hovered, on purpose: moving the pointer OUT of the list to
    // reach the outside target would fire the pointer-leave path on the way,
    // and this check would be grading that instead of the click. cmdk routes
    // arrow keys through the focused input, so the preview is real either way.
    let previewed = committedCanvas;
    for (let step = 0; step < CANVAS_OPTIONS.length && previewed === committedCanvas; step += 1) {
      await page.keyboard.press("ArrowDown");
      previewed = await waitForCanvasPaint(page, (value) => value !== committedCanvas, {
        timeout: 800,
      });
    }
    // The row's own description: inert copy, outside the popover, and it cannot
    // wander the way a bare coordinate can.
    await page.getByText("The layer behind the app's content.", { exact: false }).first().click();
    const restored = await waitForCanvasPaint(page, (value) => value === committedCanvas);
    return {
      ok: previewed !== committedCanvas && restored === committedCanvas,
      detail: `preview=${short(previewed)} restored=${restored === committedCanvas ? "exactly" : short(restored)}`,
    };
  });

  await attempt(25, "the pointer leaving the list ends a Background preview", async () => {
    await openBackgroundMenu(page);
    const previewed = await hoverBackgroundRow(page, "Mesh", committedCanvas);
    // A hover has no Escape: walking away IS the "never mind". (8, 8) is outside
    // the Command root, so this is the real pointerleave and not a click.
    await page.mouse.move(8, 8);
    const restored = await waitForCanvasPaint(page, (value) => value === committedCanvas);
    // Re-entering the SAME row must preview again. cmdk no-ops on an unchanged
    // value, so a row left highlighted swallows every later hover over it —
    // the bug 2c84925 fixed, on a row that fix predates.
    const reentered = await hoverBackgroundRow(page, "Mesh", committedCanvas);
    await page.mouse.move(8, 8);
    const restoredTwice = await waitForCanvasPaint(page, (value) => value === committedCanvas);
    return {
      ok:
        previewed !== committedCanvas &&
        restored === committedCanvas &&
        reentered === previewed &&
        restoredTwice === committedCanvas,
      detail: `preview=${short(previewed)} left=${restored === committedCanvas ? "exactly" : short(restored)} reentry=${reentered === previewed ? "previewed again" : short(reentered)}`,
    };
  });

  await attempt(26, "picking a Background repaints instantly, with no crossfade", async () => {
    // The negative half of #124's behaviour 16, and the one that matters most:
    // a canvas that faded on every pick would make three options feel like a
    // queue of stale frames, and nothing else in the suite would notice.
    await openBackgroundMenu(page);
    await watchCanvasFades(page);
    await watchScopeTransition(page);
    await page.getByRole("option", { name: "Gradient", exact: true }).first().click();
    const painted = await waitForCanvasPaint(page, (value) => value.includes("linear-gradient"));
    await sleep(SCOPE_TRANSITION_SETTLE_MS);
    const fades = await readCanvasFades(page);
    const armed = await readScopeTransition(page);
    return {
      ok: painted.includes("linear-gradient") && fades.length === 0 && !armed.seen,
      detail: `painted=${short(painted)} fades=${JSON.stringify(fades)} crossfadeArmed=${armed.seen}`,
    };
  });

  // Save the draft, so the GLOBAL theme now carries a gradient. Without this the
  // two scopes below would both resolve to `var(--rail)` — the same string, no
  // repaint, and checks 27-28 would be watching for a fade that correctly never
  // happens. This is also the only path that derives the stops through the app.
  await page.getByRole("button", { name: "Save theme", exact: true }).click();
  // Waited on the EDITOR closing, not on the paint: the paint is optimistic and
  // is already on screen, so a canvas poll would return before the write's
  // response has been adopted — leaving check 27 to switch scopes with a theme
  // write still in flight, which is a race it has no business testing.
  await backgroundTrigger(page).waitFor({ state: "detached" });
  await waitForCanvasPaint(page, (value) => value.includes("linear-gradient"));

  await attempt(27, "a project-scope change crossfades the canvas layer", async () => {
    await watchCanvasFades(page);
    await watchScopeTransition(page);
    // The paint trace is diagnosis, not assertion: "no crossfade" and "no scope
    // change to crossfade" look identical from the outside, and only the trace
    // tells them apart if this ever misses.
    await watchBackgroundPaints(page);
    // Alpha overrides to Midnight, which carries no canvas, so the layer goes
    // from the saved gradient to the flat fill — precisely the change
    // `background-image` cannot interpolate, and the whole reason two layers
    // are stacked rather than one whose `background` moves.
    await selectProject(page, PROJECT_A);
    const applied = await waitForToken(page, "--background", MIDNIGHT["--background"]);
    await sleep(SCOPE_TRANSITION_SETTLE_MS);
    const fades = await readCanvasFades(page);
    const armed = await readScopeTransition(page);
    const fade = fades[0] ?? {};
    return {
      ok:
        applied === MIDNIGHT["--background"] &&
        armed.seen &&
        fades.length === 1 &&
        fade.name === "volli-canvas-fade" &&
        fade.outgoing === true &&
        fade.duration === SCOPE_CROSSFADE_MS &&
        fade.playState === "running",
      detail: `--background=${applied} crossfadeArmed=${armed.seen} fades=${JSON.stringify(fades)} paints=${JSON.stringify(await readBackgroundPaints(page))}`,
    };
  });

  await attempt(28, "reduced motion collapses the crossfade to its short ease", async () => {
    // HIG: nothing here translates or scales, so the accessible treatment is the
    // shortest honest ease rather than a hard cut. The media query moves ONE
    // custom property, and the canvas reads it through the same animation — so
    // if this number is 300 the canvas has a duration of its own somewhere.
    await page.emulateMedia({ reducedMotion: "reduce" });
    // Reported for diagnosis only — Chromium serializes it as `.12s`, and the
    // assertion below is on the resolved animation, which is the number that
    // actually governs what is on screen.
    const collapsed = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--theme-scope-crossfade").trim(),
    );
    await watchCanvasFades(page);
    await selectProject(page, PROJECT_B);
    const applied = await waitForToken(page, "--background", EMBER["--background"]);
    await sleep(SCOPE_TRANSITION_SETTLE_MS);
    const fades = await readCanvasFades(page);
    const fade = fades[0] ?? {};
    return {
      ok:
        applied === EMBER["--background"] &&
        fades.length === 1 &&
        fade.duration === REDUCED_MOTION_CROSSFADE_MS,
      detail: `--theme-scope-crossfade=${collapsed || "(unset)"} --background=${applied} fades=${JSON.stringify(fades)}`,
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
