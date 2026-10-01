/**
 * Pure workspace identity model, promoted from the VC-489 identity atelier.
 * Choices are captured once by the caller; this module has no clock, random
 * source, name-to-choice state, network, or persistence. A stamp's stable seed
 * may be allocated before a project exists and must survive renames unchanged.
 */

/** One curated glyph: the exact Phosphor name, a human label, and the
 * lowercase words that should semantically select it. */
export interface GlyphCatalogEntry {
  /** Phosphor icon name, spelled exactly as `GLYPH_COMPONENTS` keys it. */
  readonly name: string;
  /** Human label for pickers and menus. */
  readonly label: string;
  /** Lowercase words; a project-name token matching one is a semantic hit. */
  readonly keywords: readonly string[];
}

/**
 * The whole bounded glyph universe. A glyph choice may name NOTHING outside
 * these 24 names — unknown names fall back to initials, never to a guess.
 * The names stay plain strings here; `marks.tsx` maps them to components.
 */
export const GLYPH_CATALOG = [
  {
    name: "code",
    label: "Code",
    keywords: [
      "code",
      "dev",
      "script",
      "terminal",
      "developer",
      "software",
      "engineering",
      "program",
    ],
  },
  {
    name: "tree",
    label: "Tree",
    keywords: ["tree", "canopy", "forest", "grove", "woods", "park", "trunk"],
  },
  {
    name: "leaf",
    label: "Leaf",
    keywords: ["leaf", "plant", "garden", "seed", "sprout", "herb", "botanical"],
  },
  {
    name: "mountains",
    label: "Mountains",
    keywords: ["mountain", "peak", "summit", "alpine", "ridge", "cliff", "hill", "valley"],
  },
  {
    name: "flame",
    label: "Flame",
    keywords: ["flame", "fire", "cinder", "ember", "forge", "heat", "blaze", "torch"],
  },
  {
    name: "sparkle",
    label: "Sparkle",
    keywords: ["sparkle", "magic", "star", "shine", "glitter", "shimmer", "spark", "twinkle"],
  },
  {
    name: "planet",
    label: "Planet",
    keywords: ["planet", "world", "earth", "globe", "orbit", "cosmos", "saturn", "mars"],
  },
  {
    name: "moon",
    label: "Moon",
    keywords: ["moon", "lunar", "night", "crescent", "eclipse", "moonlight", "dusk"],
  },
  {
    name: "rocket",
    label: "Rocket",
    keywords: ["rocket", "launch", "space", "shuttle", "thrust", "boost", "spacecraft", "moonshot"],
  },
  {
    name: "paper-plane",
    label: "Paper Plane",
    keywords: ["paper", "plane", "send", "message", "letter", "post", "airmail", "fly"],
  },
  {
    name: "scroll",
    label: "Scroll",
    keywords: ["scroll", "paper", "trail", "log", "journal", "note", "record", "parchment"],
  },
  {
    name: "book-open",
    label: "Book Open",
    keywords: ["book", "read", "reading", "library", "chapter", "story", "manual", "docs"],
  },
  {
    name: "archive",
    label: "Archive",
    keywords: ["archive", "storage", "vault", "backup", "history", "attic", "crate"],
  },
  {
    name: "package",
    label: "Package",
    keywords: ["package", "parcel", "box", "bundle", "carton", "shipment", "cargo"],
  },
  {
    name: "git-branch",
    label: "Git Branch",
    keywords: ["branch", "merge", "fork", "commit", "revision", "version", "workflow", "git"],
  },
  {
    name: "circuitry",
    label: "Circuitry",
    keywords: [
      "circuit",
      "circuitry",
      "chip",
      "hardware",
      "board",
      "electronics",
      "silicon",
      "robot",
    ],
  },
  {
    name: "atom",
    label: "Atom",
    keywords: ["atom", "science", "physics", "particle", "quantum", "lab", "nucleus", "research"],
  },
  {
    name: "music-notes",
    label: "Music Notes",
    keywords: ["music", "song", "audio", "sound", "melody", "tune", "rhythm", "band"],
  },
  {
    name: "waves",
    label: "Waves",
    keywords: ["wave", "ocean", "sea", "tide", "surf", "ripple", "water", "harbor"],
  },
  {
    name: "coffee",
    label: "Coffee",
    keywords: ["coffee", "cafe", "espresso", "brew", "caffeine", "roast", "mug", "latte"],
  },
  {
    name: "bird",
    label: "Bird",
    keywords: ["bird", "sparrow", "wren", "robin", "raven", "feather", "nest", "flight"],
  },
  {
    name: "flower",
    label: "Flower",
    keywords: ["flower", "bloom", "blossom", "petal", "rose", "tulip", "floral", "daisy"],
  },
  {
    name: "compass",
    label: "Compass",
    keywords: [
      "compass",
      "navigate",
      "navigation",
      "direction",
      "explore",
      "expedition",
      "journey",
      "waypoint",
    ],
  },
  {
    name: "diamond",
    label: "Diamond",
    keywords: ["diamond", "gem", "jewel", "crystal", "gemstone", "prism", "carbon", "facet"],
  },
] as const satisfies readonly GlyphCatalogEntry[];

/** Every name a `glyph` choice may legally carry, derived from the catalog. */
export type GlyphName = (typeof GLYPH_CATALOG)[number]["name"];

/**
 * A workspace's identity, captured at selection time as a plain value.
 * Shape-compatible with `StudioChoice` in `./marks`: same kind strings, same
 * field names, so a choice made here renders there unchanged.
 */
export type IdentityChoice =
  | { kind: "glyph"; name: GlyphName }
  | { kind: "initials" }
  | { kind: "stamp"; seed: string; variant: number }
  | { kind: "custom"; dataUrl: string };

/** One side of the square stamp; a grid is always this many cells across. */
const STAMP_SIZE = 5;

/** Roughly half of the decidable cells fill, so a stamp reads as a mark. */
const STAMP_FILL = 0.5;

/** A stamp: 5 rows of 5 cells, row-major, left half mirrored onto the right. */
export type StampGrid = readonly (readonly boolean[])[];

const GLYPH_CODES: ReadonlySet<string> = new Set(GLYPH_CATALOG.map((entry) => entry.name));

/** Whether `value` is exactly one of the curated catalog codes. This is the
 * validation door a future classifier's output must pass through. */
export function isGlyphName(value: string): value is GlyphName {
  return GLYPH_CODES.has(value);
}

/**
 * Builds a glyph choice from an untrusted name: exact catalog codes become
 * glyph choices, everything else — casing, whitespace, plurals, near misses —
 * falls back to the safe initials choice rather than to a guess.
 */
export function glyphChoice(name: string): IdentityChoice {
  return isGlyphName(name) ? { kind: "glyph", name } : { kind: "initials" };
}

/**
 * Lowercase, keep letters and digits, and fold a trailing plural `s` so the
 * name token "mountains" meets the keyword "mountain". Applied to BOTH name
 * tokens and catalog keywords so the fold stays consistent — "compass" on
 * either side folds to "compas" and still matches.
 */
function normalizeWord(word: string): string {
  const folded = word.toLowerCase().replace(/[^a-z0-9]/g, "");
  return folded.length > 3 && folded.endsWith("s") ? folded.slice(0, -1) : folded;
}

/** Project name → comparable tokens ("Paper Trail!" → ["paper", "trail"]). */
function nameTokens(projectName: string): readonly string[] {
  return projectName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(normalizeWord)
    .filter((token) => token.length > 0);
}

/** Catalog keywords, normalized once at module load; immutable after that. */
const GLYPH_MATCHERS: readonly { name: GlyphName; keywords: readonly string[] }[] =
  GLYPH_CATALOG.map((entry) => ({
    name: entry.name,
    keywords: entry.keywords.map(normalizeWord),
  }));

/**
 * Three unique, deterministic glyph suggestions for a project name.
 *
 * Ranking, in order: semantic hits first (more matched name tokens wins),
 * then UNUSED glyphs ahead of taken ones, then catalog order. So relevance
 * always leads, a taken glyph is de-prioritized only within its relevance —
 * a used semantic match still outranks unrelated filler and is never pushed
 * out of the suggestions entirely — and ties break by catalog order.
 *
 * An empty or unknown name has no semantic hits, so it falls back to the
 * head of the catalog minus what is already used — the same deterministic
 * trio for every such name. Always exactly three; the catalog is 24 deep.
 *
 * The array is fresh and mutable on every call: callers may keep or reshape
 * their copy without touching this module or each other.
 */
export function suggestGlyphs(
  projectName: string,
  usedGlyphs: readonly GlyphName[] = [],
): GlyphName[] {
  const used = new Set<string>(usedGlyphs);
  const tokens = nameTokens(projectName);
  const ranked = GLYPH_MATCHERS.map((entry, index) => ({
    name: entry.name,
    order: index,
    hits: tokens.filter((token) => entry.keywords.includes(token)).length,
    used: used.has(entry.name),
  }));
  ranked.sort((a, b) => b.hits - a.hits || Number(a.used) - Number(b.used) || a.order - b.order);
  return ranked.slice(0, 3).map((candidate) => candidate.name);
}

/**
 * The suggested identity for a workspace whose name is known right now: the
 * first glyph suggestion as a glyph choice, or initials if suggestions were
 * somehow empty (the catalog always yields three; the initials branch is the
 * safety net that keeps the return type total). The caller stores the result
 * — this function holds nothing.
 */
export function chooseSuggestedIdentity(
  projectName: string,
  usedGlyphs: readonly GlyphName[] = [],
): IdentityChoice {
  const [first] = suggestGlyphs(projectName, usedGlyphs);
  // The catalog is fixed and always yields three suggestions.
  return { kind: "glyph", name: first! };
}

/** FNV-1a over the seed string — tiny, stable across engines, no deps. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32 — 32 bits of well-mixed determinism from one word of state. */
function mulberry32(state: number): () => number {
  let a = state >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

/**
 * The procedural stamp for a seed and variant: a deterministic 5×5 boolean
 * grid whose left half mirrors onto the right, always with at least one
 * filled cell.
 *
 * The seed must be the workspace's STABLE id, never its name — a rename must
 * not redraw the mark, and only the caller knows the id, so only the caller
 * can keep that promise. Different variants of one seed give different marks
 * without changing the identity underneath. Same inputs, same grid, forever.
 */
export function proceduralStamp(seed: string, variant = 0): StampGrid {
  const next = mulberry32(fnv1a(`${seed}\u0000${variant}`));
  const rows: boolean[][] = [];
  for (let row = 0; row < STAMP_SIZE; row += 1) {
    const leading = next() < STAMP_FILL;
    const inner = next() < STAMP_FILL;
    const center = next() < STAMP_FILL;
    rows.push([leading, inner, center, inner, leading]);
  }
  // The mirror can land on an empty grid for roughly 1 in 2^15 seeds; the
  // center cell guarantees the mark is never blank.
  if (!rows.some((row) => row.some((filled) => filled))) {
    rows[2]![2] = true;
  }
  return rows;
}

/** The material and monogram vocabulary shared by storage and rendering. */
export type StudioSurface = "etched" | "porcelain" | "orbit" | "letterpress";
export type MonogramStyle = "editorial" | "architect" | "woven";

/** Authored at creation, independent of the workspace's name and canvas. */
export interface WorkspaceIdentity {
  choice: IdentityChoice;
  surface: StudioSurface;
  monogramStyle: MonogramStyle;
}

const MAX_RASTER_BYTES = 2 * 1024 * 1024;
const MAX_RASTER_BASE64_LENGTH = Math.ceil(MAX_RASTER_BYTES / 3) * 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strict, bounded base64 raster URL; no remote URL, SVG, or permissive decoder. */
function isRasterDataUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const prefixes = ["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,"];
  const prefix = prefixes.find((candidate) => value.startsWith(candidate));
  if (prefix === undefined) return false;
  const length = value.length - prefix.length;
  if (length === 0 || length > MAX_RASTER_BASE64_LENGTH || length % 4 !== 0) return false;
  const payload = value.slice(prefix.length);
  if (!/^[A-Za-z0-9+/]*={0,2}(?![\s\S])/.test(payload)) return false;
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return (length / 4) * 3 - padding <= MAX_RASTER_BYTES;
}

/**
 * The IPC/storage trust boundary. Bad or future payloads degrade to null;
 * accepted values are rebuilt field by field, never kept by reference.
 */
export function parseWorkspaceIdentity(value: unknown): WorkspaceIdentity | null {
  if (!isRecord(value)) return null;
  const { surface, monogramStyle, choice } = value;
  if (
    surface !== "etched" &&
    surface !== "porcelain" &&
    surface !== "orbit" &&
    surface !== "letterpress"
  )
    return null;
  if (monogramStyle !== "editorial" && monogramStyle !== "architect" && monogramStyle !== "woven")
    return null;
  if (!isRecord(choice)) return null;
  let safeChoice: IdentityChoice;
  switch (choice.kind) {
    case "initials":
      safeChoice = { kind: "initials" };
      break;
    case "glyph":
      if (typeof choice.name !== "string" || !isGlyphName(choice.name)) return null;
      safeChoice = { kind: "glyph", name: choice.name };
      break;
    case "stamp":
      if (
        typeof choice.seed !== "string" ||
        choice.seed.length > 128 ||
        choice.seed.trim().length === 0
      )
        return null;
      if (
        typeof choice.variant !== "number" ||
        !Number.isSafeInteger(choice.variant) ||
        choice.variant < 0 ||
        choice.variant > 1_000_000
      )
        return null;
      safeChoice = { kind: "stamp", seed: choice.seed, variant: choice.variant };
      break;
    case "custom":
      if (!isRasterDataUrl(choice.dataUrl)) return null;
      safeChoice = { kind: "custom", dataUrl: choice.dataUrl };
      break;
    default:
      return null;
  }
  return { choice: safeChoice, surface, monogramStyle };
}
