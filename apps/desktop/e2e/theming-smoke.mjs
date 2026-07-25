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
 *
 * Like terminal-smoke.mjs / ghostty-config-smoke.mjs this is a MANUALLY-RUN
 * smoke (needs a display + the built app) — CI does not run it:
 *
 *   pnpm -C apps/desktop run build
 *   node apps/desktop/e2e/theming-smoke.mjs
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { APCAcontrast, sRGBtoY } from "apca-w3";

import {
  assertProfileIsolated,
  createRunner,
  launch,
  makeScratch,
  pathExists,
  readFileSafe,
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
async function waitForToken(page, name, expected) {
  await waitUntil(
    `${name} → ${expected}`,
    async () => (await readAppliedTokens(page, [name]))[name] === expected,
    { timeout: 4000 },
  ).catch(() => {});
  return (await readAppliedTokens(page, [name]))[name];
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
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByText("Ghostty's full theme catalog", { exact: false }).first().waitFor();
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
    floor("border ΔL", oklchL(t["--border"]) - oklchL(t["--background"]), 0.07);
    return { ok: failures.length === 0, detail: failures.join(" · ") };
  });

  // ---- 3. the picker: live preview, revert, commit --------------------------
  // Driven on the APP theme rather than the terminal, because app-surface
  // preview lands in CSS custom properties — readable straight out of the
  // running document, with no canvas to screenshot and no test-only hook.
  await openAppearanceSettings(page);

  await attempt(4, "moving through the picker previews the theme live", async () => {
    await page
      .getByRole("option", { name: /Midnight/ })
      .first()
      .hover();
    const applied = await waitForToken(page, "--background", MIDNIGHT["--background"]);
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

  await attempt(6, "picking a theme commits it", async () => {
    await page.getByRole("option", { name: /Moss/ }).first().click();
    const applied = await waitForToken(page, "--background", MOSS["--background"]);
    return { ok: applied === MOSS["--background"], detail: `--background=${applied}` };
  });

  // ---- 4. the terminal overlay ---------------------------------------------
  await attempt(7, "committing a terminal theme writes Volli's own overlay", async () => {
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
  await attempt(8, "the user's own ghostty config is byte-identical (#67)", async () => {
    const after = await fs.readFile(userConfigPath, "utf8");
    return {
      ok: after === userConfigBefore,
      detail: after === userConfigBefore ? "unchanged" : "MUTATED — decision #67 violated",
    };
  });

  await attempt(9, "a Volli write preserves hand-written keys and comments (#68)", async () => {
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

  await attempt(10, "the committed terminal theme survives a relaunch", async () => {
    await openAppearanceSettings(page);
    const label = await terminalThemeTrigger(page).textContent();
    return {
      ok: label?.trim() === "Nord",
      detail: `trigger reads ${JSON.stringify(label?.trim())}`,
    };
  });

  await attempt(11, "the committed app theme survives a relaunch", async () => {
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
} catch (error) {
  check("!", "smoke crashed", false, String(error?.stack ?? error));
} finally {
  await app.close().catch(() => {});
}

const exitCode = summarize();
await cleanup();
process.exit(exitCode);
