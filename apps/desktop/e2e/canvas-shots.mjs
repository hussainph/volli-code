/**
 * Acceptance smoke AND visual probe for the canvas layer (#124,
 * docs/plans/theming-engine.md § Canvas + shaders).
 *
 * Part probe, part proof. The screenshots exist so the two-versus-three-stop
 * question is settled by eye against the real window rather than by a number;
 * the checks around them cover the things a unit test structurally cannot see,
 * because all of them are about COMPOSITED pixels in a real compositor:
 *
 *   1. **`solid` is pixel-identical to the shell without a canvas.** Proved,
 *      not asserted: the window is sampled twice — once as it ships, once with
 *      the layer hidden and every veil forced back to the opaque token it was
 *      solved from, which IS the arrangement that existed before this PR — and
 *      the two sets of patches are compared byte for byte. That comparison is
 *      the whole safety story, so it is check 1. (See {@link flatPatches} for
 *      why it samples flat fill rather than the whole window.)
 *   2. The layer honors its contract in the real DOM, including sitting
 *      OUTSIDE the `zoom: uiScale` row (a zoomed canvas would rescale its own
 *      gradient on every ⌘+) and holding no text.
 *   3. No focus ring punches an opaque halo through the canvas — the
 *      `ring-offset` audit, verified against a REAL focus rather than by
 *      reading the class list.
 *   4. The stops the app derives all sit inside the legibility band, read back
 *      off the layer it painted rather than recomputed here.
 *   5. The content card stays **fully opaque over every canvas kind**. Cards
 *      stay opaque is the fixed rule; alpha is only readable from a live
 *      computed style, which is why it lives here.
 *
 * There is no Background picker to drive: the row is deliberately unexposed
 * until #74's vivid color model lands (theme-editor.tsx says why), so the app's
 * own derivation is reached through the seed field instead — see
 * {@link paintedStops}. Check 1 never touched a control and is unchanged, which
 * matters: it is the guarantee that makes shipping the dormant layer free.
 *
 * MANUALLY RUN (needs a display + the built app); CI does not run it:
 *
 *   pnpm -C apps/desktop run build     # or: vp run build
 *   node apps/desktop/e2e/canvas-shots.mjs [out-dir]
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

import {
  APP_DIR,
  assertProfileIsolated,
  createRunner,
  launch,
  makeGitRepo,
  makeScratch,
  seedProjects,
  sleep,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const OUT_DIR = process.argv[2] ?? join(APP_DIR, "e2e", "shots");

/** The band from theme/canvas.ts, plus the one 8-bit step it is allowed to round by. */
const BAND = { min: 0.105, max: 0.17, quantization: 0.005 };

/**
 * Ember's seed, and three stops no derivation would ever emit.
 *
 * The placeholders are three unrelated saturated hues; the read-time band clamp
 * drags them dark but cannot make them a monotone ramp, so a seed nudge that
 * failed to re-derive shows up as a paint that never moved rather than as a
 * plausible gradient nobody notices. {@link paintedStops} throws on exactly that.
 */
const EMBER_SEED = "#e8652a";
const PLACEHOLDER_STOPS = ["#ff00ff", "#00ff00", "#0000ff"];

const { scratch, userDataDir, dbPath, cleanup } = await makeScratch("volli-canvas-shots-");
const { check, attempt, summarize } = createRunner();
await fs.mkdir(OUT_DIR, { recursive: true });

const app = await launch({ dbPath, userDataDir });

try {
  await assertProfileIsolated(app, userDataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1440, height: 900 });
  // Two projects, the first selected — so the rail carries a SELECTED tile,
  // which is the one ring in the app with a non-zero offset and therefore the
  // whole point of check 3.
  await seedProjects(page, [
    { id: "canvas-shots-alpha", name: "Voltaic", prefix: "VLT", path: await makeGitRepo(scratch) },
    { id: "canvas-shots-beta", name: "Beacon", prefix: "BCN", path: await makeGitRepo(scratch) },
  ]);
  await waitUntil("the canvas layer to mount", () =>
    page.evaluate(() => document.querySelector("[data-volli-canvas]") !== null),
  );
  await seedBoard(page);
  await sleep(700);

  await attempt(1, "solid is pixel-identical to the shell without a canvas", async () => {
    const patches = await flatPatches(page);
    const shipped = await samplePatches(page, patches);
    // Undo the layer, exactly: hide it (SidebarProvider's own `bg-rail` is
    // still underneath, which is what the backdrop row used to paint), and
    // force each veil to the opaque token it was solved from. That IS the
    // arrangement that existed before this PR, so if the veil math is right
    // these are the same pixels.
    await page.evaluate(() => {
      const root = document.documentElement;
      const read = (name) => getComputedStyle(root).getPropertyValue(name).trim();
      document.querySelector("[data-volli-canvas]").style.display = "none";
      for (const [veil, opaque] of [
        ["--sidebar-veil", "--sidebar"],
        ["--sidebar-accent-veil", "--sidebar-accent"],
        ["--sidebar-border-veil", "--sidebar-border"],
      ]) {
        root.style.setProperty(veil, read(opaque));
      }
    });
    await sleep(400);
    const restored = await samplePatches(page, patches);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await waitUntil("the canvas layer to come back", () =>
      page.evaluate(() => document.querySelector("[data-volli-canvas]") !== null),
    );
    await sleep(700);
    const moved = patches.filter(
      (_, index) => Buffer.compare(shipped[index], restored[index]) !== 0,
    );
    return {
      // Enough patches that "found nothing to compare" cannot read as a pass.
      ok: moved.length === 0 && patches.length >= 12,
      detail: `patches=${patches.length} moved=${moved.length}${moved.length === 0 ? "" : ` at ${JSON.stringify(moved.slice(0, 6))}`}`,
    };
  });

  await attempt(2, "the layer honors its contract, outside the zoom row", async () => {
    const contract = await page.evaluate(() => {
      const layer = document.querySelector("[data-volli-canvas]");
      const computed = getComputedStyle(layer);
      const zoomed = [...document.querySelectorAll("*")].find(
        (node) => node !== layer && getComputedStyle(node).zoom !== "1",
      );
      return {
        ariaHidden: layer.getAttribute("aria-hidden"),
        zIndex: computed.zIndex,
        pointerEvents: computed.pointerEvents,
        contain: computed.contain,
        isolatedHost: getComputedStyle(layer.parentElement).isolation,
        firstChild: layer.parentElement.firstElementChild === layer,
        text: layer.textContent,
        insideZoomedRow: zoomed !== undefined && zoomed.contains(layer),
      };
    });
    return {
      ok:
        contract.ariaHidden === "true" &&
        contract.zIndex === "-1" &&
        contract.pointerEvents === "none" &&
        contract.contain === "strict" &&
        contract.isolatedHost === "isolate" &&
        contract.firstChild &&
        contract.text === "" &&
        !contract.insideZoomedRow,
      detail: JSON.stringify(contract),
    };
  });

  await attempt(3, "no ring offset paints an opaque halo through the canvas", async () => {
    // The `ring-offset` audit, and the single most likely visual bug in this
    // change: `ring-offset-rail` (or `-background`) over a surface that has
    // given up its fill punches a solid dark hole in the gradient. Only rings
    // with a NON-ZERO offset width paint one at all — Tailwind leaves
    // `--tw-ring-offset-color` at its `#fff` default on every element — so the
    // width is what makes an element part of this sweep. Driven with a real
    // focus, so anything focus-only is in scope too.
    await page.keyboard.press("Tab");
    await sleep(250);
    const rings = await page.evaluate(() => {
      const offenders = [];
      let offsetRings = 0;
      const backdrop = document.querySelector("[data-slot='sidebar-wrapper']");
      for (const node of [backdrop, ...backdrop.querySelectorAll("*")]) {
        // Inside the framed card the surface is still opaque, so an offset
        // there is correct — this sweep is about the canvas.
        if (node.closest("[data-volli-surface]") !== null) continue;
        const computed = getComputedStyle(node);
        const width = Number.parseFloat(computed.getPropertyValue("--tw-ring-offset-width"));
        if (!(width > 0)) continue;
        offsetRings += 1;
        const color = computed.getPropertyValue("--tw-ring-offset-color").trim();
        const transparent = color === "transparent" || /rgba\(.*,\s*0\)$/.test(color);
        if (!transparent) offenders.push(`${node.tagName.toLowerCase()} → ${color}`);
      }
      return { offenders, offsetRings, focused: document.activeElement?.tagName ?? "none" };
    });
    return {
      // A zero count would mean the sweep found nothing to check — the selected
      // project tile always carries one, so that is a broken test, not a pass.
      ok: rings.offenders.length === 0 && rings.offsetRings > 0,
      detail: `focused=${rings.focused} offsetRings=${rings.offsetRings} offenders=${JSON.stringify(rings.offenders)}`,
    };
  });

  // Derive the stops through the APP rather than recomputing them here: the
  // painted layer is the derivation's own output, so a shot can never be of
  // colors the app would not actually produce.
  const gradient = await paintedStops(page, "gradient");
  const mesh = await paintedStops(page, "mesh");
  // Back to the board, which is the surface worth judging: rail, sidebar,
  // chrome band and the framed card all in one frame.
  await page.getByRole("button", { name: "Board", exact: true }).first().click();
  await sleep(900);
  // A two-stop derivation IS the three-stop one without its middle: both
  // endpoints are the band's ends at the same chroma multipliers.
  const gradientTwo = [gradient[0], gradient[gradient.length - 1]];

  await attempt(4, "every derived stop lands inside the legibility band", async () => {
    const outside = [...gradient, ...mesh].filter((hex) => {
      const L = lightness(hex);
      return L < BAND.min - BAND.quantization || L > BAND.max + BAND.quantization;
    });
    return {
      ok: gradient.length === 3 && mesh.length === 3 && outside.length === 0,
      detail: `gradient=${gradient.join(",")} mesh=${mesh.join(",")} outside=${outside.join(",") || "none"}`,
    };
  });

  const shots = [
    ["1-solid", { kind: "solid" }],
    ["2-gradient-2-stops", { kind: "gradient", stops: gradientTwo }],
    ["3-gradient-3-stops", { kind: "gradient", stops: gradient }],
    ["4-mesh", { kind: "mesh", stops: mesh }],
  ];

  const opaqueCard = [];
  for (const [name, canvas] of shots) {
    await setCanvas(page, canvas);
    await sleep(500);
    await page.screenshot({ path: join(OUT_DIR, `${name}.png`) });
    opaqueCard.push(
      await page.evaluate((label) => {
        const card = getComputedStyle(document.querySelector("[data-volli-surface]"));
        return `${label}:${card.backgroundColor}`;
      }, name),
    );
  }

  await attempt(5, "the content card stays fully opaque over every canvas", async () => {
    // The fixed rule: cards stay opaque. A card that went translucent would put
    // the gradient under body copy, which is the one thing this design is
    // built around not doing.
    const translucent = opaqueCard.filter((entry) => entry.includes("rgba"));
    return { ok: translucent.length === 0, detail: opaqueCard.join(" ") };
  });

  console.log(`\nshots written to ${OUT_DIR}`);
} catch (error) {
  check("!", "smoke crashed", false, String(error?.stack ?? error));
} finally {
  await app.close().catch(() => {});
}

const exitCode = summarize();
await cleanup();
process.exit(exitCode);

/**
 * A board with something on it. The canvas is judged by eye against the app,
 * not against an empty window — an empty board would hide the one relationship
 * that matters most, the framed card's mass sitting on the darker half of the
 * ramp.
 */
async function seedBoard(page) {
  const seeded = await page.evaluate(async () => {
    const boot = await window.api.data.bootstrap();
    if (!boot.ok) return boot.error;
    const project = boot.data.projects[0];
    if (project === undefined) return "no project";
    const add = (status, title, priority) =>
      window.api.tickets.create({ projectId: project.id, status, title, priority });
    await add("doing", "Derive the canvas layer's stops inside a legibility band", "high");
    await add("doing", "Solve the veil tokens for every opaque chrome surface", "medium");
    await add("backlog", "Curated canvas images and the custom-image scrim", "medium");
    await add("backlog", "Paper Shaders as baked stills", "low");
    await add("todo", "Terminal GPU backend seam", "high");
    await add("todo", "Ghostty config adapter follow-ups", "medium");
    await add("needs_review", "Per-project theme override", "medium");
    await add("done", "Grain overlay and the static-asset pipeline", "low");
    return null;
  });
  if (seeded !== null) throw new Error(`board seed failed: ${seeded}`);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await waitUntil("the canvas layer to remount", () =>
    page.evaluate(() => document.querySelector("[data-volli-canvas]") !== null),
  );
  await sleep(1200);
}

/** Settings → Appearance → Customize: the theme editor, opened on the applied theme. */
async function openThemeEditor(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page
    .getByRole("navigation", { name: "Settings categories" })
    .getByRole("button", { name: "Appearance", exact: true })
    .click();
  await page.getByRole("button", { name: "Customize", exact: true }).click();
  await seedHexField(page).waitFor();
}

/** The theme editor's seed hex field — the control that re-derives a canvas. */
function seedHexField(page) {
  return page.getByLabel("Theme color hex");
}

/**
 * Writes a canvas onto the global theme and gets the window wearing it.
 *
 * The reload is not optional: `window.api` writes through MAIN, and the
 * renderer's theme store only learns about a write it did not make itself when
 * it next hydrates. Same pattern as `grain-smoke.mjs`.
 */
async function setCanvas(page, canvas) {
  await page.evaluate(async (next) => {
    const { theme } = (await window.api.theme.state({})).value;
    await window.api.theme.setGlobal({ ...theme, canvas: next }, null);
  }, canvas);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await waitUntil("the canvas layer to repaint", () =>
    page.evaluate(() => document.querySelector("[data-volli-canvas]") !== null),
  );
  await sleep(1200);
}

/** The canvas layer's current paint, both halves, as one comparable string. */
function canvasPaint(page) {
  return page.evaluate(() => {
    const computed = getComputedStyle(document.querySelector("[data-volli-canvas] > div"));
    return `${computed.backgroundImage} ${computed.backgroundColor}`;
  });
}

/**
 * The stops the app itself derives for `kind`, read back off the layer it
 * actually painted — never recomputed here, because a smoke that reimplemented
 * the OKLCH derivation could shoot a gradient the app would never produce and
 * never notice.
 *
 * The route is the **seed field**, not a Background picker: that row is
 * deliberately unexposed until #74's vivid color model lands (theme-editor.tsx
 * says why), and `withSeed` is the control that still re-derives a non-solid
 * canvas — "its colors come from the color above" is a promise the editor keeps
 * whether or not there is a row to pick the geometry in. So: write a canvas of
 * the right kind with junk stops, open the editor, move the seed off Ember and
 * back, and let the app fill them in. That also means this smoke now covers the
 * one canvas path a control still reaches.
 */
async function paintedStops(page, kind) {
  await setCanvas(page, { kind, stops: PLACEHOLDER_STOPS });
  await openThemeEditor(page);
  const before = await canvasPaint(page);
  // Two writes, ending on Ember's own seed: React fires no change event for a
  // fill that leaves the value where it was, so the nudge has to actually move.
  await seedHexField(page).fill("#e8652b");
  await seedHexField(page).fill(EMBER_SEED);
  const painted = await waitUntil(`the ${kind} canvas to re-derive`, async () => {
    const now = await canvasPaint(page);
    return now === before ? null : now;
  });
  // Leave the edit without saving — the shots below write the canvas directly,
  // onto the shipped theme rather than onto a copy of it.
  await page.keyboard.press("Escape");
  await sleep(300);
  // A mesh's base fill lands in `background-color` rather than in the image
  // list, and its pools repeat a stop so all three anchors get used — so read
  // both halves, drop the `transparent` falloffs, and keep first appearances.
  const stops = [...painted.matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/g)]
    .filter(([, , , , alpha]) => alpha === undefined || Number(alpha) > 0)
    .map(
      ([, r, g, b]) =>
        `#${[r, g, b].map((value) => Number(value).toString(16).padStart(2, "0")).join("")}`,
    );
  return stops.filter((hex, index) => stops.indexOf(hex) === index);
}

/**
 * Small patches of FLAT FILL across every surface the canvas layer moved in
 * under — the chrome band, the project rail, the sidebar column and the gutter
 * around the card — chosen so none of them contains text.
 *
 * Text is excluded because Chromium's glyph rasterization is not frame-stable
 * on macOS: measured here, two screenshots of a window whose DOM and computed
 * styles are byte-identical still differ, alternating between two rasterizations
 * of the same text. That noise has nothing to do with this change and would make
 * a whole-window comparison flap forever. Flat fill has no such noise, and flat
 * fill is exactly what the identity claim is ABOUT — the composite of a veil
 * over the canvas versus the opaque token it replaced.
 */
async function flatPatches(page) {
  return page.evaluate(() => {
    const card = document.querySelector("[data-volli-surface]").getBoundingClientRect();
    const blocked = [];
    for (const node of document.querySelectorAll("*")) {
      const hasText = [...node.childNodes].some(
        (child) => child.nodeType === Node.TEXT_NODE && child.textContent.trim().length > 0,
      );
      // Anything drawn on top of a fill invalidates the patch, not only text:
      // an icon, a tile, an input. Leaf elements with their own paint count.
      if (hasText || node.tagName === "SVG" || node.tagName === "svg" || node.tagName === "INPUT") {
        blocked.push(node.getBoundingClientRect());
      }
    }
    const size = 8;
    const patches = [];
    for (let y = 4; y + size < window.innerHeight; y += 24) {
      for (let x = 4; x + size < card.left + card.width; x += 24) {
        // Left of the card, or above it: the surfaces that gave up their fill.
        if (x > card.left && y > card.top) continue;
        const clear = blocked.every(
          (rect) =>
            x + size < rect.left - 2 ||
            x > rect.right + 2 ||
            y + size < rect.top - 2 ||
            y > rect.bottom + 2,
        );
        if (clear) patches.push({ x, y, width: size, height: size });
      }
    }
    // Spread the sample rather than taking the first N, which would all land in
    // one column of the rail.
    const stride = Math.max(1, Math.floor(patches.length / 40));
    return patches.filter((_, index) => index % stride === 0).slice(0, 40);
  });
}

/** One screenshot per patch, in order. */
async function samplePatches(page, patches) {
  const shots = [];
  for (const clip of patches) shots.push(await page.screenshot({ clip }));
  return shots;
}

/** OKLCH lightness of an `#rrggbb`, enough of the math to check a band. */
function lightness(hex) {
  const channel = (index) => {
    const value = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [0, 1, 2].map(channel);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}
