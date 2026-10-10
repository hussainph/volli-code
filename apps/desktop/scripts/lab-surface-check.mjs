/** Local, isolated browser check. Start `pnpm lab` first.
 * node apps/desktop/scripts/lab-surface-check.mjs [--browser /path/to/chrome] [--preset "All glass"]
 * Measures the actual light drag, not an animation of a static screenshot.
 * No timing threshold: hardware differs. Assert wiring, cached geometry and lifetime.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { chromiumPath } from "./lab-browser.mjs";

const tmp = fileURLToPath(new URL("../../../.volli/surface-check/", import.meta.url));
await mkdir(tmp, { recursive: true });
const run = await mkdtemp(join(tmp, "run-"));
const browserFlag = process.argv.indexOf("--browser");
const executablePath = browserFlag === -1 ? chromiumPath() : process.argv[browserFlag + 1];
let context;
try {
  context = await chromium.launchPersistentContext(join(run, "profile"), {
    executablePath,
    headless: true,
    viewport: { width: 1440, height: 1000 },
    env: { ...process.env, TMPDIR: run },
  });
  const page = context.pages()[0];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://localhost:5174/lab/?clean#surface-materials");
  const presetFlag = process.argv.indexOf("--preset");
  const preset = presetFlag === -1 ? "Modern Aqua" : process.argv[presetFlag + 1];
  await page.getByRole("button", { name: preset, exact: true }).click();
  const field = page.getByRole("textbox", { name: "Local preview note", exact: true });
  await field.fill("Draft survives lighting and layout changes");
  await page.getByRole("button", { name: "Inspect material", exact: true }).click();
  const preview = page.getByRole("region", { name: "Component preview", exact: true });
  const dialPane = page.getByTestId("surface-dial-scroll");
  const previewScrollBefore = await preview.evaluate((node) => node.scrollTop);
  const sceneBefore = await page.getByTestId("surface-environment").boundingBox();
  await page.getByRole("slider", { name: "Colour", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  assert.ok(
    await dialPane.evaluate((node) => node.scrollTop > 0),
    "lower dials must be reached by scrolling the control pane",
  );
  assert.equal(
    await preview.evaluate((node) => node.scrollTop),
    previewScrollBefore,
    "tuning controls must not scroll the preview",
  );
  assert.equal(
    await page.getByTestId("surface-study").evaluate((node) => node.scrollTop),
    0,
    "the document must stay fixed",
  );
  const sceneAfter = await page.getByTestId("surface-environment").boundingBox();
  assert.equal(
    sceneAfter.y,
    sceneBefore.y,
    "preview components must stay in place while the dial pane scrolls",
  );
  await page.evaluate(async () => {
    document.querySelector('[data-testid="surface-study"]').scrollTop = 0;
    for (let i = 0; i < 15; i++) await new Promise(requestAnimationFrame);
    const original = HTMLElement.prototype.getBoundingClientRect;
    window.surfaceRectReads = 0;
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.matches('[data-spatial-body], [data-testid="surface-environment"]'))
        window.surfaceRectReads++;
      return original.call(this);
    };
  });
  const client = await context.newCDPSession(page);
  await client.send("Performance.enable");
  const before = (await client.send("Performance.getMetrics")).metrics;
  const trace = [];
  client.on("Tracing.dataCollected", (event) => trace.push(...event.value));
  await client.send("Tracing.start", {
    categories: "devtools.timeline,disabled-by-default-devtools.timeline",
    transferMode: "ReportEvents",
  });
  const handle = page.getByRole("button", { name: "Move key light", exact: true });
  const initial = await handle.getAttribute("style");
  const h = await handle.boundingBox();
  const environment = await page.getByTestId("surface-environment").boundingBox();
  const start = performance.now();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  for (let step = 0; step < 90; step++) {
    await page.mouse.move(
      environment.x + environment.width * (0.1 + step / 115),
      environment.y + environment.height * 0.4,
    );
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  const spatialRectReadsDuringDrag = await page.evaluate(() => window.surfaceRectReads);
  assert.equal(spatialRectReadsDuringDrag, 0, "light drag must reuse cached component bounds");
  assert.notEqual(await handle.getAttribute("style"), initial, "light must really move");
  await page.mouse.up();
  const complete = new Promise((resolve) => client.once("Tracing.tracingComplete", resolve));
  await client.send("Tracing.end");
  await complete;
  const durationMs = performance.now() - start;
  const after = (await client.send("Performance.getMetrics")).metrics;
  const metrics = Object.fromEntries(
    after
      .filter((m) =>
        ["LayoutDuration", "RecalcStyleDuration", "ScriptDuration", "TaskDuration"].includes(
          m.name,
        ),
      )
      .map((m) => [
        m.name + "Ms",
        1000 * (m.value - before.find((old) => old.name === m.name).value),
      ]),
  );
  const events = {};
  for (const event of trace)
    if (["Paint", "RasterTask"].includes(event.name)) {
      const bucket = (events[event.name] ??= { count: 0, totalMs: 0 });
      bucket.count++;
      bucket.totalMs += (event.dur ?? 0) / 1000;
    }
  await page.getByRole("button", { name: "Placement", exact: true }).click();
  const savedKeyX = Number(
    await page.getByRole("slider", { name: "Key X", exact: true }).getAttribute("aria-valuenow"),
  );
  assert.ok(savedKeyX > 0.85, "release must commit placement into the versioned dials");
  const promoted = await page
    .locator("[data-light][data-part]")
    .evaluateAll((nodes) => nodes.filter((node) => node.style.willChange).length);
  assert.equal(promoted, 0, "temporary layer promotion must end with the drag");
  await page.evaluate(() => {
    const observe = ResizeObserver.prototype.observe;
    window.surfaceRigRebuilds = 0;
    ResizeObserver.prototype.observe = function (target, options) {
      if (target.matches('[data-testid="surface-environment"]')) window.surfaceRigRebuilds++;
      return observe.call(this, target, options);
    };
  });
  await page.getByRole("slider", { name: "Shadow", exact: true }).first().focus();
  await page.keyboard.press("ArrowLeft");
  await page.evaluate(async () => {
    for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
  });
  assert.equal(
    await page.evaluate(() => window.surfaceRigRebuilds),
    0,
    "dial edits must not rebuild lighting observers/listeners",
  );
  // Material switches share a lighting rig and leave reading content opaque/live.
  await page.getByRole("button", { name: "Satin", exact: true }).click();
  assert.equal(
    await page
      .getByRole("dialog", { name: "Surface model inspector" })
      .getAttribute("data-material"),
    "satin",
  );
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  assert.equal(
    await page.getByRole("region", { name: "Work pane" }).getAttribute("data-material"),
    "glass",
  );
  await page
    .getByRole("radiogroup", { name: "Backdrop Detail", exact: true })
    .getByRole("radio", { name: "On", exact: true })
    .click();
  assert.equal(await page.locator(".surface-backdrop-detail").count(), 1);
  const transmission = await page.getByRole("region", { name: "Work pane" }).evaluate((node) => ({
    face: getComputedStyle(node).backgroundColor,
    opacity: getComputedStyle(node).opacity,
    textOpacity: getComputedStyle(node.querySelector("p")).opacity,
  }));
  assert.equal(transmission.opacity, "1");
  assert.equal(transmission.textOpacity, "1");
  await page.getByRole("button", { name: "All glass", exact: true }).click();
  assert.equal(
    await page
      .getByRole("region", { name: "Work pane" })
      .evaluate((node) => getComputedStyle(node).backdropFilter),
    "blur(8px)",
  );
  assert.equal(
    await page.evaluate(() => window.surfaceRigRebuilds),
    0,
    "material starts must also reuse the lighting rig",
  );
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.getByRole("button", { name: "Move rail left", exact: true }).click();
  assert.equal(await page.getByTestId("surface-study").getAttribute("data-appearance"), "dark");
  assert.equal(await page.getByRole("dialog", { name: "Surface model inspector" }).count(), 1);
  assert.equal(await field.inputValue(), "Draft survives lighting and layout changes");
  await page.getByRole("button", { name: /^Components \(/ }).click();
  const gallery = page.getByTestId("surface-component-gallery");
  assert.equal(
    await gallery
      .locator('[aria-label="Component inventory"]')
      .evaluate((node) => node.children.length),
    19,
  );
  await gallery.getByRole("switch").click();
  assert.equal(await gallery.getByRole("switch").getAttribute("aria-checked"), "false");
  await gallery.getByRole("textbox", { name: "Search gallery files", exact: true }).fill("surface");
  await gallery.getByRole("tab", { name: "Files", exact: true }).click();
  assert.ok((await gallery.getByRole("tabpanel").textContent()).includes("surface.tsx"));
  await gallery.getByRole("combobox", { name: "Gallery ticket priority", exact: true }).click();
  const selectSurface = page.locator('[data-slot="select-content"]');
  assert.equal(
    await selectSurface.evaluate((node) => node.style.getPropertyValue("--card")),
    await page
      .getByTestId("surface-study")
      .evaluate((node) => node.style.getPropertyValue("--card")),
  );
  await page.getByRole("option", { name: /High/ }).click();
  await gallery.getByRole("button", { name: "Fixture actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Copy title", exact: true }).click();
  assert.ok((await gallery.textContent()).includes("Local title copied"));
  await gallery.getByRole("button", { name: "Sample details", exact: true }).click();
  const details = page.getByRole("dialog", { name: "Surface exploration", exact: true });
  const dialogClose = details.getByRole("button", { name: "Close", exact: true });
  assert.equal(await dialogClose.evaluate((node) => getComputedStyle(node).position), "absolute");
  const dialogBounds = await details.boundingBox();
  const closeBounds = await dialogClose.boundingBox();
  assert.ok(
    closeBounds.y - dialogBounds.y > 0 && closeBounds.y - dialogBounds.y < 25,
    "production close button belongs at the top right, not in a bottom grid row",
  );
  assert.ok(dialogBounds.x + dialogBounds.width - (closeBounds.x + closeBounds.width) < 25);
  await dialogClose.click();
  assert.equal(await details.count(), 0);
  await gallery.getByRole("button", { name: "Sample details", exact: true }).click();
  await page.getByRole("button", { name: "Porcelain", exact: true }).click();
  assert.equal(await details.getAttribute("data-material"), "porcelain");
  assert.equal(
    await details.evaluate((node) => node.style.getPropertyValue("--surface-opacity")),
    "100%",
  );
  assert.equal(await gallery.getByRole("switch").getAttribute("aria-checked"), "false");
  assert.equal(
    await gallery.getByRole("textbox", { name: "Search gallery files", exact: true }).inputValue(),
    "surface",
  );
  await details.getByRole("button", { name: "Dismiss details", exact: true }).click();
  // Separate reference study: switching treatment preserves authored recipes and nodes.
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByRole("button", { name: "Inspect material", exact: true }).click();
  const referenceLens = page.getByRole("dialog", { name: "Surface model inspector" });
  const authoredBevel = await referenceLens.evaluate((node) =>
    node.style.getPropertyValue("--surface-bevel"),
  );
  const liveDraft = await field.elementHandle();
  await page.getByRole("button", { name: "macOS 27", exact: true }).click();
  for (const group of ["Lens", "Work Pane", "Controls", "Lighting", "Optical Experiment"]) {
    assert.equal(
      await page.getByRole("button", { name: group, exact: true }).count(),
      0,
      "Surface-only folders must be hidden in the reference study",
    );
  }
  const expectedStops = [
    ["Clear", "24%", "blur(6px)"],
    ["Balanced", "57%", "blur(14px)"],
    ["Tinted", "90%", "blur(22px)"],
  ];
  for (const mode of ["Light", "Dark"]) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    for (const [stop, opacity, diffusion] of expectedStops) {
      await page.getByRole("button", { name: stop, exact: true }).click();
      assert.equal(
        await referenceLens.evaluate((node) => node.style.getPropertyValue("--surface-opacity")),
        opacity,
      );
      assert.equal(
        await referenceLens.evaluate((node) => node.style.getPropertyValue("--surface-backdrop")),
        diffusion,
      );
      const referenceChrome = await page.getByTestId("surface-toolbar").evaluate((node) => ({
        face: !!node.querySelector(".surface-material-face"),
        blur: getComputedStyle(node).backdropFilter,
        textOpacity: getComputedStyle(node.querySelector("button")).opacity,
      }));
      assert.ok(referenceChrome.face);
      assert.ok(referenceChrome.blur.startsWith(diffusion));
      assert.equal(referenceChrome.textOpacity, "1");
      assert.equal(
        await page
          .getByRole("region", { name: "Work pane" })
          .evaluate((node) => getComputedStyle(node).backdropFilter),
        "none",
      );
      assert.equal(await field.inputValue(), "Draft survives lighting and layout changes");
    }
  }
  await page.getByRole("button", { name: "Balanced", exact: true }).click();
  const referenceShadow = await referenceLens.evaluate((node) =>
    node.style.getPropertyValue("--surface-shadow"),
  );
  await page.getByRole("button", { name: "Inactive", exact: true }).click();
  assert.notEqual(
    await referenceLens.evaluate((node) => node.style.getPropertyValue("--surface-shadow")),
    referenceShadow,
  );
  assert.equal(await referenceLens.evaluate((node) => getComputedStyle(node).opacity), "1");
  await page.getByRole("button", { name: "Active", exact: true }).click();
  await page.evaluate(async () => {
    for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame);
    window.surfaceRigRebuilds = 0;
  });
  const balanceDial = page.getByRole("slider", { name: "Balance", exact: true });
  await balanceDial.focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await balanceDial.getAttribute("aria-valuenow"), "0.51");
  await page.evaluate(async () => {
    for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame);
  });
  assert.equal(
    await page.evaluate(() => window.surfaceRigRebuilds),
    0,
    "reference balance must reuse the lighting rig",
  );
  const referenceHandle = await handle.boundingBox();
  const referenceScene = await page.getByTestId("surface-environment").boundingBox();
  await page.mouse.move(referenceHandle.x + 14, referenceHandle.y + 14);
  await page.mouse.down();
  await page.evaluate(async () => {
    for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
    window.surfaceRectReads = 0;
  });
  for (let step = 0; step < 30; step++) {
    await page.mouse.move(
      referenceScene.x + referenceScene.width * (0.15 + step / 45),
      referenceScene.y + referenceScene.height * 0.35,
    );
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  const referenceRectReads = await page.evaluate(() => window.surfaceRectReads);
  assert.equal(referenceRectReads, 0, "reference chrome also uses cached placement geometry");
  await page.mouse.up();
  await page.getByRole("button", { name: "Components (19)", exact: true }).click();
  await gallery.getByRole("button", { name: "Sample details", exact: true }).click();
  assert.ok((await details.getAttribute("class")).includes("surface-reference"));
  await page.getByRole("button", { name: "Tinted", exact: true }).click();
  assert.equal(
    await details.evaluate((node) => node.style.getPropertyValue("--surface-opacity")),
    "90%",
  );
  await details.getByRole("button", { name: "Dismiss details", exact: true }).click();
  assert.equal(await field.evaluate((node, saved) => node === saved, liveDraft), true);
  await page.getByRole("button", { name: "Surface", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Lens", exact: true }).count(), 1);
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  const restoredInspector = page.locator('[aria-label="Surface model inspector"]');
  if ((await restoredInspector.count()) === 0)
    await page.getByRole("button", { name: "Inspect material", exact: true }).click();
  assert.equal(
    await restoredInspector.evaluate((node) => node.style.getPropertyValue("--surface-bevel")),
    authoredBevel,
  );
  await page.getByRole("button", { name: "macOS 27", exact: true }).click();
  await page.setViewportSize({ width: 640, height: 900 });
  await page.evaluate(async () => {
    for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
  });
  assert.ok(
    await page.getByTestId("surface-study").evaluate((node) => node.scrollWidth <= innerWidth),
    "narrow fixture must not overflow horizontally",
  );
  const narrowScroll = await page.evaluate(() => {
    const previewNode = document.querySelector(".surface-preview-scroll");
    const dials = document.querySelector('[data-testid="surface-dial-scroll"]');
    const previousScroll = previewNode.scrollTop;
    dials.scrollTop = dials.scrollHeight;
    return {
      before: previousScroll,
      after: previewNode.scrollTop,
      dials: dials.scrollTop,
      document: document.scrollingElement.scrollTop,
    };
  });
  assert.equal(narrowScroll.before, narrowScroll.after);
  assert.ok(narrowScroll.dials > 0);
  assert.equal(narrowScroll.document, 0);
  assert.equal(errors.length, 0, errors.join("\n"));
  const browserClient = await context.browser().newBrowserCDPSession();
  const gpuCompositing = (await browserClient.send("SystemInfo.getInfo")).gpu.featureStatus
    .gpu_compositing;
  console.log(
    JSON.stringify(
      {
        result: "pass",
        steps: 90,
        preset,
        durationMs,
        spatialRectReadsDuringDrag,
        savedKeyX,
        gpuCompositing,
        metrics,
        events,
        pageErrors: errors.length,
        darkAndNarrow: "pass",
        draftLifetime: "pass",
        temporaryPromotionCleanup: "pass",
        dialRigLifetime: "pass",
        independentMaterialsAndOpaqueInk: "pass",
        independentControlScroll: "pass",
        componentGallery: "19 real families, interactions and scoped portals pass",
        macOS27:
          "clear/balanced/tinted in light/dark, continuous slider, activity, portal scope, restoration and field lifetime pass",
        referenceRectReadsDuringDrag: referenceRectReads,
      },
      null,
      2,
    ),
  );
} finally {
  await context?.close();
  await rm(run, { recursive: true, force: true });
}
