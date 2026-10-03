/**
 * 03 · The Session cursor drives a Browser Tab (VC-238, VC-239).
 * Component: src/flute/shots/cursor.tsx. Layout: a 1282×827 browser window
 * centred on the origin; the cursor layer sits 46px above its page.
 */
import { ease, mix, track3 } from "../lib.mjs";

const CURSOR = (() => {
  const W = 1282;
  const TOP = 66;
  const H = TOP + 760 + 1;
  const page = (x, y, z = 0) => [x + 1 - W / 2, TOP + y - H / 2, z];
  const name = page(196, 214, 46);
  const plan = page(300, 374, 46);
  const cont = page(150, 470, 46);
  // The camera's own idea of where the cursor is: it follows, a beat behind.
  const follow = (t) =>
    track3(
      t,
      [
        [0, name],
        [560, name],
        [1120, plan],
        [1220, plan],
        [1820, cont],
      ],
      ease.inOutCubic,
    );
  return { follow, page };
})();

function cursorRig(format) {
  const wide = format === "wide";
  return (t) => {
    const cursor = CURSOR.follow(t);
    // Starts close on the cursor, already off to one side, and opens fast so
    // the page floats in the cobalt world with the super beside it (right in
    // 16:9, above in 9:16) from ~500ms on.
    const open = ease.outCubic(Math.min(1, Math.max(0, t / 1500)));
    const wideView = CURSOR.page(600, 330, 0);
    const target = [0, 1, 2].map((i) => mix(cursor[i], mix(cursor[i], wideView[i], 0.6), open));
    return {
      rotation: wide
        ? {
            rotateX: mix(14, 9, open) - t / 900,
            rotateY: mix(34, 40, open),
            rotateZ: mix(-3, -1, open),
          }
        : {
            rotateX: mix(26, 30, open),
            rotateY: mix(20, 16, open),
            rotateZ: mix(-4, -2, open),
          },
      target,
      near: (wide ? mix(300, -420, open) : mix(260, -260, open)) + 30 * Math.min(1, t / 3800),
      offset: wide ? [mix(-420, -600, open), -30] : [mix(10, 20, open), mix(300, 420, open)],
      focus: mix(0, 40, open),
      fStop: mix(4, 6, open),
      focalLength: 60,
      maxBlur: 7,
    };
  };
}

export const shot = {
  key: "cursor",
  title: "Agents drive the browser",
  description: "VC-238/239 — the Session cursor types, picks a plan, clicks Continue and lets go.",
  durationMs: 3800,
  perspective: 1400,
  nodes: [{ id: "browser" }, { id: "cursor-layer", parentId: "browser", transform: { z: 46 } }],
  rig: cursorRig,
};
