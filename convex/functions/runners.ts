/**
 * Runners: linking a machine to a person, its rotated credential, its
 * heartbeat and capabilities, and the list Settings shows.
 *
 * A runner belongs to a person and runs only that person's work, in every
 * Workspace they are a member of. Three doors create one, and all end at the
 * same `runners` row and refresh credential:
 * - `registerThisMac`: the signed-in desktop registers its own Mac;
 * - an install token (`createInstallToken`, then the box's `POST /runner/link`);
 * - a device code (the box's `POST /runner/link/start`, the person's
 *   `previewLink` / `decideLink`, the box's `POST /runner/link/poll`).
 *
 * The box exchanges its refresh credential at `POST /runner/token` for a
 * 15-minute runner token and the credential's successor (`rotateCredential`).
 * A credential presented after its successor was used means it was copied:
 * the runner is cut off (`revoked`, reason `credential_reuse`), and its owner
 * gets a Needs-you runner alert, cleared when they remove the runner.
 *
 * A Mac that lost its sealed credential (keychain loss, a reset inventory)
 * registers again naming the runner it was (`replacesRunnerId`, from a
 * non-secret local record). When that names one of the caller's own Mac
 * runners that is neither gone nor still heartbeating in a live status, the
 * new runner succeeds it in the same transaction: it takes the old runner's
 * name, the old runner is revoked (reason `replaced`) and leaves the list,
 * and the old runner's work follows
 * (`moveRunnerWork`): Session claims (next generation), Session Places,
 * viewers, and open jobs that name no Working copy. Working-copy jobs stay
 * with the replaced runner until Working copies move (not part of this
 * handover).
 * Any other value registers a plain new runner, so the id reveals nothing
 * about anyone else's runners. A client-minted `registrationId` makes a lost
 * registration reply retryable while the first credential is unused: the
 * same runner is returned with a fresh credential, without moving work again.
 *
 * Liveness: `heartbeat` writes only `runnerPresence`, which no client
 * subscribes to; `runners.status` changes only on a transition (the first
 * heartbeat after silence or sleep, an explicit `reportState`, or
 * `sweepOffline` after 90 s of silence), so a heartbeat never re-runs anyone's
 * runner list. `asleep` (a Mac whose lid closed) is reported, not live: the
 * sweep leaves it alone, and the first beat after wake makes it `online`.
 *
 * Secrets are minted in actions (`lib/runnerSecrets.ts`); mutations here see
 * only their hashes.
 */

import { ConvexError, v } from "convex/values";
import type { GenericDatabaseReader, GenericDatabaseWriter } from "convex/server";

import {
  LIVE_RUNNER_STATUSES,
  RUNNER_ALERTS,
  RUNNER_INSTALL_TOKEN_TTL_MS,
  RUNNER_LINK_REQUEST_TTL_MS,
  RUNNER_OFFLINE_AFTER_MS,
  RUNNER_PLACES_MAX_SESSIONS,
  RUNNER_REPORTED_STATES,
  RUNNER_SECRET_PREFIXES,
  RUNNER_STATUS_REASONS,
  RunnerWireError,
  chooseRunnerName,
  dedupeRunnerName,
  newId,
  normalizeUserCode,
  parseId,
  parseRunnerCapabilityReport,
  parseRunnerHostFacts,
  isUuid,
  runnerKindForOs,
  runnerNameSlug,
  secretHash,
  type RunnerHeartbeatReply,
  type RunnerHostFacts,
  type RunnerKind,
  type RunnerLinkGrant,
  type RunnerLinkMethod,
  type RunnerPlace,
  type RunnerStatus,
  type UserId,
} from "@volli/shared/cloud";

import { internal } from "./_generated/api";
import type { DataModel, Doc } from "./_generated/dataModel.js";
import {
  action,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { clearRunnerAlert, raiseRunnerAlert } from "./lib/attention";
import { authError, requireSessionVisible, requireViewer, type Viewer } from "./lib/auth";
import { requireRunnerForWrite } from "./lib/runnerAuth";
import { mintSecret } from "./lib/runnerSecrets";
import { nullable } from "./lib/validators";

type Reader = { db: GenericDatabaseReader<DataModel> };
type Writer = { db: GenericDatabaseWriter<DataModel> };

/** Failed device-code entries allowed per person per window before `rate_limited`. */
export const LINK_ATTEMPT_MAX_FAILURES = 10;
export const LINK_ATTEMPT_WINDOW_MS = 10 * 60_000;
/** How long expired link rows and audit events are kept before the cleanup deletes them. */
export const EXPIRED_LINK_ROW_RETENTION_MS = 24 * 60 * 60_000;
export const RUNNER_EVENT_RETENTION_MS = 90 * 24 * 60 * 60_000;
/** Rows one sweep or cleanup pass touches; a full page schedules the next one. */
export const SWEEP_PAGE_SIZE = 200;

const DEFAULT_AUTO_UPDATE = { enabled: true, channel: "stable", pinnedVersion: null };
const MAX_BOOT_ID_LENGTH = 200;
const MAX_REASON_LENGTH = 500;

// ── shared steps ─────────────────────────────────────────────────────────────

/**
 * A shared codec's verdict as the caller sees it: a typed `invalid_request`
 * rather than an opaque server error.
 */
function parsed<T>(parse: (value: unknown) => T, value: unknown): T {
  try {
    return parse(value);
  } catch (error) {
    if (error instanceof RunnerWireError) {
      throw new ConvexError({ code: "invalid_request", message: error.message });
    }
    throw error;
  }
}

/** JSON with object keys sorted, so a stored document and a report compare by value. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, field: unknown) =>
    field !== null && typeof field === "object" && !Array.isArray(field)
      ? Object.fromEntries(
          Object.entries(field).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : field,
  );
}

async function runnerById(ctx: Reader, runnerId: string): Promise<Doc<"runners"> | null> {
  return ctx.db
    .query("runners")
    .withIndex("by_uuid", (q) => q.eq("id", runnerId))
    .unique();
}

async function credentialsOf(ctx: Reader, runnerId: string) {
  return ctx.db
    .query("runnerCredentials")
    .withIndex("by_runner", (q) => q.eq("runnerId", runnerId))
    .unique();
}

/** A person who may own a new runner: an active account, not pending deletion. */
async function activeUser(ctx: Reader, userId: string): Promise<Doc<"users"> | null> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_uuid", (q) => q.eq("id", userId))
    .unique();
  return user !== null && user.status === "active" ? user : null;
}

/**
 * Whether a runner is gone: removed by its owner, or replaced by its
 * successor on the same Mac. Its name is free again and it leaves the list.
 */
function isGone(runner: Doc<"runners">): boolean {
  return (
    runner.status === "revoked" &&
    (runner.statusReason === RUNNER_STATUS_REASONS.removed ||
      runner.statusReason === RUNNER_STATUS_REASONS.replaced)
  );
}

async function namesTaken(ctx: Reader, ownerUserId: string, except: string | null = null) {
  const owned = await ctx.db
    .query("runners")
    .withIndex("by_owner_name", (q) => q.eq("ownerUserId", ownerUserId))
    .collect();
  return new Set(
    owned.filter((runner) => !isGone(runner) && runner.id !== except).map((runner) => runner.name),
  );
}

/** A grant as a mutation knows it: the action that minted the credential adds the plaintext. */
export type IssuedGrant = Omit<RunnerLinkGrant, "credential">;

function requireUuid(value: string, what: string): string {
  if (!isUuid(value)) throw authError("forbidden", `${what} must be a lowercase UUID.`);
  return value;
}

interface NewRunner {
  ownerUserId: string;
  kind: RunnerKind;
  linkedVia: RunnerLinkMethod;
  host: RunnerHostFacts;
  /** The candidates the name is chosen from, best first. */
  name: string | null;
  nameHint: string | null;
  credentialHash: string;
  /** The runner this one succeeds: its name does not count as taken. */
  replaces?: string;
  desktopRegistrationId?: string;
}

/** Inserts the runner, its first credential and its `linked` audit event. */
async function createRunner(ctx: Writer, input: NewRunner): Promise<IssuedGrant> {
  const now = Date.now();
  const runnerId = newId("runner");
  const taken = await namesTaken(ctx, input.ownerUserId, input.replaces ?? null);
  const name = dedupeRunnerName(
    chooseRunnerName({ name: input.name, nameHint: input.nameHint, hostname: input.host.hostname }),
    (candidate) => taken.has(candidate),
  );
  await ctx.db.insert("runners", {
    id: runnerId,
    ownerUserId: input.ownerUserId,
    kind: input.kind,
    name,
    // Linked, not yet connected: its first heartbeat makes it `online`.
    status: "offline",
    statusReason: null,
    statusChangedAt: now,
    version: "unknown",
    platform: input.host.platform,
    capabilities: null,
    installMode: input.host.installMode,
    linkedVia: input.linkedVia,
    linkedAt: now,
    ...(input.desktopRegistrationId === undefined
      ? {}
      : { desktopRegistrationId: input.desktopRegistrationId }),
    autoUpdate: DEFAULT_AUTO_UPDATE,
    update: null,
    revokedAt: null,
    createdAt: now,
  });
  await ctx.db.insert("runnerCredentials", {
    runnerId,
    currentHash: input.credentialHash,
    previousHash: null,
    currentFirstUsedAt: null,
    generation: 1,
    rotatedAt: now,
    lastUsedAt: now,
    lastUsedIp: null,
  });
  await ctx.db.insert("runnerEvents", {
    runnerId,
    kind: "linked",
    at: now,
    detail: {
      via: input.linkedVia,
      hostname: input.host.hostname,
      ...(input.replaces === undefined ? {} : { replaces: input.replaces }),
    },
  });
  return { runnerId, name, generation: 1 };
}

/** Cuts a runner off: no credential, no token, every live call refused at once. */
async function revokeRunner(
  ctx: Writer,
  runner: Doc<"runners">,
  reason: string,
  detail: Record<string, unknown>,
) {
  const now = Date.now();
  await ctx.db.patch(runner._id, {
    status: "revoked",
    statusReason: reason,
    statusChangedAt: now,
    revokedAt: runner.revokedAt ?? now,
  });
  const credentials = await credentialsOf(ctx, runner.id);
  if (credentials !== null) await ctx.db.delete(credentials._id);
  // Live state of a runner that will never report again.
  const presence = await ctx.db
    .query("runnerPresence")
    .withIndex("by_runner", (q) => q.eq("runnerId", runner.id))
    .unique();
  if (presence !== null) await ctx.db.delete(presence._id);
  const local = await ctx.db
    .query("runnerLocalCredentials")
    .withIndex("by_runner", (q) => q.eq("runnerId", runner.id))
    .collect();
  for (const row of local) await ctx.db.delete(row._id);
  await ctx.db.insert("runnerEvents", {
    runnerId: runner.id,
    kind: reason === RUNNER_STATUS_REASONS.credentialReuse ? "token_reuse" : "revoked",
    at: now,
    detail: { reason, ...detail },
  });
  // A runner cut off for reuse tells its owner in Needs you; removing it is the answer.
  if (reason === RUNNER_STATUS_REASONS.credentialReuse) {
    await raiseRunnerAlert(ctx, runner, RUNNER_ALERTS.credentialReuse, now);
  } else if (reason === RUNNER_STATUS_REASONS.removed) {
    await clearRunnerAlert(ctx, runner.id, RUNNER_ALERTS.credentialReuse, now);
  }
}

async function setStatus(
  ctx: Writer,
  runner: Doc<"runners">,
  status: RunnerStatus,
  reason: string | null,
): Promise<RunnerStatus> {
  if (runner.status !== status || runner.statusReason !== reason) {
    await ctx.db.patch(runner._id, { status, statusReason: reason, statusChangedAt: Date.now() });
  }
  return status;
}

// ── the person's side: Settings → Runners ────────────────────────────────────

/** A runner as Settings lists it. Presence (the heartbeat) is deliberately not part of it. */
export interface RunnerSummary {
  id: string;
  name: string;
  kind: RunnerKind;
  status: RunnerStatus;
  statusReason: string | null;
  statusChangedAt: number;
  version: string;
  platform: Doc<"runners">["platform"];
  capabilities: unknown;
  installMode: Doc<"runners">["installMode"];
  linkedVia: RunnerLinkMethod;
  linkedAt: number;
}

function summary(runner: Doc<"runners">): RunnerSummary {
  return {
    id: runner.id,
    name: runner.name,
    kind: runner.kind,
    status: runner.status,
    statusReason: runner.statusReason,
    statusChangedAt: runner.statusChangedAt,
    version: runner.version,
    platform: runner.platform,
    capabilities: runner.capabilities,
    installMode: runner.installMode,
    linkedVia: runner.linkedVia,
    linkedAt: runner.linkedAt,
  };
}

/** The caller's runners, by name. A removed runner is gone from the list; one cut off stays, so it can be explained. */
export const list = query({
  args: {},
  handler: async (ctx): Promise<RunnerSummary[]> => {
    const { userId } = await requireViewer(ctx);
    const owned = await ctx.db
      .query("runners")
      .withIndex("by_owner_name", (q) => q.eq("ownerUserId", userId))
      .collect();
    return owned.filter((runner) => !isGone(runner)).map(summary);
  },
});

/**
 * The Places of Sessions the caller can see: for each Session id, the runner
 * it lives on as "Waiting for <Mac>" reads it (`sessionPlaceState` in
 * `@volli/shared/cloud`), or `null` when the caller cannot see that Session
 * (absent, deleted, private to someone else, or no longer a Member: all read
 * the same). Keyed by Session, never by runner, so a teammate learns of a
 * runner only through a Session they can already see, and the read is bounded
 * by {@link RUNNER_PLACES_MAX_SESSIONS}. A removed runner is still answered
 * (`revoked`), so its Sessions can say so.
 */
export const places = query({
  args: { sessionIds: v.array(v.string()) },
  handler: async (ctx, { sessionIds }): Promise<SessionPlaceRow[]> => {
    const viewer = await requireViewer(ctx);
    const unique = [...new Set(sessionIds)];
    if (unique.length > RUNNER_PLACES_MAX_SESSIONS) {
      throw new ConvexError({
        code: "invalid_request",
        message: `At most ${RUNNER_PLACES_MAX_SESSIONS} sessions per read.`,
      });
    }
    const runners = new Map<string, Doc<"runners"> | null>();
    const answer: SessionPlaceRow[] = [];
    for (const sessionId of unique) {
      const runnerId = await visiblePlace(ctx, viewer, sessionId);
      if (runnerId === null) {
        answer.push({ sessionId, place: null });
        continue;
      }
      if (!runners.has(runnerId)) runners.set(runnerId, await runnerById(ctx, runnerId));
      const runner = runners.get(runnerId)!;
      answer.push({
        sessionId,
        place:
          runner === null
            ? null
            : {
                id: runner.id,
                name: runner.name,
                kind: runner.kind,
                status: runner.status,
                statusChangedAt: runner.statusChangedAt,
                statusReason: runner.statusReason,
                owned: runner.ownerUserId === viewer.userId,
              },
      });
    }
    return answer;
  },
});

/** One `runners.places` answer. */
export interface SessionPlaceRow {
  sessionId: string;
  place: RunnerPlace | null;
}

/** The Place of a Session the viewer can see, else `null` (every refusal reads the same). */
async function visiblePlace(
  ctx: QueryCtx,
  viewer: Viewer,
  sessionId: string,
): Promise<string | null> {
  if (!isUuid(sessionId)) return null;
  try {
    const { session } = await requireSessionVisible(ctx, sessionId, viewer);
    return session.placeRunnerId;
  } catch (error) {
    if (error instanceof ConvexError && (error.data as { code?: unknown }).code === "not_found") {
      return null;
    }
    throw error;
  }
}

/** One of the caller's own runners, or `not_found` (someone else's reads the same). */
async function requireOwnRunner(ctx: MutationCtx, runnerId: string) {
  const { userId } = await requireViewer(ctx);
  const runner = await runnerById(ctx, parseId("runner", runnerId));
  if (runner === null || runner.ownerUserId !== userId || isGone(runner)) {
    throw authError("not_found", "That runner does not exist.");
  }
  return { userId, runner };
}

export const rename = mutation({
  args: { runnerId: v.string(), name: v.string() },
  handler: async (ctx, { runnerId, name }): Promise<{ name: string }> => {
    const { userId, runner } = await requireOwnRunner(ctx, runnerId);
    const slug = runnerNameSlug(name);
    if (slug === null) throw authError("forbidden", "A runner name needs a letter or a digit.");
    if (slug === runner.name) return { name: slug };
    if ((await namesTaken(ctx, userId, runner.id)).has(slug)) {
      throw authError("forbidden", `You already have a runner named ${slug}.`);
    }
    await ctx.db.patch(runner._id, { name: slug });
    return { name: slug };
  },
});

/** Removes a runner: its credential is deleted and it is refused at once. Idempotent. */
export const remove = mutation({
  args: { runnerId: v.string() },
  handler: async (ctx, { runnerId }): Promise<null> => {
    const { userId } = await requireViewer(ctx);
    const runner = await runnerById(ctx, parseId("runner", runnerId));
    if (runner === null || runner.ownerUserId !== userId) {
      throw authError("not_found", "That runner does not exist.");
    }
    if (!isGone(runner)) {
      await revokeRunner(ctx, runner, RUNNER_STATUS_REASONS.removed, { by: userId });
    }
    return null;
  },
});

// Install tokens ("Add a Linux runner").

export const recordInstallToken = internalMutation({
  args: {
    id: v.string(),
    tokenHash: v.string(),
    nameHint: nullable(v.string()),
    defaultWorkspaceId: nullable(v.string()),
  },
  handler: async (ctx, args): Promise<{ expiresAt: number }> => {
    const { userId } = await requireViewer(ctx);
    const expiresAt = Date.now() + RUNNER_INSTALL_TOKEN_TTL_MS;
    await ctx.db.insert("runnerInstallTokens", {
      id: requireUuid(args.id, "installTokenId"),
      tokenHash: args.tokenHash,
      createdByUserId: userId,
      nameHint: args.nameHint === null ? null : runnerNameSlug(args.nameHint),
      defaultWorkspaceId:
        args.defaultWorkspaceId === null ? null : parseId("workspace", args.defaultWorkspaceId),
      expiresAt,
      usedAt: null,
      usedByRunnerId: null,
      revokedAt: null,
    });
    return { expiresAt };
  },
});

/** Mints a one-time install token, valid for an hour. The token is returned once; Convex keeps its hash. */
export const createInstallToken = action({
  args: { nameHint: nullable(v.string()), defaultWorkspaceId: nullable(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ installTokenId: string; installToken: string; expiresAt: number }> => {
    const installToken = mintSecret(RUNNER_SECRET_PREFIXES.installToken);
    const installTokenId = crypto.randomUUID();
    const { expiresAt } = await ctx.runMutation(internal.runners.recordInstallToken, {
      id: installTokenId,
      tokenHash: secretHash(installToken),
      ...args,
    });
    return { installTokenId, installToken, expiresAt };
  },
});

export type InstallTokenStatus = {
  state: "waiting" | "used" | "expired" | "revoked";
  expiresAt: number;
  runner: { id: string; name: string; status: RunnerStatus } | null;
};

/** One of the caller's own install tokens, or `not_found`. */
async function requireOwnInstallToken(
  ctx: Parameters<typeof requireViewer>[0],
  installTokenId: string,
) {
  const { userId } = await requireViewer(ctx);
  const token = await ctx.db
    .query("runnerInstallTokens")
    .withIndex("by_uuid", (q) => q.eq("id", installTokenId))
    .unique();
  if (token === null || token.createdByUserId !== userId) {
    throw authError("not_found", "That install token does not exist.");
  }
  return token;
}

/** What the "Add a Linux runner" sheet waits on: the token used, and the runner it made. */
export const installTokenStatus = query({
  args: { installTokenId: v.string() },
  handler: async (ctx, { installTokenId }): Promise<InstallTokenStatus> => {
    const token = await requireOwnInstallToken(ctx, installTokenId);
    const runner =
      token.usedByRunnerId === null ? null : await runnerById(ctx, token.usedByRunnerId);
    const state =
      token.revokedAt !== null
        ? "revoked"
        : token.usedAt !== null
          ? "used"
          : token.expiresAt <= Date.now()
            ? "expired"
            : "waiting";
    return {
      state,
      expiresAt: token.expiresAt,
      runner: runner === null ? null : { id: runner.id, name: runner.name, status: runner.status },
    };
  },
});

export const revokeInstallToken = mutation({
  args: { installTokenId: v.string() },
  handler: async (ctx, { installTokenId }): Promise<null> => {
    const token = await requireOwnInstallToken(ctx, installTokenId);
    if (token.revokedAt === null && token.usedAt === null) {
      await ctx.db.patch(token._id, { revokedAt: Date.now() });
    }
    return null;
  },
});

// The desktop's own Mac.

/**
 * The runner a re-registering Mac may succeed: one of `ownerUserId`'s own Mac
 * runners that is neither gone nor still heartbeating in a live status,
 * registering again as a Mac. Anything else (nothing named, a malformed or
 * unknown id, someone else's runner, another kind, a removed or already
 * replaced runner) is `null`, read the same way.
 */
async function replaceableRunner(
  ctx: Reader,
  ownerUserId: string,
  kind: RunnerKind,
  runnerId: string | null | undefined,
): Promise<Doc<"runners"> | null> {
  if (kind !== "mac" || typeof runnerId !== "string" || !isUuid(runnerId)) return null;
  const runner = await runnerById(ctx, runnerId);
  if (runner === null || runner.ownerUserId !== ownerUserId) return null;
  if (runner.kind !== "mac" || isGone(runner)) return null;
  if (LIVE_RUNNER_STATUSES.some((status) => status === runner.status)) {
    const presence = await ctx.db
      .query("runnerPresence")
      .withIndex("by_runner", (q) => q.eq("runnerId", runner.id))
      .unique();
    if (presence !== null && Date.now() - presence.lastHeartbeatAt <= RUNNER_OFFLINE_AFTER_MS) {
      return null;
    }
  }
  return runner;
}

/** A lost registration reply may replace only the caller's never-used first credential. */
async function retryDesktopRegistration(
  ctx: Writer,
  ownerUserId: string,
  registrationId: string,
  credentialHash: string,
): Promise<IssuedGrant | null> {
  const owned = await ctx.db
    .query("runners")
    .withIndex("by_owner_name", (q) => q.eq("ownerUserId", ownerUserId))
    .collect();
  for (const runner of owned) {
    if (runner.desktopRegistrationId !== registrationId || isGone(runner)) continue;
    const credentials = await credentialsOf(ctx, runner.id);
    // A token exchange advances generation even before the first runner write.
    if (credentials?.generation !== 1 || credentials.currentFirstUsedAt !== null) continue;
    await ctx.db.patch(credentials._id, { currentHash: credentialHash });
    return {
      runnerId: parseId("runner", runner.id),
      name: runner.name,
      generation: credentials.generation,
    };
  }
  return null;
}

/**
 * Moves one page of a replaced runner's work to its successor, and returns
 * whether more may remain:
 * - every Session claim it held passes to the successor at the next claim
 *   generation, so a write fenced by the old claim is refused;
 * - every Session placed on it is placed on the successor, and its viewers
 *   (indexed by the claimed runner) follow;
 * - its open jobs (queued, or leased: the lease keeps its boot and attempt,
 *   so the successor's next claim takes back one an earlier boot held, and
 *   the same process may still complete its own) follow, except jobs naming
 *   a Working copy: Working copies stay on the runner that reported them,
 *   and a job's Working copy is always on the job's runner.
 * A moved row leaves the old runner's index, so a continuation simply runs
 * this again.
 */
async function moveRunnerWork(ctx: Writer, from: string, to: string): Promise<boolean> {
  const intakes = await ctx.db
    .query("sessionIntake")
    .withIndex("by_runner", (q) => q.eq("claim.runnerId", from))
    .take(SWEEP_PAGE_SIZE);
  for (const intake of intakes) {
    await ctx.db.patch(intake._id, {
      claim: { runnerId: to, generation: intake.claim.generation + 1 },
    });
  }
  const sessions = await ctx.db
    .query("sessions")
    .withIndex("by_place_runner", (q) => q.eq("placeRunnerId", from))
    .take(SWEEP_PAGE_SIZE);
  for (const session of sessions) await ctx.db.patch(session._id, { placeRunnerId: to });
  const viewers = await ctx.db
    .query("sessionViewers")
    .withIndex("by_runner", (q) => q.eq("runnerId", from))
    .take(SWEEP_PAGE_SIZE);
  for (const viewer of viewers) await ctx.db.patch(viewer._id, { runnerId: to });
  let jobsLeft = false;
  for (const status of ["queued", "leased"] as const) {
    const jobs = await ctx.db
      .query("runnerJobs")
      .withIndex("by_runner_ready", (q) => q.eq("runnerId", from).eq("status", status))
      .filter((q) => q.eq(q.field("workingCopyId"), null))
      .take(SWEEP_PAGE_SIZE);
    for (const job of jobs) await ctx.db.patch(job._id, { runnerId: to });
    if (jobs.length === SWEEP_PAGE_SIZE) jobsLeft = true;
  }
  return jobsLeft || [intakes, sessions, viewers].some((rows) => rows.length === SWEEP_PAGE_SIZE);
}

/** The rest of a replaced runner's work, a page per run, when it had more than one page. */
export const moveReplacedWork = internalMutation({
  args: { from: v.string(), to: v.string() },
  handler: async (ctx, { from, to }): Promise<null> => {
    if (await moveRunnerWork(ctx, from, to)) {
      await ctx.scheduler.runAfter(0, internal.runners.moveReplacedWork, { from, to });
    }
    return null;
  },
});

export const linkFromDesktop = internalMutation({
  args: {
    credentialHash: v.string(),
    host: v.any(),
    name: nullable(v.string()),
    replacesRunnerId: v.optional(nullable(v.string())),
    registrationId: v.optional(nullable(v.string())),
  },
  handler: async (ctx, args): Promise<IssuedGrant> => {
    const { userId, user } = await requireViewer(ctx);
    if (user.status !== "active") {
      throw authError("account_deleted", "This account is being deleted.");
    }
    const host = parsed(parseRunnerHostFacts, args.host);
    const kind = runnerKindForOs(host.platform.os);
    const registrationId = isUuid(args.registrationId) ? args.registrationId : undefined;
    if (registrationId !== undefined) {
      const retry = await retryDesktopRegistration(
        ctx,
        userId,
        registrationId,
        args.credentialHash,
      );
      if (retry !== null) return retry;
    }
    const replaced = await replaceableRunner(ctx, userId, kind, args.replacesRunnerId);
    const grant = await createRunner(ctx, {
      ownerUserId: userId,
      kind,
      linkedVia: "desktop",
      host,
      // A successor keeps the name the person knows the Mac by.
      name: replaced?.name ?? args.name,
      nameHint: null,
      credentialHash: args.credentialHash,
      ...(registrationId === undefined ? {} : { desktopRegistrationId: registrationId }),
      ...(replaced === null ? {} : { replaces: replaced.id }),
    });
    if (replaced !== null) {
      await revokeRunner(ctx, replaced, RUNNER_STATUS_REASONS.replaced, {
        by: userId,
        successor: grant.runnerId,
      });
      if (await moveRunnerWork(ctx, replaced.id, grant.runnerId)) {
        await ctx.scheduler.runAfter(0, internal.runners.moveReplacedWork, {
          from: replaced.id,
          to: grant.runnerId,
        });
      }
    }
    return grant;
  },
});

/**
 * The signed-in desktop registers the machine it runs on. Returns the same
 * grant a box gets from linking; the desktop seals the credential locally.
 * `replacesRunnerId` is the runner this Mac was before it lost its
 * credential: when it is the caller's own Mac runner, the new one succeeds it
 * (see the module comment); otherwise it is ignored. `registrationId` is a
 * client-minted lowercase UUID retained across retries until the first
 * credential is used; null, omitted or malformed ids are ignored.
 */
export const registerThisMac = action({
  args: {
    host: v.any(),
    name: nullable(v.string()),
    replacesRunnerId: v.optional(nullable(v.string())),
    registrationId: v.optional(nullable(v.string())),
  },
  handler: async (ctx, args): Promise<RunnerLinkGrant> => {
    const credential = mintSecret(RUNNER_SECRET_PREFIXES.credential);
    const grant = await ctx.runMutation(internal.runners.linkFromDesktop, {
      credentialHash: secretHash(credential),
      ...args,
    });
    return { ...grant, credential };
  },
});

// Device codes ("Link a runner").

type LinkLookup =
  | { ok: true; request: Doc<"runnerLinkRequests"> }
  | { ok: false; code: "not_found" | "rate_limited" };

/**
 * Finds the pending request a typed code names, counting misses per person.
 * Returns instead of throwing, so a miss is recorded (a throw would roll the
 * count back).
 */
async function lookupLinkCode(
  ctx: MutationCtx,
  userId: UserId,
  userCode: string,
): Promise<LinkLookup> {
  const now = Date.now();
  const attempts = await ctx.db
    .query("runnerLinkAttempts")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  const inWindow = attempts !== null && now - attempts.windowStartedAt < LINK_ATTEMPT_WINDOW_MS;
  if (inWindow && attempts.failures >= LINK_ATTEMPT_MAX_FAILURES)
    return { ok: false, code: "rate_limited" };
  const code = normalizeUserCode(userCode);
  const request =
    code === null
      ? null
      : await ctx.db
          .query("runnerLinkRequests")
          .withIndex("by_code", (q) =>
            q.eq("userCodeHash", secretHash(code)).eq("status", "pending"),
          )
          .first();
  if (request !== null && request.expiresAt > now) return { ok: true, request };
  if (request !== null) await ctx.db.patch(request._id, { status: "expired" });
  if (attempts === null) {
    await ctx.db.insert("runnerLinkAttempts", { userId, windowStartedAt: now, failures: 1 });
  } else if (inWindow) {
    await ctx.db.patch(attempts._id, { failures: attempts.failures + 1 });
  } else {
    await ctx.db.patch(attempts._id, { windowStartedAt: now, failures: 1 });
  }
  return { ok: false, code: "not_found" };
}

export type LinkPreview =
  | {
      ok: true;
      requestId: string;
      hostname: string;
      os: string;
      distro: string | null;
      arch: string;
      /** As the edge reported it; a hint, not proof. */
      ip: string | null;
      requestedAt: number;
      expiresAt: number;
    }
  | { ok: false; code: "not_found" | "rate_limited" };

/**
 * What the approval sheet shows before the person confirms: which machine is
 * asking. A mutation, because every miss counts against the person's limit.
 */
export const previewLink = mutation({
  args: { userCode: v.string() },
  handler: async (ctx, { userCode }): Promise<LinkPreview> => {
    const { userId } = await requireViewer(ctx);
    const found = await lookupLinkCode(ctx, userId, userCode);
    if (!found.ok) return found;
    const { request } = found;
    return {
      ok: true,
      requestId: request.id,
      hostname: request.host.hostname,
      os: request.host.os,
      distro: request.host.distro,
      arch: request.host.arch,
      ip: request.host.ip,
      requestedAt: request.createdAt,
      expiresAt: request.expiresAt,
    };
  },
});

/** Approves (the box becomes the caller's runner at its next poll) or denies a device code. */
export const decideLink = mutation({
  args: {
    // The request the person previewed: the decision applies to that machine only.
    requestId: v.string(),
    userCode: v.string(),
    decision: v.union(v.literal("approve"), v.literal("deny")),
  },
  handler: async (
    ctx,
    { requestId, userCode, decision },
  ): Promise<
    { ok: true; requestId: string } | { ok: false; code: "not_found" | "rate_limited" }
  > => {
    const { userId } = await requireViewer(ctx);
    // A second click on Approve: already decided, by this person, the same way.
    const previewed = await ctx.db
      .query("runnerLinkRequests")
      .withIndex("by_uuid", (q) => q.eq("id", requestId))
      .unique();
    if (
      previewed?.status === "approved" &&
      decision === "approve" &&
      previewed.approvedByUserId === userId
    ) {
      return { ok: true, requestId };
    }
    const found = await lookupLinkCode(ctx, userId, userCode);
    if (!found.ok) return found;
    if (found.request.id !== requestId) return { ok: false, code: "not_found" };
    await ctx.db.patch(found.request._id, {
      status: decision === "approve" ? "approved" : "denied",
      approvedByUserId: decision === "approve" ? userId : null,
    });
    return { ok: true, requestId: found.request.id };
  },
});

// ── the box's side: `/runner/*` (internal; called by `runnerHttp.ts`) ────────

export type LinkFailure = {
  ok: false;
  code: "invalid_install_token" | "invalid_link_request" | "revoked" | "invalid_credential";
};

export const linkWithInstallToken = internalMutation({
  args: {
    tokenHash: v.string(),
    credentialHash: v.string(),
    host: v.any(),
    name: nullable(v.string()),
  },
  handler: async (ctx, args): Promise<({ ok: true } & IssuedGrant) | LinkFailure> => {
    const now = Date.now();
    const token = await ctx.db
      .query("runnerInstallTokens")
      .withIndex("by_token", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (
      token === null ||
      token.usedAt !== null ||
      token.revokedAt !== null ||
      token.expiresAt <= now ||
      (await activeUser(ctx, token.createdByUserId)) === null
    ) {
      return { ok: false, code: "invalid_install_token" };
    }
    const host = parsed(parseRunnerHostFacts, args.host);
    const grant = await createRunner(ctx, {
      ownerUserId: token.createdByUserId,
      kind: runnerKindForOs(host.platform.os),
      linkedVia: "install_token",
      host,
      name: args.name,
      nameHint: token.nameHint,
      credentialHash: args.credentialHash,
    });
    await ctx.db.patch(token._id, { usedAt: now, usedByRunnerId: grant.runnerId });
    return { ok: true, ...grant };
  },
});

export const startDeviceLink = internalMutation({
  args: {
    requestId: v.string(),
    userCodeHash: v.string(),
    pollSecretHash: v.string(),
    host: v.any(),
    ip: nullable(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: true; expiresAt: number } | { ok: false; code: "collision" }> => {
    // Codes are unique among pending requests, expired-but-unswept ones included.
    const clash = await ctx.db
      .query("runnerLinkRequests")
      .withIndex("by_code", (q) => q.eq("userCodeHash", args.userCodeHash).eq("status", "pending"))
      .first();
    if (clash !== null) return { ok: false, code: "collision" };
    const host = parsed(parseRunnerHostFacts, args.host);
    const now = Date.now();
    const expiresAt = now + RUNNER_LINK_REQUEST_TTL_MS;
    await ctx.db.insert("runnerLinkRequests", {
      id: requireUuid(args.requestId, "requestId"),
      userCodeHash: args.userCodeHash,
      pollSecretHash: args.pollSecretHash,
      host: {
        hostname: host.hostname,
        os: host.platform.os,
        distro: host.platform.distro,
        arch: host.platform.arch,
        ip: args.ip,
      },
      status: "pending",
      approvedByUserId: null,
      runnerId: null,
      expiresAt,
      createdAt: now,
      installMode: host.installMode,
    });
    return { ok: true, expiresAt };
  },
});

export const pollDeviceLink = internalMutation({
  args: { requestId: v.string(), pollSecretHash: v.string(), credentialHash: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { ok: true; status: "pending" | "denied" | "expired" }
    | ({ ok: true; status: "linked" } & IssuedGrant)
    | LinkFailure
  > => {
    const request = await ctx.db
      .query("runnerLinkRequests")
      .withIndex("by_poll_secret", (q) => q.eq("pollSecretHash", args.pollSecretHash))
      .unique();
    // A consumed request answered once; its credential is not handed out twice.
    if (request === null || request.id !== args.requestId || request.status === "consumed") {
      return { ok: false, code: "invalid_link_request" };
    }
    if (request.status === "pending" && request.expiresAt <= Date.now()) {
      await ctx.db.patch(request._id, { status: "expired" });
      return { ok: true, status: "expired" };
    }
    if (request.status !== "approved") return { ok: true, status: request.status };
    const ownerUserId = request.approvedByUserId;
    if (ownerUserId === null || (await activeUser(ctx, ownerUserId)) === null) {
      await ctx.db.patch(request._id, { status: "denied" });
      return { ok: true, status: "denied" };
    }
    const grant = await createRunner(ctx, {
      ownerUserId,
      kind: runnerKindForOs(request.host.os),
      linkedVia: "device_code",
      host: {
        hostname: request.host.hostname,
        platform: {
          os: request.host.os,
          distro: request.host.distro,
          kernel: null,
          arch: request.host.arch,
          glibc: null,
        },
        installMode: request.installMode ?? "user",
      },
      name: null,
      nameHint: null,
      credentialHash: args.credentialHash,
    });
    await ctx.db.patch(request._id, { status: "consumed", runnerId: grant.runnerId });
    return { ok: true, status: "linked", ...grant };
  },
});

/**
 * One `/runner/token` exchange: the presented credential's successor becomes
 * current. Two slots, current and previous:
 * - the current credential rotates (it becomes previous, `nextHash` current);
 * - the previous one rotates again while the current one is unused
 *   (`currentFirstUsedAt` null): the box crashed before persisting it, or
 *   lost the reply. The unused one is dropped;
 * - the previous one after the current one was used is a copy: the runner
 *   is cut off, and its owner sees why;
 * - anything else is `invalid_credential` and changes nothing, so a stranger
 *   who knows a runner id cannot revoke it.
 * Returns instead of throwing, so a revocation is committed.
 */
export const rotateCredential = internalMutation({
  args: {
    runnerId: v.string(),
    presentedHash: v.string(),
    nextHash: v.string(),
    ip: nullable(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { ok: true; generation: number; ownerUserId: UserId; kind: RunnerKind }
    | { ok: false; code: "revoked" | "invalid_credential" }
  > => {
    const runner = await runnerById(ctx, args.runnerId);
    const credentials = runner === null ? null : await credentialsOf(ctx, runner.id);
    // An unknown id reads like a wrong credential: an id alone reveals nothing.
    if (runner === null) return { ok: false, code: "invalid_credential" };
    if (
      runner.revokedAt !== null ||
      credentials === null ||
      (await activeUser(ctx, runner.ownerUserId)) === null
    ) {
      return { ok: false, code: "revoked" };
    }
    const now = Date.now();
    const generation = credentials.generation + 1;
    const used = { generation, rotatedAt: now, lastUsedAt: now, lastUsedIp: args.ip };
    if (args.presentedHash === credentials.currentHash) {
      await ctx.db.patch(credentials._id, {
        ...used,
        previousHash: credentials.currentHash,
        currentHash: args.nextHash,
        currentFirstUsedAt: null,
      });
    } else if (
      args.presentedHash === credentials.previousHash &&
      credentials.currentFirstUsedAt === null
    ) {
      await ctx.db.patch(credentials._id, { ...used, currentHash: args.nextHash });
    } else if (args.presentedHash === credentials.previousHash) {
      await revokeRunner(ctx, runner, RUNNER_STATUS_REASONS.credentialReuse, { ip: args.ip });
      return { ok: false, code: "revoked" };
    } else {
      return { ok: false, code: "invalid_credential" };
    }
    return { ok: true, generation, ownerUserId: runner.ownerUserId as UserId, kind: runner.kind };
  },
});

// ── the runner's own calls (runner token) ────────────────────────────────────

const load = v.object({
  activeSessions: v.number(),
  activeTurns: v.number(),
  queueDepth: v.number(),
  freeDiskMb: v.number(),
  freeMemMb: v.number(),
});

/**
 * Every 30 s. Writes presence (never subscribed), flips `offline`, `stopped`
 * or `asleep` to `online` on the first beat after silence or sleep, and
 * answers with what the runner should run.
 */
export const heartbeat = mutation({
  args: { bootId: v.string(), load },
  handler: async (ctx, args): Promise<RunnerHeartbeatReply> => {
    const { runner } = await requireRunnerForWrite(ctx);
    const now = Date.now();
    const { ip } = await ctx.meta.getRequestMetadata();
    const bootId = args.bootId.slice(0, MAX_BOOT_ID_LENGTH);
    const presence = await ctx.db
      .query("runnerPresence")
      .withIndex("by_runner", (q) => q.eq("runnerId", runner.id))
      .unique();
    if (presence === null) {
      await ctx.db.insert("runnerPresence", {
        runnerId: runner.id,
        lastHeartbeatAt: now,
        bootId,
        load: args.load,
        lastIp: ip,
      });
    } else {
      await ctx.db.patch(presence._id, {
        lastHeartbeatAt: now,
        bootId,
        load: args.load,
        lastIp: ip,
      });
    }
    const status =
      runner.status === "offline" || runner.status === "stopped" || runner.status === "asleep"
        ? await setStatus(ctx, runner, "online", null)
        : runner.status;
    const release = await ctx.db
      .query("releaseChannels")
      .withIndex("by_channel", (q) => q.eq("channel", runner.autoUpdate.channel))
      .unique();
    return {
      serverTime: now,
      status,
      targetVersion: runner.autoUpdate.pinnedVersion ?? release?.version ?? null,
      minVersion: release?.minVersion ?? null,
      autoUpdate: runner.autoUpdate,
    };
  },
});

/**
 * A transition the runner reports itself: `draining`, `updating`,
 * `degraded(reason)`, `stopped`, `asleep` (a Mac going to sleep), back to
 * `online`.
 */
export const reportState = mutation({
  args: {
    state: v.union(...RUNNER_REPORTED_STATES.map((state) => v.literal(state))),
    reason: nullable(v.string()),
  },
  handler: async (ctx, { state, reason }): Promise<{ status: RunnerStatus }> => {
    const { runner } = await requireRunnerForWrite(ctx);
    // `upgrade_required` is the backend's verdict; only an update clears it.
    if (runner.status === "upgrade_required" && state === "online") {
      return { status: runner.status };
    }
    const status = await setStatus(
      ctx,
      runner,
      state,
      reason === null ? null : reason.slice(0, MAX_REASON_LENGTH),
    );
    return { status };
  },
});

/** Sent on connect and on change. Writes the row only when something differs. */
export const reportCapabilities = mutation({
  args: { report: v.any() },
  handler: async (ctx, args): Promise<{ changed: boolean }> => {
    const { runner } = await requireRunnerForWrite(ctx);
    const report = parsed(parseRunnerCapabilityReport, args.report);
    const next = {
      version: report.version,
      platform: report.platform,
      installMode: report.installMode,
      capabilities: report.capabilities,
    };
    const current = {
      version: runner.version,
      platform: runner.platform,
      installMode: runner.installMode,
      capabilities: runner.capabilities as unknown,
    };
    let changed = stableJson(next) !== stableJson(current);
    if (changed) await ctx.db.patch(runner._id, next);
    const stored = await ctx.db
      .query("runnerLocalCredentials")
      .withIndex("by_runner", (q) => q.eq("runnerId", runner.id))
      .collect();
    if (credentialSetKey(stored) !== credentialSetKey(report.localCredentials)) {
      changed = true;
      for (const row of stored) await ctx.db.delete(row._id);
      for (const credential of report.localCredentials) {
        await ctx.db.insert("runnerLocalCredentials", { runnerId: runner.id, ...credential });
      }
    }
    return { changed };
  },
});

/** A local-credential set compared by value, order-free. */
function credentialSetKey(rows: { providerId: string; kind: string; expiresAt: number | null }[]) {
  return rows
    .map(({ providerId, kind, expiresAt }) => JSON.stringify([providerId, kind, expiresAt]))
    .toSorted()
    .join("\n");
}

// ── Convex's own: the offline sweep and the expiry cleanup (crons.ts) ─────────

/**
 * Marks `offline` every live runner silent for more than 90 s. One page of one
 * live status per run; a full page continues at once, and the next status
 * follows, so the work stays bounded however many runners there are.
 */
export const sweepOffline = internalMutation({
  args: { statusIndex: v.number(), cursor: nullable(v.string()) },
  handler: async (ctx, { statusIndex, cursor }): Promise<{ marked: number }> => {
    const status = LIVE_RUNNER_STATUSES[statusIndex];
    if (status === undefined) return { marked: 0 };
    const now = Date.now();
    const page = await ctx.db
      .query("runners")
      .withIndex("by_status", (q) => q.eq("status", status))
      .paginate({ numItems: SWEEP_PAGE_SIZE, cursor });
    let marked = 0;
    for (const runner of page.page) {
      const presence = await ctx.db
        .query("runnerPresence")
        .withIndex("by_runner", (q) => q.eq("runnerId", runner.id))
        .unique();
      // A state report counts as a sign of life too.
      const lastSeen = Math.max(presence?.lastHeartbeatAt ?? 0, runner.statusChangedAt);
      if (now - lastSeen > RUNNER_OFFLINE_AFTER_MS) {
        await setStatus(ctx, runner, "offline", RUNNER_STATUS_REASONS.heartbeatLost);
        marked += 1;
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.runners.sweepOffline, {
        statusIndex,
        cursor: page.continueCursor,
      });
    } else if (statusIndex + 1 < LIVE_RUNNER_STATUSES.length) {
      await ctx.scheduler.runAfter(0, internal.runners.sweepOffline, {
        statusIndex: statusIndex + 1,
        cursor: null,
      });
    }
    return { marked };
  },
});

/** Deletes link rows a day past expiry and audit events past 90 days, a page at a time. */
export const sweepExpired = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ deleted: number }> => {
    const now = Date.now();
    const linkCutoff = now - EXPIRED_LINK_ROW_RETENTION_MS;
    const tokens = await ctx.db
      .query("runnerInstallTokens")
      .withIndex("by_expiry", (q) => q.lt("expiresAt", linkCutoff))
      .take(SWEEP_PAGE_SIZE);
    const requests = await ctx.db
      .query("runnerLinkRequests")
      .withIndex("by_expiry", (q) => q.lt("expiresAt", linkCutoff))
      .take(SWEEP_PAGE_SIZE);
    const events = await ctx.db
      .query("runnerEvents")
      .withIndex("by_at", (q) => q.lt("at", now - RUNNER_EVENT_RETENTION_MS))
      .take(SWEEP_PAGE_SIZE);
    for (const row of [...tokens, ...requests, ...events]) await ctx.db.delete(row._id);
    if ([tokens, requests, events].some((rows) => rows.length === SWEEP_PAGE_SIZE)) {
      await ctx.scheduler.runAfter(0, internal.runners.sweepExpired, {});
    }
    return { deleted: tokens.length + requests.length + events.length };
  },
});
