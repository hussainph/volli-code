/**
 * Column positions as fractional-index keys.
 *
 * A ticket's place in its column is a string key; the column sorts by plain
 * string comparison. A move names its neighbours (`afterTicketId` /
 * `beforeTicketId`), never an integer index, and the backend computes the key
 * between them inside the transaction, so a move writes exactly the moved
 * ticket and concurrent moves cannot collide.
 *
 * The algorithm is David Greenspan's, as implemented by `fractional-indexing`
 * (rocicorp) with its default base-62 alphabet, byte-compatible with the Go,
 * Python, Kotlin and Ruby ports. Keys are case-sensitive: compare them with
 * {@link comparePositions} (or `<`), never `localeCompare`.
 *
 * Keys lengthen under repeated inserts at one spot; past
 * {@link POSITION_REBALANCE_LENGTH} the backend rewrites the column's keys
 * ({@link needsRebalance}, {@link rebalancedPositions}).
 */

import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

export type PositionKey = string;

/** A key longer than this triggers a rebalance of its column. */
export const POSITION_REBALANCE_LENGTH = 48;

/** Thrown when a neighbour is not a valid key, or `after` does not sort before `before`. */
export class InvalidPositionError extends Error {
  readonly code = "invalid_position";
  constructor(detail: string) {
    super(`Invalid position: ${detail}`);
    this.name = "InvalidPositionError";
  }
}

function guarded<T>(generate: () => T): T {
  try {
    return generate();
  } catch (error) {
    throw new InvalidPositionError((error as Error).message);
  }
}

/**
 * The key strictly between `after` and `before`. `null` means the column's
 * start (for `after`) or end (for `before`); both `null` is an empty column.
 */
export function positionBetween(
  after: PositionKey | null,
  before: PositionKey | null,
): PositionKey {
  return guarded(() => generateKeyBetween(after, before));
}

/** `count` ascending keys strictly between `after` and `before`, spaced evenly (for moving a group). */
export function positionsBetween(
  after: PositionKey | null,
  before: PositionKey | null,
  count: number,
): PositionKey[] {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new InvalidPositionError(`count must be a non-negative integer, got ${count}`);
  }
  return guarded(() => generateNKeysBetween(after, before, count));
}

/** Whether `value` is a valid position key. */
export function isPositionKey(value: unknown): value is PositionKey {
  if (typeof value !== "string") return false;
  try {
    // The generator validates both neighbours before it computes anything.
    generateKeyBetween(value, null);
    return true;
  } catch {
    return false;
  }
}

/** Plain code-unit order, which is the order the keys were generated to sort in. */
export function comparePositions(a: PositionKey, b: PositionKey): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whether a key has grown long enough that its column should be rebalanced. */
export function needsRebalance(key: PositionKey): boolean {
  return key.length > POSITION_REBALANCE_LENGTH;
}

/** Fresh, short keys for a whole column of `count` items, in order. */
export function rebalancedPositions(count: number): PositionKey[] {
  return positionsBetween(null, null, count);
}
