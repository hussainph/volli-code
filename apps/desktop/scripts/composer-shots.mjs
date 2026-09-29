/**
 * Refresh the composer review artifacts from the real lab components.
 *
 * WHY THIS IS A SCRIPT AND NOT A HANDFUL OF MANUAL CAPTURES. The VC-335
 * artifacts under `.volli/artifacts/` went three commits stale without anyone
 * noticing, and they were stale in the worst way: they showed a wrapped,
 * two-row narrow footer that the code no longer produced, so a reviewer reading
 * them would have filed a bug that was already fixed. A capture you can re-run
 * in one command is the only kind that stays honest.
 *
 * Start the lab, then: node scripts/composer-shots.mjs [port]
 * No Electron, provider calls, or durable mutations.
 *
 * `composer-before.png` is deliberately NOT written here: it records `main`'s
 * flat box for the before/after pair and must not track the working tree.
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";
import { chromiumPath } from "./lab-browser.mjs";

const port = Number(process.argv[2] ?? 5174);
const outDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  ".volli",
  "artifacts",
);
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: chromiumPath(), headless: true });
const written = [];

/** Each page names the node whose presence means its fixtures have mounted. */
const statesReady = (page) => page.getByTestId("composer-states");
const kickoffReady = (page) => page.getByRole("button", { name: "Open composer", exact: true });

/** One lab page, driven to a named state, captured whole or by element. */
async function shot({ name, hash, ready, colorScheme = "dark", steps = [], selector = null }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // A cold dev server transforms the whole renderer on the first navigation,
  // which routinely outruns Playwright's 30s default.
  await page.goto(`http://localhost:${port}/lab/#${hash}`, { timeout: 180_000 });
  // The lab mounts fixtures asynchronously, and a cold dev server has to
  // transform the whole renderer first — hence the same generous ceiling the
  // layout check uses. Each page names the node that means "ready".
  await ready(page).waitFor({ timeout: 180_000 });
  for (const step of steps) {
    await page.getByRole("button", { name: step, exact: true }).click();
  }
  // Let container queries and any entrance transition settle before capturing.
  await page.waitForTimeout(400);
  const path = join(outDir, `${name}.png`);
  const target = selector === null ? page : page.locator(selector).first();
  await target.screenshot({ path, ...(selector === null ? { fullPage: false } : {}) });
  if (errors.length > 0) throw new Error(`${name}: page errors: ${errors.join("; ")}`);
  written.push(name);
  await page.close();
}

try {
  const states = "composer-states";
  await shot({
    name: "composer-after",
    hash: states,
    ready: statesReady,
    steps: ["720 · reading measure", "Idle, empty"],
  });
  await shot({
    name: "composer-narrow",
    hash: states,
    ready: statesReady,
    steps: ["265 · narrowest pane", "All states"],
  });
  await shot({
    name: "composer-working-narrow",
    hash: states,
    ready: statesReady,
    steps: ["265 · narrowest pane", "Turn live, two queued"],
  });
  await shot({
    name: "composer-light",
    hash: states,
    ready: statesReady,
    colorScheme: "light",
    steps: ["720 · reading measure", "Idle, draft"],
  });
  // The composer alone, for the close read of the sheet/tray seam.
  await shot({
    name: "composer-preview",
    hash: states,
    ready: statesReady,
    steps: ["720 · reading measure", "Idle, draft"],
    selector: "form",
  });
  await shot({
    name: "composer-ticket",
    hash: "ticket-kickoff",
    ready: kickoffReady,
    steps: ["Open composer"],
  });
} finally {
  await browser.close();
}

console.log(`WROTE ${written.length} artifacts to .volli/artifacts: ${written.join(", ")}`);
