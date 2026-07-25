/**
 * End-to-end acceptance smoke for the grain overlay and the static-asset
 * pipeline it establishes (docs/plans/theming-engine.md § Grain, PR 2).
 *
 * Everything here is a property the unit tests structurally cannot see,
 * because all of it is about the PACKAGED app rather than the component:
 *
 *   1. The noise tile actually resolves and decodes over `volli-app://bundle`.
 *      This is the whole point of the asset pipeline — `base: "./"` plus a
 *      custom protocol is exactly where an asset that works in dev 404s once
 *      packaged, and a background-image that fails to load is INVISIBLE, not
 *      an error. PR 5's curated canvas images inherit this path.
 *   2. The overlay is painted at the opacity Ember's grain (0.35) maps to.
 *   3. It cannot stack above text: it is the framed content card's own
 *      backdrop layer — negative z-index inside an isolated stacking context,
 *      with every page's content as its later sibling.
 *   4. There is exactly ONE of them, and it lives on the card rather than
 *      inside any terminal or editor subtree.
 *
 * Like the other smokes this is MANUALLY RUN (needs a display + the built
 * app); CI does not run it:
 *
 *   pnpm -C apps/desktop run build     # or: vp run build
 *   node apps/desktop/e2e/grain-smoke.mjs
 */
import {
  assertProfileIsolated,
  createRunner,
  launch,
  makeScratch,
  waitUntil,
} from "./lib/smoke-kit.mjs";

/** Ember's grain (0.35) across the 0.015–0.035 window — see theme/grain.ts. */
const EMBER_GRAIN_OPACITY = 0.022;

/** The tile's declared edge, mirrored from theme/grain.ts. */
const TILE_PX = 128;

const { userDataDir, dbPath, cleanup } = await makeScratch("volli-grain-smoke-");
const { check, attempt, summarize } = createRunner();

let app = await launch({ dbPath, userDataDir });

try {
  await assertProfileIsolated(app, userDataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await waitUntil("the grain overlay to mount", () =>
    page.evaluate(() => document.querySelector("[data-volli-grain]") !== null),
  );

  await attempt(1, "the noise tile loads over the app protocol", async () => {
    const tile = await page.evaluate(async () => {
      const layer = document.querySelector("[data-volli-grain]");
      const url = /url\("?([^")]+)"?\)/.exec(getComputedStyle(layer).backgroundImage)?.[1] ?? "";
      // Decoding it is the assertion: a 404 under volli-app:// leaves the
      // background-image set and simply paints nothing.
      const decoded = await new Promise((resolve) => {
        const probe = new Image();
        probe.addEventListener("load", () =>
          resolve({ width: probe.naturalWidth, height: probe.naturalHeight }),
        );
        probe.addEventListener("error", () => resolve(null));
        probe.src = url;
      });
      return { url, decoded };
    });
    return {
      ok:
        // Dev serves from http://localhost:5173; the built app must serve the
        // tile from its own bundle origin.
        tile.url.startsWith("volli-app://bundle/") &&
        tile.decoded?.width === TILE_PX &&
        tile.decoded?.height === TILE_PX,
      detail: `${tile.url} → ${JSON.stringify(tile.decoded)}`,
    };
  });

  await attempt(2, "it is tiled, inert, and painted at Ember's grain", async () => {
    const style = await page.evaluate(() => {
      const computed = getComputedStyle(document.querySelector("[data-volli-grain]"));
      return {
        opacity: computed.opacity,
        repeat: computed.backgroundRepeat,
        size: computed.backgroundSize,
        pointerEvents: computed.pointerEvents,
        contain: computed.contain,
      };
    });
    return {
      ok:
        Math.abs(Number(style.opacity) - EMBER_GRAIN_OPACITY) < 1e-6 &&
        style.repeat === "repeat" &&
        style.size === `${TILE_PX}px ${TILE_PX}px` &&
        style.pointerEvents === "none" &&
        style.contain === "strict",
      detail: JSON.stringify(style),
    };
  });

  await attempt(3, "it can never paint above text", async () => {
    const order = await page.evaluate(() => {
      const layer = document.querySelector("[data-volli-grain]");
      const card = layer.parentElement;
      // Any rendered text inside the same card. Its nearest positioned/
      // isolated ancestor is that card, so paint order between the two is
      // decided entirely by the layer's negative z-index.
      const text = [...card.querySelectorAll("*")].find(
        (node) =>
          !layer.contains(node) &&
          node.childNodes.length > 0 &&
          [...node.childNodes].some((c) => c.nodeType === Node.TEXT_NODE && c.textContent.trim()),
      );
      return {
        zIndex: getComputedStyle(layer).zIndex,
        isolated: getComputedStyle(card).isolation,
        textFound: text !== undefined,
        textInsideLayer: text !== undefined && layer.contains(text),
        // DOM order too: the layer precedes every page's content.
        layerIsFirst: card.firstElementChild === layer,
      };
    });
    return {
      ok:
        order.zIndex === "-1" &&
        order.isolated === "isolate" &&
        order.textFound &&
        !order.textInsideLayer &&
        order.layerIsFirst,
      detail: JSON.stringify(order),
    };
  });

  await attempt(4, "exactly one overlay, and none inside a terminal or editor", async () => {
    const placement = await page.evaluate(() => {
      const layers = [...document.querySelectorAll("[data-volli-grain]")];
      return {
        count: layers.length,
        inSurface: layers.some(
          (layer) =>
            layer.closest(".monaco-editor") !== null || layer.querySelector("canvas") !== null,
        ),
      };
    });
    return {
      ok: placement.count === 1 && !placement.inSurface,
      detail: JSON.stringify(placement),
    };
  });
} catch (error) {
  check("!", "smoke crashed", false, String(error?.stack ?? error));
} finally {
  await app.close().catch(() => {});
}

const exitCode = summarize();
await cleanup();
process.exit(exitCode);
