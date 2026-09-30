#!/usr/bin/env node
/**
 * The volli.app hero film (VC-472): the web-only `hero` shot (shots/hero.mjs),
 * rendered as two videos of the real app in its world — an intro that plays
 * once (the sweep down live agents, pulling back to the centred window) and a
 * drift that loops without a seam. The film's backdrop is kept; its supers and
 * grade are left out, because the page sets its own words.
 *
 * Rendering is slow (a 3D camera, depth of field, a real device scale), so it
 * splits: render frame ranges in parallel into one directory, then encode.
 *
 *   node scripts/film/web-hero.mjs --frames <dir> [--from ms] [--to ms]   # render
 *   node scripts/film/web-hero.mjs --frames <dir> --encode [--split 2600] # encode
 *
 *   options: [--port 5188] [--scene hero-wide]
 *            [--fps 30] [--scale 1.75] [--width 2400]
 *
 * The lab must already be serving (`pnpm lab`, or `vp dev --mode lab`).
 *
 * Sharpness comes from a real device scale (the `--force-device-scale-factor`
 * launch flag), not Playwright's emulated one: the film's camera magnifies its
 * surfaces through a perspective transform, and under emulation Chrome
 * rasterizes those layers at 1x and blows them up (see web-stills.mjs).
 *
 * Output: `apps/website/src/assets/hero/{intro,loop}.{mp4,webm}` and a poster —
 * the loop's first frame, which is also where the intro ends — shown alone
 * under reduced motion.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "..", "website", "src", "assets", "hero");

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const port = Number(option("--port", "5188"));
const sceneId = option("--scene", "hero-wide");
const frames = option("--frames", null);
if (frames === null) throw new Error("--frames <dir> is required");
mkdirSync(frames, { recursive: true });
const frameName = (index) => join(frames, `${String(index).padStart(4, "0")}.png`);
const fps = Number(option("--fps", "30"));
const scale = Number(option("--scale", "1.75"));
// Flute's capture bridge: the same `seek` its own export drives (capture.mjs).
const BRIDGE = "__FLUTE_CAPTURE__";
const width = Number(option("--width", "2400"));
const viewport = sceneId.endsWith("-tall")
  ? { width: 1080, height: 1920 }
  : { width: 1920, height: 1080 };

// The film's frame, not the product: supers and the vignette go; the backdrop
// world stays, because the hero is the app floating in it.
const CSS = `
  .film-frame { display: none !important; }
  html.web-hero-walking body { visibility: hidden !important; }
  [data-flute-preview-chrome], nextjs-portal { visibility: hidden !important; }
`;

const PRIVATE = [
  /\/Users\/[^\s"')]*/,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?!example\b|test\b|invalid\b)[A-Za-z]{2,}\b/,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/,
];

if (!args.includes("--encode")) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--force-color-profile=srgb",
      "--hide-scrollbars",
      "--disable-lcd-text",
      `--force-device-scale-factor=${scale}`,
      `--window-size=${viewport.width},${viewport.height}`,
    ],
  });
  const context = await browser.newContext({ viewport: null, colorScheme: "dark" });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error(`[${sceneId}]`, error.message));
  await page.addInitScript((css) => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = css;
      document.head.append(style);
    });
  }, CSS);
  await page.goto(
    `http://127.0.0.1:${port}/lab/?flute-preview=1&flute-scene=${encodeURIComponent(sceneId)}`,
    { waitUntil: "load", timeout: 180_000 },
  );
  await page.waitForFunction((name) => typeof window[name]?.seek === "function", BRIDGE, {
    timeout: 180_000,
  });
  await page.evaluate(() => document.fonts.ready);
  const { selector, durationMs } = await page.evaluate(
    (name) => ({ selector: window[name].selector, durationMs: window[name].durationMs }),
    BRIDGE,
  );

  const seek = (ms) =>
    page.evaluate(
      async ([name, elapsed]) => {
        window[name].seek(elapsed);
        const want = String(elapsed);
        const deadline = performance.now() + 5000;
        while (document.documentElement.dataset.filmTime !== want) {
          if (performance.now() > deadline) throw new Error(`scene never reached ${want}`);
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      },
      [BRIDGE, ms],
    );

  const box = await page.evaluate((sel) => {
    const rect = document.querySelector(sel).getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, selector);

  const first = Math.ceil((Number(option("--from", "0")) * fps) / 1000);
  const end = Math.min(Number(option("--to", String(durationMs))), durationMs);
  const count = Math.ceil((end * fps) / 1000);
  const started = performance.now();
  // Walk the clock up to the range: components' own transitions are pinned from
  // the frame they start on, so a range cannot start cold at its first frame.
  await page.evaluate(() => document.documentElement.classList.add("web-hero-walking"));
  for (let clock = 0; clock < (first * 1000) / fps; clock += 1000 / fps) {
    await seek(Math.round(clock * 1000) / 1000);
  }
  await page.evaluate(() => document.documentElement.classList.remove("web-hero-walking"));
  for (let index = first; index < count; index += 1) {
    await seek(Math.round(((index * 1000) / fps) * 1000) / 1000);
    const text = await page.evaluate(
      (sel) => document.querySelector(sel)?.innerText ?? "",
      selector,
    );
    for (const pattern of PRIVATE) {
      const hit = text.match(pattern);
      if (hit !== null) throw new Error(`${sceneId}: private-looking text in frame: ${hit[0]}`);
    }
    const png = await page.screenshot({ clip: box, type: "png", timeout: 180_000 });
    writeFileSync(frameName(index), png);
    if (index % fps === 0) {
      const rate = (index - first + 1) / ((performance.now() - started) / 1000);
      process.stderr.write(`${sceneId}: ${index + 1}/${count} (${rate.toFixed(2)} fps)\n`);
    }
  }
  await browser.close();
  console.log("rendered", first, "to", count - 1, "into", frames);
} else {
  // Encode: [0, split) is the intro, [split, end) the loop. The loop's last
  // frame is one step before its first, so it wraps without a repeated frame.
  mkdirSync(outDir, { recursive: true });
  const split = Math.round((Number(option("--split", "2600")) * fps) / 1000);
  const total = readdirSync(frames).filter((file) => file.endsWith(".png")).length;
  const encode = (name, start, frameCount) => {
    const input = [
      "-framerate",
      String(fps),
      "-start_number",
      String(start),
      "-i",
      join(frames, "%04d.png"),
      "-frames:v",
      String(frameCount),
      "-vf",
      `scale=${width}:-2:flags=lanczos`,
      "-an",
    ];
    const run = (extra) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          "ffmpeg",
          ["-hide_banner", "-loglevel", "error", "-y", ...input, ...extra],
          {
            stdio: ["ignore", "inherit", "inherit"],
          },
        );
        child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))));
      });
    return Promise.all([
      run([
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-crf",
        "21",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        join(outDir, `${name}.mp4`),
      ]),
      run([
        "-c:v",
        "libvpx-vp9",
        "-crf",
        "36",
        "-b:v",
        "0",
        "-row-mt",
        "1",
        join(outDir, `${name}.webm`),
      ]),
    ]);
  };
  await encode("intro", 0, split);
  await encode("loop", split, total - split);
  await sharp(readFileSync(frameName(split)))
    .resize({ width })
    .webp({ quality: 82, effort: 6 })
    .toFile(join(outDir, "poster.webp"));
  console.log("wrote", outDir, `intro (${split} frames), loop (${total - split}), poster`);
}
