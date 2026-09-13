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
        const issues = await page.getByTestId("composer-states").evaluate(
          (root, expected) => {
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
            const compact = expected.width === "265 · narrowest pane";
            if (expected.state === "Turn live, two queued") {
              const liveConfig = form.querySelector(".composer-live-config");
              const steerLabels = [...form.querySelectorAll(".composer-steer-label")];
              if ((getComputedStyle(liveConfig).display === "none") !== compact)
                problems.push("live config compactness");
              if (
                steerLabels.some(
                  (label) => (getComputedStyle(label).display === "none") !== compact,
                )
              )
                problems.push("Steer label compactness");
            }
            if (expected.state !== "Frozen pill (no models)") {
              const separateEffort = form.querySelector(".composer-separate-effort");
              const mergedEffort = form.querySelector(".composer-merged-effort-label");
              if ((getComputedStyle(separateEffort).display === "none") !== compact)
                problems.push("separate effort responsiveness");
              if ((getComputedStyle(mergedEffort).display !== "none") !== compact)
                problems.push("merged effort responsiveness");
            }
            const ticketFooter = root.querySelector('[data-testid="new-ticket-footer"]');
            const ticketEffort = ticketFooter.querySelector(".composer-separate-effort");
            const ticketMergedEffort = ticketFooter.querySelector(".composer-merged-effort-label");
            if ((getComputedStyle(ticketEffort).display === "none") !== compact)
              problems.push("ticket effort responsiveness");
            if ((getComputedStyle(ticketMergedEffort).display !== "none") !== compact)
              problems.push("ticket merged effort responsiveness");
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
          },
          { state, width },
        );
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
    assert.equal(await page.getByRole("menuitem", { name: /Commands & skills/ }).isVisible(), true);
    await page.getByRole("menuitem", { name: /Mention a file/ }).click();
    assert.equal(await input.inputValue(), "@");
    assert.equal(await input.evaluate((node) => document.activeElement === node), true);

    // At the narrowest width, model and effort share one trigger and one
    // popover. The standalone effort chip and expanded-editor icon are gone.
    const sessionComposer = page.locator("form.prompt-surface");
    const combined = sessionComposer.getByRole("button", { name: /^Model and effort:/ });
    assert.equal(await combined.isVisible(), true);
    assert.equal(
      await sessionComposer.getByRole("button", { name: /^Reasoning effort:/ }).isVisible(),
      false,
    );
    assert.equal(
      await sessionComposer.getByRole("button", { name: /Expand message editor/ }).count(),
      0,
    );
    await combined.click();
    const combinedEffort = page.getByRole("slider", { name: "Reasoning effort", exact: true });
    assert.equal(await combinedEffort.isVisible(), true);
    await combinedEffort.press("Home");
    assert.equal(await combinedEffort.getAttribute("aria-valuetext"), "Off");
    await combinedEffort.press("Escape");
    await page.getByTestId("combined-model-effort").waitFor({ state: "detached" });

    const ticketFooter = page.getByTestId("new-ticket-footer");
    const ticketCombined = ticketFooter.getByRole("button", { name: /^Model and effort:/ });
    assert.equal(await ticketCombined.isVisible(), true);
    assert.equal(
      await ticketFooter.getByRole("button", { name: /^Reasoning effort:/ }).isVisible(),
      false,
    );
    await ticketCombined.click();
    assert.equal(
      await page.getByRole("slider", { name: "Reasoning effort", exact: true }).isVisible(),
      true,
    );
    await page.getByRole("slider", { name: "Reasoning effort", exact: true }).press("Escape");

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
    `PASS: ${checks} theme/width/state layouts; picker, newline, send, Add, and compact model/effort in both appearances.`,
  );
} finally {
  await browser.close();
}
