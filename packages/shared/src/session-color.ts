/**
 * Session colour: WHICH Session, never what state it is in (VC-239).
 *
 * Every other colour a Session wears in this app is a state — `ui/status-dot.tsx`
 * paints working, waiting, error — and one status map is the whole point of
 * that file. This is a different axis. When two Sessions drive two Browser
 * Tabs at once, a person has to be able to say "that cursor is the one I
 * asked to fix the form" without reading a label, and a state colour cannot
 * carry that: both Sessions are `working`.
 *
 * Defined here rather than derived from the live canvas, on purpose. A cursor
 * drawn over a web PAGE has no app canvas under it to harmonise with, and the
 * overlay that draws it is a main-process view that does not know which
 * workspace's canvas is on screen. Main and renderer have to agree on the
 * colour of one Session with nothing but its id in common, the way they agree
 * on {@link projectColor} with nothing but an index — so this is a fixed
 * palette, fanned once around the ember accent by {@link hueFan} so its eight
 * members read as one family at one weight. Legibility over a page comes from
 * the cursor's outline, not from the hue; the hue only has to say which.
 *
 * Keyed by a stable hash of the Session id, FNV-1a as {@link tagColor} uses,
 * so a Session has the same colour in every surface, launch after launch, with
 * nothing stored. Eight slots and a hash cannot promise two CONCURRENT Sessions
 * different colours, and the ticket requires it, so {@link pickSessionColor}
 * resolves each arrival against the colours already in use: its own slot or
 * the next free one. Assigning one at a time, as Sessions arrive, is the
 * host's stability guarantee — a Session keeps its colour for as long as it
 * holds, whoever comes or goes after it.
 */
import { PROJECT_COLORS } from "./project-identity";
import { hueFan } from "./theme/chart-color";
import { apcaLc } from "./theme/color";

/** The palette's anchor: the ember accent, the same hex the first project tile wears. */
const SESSION_COLOR_ANCHOR: string = PROJECT_COLORS[0];

/**
 * How many distinct Session colours there are. Eight is what a person can tell
 * apart at cursor size and what the parent-plus-children shape of VC-9 needs
 * with room to spare; sixteen would be a wheel of near-neighbours.
 */
export const SESSION_COLOR_COUNT = 8;

/**
 * Almost the whole wheel, so the eight slots sit 45° apart. Not a full 360:
 * an even count fanned symmetrically never lands ON the anchor, which is
 * deliberate — a Session in the exact accent would sit two pixels from the
 * accent-coloured selected-tab indicator, the collision `status-dot.tsx`
 * already ended once for state colours.
 */
const SESSION_COLOR_SPREAD_DEGREES = 315;

/**
 * The eight identity hues, in slot order. Order is data: {@link sessionColorSlot}
 * indexes into it, and a Session's colour is durable only while this order is.
 */
export const SESSION_COLORS: readonly string[] = hueFan(
  SESSION_COLOR_ANCHOR,
  SESSION_COLOR_COUNT,
  SESSION_COLOR_SPREAD_DEGREES,
);

/** FNV-1a over the id's code points, the hash {@link tagColor} settled on. */
function hashSessionId(sessionId: string): number {
  let hash = 2166136261;
  for (const ch of sessionId) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

/** The slot a Session's id hashes to, before any collision is resolved. */
export function sessionColorSlot(sessionId: string): number {
  return hashSessionId(sessionId) % SESSION_COLOR_COUNT;
}

/** One Session's colour in isolation — its hashed slot's hue. */
export function sessionColor(sessionId: string): string {
  return SESSION_COLORS[sessionColorSlot(sessionId)]!;
}

/**
 * The ink a label wears on a Session-coloured chip: whichever of black and
 * white APCA rates more legible on that hue. The palette sits at one mid
 * lightness where the answer differs by hue — white carries on blue and
 * violet, black on olive — so it is decided per colour rather than once.
 */
export function sessionColorInk(colorHex: string): "#000000" | "#ffffff" {
  return apcaLc("#000000", colorHex) >= apcaLc("#ffffff", colorHex) ? "#000000" : "#ffffff";
}

/**
 * One more Session's colour, given the colours already in use: its own slot
 * if free, else the next free slot round the wheel — the nearest neighbour
 * hue, so a collision costs the least identity — else its own slot again once
 * the wheel is full. Past eight live Sessions that is the palette's honest
 * limit, not something this function papers over.
 *
 * Incremental on purpose: a host assigns colours as Sessions ARRIVE and must
 * never revisit one it already handed out, and a batch re-resolution could
 * move a live Session's colour when an earlier one leaves. Every surface that
 * needs several — the lab, a test — folds this over its Sessions in order.
 */
export function pickSessionColor(sessionId: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const preferred = sessionColorSlot(sessionId);
  for (let step = 0; step < SESSION_COLOR_COUNT; step += 1) {
    const candidate = SESSION_COLORS[(preferred + step) % SESSION_COLOR_COUNT]!;
    if (!used.has(candidate)) return candidate;
  }
  return SESSION_COLORS[preferred]!;
}
