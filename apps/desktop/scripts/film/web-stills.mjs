#!/usr/bin/env node
/**
 * Product stills for volli.app (VC-472), cut from the release film's scenes.
 *
 *   node scripts/film/web-stills.mjs [--port 5188] [--only armed,island] [--formats wide,tall]
 *
 * The lab must already be serving (`pnpm lab`, or `vp dev --mode lab`).
 *
 * The website tells a release the way the film does — one chapter per
 * headline, each in its own world — so its pictures are the film's frames:
 * the same real renderer components, fixture data, theme and camera. What
 * this leaves OUT is everything that belongs to the film's frame rather than
 * to the product: the supers, the vignette and grade, and the backdrop world.
 * The frame is captured with a transparent background, so the site paints its
 * own live world behind the window and sets its supers as real text.
 *
 * Every still is taken from the wide (16:9) and the tall (9:16) composition of
 * its shot; the site picks the tall one on narrow screens, the same
 * recomposition the film does for vertical video.
 *
 * Output: `apps/website/src/assets/stills/<name>-<format>.webp`, written with
 * sharp. The same public-safety scan as `capture.mjs` runs on every frame.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import sharp from "sharp";
import { trimToSubject, WEBP } from "./trim-still.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "..", "website", "src", "assets", "stills");

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const port = Number(option("--port", "5188"));
const only = option("--only", null)?.split(",") ?? null;
const formats = option("--formats", "wide,tall").split(",");

/**
 * Which frame of which shot each chapter uses, per format. Times are scene
 * milliseconds, picked where the shot has settled and its subject reads.
 */
const STILLS = [
  { name: "armed", scene: "armed", wide: 1500, tall: 1500 },
  { name: "island", scene: "island", wide: 1500, tall: 1500 },
  // Heavy backdrop blurs: at 4x a frame takes minutes to paint; 3x is still sharp.
  { name: "cursor", scene: "cursor", wide: 1800, tall: 1800, scale: 3 },
  { name: "split", scene: "split", wide: 2700, tall: 2700 },
  { name: "limits", scene: "limits", wide: 1500, tall: 1500 },
  { name: "models", scene: "models", wide: 1800, tall: 1800 },
  { name: "mcp", scene: "mcp", wide: 1399, tall: 1399 },
  { name: "hook", scene: "hook", wide: 1600, tall: 1600 },
  { name: "peek", scene: "peek", wide: 1600, tall: 1600, scale: 3 },
  { name: "peek-reply", scene: "peek", wide: 4200, tall: 4200 },
  { name: "rail", scene: "rail", wide: 1100, tall: 1100 },
  { name: "picker", scene: "picker", wide: 1400, tall: 1400 },
];

/** What the website needs, per format: CSS width at 2x, and the layout size. */
const FORMATS = {
  wide: { viewport: { width: 1920, height: 1080 }, width: 2880 },
  tall: { viewport: { width: 1080, height: 1920 }, width: 1440 },
};

// The film's frame, not the product: hide it, and let the page show through.
const TRANSPARENT = `
  html, body, main, .flute-viewport, .flute-canvas, [data-flute-scene] { background: transparent !important; }
  .film-backdrop, .film-frame { display: none !important; }
  [data-flute-preview-chrome], nextjs-portal { visibility: hidden !important; }
  /* While the clock walks up to the still nothing needs painting — the scene's
     state follows the clock, not the pixels — and at 4x paint is the cost. */
  html.web-still-walking body { visibility: hidden !important; }
`;

const PRIVATE = [
  /\/Users\/[^\s"')]*/,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?!example\b|test\b|invalid\b)[A-Za-z]{2,}\b/,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/,
];

/**
 * The scale the frame is rasterized at. The camera magnifies surfaces through
 * a perspective transform, and Chrome rasterizes those layers at the device
 * scale rather than at the scale they end up on screen — so at an emulated
 * deviceScaleFactor of 2 a pushed-in window is a 1x picture blown up, and its
 * text smears. A real device scale (the command-line flag, not Playwright's
 * emulation) rasterizes every layer at it; 4x, downsampled, is sharp at the
 * site's 2x width.
 */
const RASTER_SCALE = 4;

mkdirSync(outDir, { recursive: true });

for (const [format, spec] of Object.entries(FORMATS)) {
  if (!formats.includes(format)) continue;
  for (const still of STILLS) {
    if (only !== null && !only.includes(still.name)) continue;
    // The device scale is a launch flag, so each still gets its own browser.
    const browser = await chromium.launch({
      headless: true,
      args: [
        "--force-color-profile=srgb",
        "--hide-scrollbars",
        "--disable-lcd-text",
        `--force-device-scale-factor=${still.scale ?? RASTER_SCALE}`,
        `--window-size=${spec.viewport.width},${spec.viewport.height}`,
      ],
    });
    const sceneId = `${still.scene}-${format}`;
    const context = await browser.newContext({ viewport: null, colorScheme: "dark" });
    const page = await context.newPage();
    page.on("pageerror", (error) => console.error(`[${sceneId}]`, error.message));
    await page.addInitScript((css) => {
      document.addEventListener("DOMContentLoaded", () => {
        const style = document.createElement("style");
        style.textContent = css;
        document.head.append(style);
      });
    }, TRANSPARENT);
    await page.goto(
      `http://127.0.0.1:${port}/lab/?flute-preview=1&flute-scene=${encodeURIComponent(sceneId)}`,
      { waitUntil: "load", timeout: 180_000 },
    );
    await page.waitForFunction(() => typeof window.__FLUTE_CAPTURE__?.seek === "function", null, {
      timeout: 180_000,
    });
    await page.evaluate(() => document.fonts.ready);
    const client = await context.newCDPSession(page);
    await client.send("Emulation.setDefaultBackgroundColorOverride", {
      color: { r: 0, g: 0, b: 0, a: 0 },
    });

    // Walk the clock up to the still at 60fps: the components' own
    // transitions are pinned from the frame they start on (capture.mjs).
    const target = still[format];
    const seek = (ms) =>
      page.evaluate(async (elapsed) => {
        window.__FLUTE_CAPTURE__.seek(elapsed);
        const want = String(elapsed);
        const deadline = performance.now() + 5000;
        while (document.documentElement.dataset.filmTime !== want) {
          if (performance.now() > deadline) throw new Error(`scene never reached ${want}`);
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }, ms);
    await page.evaluate(() => document.documentElement.classList.add("web-still-walking"));
    for (let clock = 0; clock < target; clock += 1000 / 60) {
      await seek(Math.round(clock * 1000) / 1000);
    }
    await page.evaluate(() => document.documentElement.classList.remove("web-still-walking"));
    await seek(target);

    const selector = await page.evaluate(() => window.__FLUTE_CAPTURE__.selector);
    const text = await page.evaluate((sel) => document.querySelector(sel)?.innerText ?? "", selector);
    for (const pattern of PRIVATE) {
      const hit = text.match(pattern);
      if (hit !== null) throw new Error(`${sceneId}: private-looking text in frame: ${hit[0]}`);
    }

    // A clip, not an element screenshot: the scene's clock is paused, but some
    // shots keep a looping CSS animation, and Playwright waits forever for an
    // element that never holds still.
    const box = await page.evaluate((sel) => {
      const rect = document.querySelector(sel).getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }, selector);
    const png = await page.screenshot({
      clip: box,
      omitBackground: true,
      type: "png",
      timeout: 180_000,
    });
    const file = join(outDir, `${still.name}-${format}.webp`);
    const sized = await sharp(png).resize({ width: spec.width }).png().toBuffer();
    await sharp(await trimToSubject(sized)).webp(WEBP).toFile(file);
    console.log("wrote", file);
    await browser.close();
  }
}
