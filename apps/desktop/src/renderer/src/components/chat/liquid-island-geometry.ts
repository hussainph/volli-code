/** A drawn union, not overlapping translucent fills or a gooey filter. */
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
const f = (n: number) => Number(n.toFixed(3));
const point = (x: number, y: number) => `${f(x)} ${f(y)}`;

export function capsulePath(width: number, height: number, bottom = 32): string {
  if (width < 0.1 || height < 0.1) return "";
  const r = Math.min(width, height) / 2;
  const x = width / 2;
  const top = bottom - height;
  return `M${point(-x + r, top)}H${f(x - r)}A${r} ${r} 0 0 1 ${point(x, top + r)}V${f(bottom - r)}A${r} ${r} 0 0 1 ${point(x - r, bottom)}H${f(-x + r)}A${r} ${r} 0 0 1 ${point(-x, bottom - r)}V${f(top + r)}A${r} ${r} 0 0 1 ${point(-x + r, top)}Z`;
}

function nubPath(y: number, direction: number, tip: number): string {
  if (tip <= 0) return "";
  const a = 4.5 * tip + 0.5;
  const length = 7 * tip;
  return `M${point(a * direction, y - direction * 5)}L${point(a * direction, y)}C${point(a * direction * 0.3, y + direction * length * 0.15)} ${point(0.6 * direction, y + direction * length * 0.75)} ${point(0, y + direction * length)}C${point(-0.6 * direction, y + direction * length * 0.75)} ${point(-a * direction * 0.3, y + direction * length * 0.15)} ${point(-a * direction, y)}L${point(-a * direction, y - direction * 5)}Z`;
}

function capInset(width: number, height: number, half: number): number {
  const r = height / 2;
  const off = clamp(half - Math.max(0, width / 2 - r), 0, r);
  return r - Math.sqrt(Math.max(0, r * r - off * off));
}

export interface LiquidGeometry {
  islandWidth: number;
  cluster: number;
  width: number;
  presence: number;
  stretch: number;
  pinch: number;
  detached: boolean;
  fade: number;
  dropping: boolean;
  squash: number;
  gulp: number;
  reduce: boolean;
}

/** Sessile A: first grow the island, then lift the pill, then form fillets. */
export function liquidIslandGeometry(s: LiquidGeometry) {
  const cluster = clamp(s.cluster, 0, 1);
  const alone = 1 - cluster;
  const pres = clamp(s.presence, 0, 1);
  const rise = clamp(cluster * 2.5, 0, 1);
  const fillet = clamp((cluster - 0.4) / 0.35, 0, 1);
  const scale = s.reduce ? 1 : (0.3 + 0.7 * pres) * cluster + (0.85 + 0.15 * pres) * alone;
  const squash = s.reduce ? 0 : clamp(s.squash, -0.14, 0.14) * (1 - alone * 0.6);
  let height = (26 * cluster + 30 * alone) * scale * (1 - squash);
  let width = Math.max(height, s.width * scale) * (1 + squash * 0.3);
  const pw = s.islandWidth * cluster + width * alone;
  const ph = (32 * cluster + height * alone) * (1 + s.gulp * 0.06 * cluster);
  const top = 32 - ph;
  const gap = (4 * fillet + s.stretch * 0.12) * pres;
  let bottom = 32 + (top - gap - 32) * rise;
  if (s.detached) bottom -= (1 - s.fade) * 4;
  if (s.dropping) bottom += (1 - s.fade) * 4;
  const beadTop = bottom - height;
  let b = Math.max(3, width / 2 - height * 0.32);
  const flat = Math.max(0, pw / 2 - ph / 2);
  let a = (b + (Math.min(b + 9, flat + 2) - b) * fillet) * Math.min(1, scale + 0.2);
  b = Math.min(b, a + 9);
  a += (Math.min(a, 6) - a) * s.pinch;
  b += (Math.min(b, 5) - b) * s.pinch;
  const py = top + capInset(pw, ph, a);
  const qy = bottom - capInset(width, height, b);
  const waist = Math.min(
    (Math.min(a, b) + fillet) * Math.sqrt(4 / Math.max(4, gap)) * (1 - s.pinch),
    Math.min(a, b) * 1.1,
  );
  const joined = cluster > 0.01 && fillet > 0.01 && qy < py - 0.5 && !s.detached && !s.dropping;
  let shell = cluster > 0.01 ? capsulePath(pw, ph) : "";
  let bead = "";
  if (s.detached) {
    width *= 1 + (1 - s.fade) * 0.12;
    height *= 1 + (1 - s.fade) * 0.12;
  }
  if (pres > 0.005) {
    if (joined) {
      // Follow the capsule's exposed perimeter, up the right concave flank,
      // around the bead, and back down the left. One fill and one outline.
      const pr = ph / 2;
      const pf = pw / 2 - pr;
      const br = height / 2;
      const bf = width / 2 - br;
      const k = Math.max(1, (py - qy) * 0.5);
      const c = (8 * waist - a - b) / 6;
      shell = `M${point(-a, py)}${a <= pf ? `L${point(-pf, top)}` : ""}A${pr} ${pr} 0 0 0 ${point(-pw / 2, top + pr)}A${pr} ${pr} 0 0 0 ${point(-pf, 32)}H${f(pf)}A${pr} ${pr} 0 0 0 ${point(pw / 2, top + pr)}A${pr} ${pr} 0 0 0 ${point(Math.max(a, pf), a <= pf ? top : py)}${a <= pf ? `L${point(a, py)}` : ""}C${point(c, py - k)} ${point(c, qy + k)} ${point(b, qy)}${b <= bf ? `L${point(bf, bottom)}` : ""}A${br} ${br} 0 0 0 ${point(width / 2, beadTop + br)}A${br} ${br} 0 0 0 ${point(bf, beadTop)}H${f(-bf)}A${br} ${br} 0 0 0 ${point(-width / 2, beadTop + br)}A${br} ${br} 0 0 0 ${point(-Math.max(b, bf), b <= bf ? bottom : qy)}${b <= bf ? `L${point(-b, qy)}` : ""}C${point(-c, qy + k)} ${point(-c, py - k)} ${point(-a, py)}Z`;
    } else {
      const tip = s.detached ? clamp(1 - (1 - s.fade) / (3.4 * 0.16), 0, 1) : 0;
      bead = capsulePath(width, height, bottom) + nubPath(qy, 1, tip);
      shell += nubPath(py, -1, tip);
      // Alone there is exactly one stadium — no ledge, neck or flare.
      if (cluster < 0.01) shell = "";
    }
  }
  return {
    shell,
    bead,
    width,
    height,
    top: bottom - height,
    joined,
    clusterOpacity: clamp(cluster * 2 - 1, 0, 1),
  };
}

/**
 * How far the bead rises above the island's 32px layout box, for the neighbour
 * that must stay clear of it (VC-1210). Layout only sees the box; the bead on
 * the rim is drawn above it, into the band the jump-to-latest button keeps.
 *
 * Arrival and departure only, never the wobble: a caption change kicks
 * `squash` and `stretch`, and a swallow kicks `gulp`, and following those would
 * bob the button and its transcript band a few pixels on every caption while
 * the reader is scrolled up. So the rise is taken from the resting bead at the
 * same presence and cluster. The one stretch kept is a pinching exit's syrup
 * thread, a departure that lifts the bead well past its rest. A wobble may
 * close a few pixels of the button's 12px band; it cannot close all of it.
 *
 * Below a quarter presence the rise eases to nothing, so the last of a
 * draining bead does not drop the button in one step; the band is wider than
 * the bead's rise at that presence, so the two still never meet.
 */
export function liquidIslandRise(s: LiquidGeometry, departing: boolean, hidden: boolean): number {
  if (hidden) return 0;
  const rest = liquidIslandGeometry({
    ...s,
    squash: 0,
    gulp: 0,
    stretch: departing ? s.stretch : 0,
  });
  return Math.max(0, -rest.top) * clamp(s.presence * 4, 0, 1);
}
