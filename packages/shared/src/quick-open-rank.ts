/**
 * Quick-open's ranking (⌘P) — the second answer to "which file did they mean?"
 * (VC-299, audit finding A13).
 *
 * ⌘P used to borrow the `@` picker's `scoreFileMatch`, and inherited the one
 * thing that picker deliberately does: a **+1000 artifact bonus** that dominates
 * every match term. Typing `README` therefore offered
 * `.volli/artifacts/design-audit/audit-motion-perf.md` (1030) above the root
 * `README.md` (46) — a scattered path match beating an exact name.
 *
 * The two surfaces are not asking the same question, which is why there are now
 * two functions instead of one tuned compromise:
 *
 *  - **`@`** WRITES A REF into a message. Artifacts are force-included context
 *    (decision #3), so grouping them first is the point — `scoreFileMatch` is
 *    unchanged and still the picker's.
 *  - **⌘P** OPENS A FILE the person is already thinking of by name. Nothing
 *    about the file's category can outrank how well its NAME matches what they
 *    typed.
 *
 * So the score here is not a sum of bonuses at all — a single number is exactly
 * how a category bonus swallowed a name match. It is a TIER, and the shape of
 * the file may only settle a tie inside one:
 *
 *   1. `exact-path`        — the whole relPath, typed out.
 *   2. `exact-name`        — the whole basename.
 *   3. `name-prefix`       — the basename starts with the query.
 *   4. `name-subsequence`  — the query's characters, in order, in the basename.
 *   5. `path-subsequence`  — in order somewhere in the path. The bottom tier.
 *
 * Then, inside one tier: match quality (a fact about the query), artifact
 * status and path depth (facts about the file), and finally the relPath itself
 * — so the order is total and adding an unrelated artifact to the index can
 * never move an unrelated result.
 *
 * Recency is deliberately absent: `IndexedFile` carries no such field, and
 * adding one is a product decision plus a data change, not a ranking tweak.
 *
 * The two surfaces still share `subsequenceScore`, the small pure matcher —
 * it is the meaning of "fuzzy" in this app, and two of those would drift.
 */
import { baseNameOf, type IndexedFile, subsequenceScore } from "./file-ref";

/** How a query hit a path, best tier first. See the module header for the order. */
export type QuickOpenMatchTier =
  | "exact-path"
  | "exact-name"
  | "name-prefix"
  | "name-subsequence"
  | "path-subsequence";

/** Sort position of each tier. Lower is better; only compared against another tier. */
const TIER_RANK: Record<QuickOpenMatchTier, number> = {
  "exact-path": 0,
  "exact-name": 1,
  "name-prefix": 2,
  "name-subsequence": 3,
  "path-subsequence": 4,
};

/**
 * One file's answer to one query: which tier it landed in, and how well it
 * matched WITHIN that tier.
 *
 * `score` is comparable only against another match in the same tier, and is
 * flat `0` where the tier already says everything (an exact path or an exact
 * basename is not more exact in one file than another). It is measured over the
 * basename for the name tiers and over the whole path for `path-subsequence`,
 * so a file's directories can never inflate a basename hit.
 */
export interface QuickOpenMatch {
  readonly tier: QuickOpenMatchTier;
  readonly score: number;
}

/** How many directories deep a relPath sits — `0` at the repo root. */
function depthOf(relPath: string): number {
  return relPath.split("/").length - 1;
}

/**
 * Where `relPath` lands for `query`, or `null` when the query's characters do
 * not appear in the path in order at all (filtered out of the list).
 *
 * An empty query matches everything in the bottom tier with a flat score: it
 * expresses no preference, so the shape tie-breakers alone order a
 * just-opened overlay. Case-insensitive on both sides.
 */
export function quickOpenMatch(query: string, relPath: string): QuickOpenMatch | null {
  const q = query.toLowerCase();
  const path = relPath.toLowerCase();
  if (q.length === 0) return { tier: "path-subsequence", score: 0 };
  if (q === path) return { tier: "exact-path", score: 0 };

  const name = baseNameOf(path);
  if (q === name) return { tier: "exact-name", score: 0 };

  // One `subsequenceScore` call answers both name tiers: a prefix is a
  // subsequence, and a prefix match's score is the same for every file whose
  // basename starts with the query — so quality never decides between them and
  // the shape tie-breakers below do.
  const nameScore = subsequenceScore(q, name);
  if (nameScore !== null) {
    return { tier: name.startsWith(q) ? "name-prefix" : "name-subsequence", score: nameScore };
  }

  const pathScore = subsequenceScore(q, path);
  return pathScore === null ? null : { tier: "path-subsequence", score: pathScore };
}

interface RankedFile {
  readonly file: IndexedFile;
  readonly match: QuickOpenMatch;
}

/**
 * The full order, most wanted first: tier, then match quality, then the file's
 * own shape (artifact, then shallower), then the relPath.
 *
 * The last step is not decoration. Without it two equally-shaped files would
 * hold whatever order the index walk happened to produce, and "the top result
 * changed because an artifact was written elsewhere in the repo" is precisely
 * the bug this module exists to end.
 */
function compareRanked(a: RankedFile, b: RankedFile): number {
  const tier = TIER_RANK[a.match.tier] - TIER_RANK[b.match.tier];
  if (tier !== 0) return tier;
  if (a.match.score !== b.match.score) return b.match.score - a.match.score;
  if (a.file.artifact !== b.file.artifact) return a.file.artifact ? -1 : 1;
  const depth = depthOf(a.file.relPath) - depthOf(b.file.relPath);
  if (depth !== 0) return depth;
  return a.file.relPath < b.file.relPath ? -1 : 1;
}

/**
 * Rank a file index for one ⌘P query, best first, dropping the misses.
 *
 * `artifact` is read from the index entry rather than re-derived from the path:
 * the index is what decided a file is an artifact, and this is a tie-breaker,
 * not a second opinion. `limit` is the caller's ceiling (quick-open draws a
 * jump list, not a result page); omitted, every match comes back.
 */
export function rankQuickOpenFiles(input: {
  query: string;
  index: readonly IndexedFile[];
  limit?: number;
}): readonly IndexedFile[] {
  const matched: RankedFile[] = [];
  for (const file of input.index) {
    const match = quickOpenMatch(input.query, file.relPath);
    if (match !== null) matched.push({ file, match });
  }
  matched.sort(compareRanked);
  return matched.slice(0, input.limit ?? matched.length).map((entry) => entry.file);
}
