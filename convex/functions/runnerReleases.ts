/** Public GitHub runner releases, polled without a deployment or GitHub credential.
 * Channel pins are operator intent: polling never overwrites one until unpinned.
 */
import { compareVersions } from "@volli/shared";
import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
} from "./_generated/server";
import { nullable } from "./lib/validators";
import { requireRunner } from "./lib/runnerAuth";
import { runnerTargetVersion } from "./lib/runnerUpdates";

const channel = v.union(v.literal("stable"), v.literal("canary"));
const releaseCandidate = v.object({
  version: v.string(),
  manifestUrl: v.string(),
  publishedAt: v.number(),
});
const cachedPage = v.object({
  etag: nullable(v.string()),
  stable: nullable(releaseCandidate),
  canary: nullable(releaseCandidate),
  hasNext: v.boolean(),
});
const pointer = v.object({
  ...releaseCandidate.fields,
  minVersion: v.string(),
});
type Release = { version: string; manifestUrl: string; publishedAt: number };
type Pointer = Release & { minVersion: string };
type CachedPage = {
  etag: string | null;
  stable: Release | null;
  canary: Release | null;
  hasNext: boolean;
};

/** The updater reads the manifest URL with its runner token, never a person's.
 * Receiving-task wiring: the runner's onTarget callback reads this before staging.
 */
export const target = query({
  args: {},
  handler: async (ctx) => {
    const { runner } = await requireRunner(ctx);
    const release = await ctx.db
      .query("releaseChannels")
      .withIndex("by_channel", (q) => q.eq("channel", runner.autoUpdate.channel))
      .unique();
    const version = runnerTargetVersion(runner.autoUpdate, release);
    return {
      targetVersion: version,
      minVersion: release?.minVersion ?? null,
      manifestUrl:
        version === null
          ? null
          : version === release?.version
            ? release.manifestUrl
            : `https://github.com/${process.env.RUNNER_RELEASE_REPO ?? "hussainph/volli-code"}/releases/download/v${version}/volli-runner-manifest.json`,
      autoUpdate: runner.autoUpdate,
    };
  },
});

// Bound both unauthenticated API use (60 requests/hour) and stored cache size.
const MAX_PAGES = 10;
const PER_PAGE = 100;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function validVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 100 && VERSION.test(value);
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid runner release document.");
  }
  return value as Record<string, unknown>;
}
function httpsUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Invalid release URL.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("Runner releases require an absolute HTTPS URL.");
  }
  return url.href;
}
function newer(a: Release | null, b: Release | null): Release | null {
  if (a === null) return b;
  if (b === null) return a;
  // Never ask runners to downgrade just because an older maintenance release
  // was published later. Publication time breaks equal-version ties only.
  const order = compareVersions(a.version, b.version);
  return order > 0 || (order === 0 && a.publishedAt >= b.publishedAt) ? a : b;
}
function candidates(value: unknown): Pick<CachedPage, "stable" | "canary"> {
  if (!Array.isArray(value) || value.length > PER_PAGE) throw new Error("Invalid releases page.");
  let stable: Release | null = null;
  let canary: Release | null = null;
  for (const item of value) {
    const row = object(item);
    if (row.draft !== false || typeof row.prerelease !== "boolean" || !row.published_at) continue;
    if (typeof row.tag_name !== "string" || !row.tag_name.startsWith("v")) continue;
    const version = row.tag_name.slice(1);
    if (!validVersion(version) || !Array.isArray(row.assets)) continue;
    const asset = row.assets.find(
      (entry: unknown) => object(entry).name === "volli-runner-manifest.json",
    );
    if (!asset) continue;
    const publishedAt = Date.parse(String(row.published_at));
    if (!Number.isFinite(publishedAt)) throw new Error("Invalid release publication time.");
    const candidate = {
      version,
      publishedAt,
      manifestUrl: httpsUrl(object(asset).browser_download_url),
    };
    if (row.prerelease) canary = newer(canary, candidate);
    else stable = newer(stable, candidate);
  }
  return { stable, canary };
}
async function json(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`Runner release request failed (${response.status}).`);
  const body = await response.text();
  if (new TextEncoder().encode(body).length > MAX_JSON_BYTES)
    throw new Error("Release document too large.");
  return JSON.parse(body) as unknown;
}
async function manifest(candidate: Release): Promise<Pointer> {
  const row = object(
    await json(
      await fetch(candidate.manifestUrl, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
    ),
  );
  if (
    row.schemaVersion !== 1 ||
    row.version !== candidate.version ||
    row.releaseTag !== `v${candidate.version}` ||
    !validVersion(row.minRunnerVersion) ||
    compareVersions(row.minRunnerVersion, candidate.version) > 0 ||
    row.minGlibc !== "2.31" ||
    !Array.isArray(row.targets) ||
    row.targets.length === 0 ||
    row.targets.length > 2
  )
    throw new Error("Invalid runner release manifest.");
  const arches = new Set<string>();
  for (const item of row.targets) {
    const artifact = object(item);
    if (
      artifact.platform !== "linux" ||
      (artifact.arch !== "x64" && artifact.arch !== "arm64") ||
      arches.has(artifact.arch) ||
      !Number.isSafeInteger(artifact.size) ||
      Number(artifact.size) <= 0 ||
      typeof artifact.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(artifact.sha256)
    )
      throw new Error("Invalid runner release target.");
    arches.add(artifact.arch);
    httpsUrl(artifact.url);
  }
  httpsUrl(object(row.provenance).bundleUrl);
  return { ...candidate, minVersion: row.minRunnerVersion };
}
async function writePointer(
  ctx: MutationCtx,
  name: "stable" | "canary",
  value: Pointer,
  pinned?: boolean,
) {
  const stored = await ctx.db
    .query("releaseChannels")
    .withIndex("by_channel", (q) => q.eq("channel", name))
    .unique();
  if (pinned === undefined && stored?.pinned) return;
  const next = { channel: name, ...value, ...(pinned === undefined ? {} : { pinned }) };
  if (stored === null) await ctx.db.insert("releaseChannels", next);
  else if (Object.entries(next).some(([key, val]) => stored[key as keyof typeof stored] !== val)) {
    await ctx.db.patch(stored._id, next);
  }
}

export const cache = internalQuery({
  args: { repo: v.string() },
  handler: async (ctx, { repo }): Promise<CachedPage[]> =>
    (
      await ctx.db
        .query("runnerReleaseFeeds")
        .withIndex("by_repo", (q) => q.eq("repo", repo))
        .unique()
    )?.pages ?? [],
});

/** Commit only after every page and selected manifest validated. A failed poll
 * retains both pointers and cache, so a retry cannot mistake a failed fetch for 304 success.
 */
export const apply = internalMutation({
  args: {
    repo: v.string(),
    pages: v.array(cachedPage),
    stable: nullable(pointer),
    canary: nullable(pointer),
  },
  handler: async (ctx, args): Promise<null> => {
    if (args.pages.length > MAX_PAGES) throw new Error("Too many release pages.");
    const stored = await ctx.db
      .query("runnerReleaseFeeds")
      .withIndex("by_repo", (q) => q.eq("repo", args.repo))
      .unique();
    if (stored === null)
      await ctx.db.insert("runnerReleaseFeeds", { repo: args.repo, pages: args.pages });
    else await ctx.db.patch(stored._id, { pages: args.pages });
    if (args.stable !== null) await writePointer(ctx, "stable", args.stable);
    if (args.canary !== null) await writePointer(ctx, "canary", args.canary);
    return null;
  },
});

/** Called every 15 minutes. Conditional requests are per page, so an edit to
 * an older release is noticed even when page one's ETag did not change.
 */
export const poll = internalAction({
  args: {},
  handler: async (ctx): Promise<null> => {
    const repo = process.env.RUNNER_RELEASE_REPO ?? "hussainph/volli-code";
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo))
      throw new Error("Invalid RUNNER_RELEASE_REPO.");
    const cached = await ctx.runQuery(internal.runnerReleases.cache, { repo });
    const pages: CachedPage[] = [];
    let stable: Release | null = null;
    let prerelease: Release | null = null;
    for (let index = 0; index < MAX_PAGES; index += 1) {
      const previous = cached[index];
      const response = await fetch(
        `https://api.github.com/repos/${repo}/releases?per_page=${PER_PAGE}&page=${index + 1}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "volli-runner-release-feed",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(previous?.etag ? { "If-None-Match": previous.etag } : {}),
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      let page: CachedPage;
      if (response.status === 304 && previous) page = previous;
      else
        page = {
          ...candidates(await json(response)),
          etag: response.headers.get("etag"),
          hasNext: /rel="next"/u.test(response.headers.get("link") ?? ""),
        };
      pages.push(page);
      stable = newer(stable, page.stable);
      prerelease = newer(prerelease, page.canary);
      if (!page.hasNext) break;
      if (index === MAX_PAGES - 1) throw new Error("Runner release feed exceeds page budget.");
    }
    const canary = newer(stable, prerelease);
    const stablePointer = stable === null ? null : await manifest(stable);
    const canaryPointer =
      canary === null ? null : canary === stable ? stablePointer : await manifest(canary);
    await ctx.runMutation(internal.runnerReleases.apply, {
      repo,
      pages,
      stable: stablePointer,
      canary: canaryPointer,
    });
    return null;
  },
});

/** Deployment-operator override. `pinned:false` resumes the feed on its next poll. */
export const pin = internalMutation({
  args: { channel, ...pointer.fields, pinned: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<null> => {
    if (
      !validVersion(args.version) ||
      !validVersion(args.minVersion) ||
      compareVersions(args.minVersion, args.version) > 0 ||
      !Number.isFinite(args.publishedAt) ||
      args.publishedAt < 0
    ) {
      throw new ConvexError({
        code: "invalid_request",
        message: "Invalid runner release pointer.",
      });
    }
    httpsUrl(args.manifestUrl);
    await writePointer(
      ctx,
      args.channel,
      {
        version: args.version,
        minVersion: args.minVersion,
        manifestUrl: args.manifestUrl,
        publishedAt: args.publishedAt,
      },
      args.pinned ?? true,
    );
    return null;
  },
});
