/**
 * Open Graph share cards for volli.app and docs.volli.app.
 *
 * Until this existed, neither site had an `og:image`. Every link posted to X,
 * Hacker News, Discord, Slack or iMessage rendered as a bare text card, which
 * is the one piece of launch surface you cannot fix after the fact — the
 * scrapers cache what they saw the first time.
 *
 * The card is rendered by Chromium rather than drawn with a canvas API so it
 * uses the site's real typeface (Mona Sans Variable, at the hero's own weight
 * and tracking) and the site's real palette, pulled from `global.css` below.
 * A drawn-by-hand card drifts from the site the first time the brand moves;
 * this one is the same fonts and the same hexes.
 *
 * It renders at 2x and downsamples to 1200x630, because text rasterised
 * directly at 1200px wide is noticeably coarser than text supersampled from
 * 2400px. 1200x630 is the size every major scraper wants, and `summary_large_image`
 * is what makes X use it.
 *
 * Deliberately typographic, with no product screenshot: a share card is
 * usually seen at around 500px wide in a feed, where UI chrome turns to mush
 * and a headline still reads.
 *
 * Run when the headline, the palette or the icon changes:
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

/** The site's palette, copied from `src/styles/global.css`. */
const PALETTE = {
  page: "#0a0a0a",
  text: "#f5f5f7",
  muted: "#9a9a9a",
  quiet: "#6e6e73",
  line: "#2a2a2a",
  ember: "#e8652a",
};

/**
 * The two cards.
 *
 * The copy is shorter than the page's own hero copy on purpose. A feed
 * preview truncates, and the full lede ("Turn a rough idea into focused tasks
 * yourself or with an agent...") loses its second clause exactly where the
 * meaning lives.
 */
const CARDS = [
  {
    out: join(websiteRoot, "public/og.png"),
    eyebrow: "Alpha · Apple silicon",
    headline: "The workspace for parallel coding agents.",
    lede: "Plan the work, run agents in parallel, review every change.",
    footer: "volli.app",
  },
  {
    out: join(repoRoot, "apps/docs/public/og.png"),
    eyebrow: "Documentation",
    headline: "Everything you need to run Volli.",
    lede: "Install, quickstart, concepts, guides, and the CLI reference.",
    footer: "docs.volli.app",
  },
];

/** Inline the assets. Chromium gets one self-contained document with no
 *  network and no file:// reads, so the render cannot silently fall back to a
 *  system font and produce a subtly wrong card. */
async function loadAssets() {
  const [font, icon] = await Promise.all([
    fs.readFile(
      join(
        websiteRoot,
        "node_modules/@fontsource-variable/mona-sans/files/mona-sans-latin-wght-normal.woff2",
      ),
    ),
    fs.readFile(join(websiteRoot, "brand/volli-icon-master.png")),
  ]);
  return {
    font: font.toString("base64"),
    icon: icon.toString("base64"),
  };
}

function markup({ eyebrow, headline, lede, footer }, { font, icon }) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      @font-face {
        font-family: "Mona Sans Variable";
        src: url(data:font/woff2;base64,${font}) format("woff2-variations");
        font-weight: 200 900;
        font-style: normal;
      }
      * { box-sizing: border-box; margin: 0; }
      body {
        width: ${WIDTH}px;
        height: ${HEIGHT}px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        padding: 72px 76px;
        background: ${PALETTE.page};
        color: ${PALETTE.text};
        font-family: "Mona Sans Variable", sans-serif;
        font-synthesis: none;
        -webkit-font-smoothing: antialiased;
        overflow: hidden;
        position: relative;
      }
      /* An ember wash bleeding off the top-right corner, echoing the warm-to-cool
         gradient inside the app icon. Large and low-opacity so it reads as depth
         rather than as a coloured shape. */
      .glow {
        position: absolute;
        top: -340px;
        right: -260px;
        width: 900px;
        height: 900px;
        border-radius: 50%;
        background: radial-gradient(circle, ${PALETTE.ember}33 0%, ${PALETTE.ember}0d 42%, transparent 68%);
      }
      .row { display: flex; align-items: center; justify-content: space-between; position: relative; }
      .brand { display: flex; align-items: center; gap: 18px; }
      .brand img { width: 64px; height: 64px; border-radius: 15px; }
      .brand span {
        font-size: 31px;
        font-weight: 500;
        letter-spacing: -0.035em;
      }
      .eyebrow {
        padding: 9px 20px 10px;
        border: 1px solid ${PALETTE.line};
        border-radius: 999px;
        color: ${PALETTE.muted};
        font-size: 20px;
        font-weight: 400;
        letter-spacing: -0.01em;
        white-space: nowrap;
      }
      .body { position: relative; }
      /* Hero tracking and weight, scaled up for the card. */
      h1 {
        max-width: 19ch;
        font-size: 78px;
        font-weight: 420;
        letter-spacing: -0.05em;
        line-height: 1.06;
        text-wrap: balance;
      }
      p {
        margin-top: 26px;
        max-width: 46ch;
        color: ${PALETTE.muted};
        font-size: 27px;
        font-weight: 360;
        letter-spacing: -0.012em;
        line-height: 1.45;
      }
      .footer {
        color: ${PALETTE.quiet};
        font-size: 22px;
        font-weight: 400;
        letter-spacing: -0.01em;
      }
      .rule { height: 1px; flex: 1; margin-left: 26px; background: ${PALETTE.line}; }
    </style>
  </head>
  <body>
    <div class="glow"></div>
    <div class="row">
      <div class="brand">
        <img src="data:image/png;base64,${icon}" alt="" />
        <span>Volli</span>
      </div>
      <div class="eyebrow">${eyebrow}</div>
    </div>
    <div class="body">
      <h1>${headline}</h1>
      <p>${lede}</p>
    </div>
    <div class="row">
      <div class="footer">${footer}</div>
      <div class="rule"></div>
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
