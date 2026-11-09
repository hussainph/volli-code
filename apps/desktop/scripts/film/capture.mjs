#!/usr/bin/env node
/**
 * Renders one release-film scene (VC-464) through Flute's own capture bridge.
 *
 *   node scripts/film/capture.mjs <scene-id> --out <file.mp4 | dir>
 *        [--port 5188] [--fps 60] [--dsf 2] [--stills 0,800,1600]
 *        [--from ms] [--to ms] [--browser chrome|shell]
 *
 * The lab must already be serving (`pnpm lab`, or `vp dev --mode lab`).
 *
 * Why not `npx flute export`: it screenshots at deviceScaleFactor 1, so a 4K
 * master means laying the UI out at 3840px — a different layout, not a
 * sharper one — and it launches a Chromium build this machine does not cache.
 * This drives the SAME bridge (`window.__FLUTE_CAPTURE__.seek`, the scene
 * viewport it names, the chrome it hides) at deviceScaleFactor 2: the lab's
 * real 1920×1080 layout, rendered at 3840×2160.
 *
 * It also does not pass `animations: "disabled"`, which fast-forwards every
 * CSS animation to its end. The film pins the components' own transitions to
 * the scene clock (src/flute/kit/film.tsx), and waits for `data-film-time` to
 * name the frame it seeked to before each picture — that is the determinism.
 *
 * Output is written under the gitignored film output directory by callers;
 * nothing here writes into the repository.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const sceneId = args[0];
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const out = option("--out", null);
if (!sceneId || !out) {
  console.error(
    "usage: capture.mjs <scene-id> --out <file.mp4|dir> [--stills a,b,c] [--fps 60] [--dsf 2]",
  );
  process.exit(2);
}
const port = Number(option("--port", "5188"));
const fps = Number(option("--fps", "60"));
const dsf = Number(option("--dsf", "2"));
const stills = option("--stills", null);
const which = option("--browser", "chrome");
const size = sceneId.endsWith("-tall")
  ? { width: 1080, height: 1920 }
  : { width: 1920, height: 1080 };

function executable() {
  const root = join(homedir(), "Library", "Caches", "ms-playwright");
  const dirs = readdirSync(root).toSorted().toReversed();
  if (which === "chrome") {
    for (const dir of dirs.filter((d) => /^chromium-\d+$/.test(d))) {
      const app = join(
        root,
        dir,
        "chrome-mac-arm64",
        "Google Chrome for Testing.app",
        "Contents",
        "MacOS",
        "Google Chrome for Testing",
      );
      if (existsSync(app)) return app;
    }
  }
  for (const dir of dirs.filter((d) => d.startsWith("chromium_headless_shell-"))) {
    const shell = join(root, dir, "chrome-headless-shell-mac-arm64", "chrome-headless-shell");
    if (existsSync(shell)) return shell;
  }
  throw new Error("no cached Playwright Chromium under " + root);
}

const browser = await chromium.launch({
  executablePath: executable(),
  headless: true,
  args: ["--force-color-profile=srgb", "--hide-scrollbars", "--disable-lcd-text", "--mute-audio"],
});
const page = await browser.newPage({ viewport: size, deviceScaleFactor: dsf, colorScheme: "dark" });
page.on("pageerror", (error) => console.error("[page error]", error.message));
const url = `http://127.0.0.1:${port}/lab/?flute-preview=1&flute-scene=${encodeURIComponent(sceneId)}`;
// Flute's own export hides the preview chrome the same way. Installed as an
// init script so it survives the preview's own navigation to the scene.
await page.addInitScript(() => {
  document.addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.textContent = "[data-flute-preview-chrome],nextjs-portal{visibility:hidden!important}";
    document.head.append(style);
  });
});
await page.goto(url, { waitUntil: "load", timeout: 180_000 });
// Flute's capture bridge: the same `seek` its own export drives.
const BRIDGE = "__FLUTE_CAPTURE__";
await page.waitForFunction((name) => typeof window[name]?.seek === "function", BRIDGE, {
  timeout: 180_000,
});
await page.evaluate(() => document.fonts.ready);
const manifest = await page.evaluate((name) => {
  const bridge = window[name];
  return { durationMs: bridge.durationMs, selector: bridge.selector };
}, BRIDGE);
const viewport = page.locator(manifest.selector);
const rect = await viewport.boundingBox();
if (rect === null) throw new Error("scene viewport not visible");
const client = await page.context().newCDPSession(page);

async function settleAt(timeMs) {
  await page.evaluate(
    async ([name, elapsed]) => {
      window[name].seek(elapsed);
      const want = String(elapsed);
      const deadline = performance.now() + 5000;
      while (document.documentElement.dataset.filmTime !== want) {
        if (performance.now() > deadline) throw new Error(`scene never reached ${want}`);
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      // One more frame: Flute re-evaluates surfaces after they re-register.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    },
    [BRIDGE, timeMs],
  );
}

// Public-safety audit (VC-464: "check every frame"). Every frame's text — the
// capture viewport's rendered text plus form values and titles — is scanned
// for the things that must never be in frame. Conservative: it reads text the
// camera may not show, so a hit is a reason to look, not proof of a leak.
const PRIVATE = [
  ["path under /Users", /\/Users\/[^\s"')]*/g],
  [
    "email",
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?!example\b|test\b|invalid\b)[A-Za-z]{2,}\b/g,
  ],
  [
    "token",
    /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
  ],
];
const findings = new Map();
async function audit(timeMs) {
  const text = await page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (root === null) return "";
    const values = [...root.querySelectorAll("input, textarea")].map((el) => el.value);
    const titles = [...root.querySelectorAll("[title], [aria-label]")].map(
      (el) => `${el.getAttribute("title") ?? ""} ${el.getAttribute("aria-label") ?? ""}`,
    );
    return [root.innerText, ...values, ...titles].join("\n");
  }, manifest.selector);
  for (const [kind, pattern] of PRIVATE) {
    for (const match of text.matchAll(pattern)) {
      const key = `${kind}: ${match[0]}`;
      if (!findings.has(key)) findings.set(key, timeMs);
    }
  }
}

async function frameAt(timeMs) {
  await settleAt(timeMs);
  await audit(timeMs);
  const { data } = await client.send("Page.captureScreenshot", {
    format: "png",
    optimizeForSpeed: true,
    clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: dsf },
  });
  return Buffer.from(data, "base64");
}

// Warm the scene once so first-frame work (fonts, layout, filters) is not timed.
await frameAt(0);

if (stills !== null) {
  mkdirSync(out, { recursive: true });
  // Walk the clock forward at the output cadence between stills: the
  // components' own transitions are pinned from the frame they START on, so a
  // still is only true to the video if the frames before it were visited.
  let clock = 0;
  for (const time of stills.split(",").map(Number)) {
    const target = Math.min(time, manifest.durationMs);
    if (target < clock) clock = 0;
    for (; clock + 1000 / fps < target; clock += 1000 / fps) {
      await settleAt(Math.round(clock * 1000) / 1000);
    }
    clock = target;
    const png = await frameAt(target);
    const file = join(out, `${sceneId}-${String(time).padStart(5, "0")}.png`);
    writeFileSync(file, png);
    console.log("wrote", file);
  }
} else {
  mkdirSync(dirname(out), { recursive: true });
  const from = Number(option("--from", "0"));
  const to = Math.min(Number(option("--to", String(manifest.durationMs))), manifest.durationMs);
  const frames = Math.ceil(((to - from) * fps) / 1000);
  const ffmpeg = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "image2pipe",
      "-framerate",
      String(fps),
      "-vcodec",
      "png",
      "-i",
      "pipe:0",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "12",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-frames:v",
      String(frames),
      out,
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  const done = new Promise((resolve, reject) =>
    ffmpeg.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)),
    ),
  );
  const started = performance.now();
  for (let i = 0; i < frames; i += 1) {
    const time = Math.round((from + (i * 1000) / fps) * 1000) / 1000;
    const png = await frameAt(time);
    if (!ffmpeg.stdin.write(png))
      await new Promise((resolve) => ffmpeg.stdin.once("drain", resolve));
    if (i % fps === 0) {
      const rate = (i + 1) / ((performance.now() - started) / 1000);
      process.stderr.write(`${sceneId}: ${i + 1}/${frames} frames (${rate.toFixed(1)} fps)\n`);
    }
  }
  ffmpeg.stdin.end();
  await done;
  console.log(
    "wrote",
    out,
    `${frames} frames @ ${fps}fps, ${rect.width * dsf}x${rect.height * dsf}`,
  );
}
if (findings.size === 0) console.log("privacy audit: clean (every captured frame's text)");
else {
  console.warn("privacy audit: LOOK AT THESE");
  for (const [key, at] of findings) console.warn(`  ${key}  (first at ${at} ms)`);
}
await browser.close();
