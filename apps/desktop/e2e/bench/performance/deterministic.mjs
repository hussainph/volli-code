/**
 * The VC-353 fixture's determinism primitives.
 *
 * Everything a generated profile contains — ids, payload text, per-Session
 * allocations — is a pure function of the preset and the seed. Nothing here
 * reads a clock, a hostname, a path, or `Math.random`, because the fixture's
 * contract is "same seed, same database" and a single ambient value anywhere in
 * this file would quietly break it for every consumer downstream.
 */

import { createHash } from "node:crypto";

/** xorshift32, with no implicit platform entropy. */
export function seededRandom(seed) {
  let state = seed >>> 0 || 0x9e_37_79_b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

/**
 * A durable id that is a content hash rendered as a UUID.
 *
 * `docs/BOUNDARIES.md` rule 1: every new durable id is a UUID, a content hash,
 * or a string scoped by a session/attachment UUID — never a bare local counter
 * and never anything machine-local. A benchmark fixture writes hundreds of
 * thousands of durable rows, so it obeys the same rule the product does: the id
 * is SHA-256 over a namespaced name, stamped with RFC 9562 version 8 (custom,
 * which is exactly what a hash-derived UUID is) and the RFC variant bits.
 *
 * The derivation is frozen the moment a baseline is published, the way every
 * product id derivation is: changing `scope` or the name shape changes every id
 * in the fixture and therefore its database digest.
 */
export function deterministicUuid(scope, name) {
  const digest = createHash("sha256").update(`vc-353:${scope}:${name}`).digest();
  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Split `total` across `weights` as exact integers: floor every share, then
 * hand the remainder out by largest fractional part with the index as the
 * tie-break. Deterministic, order-stable, and exact — three properties the
 * fixture needs everywhere it turns a measured total into per-row counts.
 */
export function largestRemainder(total, weights) {
  if (!Number.isInteger(total) || total < 0)
    throw new Error("total must be a non-negative integer");
  if (weights.length === 0) throw new Error("largestRemainder needs at least one weight");
  if (weights.some((weight) => !(weight >= 0))) throw new Error("weights must be non-negative");
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  if (weightTotal === 0) {
    // No weight anywhere: spread evenly rather than refuse, so a caller with an
    // all-zero mix still gets an exact split.
    return distributeExact(weights.length, total);
  }
  const shares = weights.map((weight, index) => {
    const raw = (total * weight) / weightTotal;
    const floor = Math.floor(raw);
    return { index, floor, fraction: raw - floor };
  });
  let assigned = shares.reduce((sum, share) => sum + share.floor, 0);
  const counts = shares.map((share) => share.floor);
  const ranked = shares.toSorted(
    (left, right) => right.fraction - left.fraction || left.index - right.index,
  );
  for (const share of ranked) {
    if (assigned >= total) break;
    counts[share.index] += 1;
    assigned += 1;
  }
  return counts;
}

/** Even split of `total` across `count` entries, front-loading the remainder. */
export function distributeExact(count, total) {
  if (count < 1) throw new Error("distributeExact needs at least one entry");
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  return Array.from({ length: count }, (_value, index) => base + (index < remainder ? 1 : 0));
}

/**
 * Deterministic, capped proportional split.
 *
 * Used where a total must land on rows that have room for it — Session Commands
 * need two ledger events each, and a five-event Session has room for none. The
 * cap is honoured exactly and the overflow goes to the entries that still have
 * capacity, largest weight first.
 */
export function distributeCapped(total, weights, caps) {
  if (weights.length !== caps.length) throw new Error("weights and caps must be the same length");
  const capacity = caps.reduce((sum, cap) => sum + cap, 0);
  if (total > capacity) throw new Error(`cannot place ${total} in a capacity of ${capacity}`);
  const counts = largestRemainder(
    total,
    weights.map((weight, index) => (caps[index] === 0 ? 0 : weight)),
  );
  let overflow = 0;
  for (const [index, cap] of caps.entries()) {
    if (counts[index] > cap) {
      overflow += counts[index] - cap;
      counts[index] = cap;
    }
  }
  if (overflow === 0) return counts;
  const order = caps
    .map((cap, index) => ({ index, room: cap - counts[index], weight: weights[index] }))
    .filter((entry) => entry.room > 0)
    .toSorted((left, right) => right.weight - left.weight || left.index - right.index);
  for (const entry of order) {
    if (overflow === 0) break;
    const take = Math.min(entry.room, overflow);
    counts[entry.index] += take;
    overflow -= take;
  }
  if (overflow !== 0) throw new Error("capped distribution could not place every unit");
  return counts;
}

/**
 * A deterministic in-place shuffle over a copy of `values`.
 *
 * Fisher–Yates driven by the fixture's own xorshift, so a Session's event order
 * is varied but reproducible. Per-session ordering only: `docs/BOUNDARIES.md`
 * rule 2 says local `sequence` is provisional order, so a fixture may choose any
 * order it likes inside one Session as long as it chooses the same one twice.
 */
export function seededShuffle(values, seed) {
  const random = seededRandom(seed);
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}

const TAPE_WORDS = [
  "projection",
  "ledger",
  "attachment",
  "worktree",
  "transcript",
  "sequence",
  "provenance",
  "compaction",
  "harness",
  "renderer",
  "migration",
  "digest",
  "checkout",
  "session",
  "command",
  "receipt",
  "observation",
  "runtime",
  "executor",
  "scheduler",
  "cursor",
  "backlog",
  "baseline",
  "threshold",
  "latency",
  "percentile",
  "allocation",
  "throughput",
  "fixture",
  "benchmark",
  "artifact",
  "snapshot",
  "boundary",
  "retention",
  "interaction",
  "attention",
  "authority",
  "reasoning",
  "tokenizer",
  "collector",
  "resolved",
  "deferred",
  "bounded",
  "monotonic",
  "idempotent",
  "durable",
  "ordered",
  "replayed",
  "scoped",
  "verified",
];

const TAPE_FRAGMENTS = [
  "src/main/session-control/sqlite-ledger.ts",
  "packages/shared/src/session-event-codec.ts",
  "apps/desktop/src/renderer/src/features/chat",
  "line 42:",
  "took 18ms,",
  "exit 0,",
  "3 matches,",
  "warn:",
  "ok:",
  "->",
];

/**
 * One long deterministic prose tape every payload body is sliced from.
 *
 * Built once at module load with the fixture's own generator — no clock, no
 * `Math.random` — and free of `"`, `\` and newlines so a JSON-encoded slice is
 * exactly as many bytes as the slice itself. That is what lets the generator
 * aim at a measured physical size instead of guessing at JSON escaping, while
 * still writing text that reads like a tool result rather than filler bytes.
 */
const TAPE = buildTape();

function buildTape() {
  const random = seededRandom(0x35_33_00_01);
  const parts = [];
  let length = 0;
  while (length < 262_144) {
    const useFragment = random() < 0.12;
    const part = useFragment
      ? TAPE_FRAGMENTS[Math.floor(random() * TAPE_FRAGMENTS.length)]
      : TAPE_WORDS[Math.floor(random() * TAPE_WORDS.length)];
    parts.push(part);
    length += part.length + 1;
  }
  return parts.join(" ");
}

/** Exactly `bytes` characters of deterministic, JSON-transparent prose. */
export function proseBytes(bytes, selector) {
  if (bytes <= 0) return "";
  const window = TAPE.length - bytes;
  if (window <= 0) throw new Error(`prose body of ${bytes} bytes exceeds the tape`);
  const offset = hashIndex(String(selector), window);
  return TAPE.slice(offset, offset + bytes);
}

/** A stable index in `[0, range)` derived from a name — never a counter. */
export function hashIndex(name, range) {
  if (range <= 0) return 0;
  const digest = createHash("sha256").update(name).digest();
  return digest.readUInt32BE(0) % range;
}
