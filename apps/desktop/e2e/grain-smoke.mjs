/**
 * End-to-end acceptance smoke for the grain overlay and the static-asset
 * pipeline it establishes (docs/plans/theming-engine.md § Grain, PR 2).
 *
 * Everything here is a property the unit tests structurally cannot see,
 * because all of it is about the PACKAGED app rather than the component:
 *
 *   1. **Grain ships OFF.** Every built-in carries `grain: 0`, and 0 means no
 *      element at all rather than a transparent one. This is the first check
 *      because it is the one a regression would silently undo: dogfooding the
 *      layer made the app harder to read — not from the mean lift § Grain
 *      quantifies (0.15 Lc) but from per-pixel variance around antialiased
 *      glyph edges — so "below text" turned out not to be far enough below.
 *   2. The noise tile actually resolves and decodes over `volli-app://bundle`.
 *      This is the whole point of the asset pipeline — `base: "./"` plus a
 *      custom protocol is exactly where an asset that works in dev 404s once
 *      packaged, and a background-image that fails to load is INVISIBLE, not
 *      an error. PR 5's curated canvas images inherit this path.
 *   3. Turned on, the overlay is painted at the opacity that grain maps to.
 *   4. It cannot stack above text: it is the framed content card's own
 *      backdrop layer — negative z-index inside an isolated stacking context,
 *      with every page's content as its later sibling.
 *   5. There is exactly ONE of them, and it lives on the card rather than
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

/**
 * The grain the smoke turns ON to inspect the layer, and the opacity it maps
 * to across the 0.015–0.035 window — see theme/grain.ts. The shipped themes
 * all carry 0; nothing about the layer is observable until something asks for
 * it, which is check 1.
 */
const TEST_GRAIN = 0.35;
const TEST_GRAIN_OPACITY = 0.022;

/** The tile's declared edge, mirrored from theme/grain.ts. */
const TILE_PX = 128;

const { userDataDir, dbPath, cleanup } = await makeScratch("volli-grain-smoke-");
const { check, attempt, summarize } = createRunner();

let app = await launch({ dbPath, userDataDir });

try {
  await assertProfileIsolated(app, userDataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  // Anchor on the surface the layer WOULD mount on, so "no overlay" means
  // "grain is off" rather than "nothing has rendered yet". With grain shipped
  // off there is no layer to wait for, which is the point of check 1.
  await waitUntil("the app surface to render", () =>
    page.evaluate(() => document.querySelector("[data-volli-surface]") !== null),
  );

  await attempt(1, "grain ships off — no layer at all on a shipped theme", async () => {
    const state = await page.evaluate(async () => ({
      grain: (await window.api.theme.state({})).value.theme.grain,
      layers: document.querySelectorAll("[data-volli-grain]").length,
    }));
    return {
      ok: state.grain === 0 && state.layers === 0,
      detail: `grain=${state.grain} layers=${state.layers}`,
    };
  });

  // Everything below is about the layer itself, so turn it on. setGlobal
  // writes through main; the reload is what makes the renderer re-read it.
  await page.evaluate(async (grain) => {
    const { theme } = (await window.api.theme.state({})).value;
    await window.api.theme.setGlobal({ ...theme, grain });
  }, TEST_GRAIN);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await waitUntil("the grain overlay to mount", () =>
    page.evaluate(() => document.querySelector("[data-volli-grain]") !== null),
  );

  await attempt(2, "the noise tile loads over the app protocol", async () => {
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

  await attempt(3, "it is tiled, inert, and painted at the grain it was given", async () => {
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
        Math.abs(Number(style.opacity) - TEST_GRAIN_OPACITY) < 1e-6 &&
        style.repeat === "repeat" &&
        style.size === `${TILE_PX}px ${TILE_PX}px` &&
        style.pointerEvents === "none" &&
        style.contain === "strict",
      detail: JSON.stringify(style),
    };
  });

  await attempt(4, "it can never paint above text", async () => {
    const order = await page.evaluate(() => {
      const layer = document.querySelector("[data-volli-grain]");
      const card = document.querySelector("[data-volli-surface]");
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

  await attempt(5, "exactly one overlay, and none inside a terminal or editor", async () => {
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
