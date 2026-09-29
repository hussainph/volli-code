/**
 * 0x · The Activity Island, exploded (VC-246, VC-268, VC-269, VC-270; VC-6).
 * Component: src/flute/shots/island.tsx — its geometry is mirrored in GEO.
 *
 *   0–700     macro on the pill at rest above the chat, camera already moving
 *   700–2600  the island's four cards rise out of it into a stack in depth;
 *             the world orbits under a steady rotateY while focus racks down
 *             the stack: plan → subagents → shells → Browser Tabs
 *   2600–4000 the cards fall back into the pill; the camera settles close on it
 *
 * The cards' travel is surface tracks sampled from the same functions the rig
 * frames, so camera, focus and layers can never disagree about where a card is.
 */
import { clamp01, ease, mix, progress, rotate, track, track3 } from "../lib.mjs";

const GEO = (() => {
  const chat = { width: 640, height: 620, top: -250 };
  const pillTop = chat.top + 16 + 404;
  const card = { plan: 190, agents: 110, shells: 110, tabs: 110 };
  const order = ["tabs", "shells", "agents", "plan"];
  const layers = {};
  let bottom = pillTop - 14;
  for (const id of order) {
    const h = card[id];
    layers[id] = { cy: bottom - h / 2, h, w: 456 };
    bottom -= h + 22;
  }
  return { chat, pillTop, pill: [0, pillTop + 16, 0], order, layers };
})();

/** Where each layer lives when the island is exploded: a stagger in x, and depth. */
const SPREAD = {
  tabs: { x: 34, z: 70 },
  shells: { x: -26, z: 150 },
  agents: { x: 24, z: 230 },
  plan: { x: -30, z: 310 },
};

const STACK_MID = (GEO.layers.plan.cy + GEO.layers.tabs.cy) / 2;
const PACK = 0.62;

const EXPLODE = { from: 560, stagger: 80, duration: 980 };
const CONVERGE = { from: 2560, stagger: 70, duration: 760 };

/** 0 = inside the pill, 1 = on its exploded slot. */
function spread(id, t) {
  const i = GEO.order.indexOf(id);
  const out = progress(t, EXPLODE.from + i * EXPLODE.stagger, EXPLODE.from + i * EXPLODE.stagger + EXPLODE.duration, ease.outQuart);
  // The farthest layer leaves first, so all four land together.
  const j = GEO.order.length - 1 - i;
  const back = progress(t, CONVERGE.from + j * CONVERGE.stagger, CONVERGE.from + j * CONVERGE.stagger + CONVERGE.duration, ease.inOutCubic);
  return { out, back, s: out * (1 - back) };
}

/** A layer's surface transform (offsets from its CSS slot) and opacity at t. */
function layerState(id, t) {
  const { out, back, s } = spread(id, t);
  const layer = GEO.layers[id];
  const dy = GEO.pill[1] - layer.cy;
  // Exploded, the deck packs tighter in y than its CSS slots (the depth
  // stagger keeps the cards apart), so the camera can come in close.
  const packed = (STACK_MID + (layer.cy - STACK_MID) * PACK - 30) - layer.cy;
  // A slow float while exploded keeps the stack alive between beats.
  const float = Math.sin((t / 1000) * 1.6 + GEO.order.indexOf(id)) * 6 * s;
  return {
    x: SPREAD[id].x * s,
    y: dy * (1 - s) + packed * s + float,
    z: SPREAD[id].z * s,
    scale: mix(0.22, 1, s),
    opacity: clamp01(out / 0.28) * (1 - clamp01((back - 0.62) / 0.34)),
  };
}

function layerCenter(id, t) {
  const st = layerState(id, t);
  return [st.x, GEO.layers[id].cy + st.y, st.z];
}

function pillState(t) {
  const lift = progress(t, 520, 1300, ease.inOutCubic) * (1 - progress(t, 2600, 3300, ease.inOutCubic));
  // The landing: a small swell as the last card is absorbed.
  const swell = Math.sin(Math.PI * progress(t, 3180, 3620, ease.linear)) * 0.045;
  return { z: 2 + 26 * lift, scale: 1 + swell };
}

/** The chat's presence: full at rest, dimmed while the cards are out. */
function chatOpacity(t) {
  const dim = progress(t, 640, 1300, ease.inOutCubic) * (1 - progress(t, 2800, 3450, ease.inOutCubic));
  return mix(1, 0.12, dim);
}

/** What the lens is on: the pill, then each card down the stack, then the pill. */
function focusPoint(t) {
  const P = (id) => layerCenter(id, t);
  const pill = [GEO.pill[0], GEO.pill[1], pillState(t).z];
  const stops = [
    [0, pill],
    [640, pill],
    [1000, P("plan")],
    [1280, P("plan")],
    [1480, P("agents")],
    [1720, P("agents")],
    [1900, P("shells")],
    [2120, P("shells")],
    [2300, P("tabs")],
    [2520, P("tabs")],
    [3100, pill],
  ];
  return track3(t, stops, ease.inOutCubic);
}

const FORMAT = {
  wide: {
    rotateX: [9, 13, 10],
    rotateY: [34, -22],
    rotateZ: -2,
    near: [
      [0, 980],
      [420, 1010],
      [1450, 560],
      [2150, 500],
      // Pulled back as the stack is fullest, so the plan card keeps a margin.
      [2650, 420],
      [3500, 900],
      [4000, 980],
    ],
    offset: {
      macro: [150, 60],
      open: [600, 90],
      settle: [160, 30],
    },
  },
  tall: {
    rotateX: [12, 16, 12],
    rotateY: [30, -18],
    rotateZ: -2,
    near: [
      [0, 940],
      [420, 970],
      [1450, 560],
      [2500, 520],
      [3500, 780],
      [4000, 820],
    ],
    offset: {
      macro: [0, -120],
      open: [0, -330],
      settle: [0, -120],
    },
  },
};

function islandRig(format) {
  const f = FORMAT[format];
  return (t) => {
    const open = progress(t, 520, 1500, ease.inOutCubic);
    const close = progress(t, 2550, 3700, ease.inOutCubic);
    const orbit = ease.inOutSine(clamp01((t + 1100) / 5300));
    const rotation = {
      rotateX: track(t, [[0, f.rotateX[0]], [1500, f.rotateX[1]], [4000, f.rotateX[2]]], ease.inOutSine),
      rotateY: mix(f.rotateY[0], f.rotateY[1], orbit),
      rotateZ: f.rotateZ,
    };
    // The frame's anchor: the pill, then the stack's middle leaning toward
    // whichever card is in focus, then the pill again.
    const stackMid = [0, STACK_MID - 30, 190];
    const fp = focusPoint(t);
    const openTarget = [0, 1, 2].map((i) => mix(stackMid[i], fp[i], 0.3));
    const pill = [GEO.pill[0], GEO.pill[1], pillState(t).z];
    const target = [0, 1, 2].map((i) => mix(mix(pill[i], openTarget[i], open), pill[i], close));
    const offset = [0, 1].map((i) =>
      mix(mix(f.offset.macro[i], f.offset.open[i], open), f.offset.settle[i], close),
    );
    const near = track(t, f.near, ease.inOutSine);
    // Rack focus: extra distance from the target to the focused point, along view z.
    const vzTarget = rotate(target, rotation)[2];
    const vzFocus = rotate(fp, rotation)[2];
    // Near-plane guard over the moving layers' corners.
    for (const id of GEO.order) {
      const c = layerCenter(id, t);
      for (const [dx, dy] of [[-228, -GEO.layers[id].h / 2], [228, GEO.layers[id].h / 2], [-228, GEO.layers[id].h / 2], [228, -GEO.layers[id].h / 2]]) {
        const v = rotate([c[0] + dx, c[1] + dy, c[2]], rotation)[2];
        const depth = 1400 - (v - (vzTarget - near));
        if (depth < 180 && layerState(id, t).opacity > 0) console.warn(`  near-plane ${format} t=${t.toFixed(0)} ${id} depth ${depth.toFixed(0)}`);
      }
    }
    return {
      rotation,
      target,
      near,
      offset,
      focus: vzTarget - vzFocus,
      fStop: track(t, [[0, 3.2], [1000, 4.2], [2700, 4.2], [3800, 3.4]], ease.inOutSine),
      focalLength: 60,
      maxBlur: 6,
    };
  };
}

function surfaceTracks(format) {
  const step = 1000 / 30;
  const times = [];
  for (let i = 0; i * step < 4000 - 0.5; i += 1) times.push(Math.round(i * step * 1000) / 1000);
  times.push(4000);
  const round = (v) => Math.round(v * 1000) / 1000;
  const tracks = [];
  // Keyframes a straight line through its neighbours already implies are
  // dropped (within `eps`), so a recipe stays under Flute's file cap.
  const thin = (values, eps) => {
    const keep = [0];
    let anchor = 0;
    for (let j = 2; j < values.length; j += 1) {
      for (let k = anchor + 1; k < j; k += 1) {
        const p = (times[k] - times[anchor]) / (times[j] - times[anchor]);
        if (Math.abs(mix(values[anchor], values[j], p) - values[k]) > eps) {
          anchor = j - 1;
          keep.push(anchor);
          break;
        }
      }
    }
    keep.push(values.length - 1);
    return keep;
  };
  const add = (id, property, fn) => {
    const values = times.map((t) => round(fn(t)));
    if (values.every((v) => v === values[0])) return;
    const eps = property === "scale" || property === "opacity" ? 0.0015 : 0.12;
    tracks.push({
      target: { kind: "surface", id },
      property,
      keyframes: thin(values, eps).map((i) => ({ timeMs: times[i], value: values[i], easing: "linear" })),
    });
  };
  for (const id of GEO.order) {
    for (const property of ["x", "y", "z", "scale", "opacity"]) {
      add(`card-${id}`, property, (t) => layerState(id, t)[property]);
    }
  }
  // The chat drops back into the void while the island is exploded, so the
  // stack reads alone and the super (9:16: over the chat's area) sits on black.
  add("chat", "opacity", (t) => chatOpacity(t));
  add("island-pill", "z", (t) => pillState(t).z);
  add("island-pill", "scale", (t) => pillState(t).scale);
  // 9:16: the rising pill would show through the super's eyebrow while it
  // fades out, so it stays dim until the super has gone.
  if (format === "tall") {
    add("island-pill", "opacity", (t) =>
      mix(1, 0.15, progress(t, 2250, 2450, ease.inOutSine) * (1 - progress(t, 2780, 3050, ease.inOutSine))),
    );
  }
  return tracks;
}

export const shot = {
  key: "island",
  title: "Everything your agent is doing",
  description:
    "VC-246/268/269/270 — the Activity Island explodes into its real cards (plan, subagents, shells, Browser Tabs) and folds back into the pill.",
  durationMs: 4000,
  perspective: 1400,
  nodes: [
    { id: "chat" },
    { id: "island-pill" },
    ...GEO.order.map((id) => ({ id: `card-${id}` })),
  ],
  rig: islandRig,
  surfaceTracks,
};
