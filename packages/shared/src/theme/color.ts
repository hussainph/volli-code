/**
 * The color primitives the theme generator is built on, hand-rolled so
 * `@volli/shared` stays runtime-dependency-free (the package rule: pure,
 * unit-tested domain code with no imports at all). The tests cross-check this
 * math against `culori` and `apca-w3`, which are devDependencies of this
 * package only and are never imported by `src/*.ts`.
 */

/** Gamma-encoded sRGB, each channel 0–1. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Björn Ottosson's OKLab: perceptual lightness plus two opponent axes. */
export interface Oklab {
  L: number;
  a: number;
  b: number;
}

/**
 * OKLab in polar form — the space the whole generator thinks in, because it
 * lets hue, chroma and lightness be varied one at a time without dragging the
 * other two along. `h` is degrees in [0, 360).
 */
export interface Oklch {
  L: number;
  C: number;
  h: number;
}

/**
 * The two scalar helpers every module downstream of this one needs, here rather
 * than re-declared in each.
 *
 * They were private three times over — in the generator, in the canvas model and
 * again in the canvas token derivation — which is three chances for one of them
 * to acquire a subtly different edge case. There is nothing to argue about in
 * either, so there is nothing to gain from a second copy.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Linear interpolation from `from` to `to`. `t` is not clamped — callers that need that do it. */
export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

const HEX_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Whether `value` is `#rgb` or `#rrggbb`, with or without a leading `#` — same acceptance as {@link hexToRgb}. */
export function isHexColor(value: string): boolean {
  return HEX_PATTERN.test(value.trim());
}

/** Parses `#rgb` or `#rrggbb` (with or without `#`) into 0–1 sRGB channels. */
export function hexToRgb(hex: string): Rgb {
  const match = HEX_PATTERN.exec(hex.trim());
  if (!match) {
    throw new Error(`Invalid hex color ${JSON.stringify(hex)} — expected #rgb or #rrggbb.`);
  }
  const digits = match[1]!;
  const full = digits.length === 3 ? digits.replace(/./g, (digit) => digit + digit) : digits;
  return {
    r: parseInt(full.slice(0, 2), 16) / 255,
    g: parseInt(full.slice(2, 4), 16) / 255,
    b: parseInt(full.slice(4, 6), 16) / 255,
  };
}

function channelToHex(value: number): string {
  const byte = Math.round(Math.min(1, Math.max(0, value)) * 255);
  return byte.toString(16).padStart(2, "0");
}

/**
 * Emits lowercase `#rrggbb`. Channels are clamped to 0–1 first, which only
 * ever absorbs float dust — real out-of-gamut colors must be handled by
 * {@link gamutMap}, because clipping shifts hue and lightness.
 */
export function rgbToHex({ r, g, b }: Rgb): string {
  return `#${channelToHex(r)}${channelToHex(g)}${channelToHex(b)}`;
}

/**
 * The three 8-bit channels of a hex color, 0–255 — the unit the compositor
 * actually works in.
 *
 * Everything that has to predict a *pixel* rather than a perception needs these:
 * the veil solve, the canvas's lift overlays, every `rgb(R G B / a)` this app
 * emits. Built on {@link hexToRgb} so there is one hex parser rather than one
 * per caller — the three hand-rolled `slice`/`parseInt` copies this replaces all
 * returned `NaN` on a malformed input, where this throws like the rest of the
 * module.
 */
export function hexChannels(hex: string): [number, number, number] {
  const { r, g, b } = hexToRgb(hex);
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/**
 * `over` at `alpha` composited on `under`, as a hex.
 *
 * In 8-bit sRGB rather than OKLCH for the same reason `veil.ts` solves there:
 * what has to match is the byte the compositor produces, and the compositor
 * works in gamma-encoded channels. A perceptual mix would predict a pixel the
 * browser never paints, and every measurement taken against it — every ink
 * score, every reported Lc — would be measuring a surface that isn't on screen.
 */
export function compositeHex(over: string, alpha: number, under: string): string {
  const top = hexChannels(over);
  const bottom = hexChannels(under);
  const bytes = top.map((value, index) =>
    clamp(Math.round(value * alpha + bottom[index] * (1 - alpha)), 0, 255)
      .toString(16)
      .padStart(2, "0"),
  );
  return `#${bytes.join("")}`;
}

/**
 * sRGB → linear-light, sign-preserving. The sign handling matters: gamut
 * mapping evaluates colors that fall *outside* sRGB, where channels go
 * negative, and a naive `Math.pow` there yields NaN and silently poisons the
 * binary search.
 */
export function srgbToLinear(channel: number): number {
  const magnitude = Math.abs(channel);
  const linear = magnitude <= 0.04045 ? magnitude / 12.92 : ((magnitude + 0.055) / 1.055) ** 2.4;
  return Math.sign(channel) * linear;
}

/** Linear-light → sRGB, the exact inverse of {@link srgbToLinear}. */
export function linearToSrgb(channel: number): number {
  const magnitude = Math.abs(channel);
  const encoded =
    magnitude <= 0.0031308 ? magnitude * 12.92 : 1.055 * magnitude ** (1 / 2.4) - 0.055;
  return Math.sign(channel) * encoded;
}

/**
 * Linear-light sRGB → OKLab (Ottosson's published sRGB-specialized matrices,
 * with the LMS cube root taken sign-preserving so out-of-gamut colors stay
 * representable instead of becoming NaN).
 */
export function linearRgbToOklab({ r, g, b }: Rgb): Oklab {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const lRoot = Math.cbrt(l);
  const mRoot = Math.cbrt(m);
  const sRoot = Math.cbrt(s);

  return {
    L: 0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot,
    a: 1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot,
    b: 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot,
  };
}

/** OKLab → linear-light sRGB. Channels may fall outside 0–1 (out of gamut). */
export function oklabToLinearRgb({ L, a, b }: Oklab): Rgb {
  const lRoot = L + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = L - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = L - 0.0894841775 * a - 1.291485548 * b;

  const l = lRoot * lRoot * lRoot;
  const m = mRoot * mRoot * mRoot;
  const s = sRoot * sRoot * sRoot;

  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

/** OKLab → OKLCH. Hue is normalized to [0, 360). */
export function oklabToOklch({ L, a, b }: Oklab): Oklch {
  const C = Math.sqrt(a * a + b * b);
  const h = C < 1e-9 ? 0 : ((((Math.atan2(b, a) * 180) / Math.PI) % 360) + 360) % 360;
  return { L, C, h };
}

/** OKLCH → OKLab. */
export function oklchToOklab({ L, C, h }: Oklch): Oklab {
  const radians = (h * Math.PI) / 180;
  return { L, a: C * Math.cos(radians), b: C * Math.sin(radians) };
}

/** Parses a hex color straight into the space the generator works in. */
export function hexToOklch(hex: string): Oklch {
  const { r, g, b } = hexToRgb(hex);
  return oklabToOklch(
    linearRgbToOklab({
      r: srgbToLinear(r),
      g: srgbToLinear(g),
      b: srgbToLinear(b),
    }),
  );
}

/** OKLCH → gamma-encoded sRGB. Channels may fall outside 0–1. */
function oklchToRgb({ L, C, h }: Oklch): Rgb {
  const { r, g, b } = oklabToLinearRgb(oklchToOklab({ L, C, h }));
  return { r: linearToSrgb(r), g: linearToSrgb(g), b: linearToSrgb(b) };
}

/**
 * Tolerance for the in-gamut test, in gamma-encoded channel units — 2.5e-3 of
 * one 8-bit step, so it can never change a rendered color. It exists so a
 * color parsed straight back out of a hex string still counts as in-gamut
 * despite float dust, which makes {@link gamutMap} an exact no-op on colors
 * that were already representable. Sized off the measured worst case: the
 * hex → OKLCH → sRGB round trip overshoots by up to 1.3e-6 across the full
 * 8-bit cube.
 */
const GAMUT_EPSILON = 1e-5;

/** Whether `oklch(L C h)` is representable in sRGB. */
export function isInGamut(L: number, C: number, h: number): boolean {
  const { r, g, b } = oklchToRgb({ L, C, h });
  return [r, g, b].every((channel) => channel >= -GAMUT_EPSILON && channel <= 1 + GAMUT_EPSILON);
}

/**
 * Brings a color into sRGB by binary-searching chroma downward at **constant
 * L and h**.
 *
 * The alternative — clipping the RGB channels — is what makes naive
 * generators produce themes that drift: clipping moves hue *and* lightness,
 * so a ladder built on fixed lightness constants silently stops having fixed
 * lightness at saturated hues, and the contrast floors the whole design rests
 * on stop meaning anything. Giving up chroma is the only lossy axis we can
 * afford.
 *
 * Returns the input unchanged when it is already representable.
 */
export function gamutMap(L: number, C: number, h: number): Oklch {
  if (isInGamut(L, C, h)) return { L, C, h };

  let low = 0;
  let high = C;
  // 1e-5 chroma is well below one 8-bit step; 30 halvings of any plausible
  // chroma reach it with room to spare, and the fixed count keeps this
  // trivially terminating.
  for (let i = 0; i < 30 && high - low > 1e-5; i += 1) {
    const mid = (low + high) / 2;
    if (isInGamut(L, mid, h)) low = mid;
    else high = mid;
  }
  return { L, C: low, h };
}

/** OKLCH → `#rrggbb`, gamut-mapped so the result is always representable. */
export function oklchToHex(L: number, C: number, h: number): string {
  return rgbToHex(oklchToRgb(gamutMap(L, C, h)));
}

/*
 * APCA-W3 0.1.9 constants (the W3C-licensed `sRGBcalc` formulation). These are
 * a published, versioned magic-number set — they are not tunable, and the
 * tests pin every one of them against `apca-w3` itself.
 */
const APCA_TRC = 2.4;
const APCA_R_COEFFICIENT = 0.2126729;
const APCA_G_COEFFICIENT = 0.7151522;
const APCA_B_COEFFICIENT = 0.072175;
const APCA_BLACK_THRESHOLD = 0.022;
// Not Math.SQRT2: this is APCA's own published black-clamp exponent, which
// merely lands near √2. Substituting the "real" constant would silently
// change every Lc this module reports.
// oxlint-disable-next-line approx-constant
const APCA_BLACK_CLAMP = 1.414;
const APCA_NORM_BG = 0.56;
const APCA_NORM_TEXT = 0.57;
const APCA_REVERSE_TEXT = 0.62;
const APCA_REVERSE_BG = 0.65;
const APCA_SCALE = 1.14;
const APCA_LOW_OFFSET = 0.027;
const APCA_LOW_CLIP = 0.1;
const APCA_DELTA_Y_MIN = 0.0005;

/**
 * APCA's screen luminance Y — deliberately *not* the sRGB linearization above:
 * APCA uses a plain 2.4 exponent with no linear toe, because it models a
 * display's actual response rather than the sRGB encoding spec.
 */
function apcaY(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return (
    APCA_R_COEFFICIENT * r ** APCA_TRC +
    APCA_G_COEFFICIENT * g ** APCA_TRC +
    APCA_B_COEFFICIENT * b ** APCA_TRC
  );
}

function softClampBlack(y: number): number {
  return y > APCA_BLACK_THRESHOLD ? y : y + (APCA_BLACK_THRESHOLD - y) ** APCA_BLACK_CLAMP;
}

/**
 * APCA lightness contrast (Lc) of `textHex` drawn on `backgroundHex`, returned
 * as a **magnitude**. APCA itself signs the result to carry polarity — light
 * text on dark comes back negative — but every floor in this design ("Lc ≥
 * 90", "Lc ≥ 60") is stated as a magnitude, and a generator that has to
 * remember which comparisons are reversed is a generator that will eventually
 * forget. Polarity is never in question here: the ladder decides it.
 *
 * WCAG 2's contrast ratio is deliberately not used. It is a ratio of relative
 * luminances that badly misjudges dark themes — it rates near-black pairs as
 * far more distinguishable than they look — and this whole design is a dark
 * theme with a near-black ladder.
 */
export function apcaLc(textHex: string, backgroundHex: string): number {
  const textY = softClampBlack(apcaY(textHex));
  const backgroundY = softClampBlack(apcaY(backgroundHex));

  if (Math.abs(backgroundY - textY) < APCA_DELTA_Y_MIN) return 0;

  if (backgroundY > textY) {
    // Dark text on a light background.
    const raw = (backgroundY ** APCA_NORM_BG - textY ** APCA_NORM_TEXT) * APCA_SCALE;
    return raw < APCA_LOW_CLIP ? 0 : (raw - APCA_LOW_OFFSET) * 100;
  }

  // Light text on a dark background — the polarity this app always runs in.
  const raw = (backgroundY ** APCA_REVERSE_BG - textY ** APCA_REVERSE_TEXT) * APCA_SCALE;
  return raw > -APCA_LOW_CLIP ? 0 : -(raw + APCA_LOW_OFFSET) * 100;
}
