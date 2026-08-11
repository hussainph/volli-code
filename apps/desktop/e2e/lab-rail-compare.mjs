/**
 * TEMPORARY: side-by-side proof for the Calm Stack port — delete after review.
 *
 * Shoots the design of record (`ticket-right-sidebar`, the reviewed scratch)
 * and the shipped rail (`rail-port-check`, the real components) on the same
 * page at the same width, and stitches each pair into one labelled PNG.
 *
 *   node apps/desktop/e2e/lab-rail-compare.mjs [outDir]
 */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LAB = process.env.LAB_URL ?? "http://localhost:5178/lab/";
const OUT = process.argv[2] ?? "/tmp/rail-compare";

/** Each side's slug, tab selectors and width control. */
const SIDES = {
  scratch: {
    slug: "ticket-right-sidebar",
    tab: (page) => `#rail-tab-${page}`,
    width: (px) => `button:text-is("${px}px")`,
    light: 'button:has-text("dark")',
  },
  ported: {
    slug: "rail-port-check",
    tab: (page) => `[data-testid="ticket-rail-tab-${page}"]`,
    width: (px) => `button:text-is("${px}px")`,
    light: null,
  },
};

const PAGES = ["now", "changes", "files"];
const WIDTHS = [300, 240];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 2,
});

/** One rail, as a base64 PNG of just the `aside`. */
async function shoot(side, railPage, width) {
  const cfg = SIDES[side];
  // A full reload each time: the shell mounts a scratch from the hash, and
  // coming back from the stitched `setContent` page leaves it half-torn-down.
  await page.goto("about:blank");
  await page.goto(`${LAB}#${cfg.slug}`, { waitUntil: "networkidle" });
  await page.evaluate((s) => {
    if (window.location.hash !== `#${s}`) window.location.hash = s;
  }, cfg.slug);
  await page.waitForSelector("aside", { timeout: 20_000 });
  await page.click(cfg.width(width));
  await page.waitForTimeout(400);
  await page.click(cfg.tab(railPage));
  // Past the pill's 320ms spring and the label's 140ms fade.
  await page.waitForTimeout(900);
  const buf = await page.locator("aside").screenshot();
  return buf.toString("base64");
}

for (const width of WIDTHS) {
  for (const railPage of PAGES) {
    const [a, b] = [
      await shoot("scratch", railPage, width),
      await shoot("ported", railPage, width),
    ];
    const html = `<body style="margin:0;background:#111;font:12px -apple-system;color:#bbb">
      <div style="display:flex;gap:24px;padding:16px;align-items:flex-start">
        <figure style="margin:0"><figcaption style="padding:4px 0">SCRATCH — design of record</figcaption>
          <img src="data:image/png;base64,${a}" style="width:${width}px;display:block"></figure>
        <figure style="margin:0"><figcaption style="padding:4px 0">PORTED — shipped components</figcaption>
          <img src="data:image/png;base64,${b}" style="width:${width}px;display:block"></figure>
      </div></body>`;
    await page.setContent(html);
    await page.waitForTimeout(200);
    const file = `${OUT}/${railPage}-${width}.png`;
    await page.locator("div").first().screenshot({ path: file });
    console.log(`wrote ${file}`);
  }
}

writeFileSync(`${OUT}/README.txt`, "scratch (left) vs ported rail (right), per page and width\n");
await browser.close();
