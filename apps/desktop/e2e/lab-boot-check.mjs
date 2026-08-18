/**
 * Does every lab scratch still boot without throwing?
 *
 * A React context error — the shape `useTicketDialogs must be used inside
 * <TicketDialogHost>` takes — kills the subtree and leaves an empty box. Nothing
 * in the node-env test project can see that: it renders to static markup, so a
 * provider that is missing only in the real tree still passes. The browser is
 * the only witness, and an uncaught error is the only signal, so collect them
 * rather than eyeballing a screenshot.
 *
 *   Run (in another terminal):  pnpm lab
 *   Then:                       node apps/desktop/e2e/lab-boot-check.mjs
 *
 * MANUALLY-RUN (needs the lab dev server and a Chromium); NOT wired into
 * `vp test`.
 */
import { existsSync } from "node:fs";

import { chromium } from "playwright-core";

// `pnpm lab` runs `vp dev --mode lab --port 5174` under `strictPort`
// (apps/desktop/vite.config.ts), so this port is not a guess and a clash there
// fails loudly rather than landing somewhere else. Overridable only because a
// second checkout may be holding it.
const PORT = process.env.VOLLI_LAB_PORT ?? "5174";
const LAB = `http://localhost:${PORT}/lab/`;
const SCRATCHES = [
  "app-shell",
  "ticket-right-sidebar",
  "rail-port-check",
  "hover-sidebar",
  // Mounts a dialog and a context provider of its own, which is exactly the
  // shape this check exists to catch (VC-56).
  "ticket-kickoff",
];

/**
 * A Chromium to drive.
 *
 * `playwright-core` ships no browsers, so something has to name one. Order:
 * an explicit override, then Playwright's own registry (present whenever
 * anything in this repo has run `playwright install`), then the two paths a
 * developer machine actually has. Hard-coding one of those last two is what
 * made this check machine-specific.
 */
function resolveBrowser() {
  const override = process.env.VOLLI_CHROME ?? process.env.CHROME_PATH;
  if (override !== undefined && override !== "") return override;

  let registry;
  try {
    registry = chromium.executablePath();
  } catch {
    registry = undefined;
  }
  if (registry !== undefined && existsSync(registry)) return registry;

  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const found = candidates.find((path) => existsSync(path));
  if (found !== undefined) return found;

  throw new Error(
    "no Chromium found — run `pnpm exec playwright install chromium` or set VOLLI_CHROME",
  );
}

/** Fail on a dev server that is not up, rather than on an opaque connect error. */
async function assertLabIsServing() {
  try {
    const response = await fetch(LAB, { redirect: "follow" });
    if (response.ok) return;
    throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new Error(
      `the lab is not serving ${LAB} (${error instanceof Error ? error.message : String(error)}) — start it with \`pnpm lab\``,
      { cause: error },
    );
  }
}

await assertLabIsServing();

const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
let failed = 0;

for (const scratch of SCRATCHES) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems = [];
  page.on("pageerror", (error) => problems.push(`throw: ${error.message}`));
  page.on("console", (message) => {
    // The lab page ships no favicon, so every load logs one 404 that says
    // nothing about the scratch. Read the location rather than the text —
    // matching on the message would also swallow a real 404 for a real asset.
    if (message.type() !== "error") return;
    if (message.location().url.endsWith("/favicon.ico")) return;
    problems.push(`console: ${message.text()}`);
  });

  await page.goto(`${LAB}#${scratch}`, { waitUntil: "networkidle" });
  // Vite's first visit can 504 on a stale pre-bundle; the reload is the fix.
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1200);

  // An error boundary swallows the throw, so also insist something rendered.
  const painted = await page.evaluate(() => {
    const root = document.querySelector("#root");
    return root instanceof HTMLElement ? root.innerText.trim().length : 0;
  });

  const ok = problems.length === 0 && painted > 0;
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${scratch} (chars=${painted})`);
  for (const problem of problems.slice(0, 4)) console.log(`      ${problem}`);
  await page.close();
}

await browser.close();
console.log(failed === 0 ? "\nall scratches boot clean" : `\n${failed} scratch(es) broken`);
process.exit(failed === 0 ? 0 : 1);
