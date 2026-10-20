/**
 * VC-473: real-layout coverage for both peek cards, using production components
 * and tokens with lab fixtures. No model calls or real Sessions.
 * Self-hosted on an ephemeral port; the smoke runner discovers this file in CI.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite-plus";

const executablePath = [
  process.env.VOLLI_CHROME,
  chromium.executablePath(),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((path) => path && existsSync(path));
assert.ok(executablePath, "Set VOLLI_CHROME to an installed Chromium browser");

const server = await createServer({
  configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
  root: fileURLToPath(new URL("../src/renderer", import.meta.url)),
  mode: "lab",
  server: { host: "127.0.0.1", port: 0, open: false },
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== "string");
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 960, height: 680 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/lab/#peek-summary-readability`, {
    // The lab eagerly loads its fixtures and warms lazy modules. Let cold
    // dependency optimization settle before toggling fixture state: its reload
    // otherwise resets the long-text switch during the layout assertions.
    waitUntil: "networkidle",
    timeout: 120_000,
  });
  await page.getByRole("button", { name: "Stress-test long text" }).click();
  await page.getByRole("button", { name: "Show typical summaries" }).waitFor();

  for (const mode of ["dark", "light"]) {
    await page.evaluate((appearance) => {
      document.documentElement.classList.remove("dark", "light");
      document.documentElement.classList.add(appearance);
    }, mode);
    for (const subject of ["session", "ticket"]) {
      const card = page.locator(`[data-peek-subject="${subject}"]`);
      const result = await card.evaluate((element) => {
        const scroller = element.querySelector(".overflow-y-auto");
        const summary = element.querySelector("[data-peek-summary]");
        if (!scroller || !summary) throw new Error("Missing summary or card scroller");
        // Serialized with this browser callback; a Node-scope helper cannot cross Playwright's boundary.
        // oxlint-disable-next-line unicorn/consistent-function-scoping
        const rect = (node) => {
          const bounds = node.getBoundingClientRect();
          return { top: bounds.top, bottom: bounds.bottom };
        };
        const header = element.querySelector("header");
        const footer = element.querySelector("footer");
        scroller.scrollTop = 0;
        const before = { header: rect(header), footer: footer && rect(footer) };
        // Prove overflow really exists: jsdom class checks cannot establish this.
        const overflows = scroller.scrollHeight > scroller.clientHeight;
        const marker = "End of the long summary — nothing was hidden by a line clamp.";
        const text = summary.firstChild;
        const start = text.textContent.indexOf(marker);
        if (start < 0) throw new Error("Long fixture has no end marker");
        const range = document.createRange();
        range.setStart(text, start);
        range.setEnd(text, start + marker.length);
        scroller.scrollTop = scroller.scrollHeight;
        // Folder end-marker can be above its final row; bring the summary's
        // last line into view, then independently prove the last row is reachable.
        if (range.getBoundingClientRect().top < scroller.getBoundingClientRect().top) {
          scroller.scrollTop -=
            scroller.getBoundingClientRect().top - range.getBoundingClientRect().top + 4;
        }
        const body = rect(scroller);
        const end = rect(range);
        const markerVisible = end.top >= body.top - 1 && end.bottom <= body.bottom + 1;
        scroller.scrollTop = scroller.scrollHeight;
        const lastSummary = element.querySelectorAll("[data-peek-summary]");
        const last = rect(lastSummary[lastSummary.length - 1]);
        return {
          overflows,
          scrollAdvanced: scroller.scrollTop > 0,
          markerVisible,
          lastSummaryVisible: last.bottom <= body.bottom + 1 && last.bottom > body.top,
          headerFixed: JSON.stringify(before.header) === JSON.stringify(rect(header)),
          footerFixed: !footer || JSON.stringify(before.footer) === JSON.stringify(rect(footer)),
          cardVisible: element.getBoundingClientRect().bottom <= window.innerHeight,
        };
      });
      assert.deepEqual(
        result,
        {
          overflows: true,
          scrollAdvanced: true,
          markerVisible: true,
          lastSummaryVisible: true,
          headerFixed: true,
          footerFixed: true,
          cardVisible: true,
        },
        `${mode} ${subject} peek must expose the end of its content without moving its chrome`,
      );
    }
  }
  assert.deepEqual(errors, [], "The fixture must render without page errors");
  console.log("peek-summary-readability: both cards scroll to the end in dark and light modes");
} finally {
  await browser?.close();
  await server.close();
}
