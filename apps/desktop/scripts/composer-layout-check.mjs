/**
 * Browser-only composer regression check against the real lab components.
 * Start the lab, then: node scripts/composer-layout-check.mjs [port]
 * No Electron, provider calls, or durable mutations.
 */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { chromiumPath } from "./lab-browser.mjs";

const port = Number(process.argv[2] ?? 5174);
const browser = await chromium.launch({ executablePath: chromiumPath(), headless: true });
const widths = ["720 · reading measure", "480 · split", "265 · narrowest pane"];
const states = [
  "Idle, empty",
  "Idle, draft",
  "Turn live, two queued",
  "Two attachments",
  "Frozen pill (no models)",
  "Not ready",
];
let checks = 0;
try {
  for (const colorScheme of ["dark", "light"]) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, colorScheme });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://localhost:${port}/lab/#composer-states`);
    await page.getByTestId("composer-states").waitFor({ timeout: 180_000 });
    for (const width of widths) {
      await page.getByRole("button", { name: width, exact: true }).click();
      for (const state of states) {
        await page.getByRole("button", { name: state, exact: true }).click();
        const issues = await page.getByTestId("composer-states").evaluate((root) => {
          const problems = [];
          for (const surface of root.querySelectorAll(".prompt-surface")) {
            if (surface.scrollWidth > surface.clientWidth + 1) problems.push("surface overflow");
            const bounds = surface.getBoundingClientRect();
            for (const button of surface.querySelectorAll("button")) {
              const box = button.getBoundingClientRect();
              if (box.width === 0) continue;
              if (box.left < bounds.left - 1 || box.right > bounds.right + 1)
                problems.push(
                  `clipped control: ${button.getAttribute("aria-label") ?? button.textContent}`,
                );
            }
          }
          const form = root.querySelector("form");
          const settings = [...form.querySelectorAll(".prompt-config")];
          const add = form.querySelector(".prompt-add");
          const primary = form.querySelector(".prompt-primary");
          const primaryBounds = primary.getBoundingClientRect();
          if (primaryBounds.width !== 32 || primaryBounds.height !== 32)
            problems.push("send key size");
          const controls = [...settings, add, primary].filter(Boolean);
          for (let i = 0; i < controls.length; i++) {
            for (const other of controls.slice(i + 1)) {
              const a = controls[i].getBoundingClientRect();
              const b = other.getBoundingClientRect();
              if (
                Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
                Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
              )
                problems.push("overlapping controls");
            }
          }
          return problems;
        });
        assert.deepEqual(issues, [], `${colorScheme} / ${width} / ${state}`);
        checks++;
      }
    }
    // The tray must not intercept text entry, picker completion, or submit.
    await page.getByRole("button", { name: "Idle, empty", exact: true }).click();
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await input.fill("/review");
    await input.press("Enter");
    // Completion keeps the invocation; expansion belongs to submission.
    assert.equal(await input.inputValue(), "/review ");
    await input.fill("A draft");
    await input.press("Shift+Enter");
    assert.equal(await input.inputValue(), "A draft\n");
    await input.press("Enter");
    assert.equal(await input.inputValue(), "");
    await page.getByRole("button", { name: "Add to message", exact: true }).first().click();
    await page.getByRole("menuitem", { name: /Mention a file/ }).click();
    assert.equal(await input.inputValue(), "@");
    assert.equal(await input.evaluate((node) => document.activeElement === node), true);
    await page.emulateMedia({ forcedColors: "active" });
    const border = await page.locator("form.prompt-surface").evaluate((node) => {
      const style = getComputedStyle(node);
      return { color: style.borderTopColor, width: style.borderTopWidth };
    });
    assert.notEqual(border.color, "rgba(0, 0, 0, 0)", "forced-colors keeps a physical edge");
    assert.equal(border.width, "1px");
    assert.deepEqual(errors, [], `${colorScheme}: browser exceptions`);
    await page.close();
  }
  console.log(
    `PASS: ${checks} theme/width/state layouts; picker, newline, send, and Add in both appearances.`,
  );
} finally {
  await browser.close();
}
