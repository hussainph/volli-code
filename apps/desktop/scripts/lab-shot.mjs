#!/usr/bin/env node
/**
 * Screenshot a lab scratch with headless Chromium.
 *
 *   node scripts/lab-shot.mjs <slug> <out.png> [--port 5174] [--width 1100]
 *        [--height 900] [--light] [--click "text"]... [--press "button name"]...
 *        [--hover "button name"]... [--full] [--wait ms] [--clip "selector"]
 *
 * The lab (`pnpm lab`) must already be serving. Its first load transforms
 * the whole scratch graph, which can take the better part of a minute, so
 * the page is awaited by a selector with a generous timeout rather than by
 * `load`. Dev-only: the app's own screenshots go through the Electron
 * smokes; this exists so a design pass can look at a scratch without a
 * display attached, and read the result back as an image.
 */
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const slug = args[0];
const out = args[1];
if (!slug || !out) {
  console.error(
    "usage: lab-shot.mjs <slug> <out.png> [--port N] [--width N] [--height N] [--light] [--click text]... [--full] [--wait ms] [--clip selector]",
  );
  process.exit(2);
}
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const port = Number(option("--port", "5174"));
const width = Number(option("--width", "1100"));
const height = Number(option("--height", "900"));
const settle = Number(option("--wait", "600"));
const clip = option("--clip", null);
const light = args.includes("--light");
const full = args.includes("--full");
const clicks = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--click") clicks.push({ kind: "text", value: args[i + 1] });
  if (args[i] === "--press") clicks.push({ kind: "button", value: args[i + 1] });
  if (args[i] === "--hover") clicks.push({ kind: "hover", value: args[i + 1] });
}

function chromiumPath() {
  const root = join(homedir(), "Library", "Caches", "ms-playwright");
  const dirs = readdirSync(root)
    .filter((d) => d.startsWith("chromium_headless_shell-"))
    .toSorted()
    .toReversed();
  for (const dir of dirs) {
    const candidate = join(root, dir, "chrome-headless-shell-mac-arm64", "chrome-headless-shell");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("no playwright chromium headless shell under " + root);
}

const browser = await chromium.launch({ executablePath: chromiumPath(), headless: true });
const page = await browser.newPage({
  viewport: { width, height },
  deviceScaleFactor: 2,
  colorScheme: light ? "light" : "dark",
});
await page.goto(`http://localhost:${port}/lab/#${slug}`, { waitUntil: "commit" });
await page.waitForSelector("main, [data-lab-stage]", { timeout: 180_000 });
if (light) {
  await page.evaluate(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.classList.add("light");
  });
}
await page.waitForTimeout(settle);
for (const step of clicks) {
  if (step.kind === "text") await page.getByText(step.value, { exact: true }).first().click();
  else if (step.kind === "button")
    await page.getByRole("button", { name: step.value, exact: true }).first().click();
  else await page.getByRole("button", { name: step.value, exact: true }).first().hover();
  await page.waitForTimeout(700);
}
if (clip) {
  await page.locator(clip).first().screenshot({ path: out });
} else {
  await page.screenshot({ path: out, fullPage: full });
}
await browser.close();
console.log("wrote", out);
