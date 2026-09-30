/**
 * Open Graph share cards for volli.app and docs.volli.app.
 *
 * Every link posted to X, Hacker News, Discord, Slack or iMessage renders this
 * card, and it is the one piece of launch surface you cannot fix after the
 * fact — the scrapers cache what they saw the first time.
 *
 * The card is rendered by Chromium rather than drawn with a canvas API so it
 * is set in the site's real typeface (Mona Sans Variable, from the same full
 * variable files `Base.astro` loads, so the width axis and the italic are
 * there) with the site's real palette and mark, copied from `site.css` and
 * `Mark.astro` below. It follows `brand/BRAND.md`: the night, ink and one
 * ember; nothing above the headline; one two-beat Super, light then bold. On
 * the website card the bold beat is the hero's italic, holding the still
 * speed lines the hero shows under reduced motion.
 *
 * It renders at 2x and downsamples to 1200x630, because text rasterised
 * directly at 1200px wide is noticeably coarser than text supersampled from
 * 2400px. 1200x630 is the size every major scraper wants, and
 * `summary_large_image` is what makes X use it.
 *
 * Deliberately typographic, with no product screenshot: a share card is
 * usually seen at around 500px wide in a feed, where UI chrome turns to mush
 * and a headline still reads.
 *
 * Run when the headline, the palette or the mark changes:
 *
 *   node apps/website/scripts/generate-og-image.mjs
 *
 * `--check` verifies the committed cards match what this script produces.
 * Needs a Chromium that playwright-core can find; the repo already keeps one
 * for the desktop e2e probes.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const websiteRoot = join(here, "..");
const repoRoot = join(websiteRoot, "..", "..");

const WIDTH = 1200;
const HEIGHT = 630;
const SCALE = 2;

/** The site's palette, copied from `src/styles/site.css` (BRAND.md §6). */
const PALETTE = {
  night: "#07070a",
  ink: "#f5f2ee",
  ink2: "rgb(245 242 238 / 0.64)",
  ink3: "rgb(245 242 238 / 0.42)",
  hairline: "rgb(245 242 238 / 0.1)",
  ember: "#e8652a",
  bone: "#f2eae0",
};

/** The mark (BRAND.md §4), the same glyph as `src/components/Mark.astro`. */
const MARK = `<svg class="mark" viewBox="48 42 160 172" aria-hidden="true">
  <rect x="48" y="42" width="40" height="172" rx="18" fill="${PALETTE.bone}" />
  <rect x="108" y="42" width="40" height="100" rx="18" fill="${PALETTE.bone}" />
  <rect x="108" y="158" width="40" height="44" rx="10" fill="${PALETTE.ember}" />
  <rect x="168" y="42" width="40" height="136" rx="18" fill="${PALETTE.bone}" />
</svg>`;

/**
 * The two cards.
 *
 * The headline is the page's own Super, two beats, light then bold. The lede
 * is shorter than the page's: a feed preview truncates, and the second
 * sentence of the hero lede is where it would cut. There is no eyebrow — the
 * brand puts nothing above a headline — so the facts a skeptic checks sit in
 * the quiet line at the foot of the card.
 */
const CARDS = [
  {
    out: join(websiteRoot, "public/og.png"),
    section: null,
    beats: ["Build like", "a team of twenty."],
    speed: true,
    lede: "A Mac app for building ambitious software with many coding agents at once.",
    host: "volli.app",
    note: "Free and open source · For Apple silicon Macs",
  },
  {
    out: join(repoRoot, "apps/docs/public/og.png"),
    section: "Docs",
    beats: ["Everything you need", "to run Volli."],
    speed: false,
    lede: "Install, quickstart, concepts, guides and the CLI reference.",
    host: "docs.volli.app",
    note: "",
  },
];

/** Inline the assets. Chromium gets one self-contained document with no
 *  network and no file:// reads, so the render cannot silently fall back to a
 *  system font and produce a subtly wrong card. */
async function loadAssets() {
  const files = join(websiteRoot, "node_modules/@fontsource-variable/mona-sans/files");
  const [upright, italic] = await Promise.all([
    fs.readFile(join(files, "mona-sans-latin-standard-normal.woff2")),
    fs.readFile(join(files, "mona-sans-latin-standard-italic.woff2")),
  ]);
  return {
    upright: upright.toString("base64"),
    italic: italic.toString("base64"),
  };
}

function markup({ section, beats: [light, bold], speed, lede, host, note }, { upright, italic }) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      @font-face {
        font-family: "Mona Sans Variable";
        src: url(data:font/woff2;base64,${upright}) format("woff2-variations");
        font-weight: 200 900;
        font-stretch: 75% 125%;
        font-style: normal;
      }
      @font-face {
        font-family: "Mona Sans Variable";
        src: url(data:font/woff2;base64,${italic}) format("woff2-variations");
        font-weight: 200 900;
        font-stretch: 75% 125%;
        font-style: italic;
      }
      * { box-sizing: border-box; margin: 0; }
      body {
        width: ${WIDTH}px;
        height: ${HEIGHT}px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        padding: 64px 80px 60px;
        background: ${PALETTE.night};
        color: ${PALETTE.ink};
        font-family: "Mona Sans Variable", sans-serif;
        font-synthesis: none;
        -webkit-font-smoothing: antialiased;
        overflow: hidden;
        position: relative;
      }
      /* Ember is home (BRAND.md §2): one low pool of the default canvas's
         light, rising from below the card's foot. Large and faint, so it
         reads as the world rather than as a coloured shape. */
      .world {
        position: absolute;
        inset: 0;
        background:
          radial-gradient(ellipse 62% 58% at 88% 118%, rgb(232 101 42 / 0.36), transparent 70%),
          radial-gradient(ellipse 48% 44% at 62% 124%, rgb(242 119 63 / 0.12), transparent 72%);
      }
      .row { position: relative; display: flex; align-items: center; justify-content: space-between; }
      .brand { display: flex; align-items: center; gap: 16px; }
      .mark { display: block; width: 37px; height: 40px; }
      .brand span {
        font-size: 34px;
        font-weight: 640;
        font-stretch: 104%;
        letter-spacing: -0.02em;
      }
      .brand .section {
        padding-left: 16px;
        border-left: 2px solid ${PALETTE.hairline};
        color: ${PALETTE.ink2};
        font-weight: 420;
        font-stretch: 100%;
      }
      .body { position: relative; }
      /* The Super: a light beat, then a bold one (BRAND.md §5). */
      h1 {
        font-size: 104px;
        font-weight: 300;
        line-height: 1;
        letter-spacing: -0.035em;
      }
      h1 span { display: block; padding-bottom: 0.08em; }
      h1 .bold {
        font-weight: 780;
        font-stretch: 108%;
        letter-spacing: -0.04em;
      }
      /* The hero's bold beat: italic, with its speed lines held still — dark
         slits and one ember stripe clipped to the letters, as the hero looks
         under reduced motion. */
      h1 .speed { font-style: italic; }
      h1 .speed > span {
        display: inline-block;
        padding-right: 0.08em;
        color: transparent;
        background:
          linear-gradient(90deg, transparent 0, ${PALETTE.night} 6%, transparent 58%) 0 34% / 7em 0.05em repeat-x,
          linear-gradient(90deg, transparent 0, ${PALETTE.night} 5%, transparent 44%) 0 49% / 4.5em 0.04em repeat-x,
          linear-gradient(90deg, transparent 0, ${PALETTE.ember} 4%, transparent 52%) 0 61% / 9em 0.065em repeat-x,
          linear-gradient(90deg, transparent 0, ${PALETTE.night} 7%, transparent 50%) 0 74% / 5.5em 0.045em repeat-x,
          ${PALETTE.ink};
        -webkit-background-clip: text;
        background-clip: text;
      }
      p {
        margin-top: 30px;
        max-width: 1040px;
        color: rgb(245 242 238 / 0.78);
        font-size: 28px;
        font-weight: 380;
        letter-spacing: -0.01em;
        line-height: 1.4;
        text-wrap: pretty;
      }
      .foot {
        color: ${PALETTE.ink3};
        font-size: 22px;
        font-weight: 440;
        letter-spacing: -0.005em;
      }
    </style>
  </head>
  <body>
    <div class="world"></div>
    <div class="row">
      <div class="brand">
        ${MARK}
        <span>Volli</span>
        ${section ? `<span class="section">${section}</span>` : ""}
      </div>
    </div>
    <div class="body">
      <h1><span>${light}</span><span class="bold${speed ? " speed" : ""}"><span>${bold}</span></span></h1>
      <p>${lede}</p>
    </div>
    <div class="row foot">
      <span>${host}</span>
      <span>${note}</span>
    </div>
  </body>
</html>`;
}

const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function main() {
  const check = process.argv.includes("--check");
  const assets = await loadAssets();

  const browser = await chromium.launch({ headless: true });
  const stale = [];

  try {
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: SCALE,
    });

    for (const card of CARDS) {
      await page.setContent(markup(card, assets), { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);

      const supersampled = await page.screenshot({ type: "png" });
      const next = await sharp(supersampled)
        .resize(WIDTH, HEIGHT, { fit: "fill", kernel: "lanczos3" })
        .png({ compressionLevel: 9, effort: 10 })
        .toBuffer();

      const label = relative(repoRoot, card.out);

      let current = null;
      try {
        current = await fs.readFile(card.out);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }

      if (current && digest(current) === digest(next)) {
        console.log(`  ok       ${label} (${(next.length / 1024).toFixed(1)} KB)`);
        continue;
      }

      if (check) {
        stale.push(label);
        console.log(`  STALE    ${label}`);
        continue;
      }

      await fs.mkdir(dirname(card.out), { recursive: true });
      await fs.writeFile(card.out, next);
      console.log(
        `  wrote    ${label} (${WIDTH}x${HEIGHT}, ${(next.length / 1024).toFixed(1)} KB)`,
      );
    }
  } finally {
    await browser.close();
  }

  if (stale.length > 0) {
    console.error(
      `\n${stale.length} share card(s) are stale. Run:\n  node apps/website/scripts/generate-og-image.mjs\n`,
    );
    process.exit(1);
  }
}

await main();
