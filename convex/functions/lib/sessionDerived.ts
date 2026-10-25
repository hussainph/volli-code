/**
 * What an accepted fact derives beyond the fold itself: the turn index, the
 * owner's attention items (written through `attention.ts`, their one writer),
 * the second job receipt, and the listing row. Each
 * writer is idempotent (an upsert by a frozen id), so a refold that passes a
 * fact again lands on the same rows.
 */

import {
  EMPTY_SESSION_USAGE_SUMMARY,
  sessionListingActivity,
  sessionListingWaitingOn,
  type SessionEvent,
  type SessionEventPayload,
} from "@volli/shared";
import type { CloudSessionView } from "@volli/shared/cloud";

import type { Doc } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server";
import { onSessionFact } from "./watches";
import {
  SESSION_BLOCKED_SOURCE_ID,
  clearSessionAttention,
  raiseSessionAttention,
} from "./attention";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** JSON with object keys sorted, so two encodings of one value compare equal. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// ── what one fact derives ───────────────────────────────────────────────────

export async function deriveFromFact(
  ctx: MutationCtx,
  session: Doc<"sessions">,
  fact: SessionEvent,
  before: CloudSessionView | null,
  after: CloudSessionView,
): Promise<void> {
  await onSessionFact(ctx, session, fact, after);
  const { payload } = fact;
  switch (payload.kind) {
    case "attention.raised":
      await raiseSessionAttention(ctx, session, {
        source: "session_attention",
        sourceId: payload.attention.id,
        kind: payload.attention.kind,
        title: ATTENTION_TITLES[payload.attention.kind],
        detail: payload.attention.detail,
        raisedAt: fact.occurredAt,
      });
      break;
    case "attention.cleared":
      await clearSessionAttention(
        ctx,
        session.id,
        payload.attentionId,
        "resolved",
        fact.occurredAt,
      );
      break;
    case "interaction.opened":
      await raiseSessionAttention(ctx, session, {
        source: "interaction",
        sourceId: payload.interaction.id,
        kind: payload.interaction.kind,
        title: payload.interaction.title,
        detail: payload.interaction.detail,
        raisedAt: fact.occurredAt,
      });
      break;
    case "interaction.resolved":
      await clearSessionAttention(
        ctx,
        session.id,
        payload.interactionId,
        "resolved",
        fact.occurredAt,
      );
      break;
    case "interaction.cancelled":
      await clearSessionAttention(
        ctx,
        session.id,
        payload.interactionId,
        "superseded",
        fact.occurredAt,
      );
      break;
    case "session.signaled":
      if (payload.signal === "blocked") {
        await raiseSessionAttention(ctx, session, {
          source: "session_blocked",
          sourceId: SESSION_BLOCKED_SOURCE_ID,
          kind: "blocked",
          title: "Blocked",
          detail: payload.reason,
          raisedAt: fact.occurredAt,
        });
      } else {
        await clearSessionAttention(
          ctx,
          session.id,
          SESSION_BLOCKED_SOURCE_ID,
          "resolved",
          fact.occurredAt,
        );
      }
      break;
    case "command.receipt.recorded":
      await mirrorReceipt(ctx, session.id, payload.receipt);
      break;
    case "turn.started":
      await startTurn(ctx, session.id, fact, payload.turnId, payload.attachmentId, after);
      break;
    case "usage.recorded":
      if (payload.turnId !== null)
        await addTurnUsage(ctx, session.id, payload.turnId, payload.usage);
      break;
    default:
      break;
  }
  if (before?.turnActive === true && !after.turnActive && before.latestTurnId !== null) {
    await endTurn(ctx, session.id, before.latestTurnId, fact, after.lastTurnOutcome);
  }
  // An item that left the fold without its clearing fact was dropped by the
  // fold's cap: its row is cleared too, so Needs you agrees with the listing.
  if (before !== null) {
    const kept = new Set([
      ...after.attention.active.map(({ id }) => id),
      ...after.interactions.active.map(({ id }) => id),
    ]);
    for (const { id } of [...before.attention.active, ...before.interactions.active]) {
      if (!kept.has(id))
        await clearSessionAttention(ctx, session.id, id, "superseded", fact.occurredAt);
    }
  }
}

/** The Attention kinds' titles, as a Needs-you row names them. */
const ATTENTION_TITLES: Record<string, string> = {
  input_required: "Needs your input",
  permission_required: "Needs your permission",
  auth_required: "Needs you to sign in",
  configuration_invalid: "Configuration needs fixing",
  rate_limited: "Rate limited",
  quota_exhausted: "Quota exhausted",
  context_limit_reached: "Context limit reached",
  transport_retrying: "Reconnecting",
  partial_turn_interrupted: "Turn interrupted",
  adapter_disconnected: "Agent disconnected",
  adapter_unrecoverable: "Agent stopped",
};

/** The second receipt: the engine's verdict on a command, copied onto its job. */
async function mirrorReceipt(
  ctx: MutationCtx,
  sessionId: string,
  receipt: Extract<SessionEventPayload, { kind: "command.receipt.recorded" }>["receipt"],
): Promise<void> {
  const job = await ctx.db
    .query("runnerJobs")
    .withIndex("by_uuid", (q) => q.eq("id", receipt.commandId))
    .unique();
  if (job === null || job.sessionId !== sessionId) return;
  const mirrored = {
    status: receipt.status,
    code: receipt.status === "rejected" ? receipt.code : null,
    detail:
      receipt.status === "rejected" || receipt.status === "unreconciled" ? receipt.detail : null,
    at: receipt.recordedAt,
  };
  if (stableJson(job.receipt) !== stableJson(mirrored)) {
    await ctx.db.patch(job._id, { receipt: mirrored });
  }
}

async function turnRow(ctx: MutationCtx, sessionId: string, turnId: string) {
  return ctx.db
    .query("sessionTurns")
    .withIndex("by_session_turn", (q) => q.eq("sessionId", sessionId).eq("turnId", turnId))
    .first();
}

async function startTurn(
  ctx: MutationCtx,
  sessionId: string,
  fact: SessionEvent,
  turnId: string,
  attachmentId: string,
  after: CloudSessionView,
): Promise<void> {
  const fields = {
    attachmentId,
    startedSequence: fact.sequence,
    endedSequence: null,
    outcome: null,
    origin: after.latestTurnOrigin,
    startedAt: fact.occurredAt,
    endedAt: null,
  };
  const existing = await turnRow(ctx, sessionId, turnId);
  if (existing === null) {
    await ctx.db.insert("sessionTurns", {
      sessionId,
      turnId,
      usage: null,
      segmentId: null,
      ...fields,
    });
  } else if (existing.startedSequence === fact.sequence) {
    // A refold replaying the same start: its usage is re-added from the facts.
    await ctx.db.patch(existing._id, { ...fields, usage: null });
  }
}

async function endTurn(
  ctx: MutationCtx,
  sessionId: string,
  turnId: string,
  fact: SessionEvent,
  outcome: string | null,
): Promise<void> {
  const existing = await turnRow(ctx, sessionId, turnId);
  if (existing !== null) {
    await ctx.db.patch(existing._id, {
      endedSequence: fact.sequence,
      outcome,
      endedAt: fact.occurredAt,
    });
  }
}

/** What a turn spent, summed over its `usage.recorded` facts. */
interface TurnUsage {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Over priced operations only; null when none was priced. */
  knownCostUsd: number | null;
}

async function addTurnUsage(
  ctx: MutationCtx,
  sessionId: string,
  turnId: string,
  usage: Extract<SessionEventPayload, { kind: "usage.recorded" }>["usage"],
): Promise<void> {
  const existing = await turnRow(ctx, sessionId, turnId);
  if (existing === null) return;
  const total: TurnUsage = (existing.usage as TurnUsage | null) ?? {
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    knownCostUsd: null,
  };
  await ctx.db.patch(existing._id, {
    usage: {
      requestCount: total.requestCount + 1,
      inputTokens: total.inputTokens + (usage.inputTokens ?? 0),
      outputTokens: total.outputTokens + (usage.outputTokens ?? 0),
      cacheReadTokens: total.cacheReadTokens + (usage.cacheReadTokens ?? 0),
      cacheWriteTokens: total.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
      knownCostUsd:
        usage.costUsd === null ? total.knownCostUsd : (total.knownCostUsd ?? 0) + usage.costUsd,
    } satisfies TurnUsage,
  });
}

// ── the listing row ─────────────────────────────────────────────────────────

/** What the listing row shows of a Session's spend. */
interface UsageTotals {
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  coverage: CloudSessionView["usage"]["costCoverage"];
  /** Additive: older clients keep reading the coarse totals above. */
  summary: CloudSessionView["usage"];
}

export const EMPTY_USAGE_TOTALS: UsageTotals = {
  costUsd: null,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  coverage: "unavailable",
  summary: EMPTY_SESSION_USAGE_SUMMARY,
};

type ListingFields = Pick<
  Doc<"sessions">,
  | "title"
  | "status"
  | "turnActive"
  | "lastTurnOutcome"
  | "signal"
  | "stopped"
  | "needsUser"
  | "attentionCount"
  | "model"
  | "listing"
>;

/** The listing rule's answer for a fold, as the row stores it (`sessions.listing`). */
export function listingOf(view: CloudSessionView): NonNullable<Doc<"sessions">["listing"]> {
  // On the ledger the executor binding is the fold's open attachment.
  const live = view.liveAttachment !== null;
  return {
    activity: sessionListingActivity(view, live),
    waitingOn: sessionListingWaitingOn(view),
    live,
    bornTicketless: view.bornTicketless,
  };
}

/** The listing-visible fields of a fold, as the row stores them. */
function listingFieldsOf(view: CloudSessionView): ListingFields {
  return {
    title: view.session.title,
    status: view.status,
    turnActive: view.turnActive,
    lastTurnOutcome: view.lastTurnOutcome,
    signal:
      view.signal === null
        ? null
        : { signal: view.signal.signal, reason: view.signal.reason, at: view.signal.occurredAt },
    stopped: view.stopped === null ? null : { at: view.stopped.at, reason: view.stopped.reason },
    needsUser: view.needsUser,
    attentionCount: view.attention.active.length + view.interactions.active.length,
    model:
      view.modelSelection === null
        ? null
        : {
            providerId: view.modelSelection.providerId,
            modelId: view.modelSelection.modelId,
            reasoningLevel: view.modelSelection.reasoningLevel,
            // The model gateway adds backend connections; today every selection is local.
            connectionId: "local",
          },
    listing: listingOf(view),
  };
}

function usageTotalsOf(view: CloudSessionView): UsageTotals {
  return {
    costUsd: view.usage.knownCostUsd,
    inputTokens: view.usage.inputTokens,
    outputTokens: view.usage.outputTokens,
    cacheReadTokens: view.usage.cacheReadTokens,
    cacheWriteTokens: view.usage.cacheWriteTokens,
    coverage: view.usage.costCoverage,
    summary: view.usage,
  };
}

/**
 * Writes the listing row only when something a list shows changed, so a list
 * subscription does not re-run on every fact. Spend and recency are coarse:
 * they ride along with another change (a turn starting or ending, a signal, an
 * attention change), and spend alone is written only between turns, so a busy
 * turn's usage facts do not churn the list. The snapshot carries them exactly.
 */
export async function syncListing(
  ctx: MutationCtx,
  session: Doc<"sessions">,
  view: CloudSessionView,
): Promise<void> {
  const current = (await ctx.db.get(session._id))!;
  const fields = listingFieldsOf(view);
  const changed: Partial<Doc<"sessions">> = {};
  for (const [key, value] of Object.entries(fields) as [keyof ListingFields, unknown][]) {
    if (stableJson(current[key]) !== stableJson(value)) {
      (changed as Record<string, unknown>)[key] = value;
    }
  }
  const usageTotals = usageTotalsOf(view);
  const usageChanged = stableJson(current.usageTotals) !== stableJson(usageTotals);
  const primary = Object.keys(changed).length > 0;
  if (primary || (usageChanged && !view.turnActive)) {
    if (usageChanged) changed.usageTotals = usageTotals;
    if (current.lastActivityAt !== view.lastActivityAt)
      changed.lastActivityAt = view.lastActivityAt;
  }
  if (Object.keys(changed).length > 0) await ctx.db.patch(session._id, changed);
}
