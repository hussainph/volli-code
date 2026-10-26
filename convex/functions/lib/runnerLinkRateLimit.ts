/**
 * Rate limits for the anonymous linking doors: `POST /runner/link/start`,
 * `/runner/link` and `/runner/link/poll`. Token buckets in one table, taken
 * all-or-none in the caller's transaction:
 * - per network, first: an IPv4 address or an IPv6 /64 (one subscriber's
 *   allocation, so cycling addresses inside it gains nothing). The address is
 *   the one Convex saw (`ctx.meta`), never a header the caller set;
 * - per code, for the doors that present one, and only when that code names a
 *   real row: the install token's row for `/runner/link`, the named link
 *   request for `/runner/link/poll`. Addresses from many networks still cannot
 *   hammer one code, and a junk code makes no bucket;
 * - for the whole deployment, on `/runner/link/start` only, so starts spread
 *   over many networks still cannot write unbounded device-code rows.
 *
 * A refused request writes nothing. Bucket keys hold a hash of the network
 * and a row's own id, never an address or a secret. An absent row is a full
 * bucket, so the sweep deletes a row once it has refilled (`fullAt`) without
 * changing any answer. `/runner/token` is not limited here: a wrong refresh
 * credential is a read that changes nothing, and every runner refreshes
 * through it.
 */

import { secretHash } from "@volli/shared/cloud";
import type { GenericDatabaseWriter } from "convex/server";

import type { DataModel, Doc } from "../_generated/dataModel.js";

type Writer = { db: GenericDatabaseWriter<DataModel> };

/** A token bucket: `capacity` requests at once, then one more every `refillMs`. */
export interface BucketPolicy {
  readonly capacity: number;
  readonly refillMs: number;
}

export const RUNNER_LINK_LIMITS = {
  /** Device-code starts from one network: a few at once, then one a minute. */
  startPerNetwork: { capacity: 10, refillMs: 60_000 },
  /** Device-code starts deployment-wide: burst 120, refilling 1,800 tokens an hour. */
  startGlobal: { capacity: 120, refillMs: 2_000 },
  /** Install-token links from one network. */
  linkPerNetwork: { capacity: 10, refillMs: 60_000 },
  /** Tries of one install token, from anywhere. */
  linkPerToken: { capacity: 5, refillMs: 60_000 },
  /** Polls from one network: a dozen boxes polling every 5 s. */
  pollPerNetwork: { capacity: 60, refillMs: 400 },
  /** Polls of one link request, from anywhere: faster than the 5 s interval never runs dry. */
  pollPerRequest: { capacity: 5, refillMs: 4_000 },
} as const satisfies Record<string, BucketPolicy>;

/** Rows one sweep pass deletes; a full page schedules the next one. */
export const RATE_LIMIT_SWEEP_PAGE_SIZE = 200;

export interface Bucket {
  key: string;
  policy: BucketPolicy;
}

export type Admission = { ok: true } | { ok: false; retryAfterMs: number };

const HEXTET = /^[0-9a-f]{1,4}$/;

const groupsOf = (half: string) => (half === "" ? [] : half.split(":"));

/** The first four groups of an IPv6 address, or `null` when it is not one. */
function ipv6Prefix(text: string): string | null {
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = groupsOf(halves[0]);
  const tail = halves.length === 2 ? groupsOf(halves[1]) : null;
  const count = head.length + (tail?.length ?? 0);
  if (tail === null ? count !== 8 : count > 7) return null;
  const groups = [...head, ...Array.from({ length: 8 - count }, () => "0"), ...(tail ?? [])];
  if (!groups.every((group) => HEXTET.test(group))) return null;
  return groups
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(":");
}

/**
 * The network an address belongs to: `v4:<address>` (an IPv4-mapped IPv6
 * address too), `v6:<prefix>::/64`, `unknown` when Convex saw none, and
 * `raw:<text>`, its own network, for anything else.
 */
export function networkOf(ip: string | null): string {
  const text = (ip ?? "").trim().toLowerCase();
  if (text === "") return "unknown";
  const v4 = text.startsWith("::ffff:") ? text.slice("::ffff:".length) : text;
  if (v4.includes(".")) return `v4:${v4}`;
  const prefix = ipv6Prefix(text);
  return prefix === null ? `raw:${text}` : `v6:${prefix}::/64`;
}

function networkBucket(door: string, ip: string | null, policy: BucketPolicy): Bucket {
  return { key: `${door}:net:${secretHash(networkOf(ip))}`, policy };
}

/** What one `/runner/link/start` from `ip` takes from. */
export function linkStartBuckets(ip: string | null): Bucket[] {
  return [
    networkBucket("link_start", ip, RUNNER_LINK_LIMITS.startPerNetwork),
    { key: "link_start:all", policy: RUNNER_LINK_LIMITS.startGlobal },
  ];
}

/** What one `/runner/link` from `ip` takes from; `tokenId` is the presented token's row, if any. */
export function linkBuckets(ip: string | null, tokenId: string | null): Bucket[] {
  const buckets = [networkBucket("link", ip, RUNNER_LINK_LIMITS.linkPerNetwork)];
  if (tokenId !== null) {
    buckets.push({ key: `link:token:${tokenId}`, policy: RUNNER_LINK_LIMITS.linkPerToken });
  }
  return buckets;
}

/** What one `/runner/link/poll` from `ip` takes from; `requestId` names a real request, if any. */
export function linkPollBuckets(ip: string | null, requestId: string | null): Bucket[] {
  const buckets = [networkBucket("link_poll", ip, RUNNER_LINK_LIMITS.pollPerNetwork)];
  if (requestId !== null) {
    buckets.push({
      key: `link_poll:request:${requestId}`,
      policy: RUNNER_LINK_LIMITS.pollPerRequest,
    });
  }
  return buckets;
}

/** How many tokens a bucket holds at `now` (a missing row is full). */
export function tokensAt(
  row: Pick<Doc<"runnerLinkRateLimits">, "tokens" | "updatedAt"> | null,
  policy: BucketPolicy,
  now: number,
): number {
  if (row === null) return policy.capacity;
  const refilled = row.tokens + Math.max(0, now - row.updatedAt) / policy.refillMs;
  return Math.min(policy.capacity, refilled);
}

/**
 * Takes one token from every bucket, or from none: when any bucket is empty
 * nothing is written and the answer says how long until all of them hold one.
 * In the caller's transaction, so concurrent callers cannot overdraw a bucket.
 */
export async function admit(
  ctx: Writer,
  buckets: readonly Bucket[],
  now: number,
): Promise<Admission> {
  const rows = await Promise.all(
    buckets.map(({ key }) =>
      ctx.db
        .query("runnerLinkRateLimits")
        .withIndex("by_key", (q) => q.eq("key", key))
        .unique(),
    ),
  );
  const levels = buckets.map(({ policy }, index) => tokensAt(rows[index], policy, now));
  let retryAfterMs = 0;
  buckets.forEach(({ policy }, index) => {
    const short = 1 - levels[index];
    if (short > 0) retryAfterMs = Math.max(retryAfterMs, Math.ceil(short * policy.refillMs));
  });
  if (retryAfterMs > 0) return { ok: false, retryAfterMs };
  for (const [index, { key, policy }] of buckets.entries()) {
    const tokens = levels[index] - 1;
    const fields = {
      tokens,
      updatedAt: now,
      fullAt: now + Math.ceil((policy.capacity - tokens) * policy.refillMs),
    };
    const row = rows[index];
    if (row === null) await ctx.db.insert("runnerLinkRateLimits", { key, ...fields });
    else await ctx.db.patch(row._id, fields);
  }
  return { ok: true };
}

/** Deletes one page of buckets that have refilled; returns how many. */
export async function sweepRefilled(ctx: Writer, now: number): Promise<number> {
  const rows = await ctx.db
    .query("runnerLinkRateLimits")
    .withIndex("by_full_at", (q) => q.lt("fullAt", now))
    .take(RATE_LIMIT_SWEEP_PAGE_SIZE);
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length;
}
