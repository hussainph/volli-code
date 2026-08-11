/**
 * Does every lab scratch still boot without throwing?
 *
 * A React context error — the shape `useTicketDialogs must be used inside
 * <TicketDialogHost>` takes — kills the subtree and leaves an empty box. Nothing
 * in the node-env test project can see that: it renders to static markup, so a
 * provider that is missing only in the real tree still passes. The browser is
 * the only witness, and an uncaught error is the only signal, so collect them
 * rather than eyeballing a screenshot.
 */
import { chromium } from "playwright-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LAB = "http://localhost:5178/lab/";
const SCRATCHES = ["app-shell", "ticket-right-sidebar", "rail-port-check", "hover-sidebar"];

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
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
