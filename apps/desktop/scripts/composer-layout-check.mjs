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
const widths = [
  "720 · reading measure",
  "576 · new-ticket dialog",
  "480 · split",
  "320 · narrow split",
  "265 · narrowest pane",
];
/**
 * Where each surface folds model and effort into one control. The chat
 * composer asks at 24rem; the New-ticket tray asks at 40rem, because its three
 * welded commits leave the settings run ~215px less than a send key does
 * (VC-382). 576 is the dialog's own width and is the width that regressed.
 */
const COMPACT_CHAT_WIDTHS = new Set(["320 · narrow split", "265 · narrowest pane"]);
/**
 * And where the chat composer's folded face still PRINTS the effort: between
 * 18rem and 24rem. Below 18rem the word costs the model name more than it is
 * worth (42px of name at the narrowest pane, against 83px without it), so the
 * face keeps the model and the value stays in the popover and the accessible
 * name. 320 is the only column in that band, which is why it is on the rig.
 */
const FACE_EFFORT_CHAT_WIDTHS = new Set(["320 · narrow split"]);
const COMPACT_TRAY_WIDTHS = new Set([
  "576 · new-ticket dialog",
  "480 · split",
  "320 · narrow split",
  "265 · narrowest pane",
]);
/**
 * And where the merged control still PRINTS the effort it holds. Below 34rem
 * the face keeps the model alone and the value lives in the popover and the
 * accessible name — the step that stops the row stacking at 480 (VC-382).
 */
const FACE_EFFORT_TRAY_WIDTHS = new Set(["576 · new-ticket dialog"]);
/**
 * Where that tray must stay on ONE line. The two columns it omits are the chat
 * composer's: 215px of welded word buttons cannot share 272px — let alone
 * 233px — with a model pill, and the dialog that owns this footer is never
 * handed such a box (`sm:max-w-xl` against a 940px window floor, so 576 is the
 * narrowest it can be).
 */
const ONE_LINE_TRAY_WIDTHS = new Set([
  "720 · reading measure",
  "576 · new-ticket dialog",
  "480 · split",
]);
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
            const compact = expected.compactChat;
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
              if ((getComputedStyle(mergedEffort).display !== "none") !== expected.faceEffortChat)
                problems.push("merged effort responsiveness");
              // The qualifier leaves the face at the fold rather than clipping
              // to a letter beside the model name. Only the seeded state has a
              // tier to draw.
              const tier = form.querySelector('[data-testid="model-pill-tier"]');
              if (tier !== null && (getComputedStyle(tier).display === "none") !== compact)
                problems.push("model tier compactness");
              // What that last step is FOR: wherever the face is not also
              // printing an effort word, the model name keeps the 56px floor
              // the pill spends its give defending. Skipped while a live turn
              // has retired the whole settings run, which draws nothing to
              // measure.
              const name = form.querySelector('[data-testid="model-pill-name"]');
              const nameWidth = name === null ? 0 : name.getBoundingClientRect().width;
              if (!expected.faceEffortChat && nameWidth > 0 && nameWidth < 56)
                problems.push("model name squeezed under its floor");
            }
            const ticketFooter = root.querySelector('[data-testid="new-ticket-footer"]');
            const ticketEffort = ticketFooter.querySelector(".composer-separate-effort");
            const ticketMergedEffort = ticketFooter.querySelector(".composer-merged-effort-label");
            if ((getComputedStyle(ticketEffort).display === "none") !== expected.compactTray)
              problems.push("ticket effort responsiveness");
            if (
              (getComputedStyle(ticketMergedEffort).display !== "none") !==
              expected.faceEffortTray
            )
              problems.push("ticket merged effort responsiveness");
            // The whole point of the fold: the settings run and the commits
            // stay on ONE line. A wrapped tray is what VC-382 was filed about,
            // and it is invisible to the clipping checks above — nothing
            // overflows, the box just grows a second row. Shared vertical
            // extent rather than equal tops: the two clusters are centred
            // against each other and their 24px and 28px boxes never start at
            // the same pixel.
            const commits = ticketFooter.querySelector(
              '[data-testid="composer-create"]',
            ).parentElement;
            const settingsRun = commits.parentElement.firstElementChild;
            const commitBox = commits.getBoundingClientRect();
            const settingsBox = settingsRun.getBoundingClientRect();
            if (
              expected.oneLineTray &&
              Math.min(commitBox.bottom, settingsBox.bottom) -
                Math.max(commitBox.top, settingsBox.top) <=
                0
            )
              problems.push("ticket footer wrapped onto a second line");
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
          {
            state,
            width,
            compactChat: COMPACT_CHAT_WIDTHS.has(width),
            faceEffortChat: FACE_EFFORT_CHAT_WIDTHS.has(width),
            compactTray: COMPACT_TRAY_WIDTHS.has(width),
            faceEffortTray: FACE_EFFORT_TRAY_WIDTHS.has(width),
            oneLineTray: ONE_LINE_TRAY_WIDTHS.has(width),
          },
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

    // And the two surfaces part company at the width the New-ticket dialog
    // actually opens at (VC-382): its tray has already folded, while the chat
    // composer beside it — same pills, one send key — still shows both.
    await page.getByRole("button", { name: "576 · new-ticket dialog", exact: true }).click();
    assert.equal(
      await ticketFooter.getByRole("button", { name: /^Model and effort:/ }).isVisible(),
      true,
    );
    assert.equal(
      await page
        .locator("form.prompt-surface")
        .getByRole("button", { name: /^Reasoning effort:/ })
        .isVisible(),
      true,
    );

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
