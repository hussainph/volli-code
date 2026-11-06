/** Optional full-tier optics, sampled from native clear-glass hue ramps.
 * Pane material is CSS-only. Full material caches one device-resolution RG
 * displacement map per geometry; only mount/resize can acquire one, never
 * scroll, pointer movement or a streamed transcript update.
 */
type Curve = readonly [number, readonly (readonly [number, number])[]];
const CURVES: readonly Curve[] = [
  [
    6,
    [
      [0.5, 0.87],
      [1, 0.13],
      [2, 0.01],
      [3, 0],
    ],
  ],
  [
    20,
    [
      [0.5, 7.24],
      [1, 5.65],
      [2, 3.34],
      [3, 2.11],
      [4, 1.11],
      [6, 0.21],
      [8, 0],
      [10, 0],
    ],
  ],
  [
    24,
    [
      [0.5, 9.28],
      [1, 7.69],
      [2, 5.37],
      [3, 3.5],
      [4, 2.28],
      [6, 0.72],
      [8, 0.25],
      [12, 0],
    ],
  ],
  [
    40,
    [
      [0.5, 17.87],
      [1, 15.4],
      [2, 12],
      [3, 9.68],
      [4, 7.59],
      [6, 4.5],
      [8, 2.5],
      [12, 0.46],
      [16, 0],
      [20, 0],
    ],
  ],
  [
    44,
    [
      [0.5, 20.16],
      [1, 17.47],
      [2, 14.06],
      [3, 11.35],
      [4, 9.22],
      [6, 5.69],
      [8, 3.47],
      [12, 0.78],
      [16, 0],
      [22, 0],
    ],
  ],
  [
    70,
    [
      [0.5, 33.21],
      [1, 29.65],
      [2, 24.71],
      [3, 20.87],
      [4, 17.44],
      [6, 12.4],
      [8, 8.65],
      [12, 3.34],
      [16, 0.86],
      [20, 0],
      [35, 0],
    ],
  ],
  [
    100,
    [
      [0.5, 43.67],
      [1, 39.02],
      [2, 32.11],
      [3, 27.17],
      [4, 22.89],
      [6, 16.29],
      [8, 11.45],
      [12, 4.82],
      [16, 1.04],
      [20, 0],
      [50, 0],
    ],
  ],
];
// All curves have an exactly neutral interior after their final nonzero
// segment. Trailing zero samples do not extend the lens's influence.
const MAX_LENS_DEPTH =
  Math.max(
    ...CURVES.map(([, curve]) => {
      let end = curve.length - 1;
      while (end > 0 && curve[end - 1][1] === 0) end--;
      return curve[end][0];
    }),
  ) + 0.25;
const NS = "http://www.w3.org/2000/svg";
interface Lens {
  id: string;
  filter: SVGElement;
  users: number;
}
interface Cache {
  defs: SVGElement;
  maps: Map<string, Lens>;
  serial: number;
}
const caches = new WeakMap<Document, Cache>();
function interpolate(curve: Curve[1], distance: number): number {
  if (distance <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    if (distance <= curve[i][0]) {
      const [x, a] = curve[i - 1],
        [y, b] = curve[i];
      return a + ((b - a) * (distance - x)) / (y - x);
    }
  }
  return 0;
}
function bend(size: number, distance: number): number {
  const d = distance - 0.25;
  let i = CURVES.findIndex(([s]) => s >= size);
  if (i < 0) i = CURVES.length - 1;
  if (!i) return interpolate(CURVES[0][1], d) * Math.min(1, size / 6);
  const [a, A] = CURVES[i - 1],
    [b, B] = CURVES[i];
  const t = Math.min(1, (size - a) / (b - a));
  return interpolate(A, d) * (1 - t) + interpolate(B, d) * t;
}
function svg(doc: Document, name: string, attrs: Record<string, string | number>): SVGElement {
  const node = doc.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}
function acquire(
  el: HTMLElement,
  w: number,
  h: number,
  radius: number,
  dpr: number,
): { key: string; release(): void } | null {
  const doc = el.ownerDocument;
  // Large reading surfaces stay pane-tier; bound per-overlay map memory/work.
  if (!w || !h || w * h > 350_000 || w > 800 || h > 800) return null;
  const r = Math.min(radius, w / 2, h / 2);
  const scale = Math.max(8, Math.ceil((bend(Math.min(w, h), 0) * 2) / 8) * 8);
  const key = [w, h, r, dpr, scale].join("-");
  let cache = caches.get(doc);
  if (!cache) {
    const root = svg(doc, "svg", {
      width: 0,
      height: 0,
      "aria-hidden": "true",
      "data-glass-optics": "",
      style: "position:absolute;pointer-events:none",
    });
    const defs = svg(doc, "defs", {});
    root.append(defs);
    doc.body.append(root);
    cache = { defs, maps: new Map(), serial: 0 };
    caches.set(doc, cache);
  }
  let lens = cache.maps.get(key);
  if (!lens) {
    const canvas = doc.createElement("canvas");
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const image = ctx.createImageData(canvas.width, canvas.height);
    image.data.fill(128);
    for (let alpha = 3; alpha < image.data.length; alpha += 4) image.data[alpha] = 255;
    // The rounded-rectangle signed distance is beyond every curve's support
    // inside this inset. Those pixels are EXACTLY neutral, not an approximation.
    // Keep device resolution and the shipped interpolation/map bytes unchanged.
    const edge = Math.ceil(Math.max(r, MAX_LENS_DEPTH) * dpr);
    for (let py = 0; py < canvas.height; py++)
      for (let px = 0; px < canvas.width; px++) {
        if (py >= edge && py < canvas.height - edge && px === edge && px < canvas.width - edge)
          px = canvas.width - edge;
        const x = (px + 0.5) / dpr - w / 2,
          y = (py + 0.5) / dpr - h / 2;
        const qx = Math.abs(x) - (w / 2 - r),
          qy = Math.abs(y) - (h / 2 - r);
        const ax = Math.max(qx, 0),
          ay = Math.max(qy, 0),
          len = Math.hypot(ax, ay);
        const sd = len + Math.min(Math.max(qx, qy), 0) - r;
        let nx = 0,
          ny = 0;
        if (len) {
          nx = (-Math.sign(x) * ax) / len;
          ny = (-Math.sign(y) * ay) / len;
        } else if (qx > qy) nx = -Math.sign(x);
        else ny = -Math.sign(y);
        const amount = sd < 0 ? bend(Math.min(w, h), -sd) : 0,
          index = (py * canvas.width + px) * 4;
        image.data[index] = 128 + (nx * amount * 256) / scale;
        image.data[index + 1] = 128 + (ny * amount * 256) / scale;
        image.data[index + 2] = 128;
        image.data[index + 3] = 255;
      }
    ctx.putImageData(image, 0, 0);
    const id = `volli-glass-optic-${cache.serial++}`;
    const filter = svg(doc, "filter", {
      id,
      x: 0,
      y: 0,
      width: w,
      height: h,
      filterUnits: "userSpaceOnUse",
      primitiveUnits: "userSpaceOnUse",
      "color-interpolation-filters": "sRGB",
    });
    filter.append(
      svg(doc, "feImage", {
        href: canvas.toDataURL(),
        x: 0,
        y: 0,
        width: w,
        height: h,
        preserveAspectRatio: "none",
        result: "raw-map",
      }),
    );
    filter.append(
      svg(doc, "feColorMatrix", {
        in: "raw-map",
        type: "matrix",
        values: ".99609375 0 0 0 0  0 .99609375 0 0 0  0 0 1 0 0  0 0 0 1 0",
        result: "map",
      }),
    );
    filter.append(
      svg(doc, "feDisplacementMap", {
        in: "SourceGraphic",
        in2: "map",
        scale,
        xChannelSelector: "R",
        yChannelSelector: "G",
      }),
    );
    cache.defs.append(filter);
    lens = { id, filter, users: 0 };
    cache.maps.set(key, lens);
  }
  lens.users++;
  el.style.setProperty("--glass-refraction", `url(#${lens.id})`);
  return {
    key,
    release() {
      lens.users--;
      // Cache at most 16 unused geometries. A visible overlay's filter is never
      // evicted by another overlay opening or changing its geometry.
      const unused = [...cache.maps].filter(([, entry]) => entry.users === 0);
      for (const [oldKey, old] of unused.slice(0, Math.max(0, unused.length - 16))) {
        old.filter.remove();
        cache.maps.delete(oldKey);
      }
    },
  };
}

/** Called by GlassSurface's full-tier ref; returns its exact observer cleanup. */
export function attachGlassOptics(el: HTMLElement): () => void {
  const view = el.ownerDocument.defaultView;
  if (
    !view ||
    view.matchMedia?.("(prefers-reduced-transparency: reduce), (prefers-contrast: more)").matches ||
    el.parentElement?.closest(".glass,.material-floating")
  )
    return () => {};
  let current: ReturnType<typeof acquire> = null;
  let geometry = "";
  let stopped = false;
  const update = (entries?: readonly ResizeObserverEntry[]) => {
    if (stopped) return;
    const box = entries?.[0]?.borderBoxSize?.[0];
    // Preserve offsetWidth's integer geometry/cache keys without forcing layout
    // from a commit ref. ResizeObserver delivers this before the first paint,
    // after Floating UI and focus have finished writing their initial geometry.
    const w = box ? Math.round(box.inlineSize) : el.offsetWidth;
    const h = box ? Math.round(box.blockSize) : el.offsetHeight;
    const radius = parseFloat(view.getComputedStyle(el).borderRadius) || 0;
    const dpr = Math.min(2, view.devicePixelRatio || 1);
    const next = [w, h, radius, dpr].join("-");
    if (next === geometry) return;
    geometry = next;
    current?.release();
    current = acquire(el, w, h, radius, dpr);
    if (!current) el.style.removeProperty("--glass-refraction");
  };
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
  if (observer) observer.observe(el, { box: "border-box" });
  else update();
  return () => {
    stopped = true;
    observer?.disconnect();
    current?.release();
    el.style.removeProperty("--glass-refraction");
  };
}
