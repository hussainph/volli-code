/**
 * That the dnd-kit patch is actually on the copy we resolve.
 *
 * `patches/@dnd-kit__core@6.3.1.patch` is what makes the board's drag crash
 * (React error #185, `Maximum update depth exceeded`) structurally impossible
 * rather than merely unlikely: unpatched, `useRects` sets a brand-new array of
 * brand-new `Rect` objects on every measure, so its layout effect can re-arm
 * itself without bound. A pnpm patch is pinned to an exact version, so the
 * ordinary way to lose it is a dependency bump that resolves past 6.3.1 and
 * silently drops the guard — the crash would come back with nothing in the diff
 * to point at.
 *
 * So this asserts the shipped artifact, not the patch file: reading
 * `patches/…` would only prove the patch still exists on disk, which is the
 * half that was never in doubt.
 *
 * The patch now carries TWO guards, because the first one turned out to cover
 * only half the loop (VC-221). `sameMeasuredRects` stops `useRects` setting an
 * unchanged VALUE; `sameScrollableAncestors` stops `useScrollableAncestors`
 * minting a new array IDENTITY for an unchanged chain — which re-armed both
 * `useRects` and `useScrollOffsets` on every commit and reached React error
 * #185 by itself. Losing either one brings a board-killing drag crash back, so
 * both are asserted on every build a consumer can reach.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

const require = createRequire(import.meta.url);

/** The builds a consumer can reach: `module` for the bundler, `main` for node. */
function dndKitBuild(file: string): string {
  const manifest = require.resolve("@dnd-kit/core/package.json");
  return readFileSync(path.join(path.dirname(manifest), "dist", file), "utf8");
}

describe("@dnd-kit/core patch", () => {
  it("guards useRects against setting an unchanged measurement (ESM build)", () => {
    // The ESM build is the one Vite bundles into the renderer — the artifact
    // that actually ships in the app.
    expect(dndKitBuild("core.esm.js")).toContain("function sameMeasuredRects(");
  });

  it("guards useScrollableAncestors against minting a new identity (ESM build)", () => {
    // VC-221: the value guard above cannot see this one. A card and the column
    // holding it have different PARENTS but the same scroll chain, so dnd-kit's
    // own parent check misses and hands back a fresh array — which is a new
    // dependency for `useRects` and `useScrollOffsets` on every commit.
    const esm = dndKitBuild("core.esm.js");
    expect(esm).toContain("function sameScrollableAncestors(");
    // …and it is actually CONSULTED, not merely defined.
    expect(esm).toContain("sameScrollableAncestors(previousValue, next)");
  });

  it("guards the CommonJS builds too", () => {
    const development = dndKitBuild("core.cjs.development.js");
    expect(development).toContain("function sameMeasuredRects(");
    expect(development).toContain("function sameScrollableAncestors(");
    // Minified, so the guards are inlined rather than named — their private
    // prefixes are the only stable handle on them.
    const production = dndKitBuild("core.cjs.production.min.js");
    expect(production).toContain("_vrRef");
    expect(production).toContain("_vsaPick");
  });

  it("no longer hands setRects an unconditionally fresh array", () => {
    // The exact pre-patch expression. If a bump restores it, the loop is back.
    expect(dndKitBuild("core.esm.js")).not.toContain(
      "setRects(() => {\n      if (!elements.length) {",
    );
  });
});
