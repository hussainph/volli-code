/**
 * Sessions on the cloud ledger: the intake a runner's drain calls, the
 * command door a client calls, and the reads every client renders from.
 *
 * - `accept` (runner): the claimed runner's facts, in order, idempotent. The
 *   rules are in `lib/sessionIntake.ts`.
 * - `command` (client): a person's intent for their Session (or an agent's,
 *   acting for the Session owner through its runner, within its supervision
 *   scope: `lib/sessionCommands.ts`), queued as a `session.command` job for
 *   the Session's runner, with a message's body staged beside it in the same
 *   transaction. The job row is the first receipt (`queued`); the engine's
 *   own receipt, folded on accept, is the second.
 * - `snapshot`, `history`, `list`, `attention` (client): the Session's
 *   bounded current state, a window of its history by sequence, the listing
 *   rows of a project or ticket, and the viewer's open attention items. An
 *   agent (an Agent token, `lib/actorAuth.ts`) reads them as its Session's
 *   owner would.
 * - `catchUp`, `refold`, `transferClaim` (internal): the paged fold over the
 *   accepted history, and the claim move a clean handoff ends with.
 *
 * Session facts and folds cross this boundary as JSON text (the codec's wire
 * form), because their payloads carry object keys a Convex value refuses.
 * Everything a client reads is renderer-safe: adapter-native detail, executor
 * routing and diagnostics are scrubbed by the shared codec first.
 */

import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import {
  assertCloudInteractionReference,
  CLOUD_MESSAGE_MEDIA_TYPE,
  decodeSessionCommandIntent,
  encodeSessionJson,
  readCloudMessageBody,
  scrubSessionAttachment,
  scrubSessionAttachmentFailure,
  scrubSessionAttention,
  scrubSessionEvent,
  scrubSessionInteraction,
  sessionListingActivity,
  sessionListingWaitingOn,
  type SessionAttachmentProjection,
  type SessionCommandIntent,
} from "@volli/shared";
import {
  canSeeSession,
  cloudSessionView,
  INLINE_ARTIFACT_MAX_BYTES,
  SESSION_COMMAND_FORMAT,
  type CloudSessionState,
  type UserId,
  type WorkspaceId,
} from "@volli/shared/cloud";

import type { Doc } from "./_generated/dataModel.js";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  findMembership,
  findPolicy,
  requireProject,
  requireSessionActor,
  requireSessionVisible,
} from "./lib/auth";
import { attentionVisibility } from "./lib/attention";
import { PERSON_OR_AGENT, requireActor } from "./lib/actorAuth";
import { enqueueJob } from "./lib/jobs";
import { tryArmSessionWatch } from "./lib/watches";
import { listingOf } from "./lib/sessionDerived";
import { requireRunnerForWrite } from "./lib/runnerAuth";
import {
  checkCommandId,
  checkSupervision,
  readCommandArtifact,
  type CommandArtifact,
} from "./lib/sessionCommands";
import { stageArtifactRows } from "./transcripts";
import {
  acceptFacts,
  catchUpStep,
  readStoredFact,
  readStoredState,
  startRefold,
  type AcceptReply,
} from "./lib/sessionIntake";

/** A typed refusal: `{ code, message }`, as every function here throws. */
function fail(code: string, message: string) {
  return new ConvexError({ code, message });
}

// ── intake (runner) ─────────────────────────────────────────────────────────

/**
 * Accepts the next facts of a Session from its claimed runner. `events` are
 * the facts' JSON text, ascending and contiguous; a resend of accepted facts
 * is answered as duplicates. Errors carry a typed `code` and the current
 * `acceptedThrough`.
 */
export const accept = mutation({
  args: { sessionId: v.string(), generation: v.number(), events: v.array(v.string()) },
  handler: async (ctx, args): Promise<AcceptReply> => {
    const caller = await requireRunnerForWrite(ctx);
    return acceptFacts(ctx, caller, args);
  },
});

/** One step of the paged fold over the accepted history (scheduled, never called by a client). */
export const catchUp = internalMutation({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }) => {
    await catchUpStep(ctx, sessionId);
  },
});

/**
 * Folds a Session again from its first accepted fact: after a deploy that
 * learned a kind it had stored unread, or to repair a state. Derived rows are
 * written idempotently, so the end state matches a fold that never stopped.
 */
export const refold = internalMutation({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }): Promise<boolean> => startRefold(ctx, sessionId),
});

/**
 * Moves a Session's claim to another of its owner's runners: the last step
 * of a clean handoff, once the current runner has drained to `headSequence`.
 * The generation moves on, so the old runner's next accept is `fenced`; the
 * place label, open viewers and queued jobs follow the claim.
 */
export const transferClaim = internalMutation({
  args: { sessionId: v.string(), toRunnerId: v.string(), headSequence: v.number() },
  handler: async (ctx, { sessionId, toRunnerId, headSequence }) => {
    const intake = await ctx.db
      .query("sessionIntake")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .unique();
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_uuid", (q) => q.eq("id", sessionId))
      .unique();
    if (intake === null || session === null) throw fail("not_found", "No such session.");
    if (intake.acceptedThrough !== headSequence) {
      throw fail(
        "not_drained",
        `The session is accepted through ${intake.acceptedThrough}, not ${headSequence}.`,
      );
    }
    const runner = await ctx.db
      .query("runners")
      .withIndex("by_uuid", (q) => q.eq("id", toRunnerId))
      .unique();
    if (runner === null || runner.revokedAt !== null) throw fail("not_found", "No such runner.");
    if (runner.ownerUserId !== session.ownerUserId) {
      throw fail("not_your_runner", "A session only moves to its owner's runners.");
    }
    const generation = intake.claim.generation + 1;
    await ctx.db.patch(intake._id, {
      claim: { runnerId: toRunnerId, generation },
      state: "active",
    });
    await ctx.db.patch(session._id, { placeRunnerId: toRunnerId });
    for (const viewer of await ctx.db
      .query("sessionViewers")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect()) {
      await ctx.db.patch(viewer._id, { runnerId: toRunnerId });
    }
    // The old runner's queued jobs, not every job the Session ever had.
    for await (const job of ctx.db
      .query("runnerJobs")
      .withIndex("by_runner_ready", (q) =>
        q.eq("runnerId", intake.claim.runnerId).eq("status", "queued"),
      )) {
      if (job.sessionId === sessionId) await ctx.db.patch(job._id, { runnerId: toRunnerId });
    }
    return { generation };
  },
});

// ── commands (client) ───────────────────────────────────────────────────────

/** A checked message body, ready to stage beside its command. */
type StagedBody = Pick<CommandArtifact, "digest" | "mediaType" | "bytes" | "body">;

/**
 * Stages a command's message body for its Session through the transcript
 * staging rule (`stageArtifactRows`: once per digest, no referencing sequence
 * yet; the runner's own staging records it when the event is accepted).
 *
 * The body was checked against its digest; a row already staged under that
 * digest is not. A row holding the same bytes is this body. An inline row
 * holding other bytes cannot be this digest's (it is corrupt), so it takes
 * the checked body rather than be handed to a runner. A spilled row is left
 * as it is: its object is checked by digest wherever it is read.
 */
async function stageCommandBody(
  ctx: MutationCtx,
  session: Doc<"sessions">,
  staged: StagedBody,
): Promise<void> {
  const existing = await ctx.db
    .query("transcriptArtifacts")
    .withIndex("by_session_digest", (q) =>
      q.eq("sessionId", session.id).eq("digest", staged.digest),
    )
    .first();
  if (existing !== null && existing.body !== null && existing.body !== staged.body) {
    await ctx.db.patch(existing._id, {
      body: staged.body,
      bytes: staged.bytes,
      mediaType: staged.mediaType,
    });
  }
  await stageArtifactRows(
    ctx,
    { sessionId: session.id, projectId: session.projectId },
    [{ ...staged, spillKey: null, sequence: null }],
    "client",
    Date.now(),
  );
}

/** An intent's JSON text; a message body travels beside it as a transcript artifact, not in it. */
const MAX_INTENT_BYTES = 64 * 1024;

/**
 * A person's command for their own Session, or an agent's for a Session it
 * may supervise (`lib/sessionCommands.ts`), queued for the target's claimed
 * runner. `intent` is a `SessionCommandIntent`'s JSON text. Idempotent by
 * `commandId`: a retry with the same intent returns the same job, a
 * different intent under a used id is `id_taken`. An agent may use its tool
 * call's frozen `<callerSessionId>:<toolCallId>` operation id.
 *
 * A `message.submit`'s body, the canonical JSON of its transcript artifact
 * (at most 64 KB), may travel beside it, staged in this transaction so a
 * runner that never wrote it can hydrate it (`transcripts.commandArtifact`).
 * Two additive spellings, each checked by its own contract, at most one per
 * call (both is `invalid_request`, whatever they hold):
 *
 * - `body` (a person's client): the artifact the runtime writes for this
 *   command (`cloudMessageSubmit` in `@volli/shared` builds both), bound to
 *   this Session and command id.
 * - `artifact` (an agent's verb, `lib/sessionCommands.ts`): the message is
 *   `<commandId>:message`, text parts only. An agent's `message.submit` must
 *   carry it (never `body`): its target may be on another runner.
 *
 * A person's message without either is queued as before: its reference
 * names a body the runner holds itself. An interaction answer carries none:
 * its reference must be the one its intent derives. No other intent takes a
 * body.
 */
export const command = mutation({
  args: {
    sessionId: v.string(),
    commandId: v.string(),
    intent: v.string(),
    artifact: v.optional(v.string()),
    body: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const caller = await requireActor(ctx, PERSON_OR_AGENT);
    const { viewer, session } = await requireSessionActor(ctx, args.sessionId, caller.viewer);
    checkCommandId(caller, args.commandId);
    if (new TextEncoder().encode(args.intent).length > MAX_INTENT_BYTES) {
      throw fail("invalid_request", `An intent is limited to ${MAX_INTENT_BYTES} bytes.`);
    }
    let intent: Exclude<SessionCommandIntent, { kind: "session.create" }>;
    let intentJson: string;
    let isMessage = false;
    try {
      const decoded = decodeSessionCommandIntent(JSON.parse(args.intent), "intent");
      if (decoded.kind === "session.create") throw new Error("intent.kind creates a session");
      intent = decoded;
      intentJson = encodeSessionJson(decoded);
      isMessage = decoded.kind === "message.submit";
    } catch (error) {
      throw fail(
        "invalid_request",
        `The intent is not a Session command: ${error instanceof Error ? error.message : "unreadable"}.`,
      );
    }
    checkSupervision(caller, session, intent);
    const scope = { sessionId: session.id, commandId: args.commandId };
    let staged: StagedBody | null = null;
    if (args.body !== undefined && args.artifact !== undefined) {
      throw fail("invalid_request", "A message carries its body once: `body` or `artifact`.");
    }
    if (caller.kind === "agent" && args.body !== undefined) {
      throw fail("invalid_request", "An agent's message carries its body (`artifact`).");
    }
    if (
      (args.body !== undefined || args.artifact !== undefined) &&
      intent.kind !== "message.submit"
    ) {
      throw fail("invalid_request", "Only a message.submit carries a message body.");
    }
    if (intent.kind === "message.submit" && args.artifact !== undefined) {
      staged = await readCommandArtifact(args.artifact, intent, args.commandId);
    } else if (intent.kind === "message.submit" && args.body !== undefined) {
      if (new TextEncoder().encode(args.body).length > INLINE_ARTIFACT_MAX_BYTES) {
        throw fail(
          "invalid_request",
          `A message is limited to ${INLINE_ARTIFACT_MAX_BYTES} bytes.`,
        );
      }
      try {
        readCloudMessageBody({ ...scope, reference: intent.reference, body: args.body });
      } catch (error) {
        throw fail("invalid_request", error instanceof Error ? error.message : "Unreadable body.");
      }
      // Checked above: the reference's digest is the body's sha256.
      staged = {
        digest: intent.reference.digest!,
        mediaType: CLOUD_MESSAGE_MEDIA_TYPE,
        bytes: new TextEncoder().encode(args.body).length,
        body: args.body,
      };
    } else if (caller.kind === "agent" && intent.kind === "message.submit") {
      throw fail("invalid_request", "An agent's message carries its body (`artifact`).");
    } else if (intent.kind === "interaction.resolve") {
      try {
        assertCloudInteractionReference(scope, intent);
      } catch (error) {
        throw fail(
          "invalid_request",
          error instanceof Error ? error.message : "Unreadable answer.",
        );
      }
    }
    const intake = await ctx.db
      .query("sessionIntake")
      .withIndex("by_session", (q) => q.eq("sessionId", session.id))
      .unique();
    if (intake === null) throw fail("not_found", "That session does not exist.");
    // The inbox's own rules: idempotent by id (`id_taken` for another intent),
    // routed to the claimed runner, which must be the owner's.
    await enqueueJob(ctx, {
      id: args.commandId,
      runnerId: intake.claim.runnerId,
      kind: "session.command",
      projectId: session.projectId,
      sessionId: session.id,
      ticketId: session.ticketId,
      commandId: args.commandId,
      payload: { format: SESSION_COMMAND_FORMAT, intent: intentJson },
      createdBy: caller.actor,
      onBehalfOf: viewer.userId,
    });
    const watch =
      caller.kind === "agent" && isMessage
        ? await tryArmSessionWatch(ctx, {
            watcher: caller.agent.session,
            target: session,
            origin: "steered",
            actor: caller.actor,
            commandId: args.commandId,
          })
        : null;
    // Staged in the job's transaction: the job exists exactly when its body
    // does. Idempotent by digest, so a replay stages nothing twice.
    if (staged !== null) await stageCommandBody(ctx, session, staged);
    const job = (await ctx.db
      .query("runnerJobs")
      .withIndex("by_uuid", (q) => q.eq("id", args.commandId))
      .unique())!;
    const runner = await ctx.db
      .query("runners")
      .withIndex("by_uuid", (q) => q.eq("id", job.runnerId))
      .unique();
    return {
      commandId: job.id,
      ...(watch === null ? {} : { watch }),
      status: job.status,
      receipt: job.receipt,
      runner:
        runner === null
          ? null
          : { id: runner.id, name: runner.name, status: runner.status, kind: runner.kind },
    };
  },
});

// ── reads (client) ──────────────────────────────────────────────────────────

type SessionListing = NonNullable<Doc<"sessions">["listing"]>;

/**
 * A row's listing: as stored, or for a row written before `listing` existed,
 * answered from its fold (read only for such a row, so a current page reads
 * nothing more). With no fold yet the Session is as born: no fact has moved it.
 */
async function listingFor(
  ctx: QueryCtx,
  session: Doc<"sessions">,
  folded?: CloudSessionState | null,
): Promise<SessionListing> {
  if (session.listing !== undefined) return session.listing;
  const state =
    folded !== undefined
      ? folded
      : readStoredState(
          await ctx.db
            .query("sessionStates")
            .withIndex("by_session", (q) => q.eq("sessionId", session.id))
            .unique(),
        );
  if (state !== null) return listingOf(cloudSessionView(state));
  const born = {
    stopped: null,
    turnActive: false,
    lastTurnOutcome: null,
    attention: { active: [], primary: null },
    interactions: { active: [] },
  };
  return {
    activity: sessionListingActivity(born, false),
    waitingOn: sessionListingWaitingOn(born),
    live: false,
    bornTicketless: session.ticketId === null,
  };
}

/** A Session's listing row, as a list or a card shows it. */
function sessionSummary(session: Doc<"sessions">, listing: SessionListing) {
  return {
    id: session.id,
    projectId: session.projectId,
    ticketId: session.ticketId,
    role: session.role,
    parentSessionId: session.parentSessionId,
    ownerUserId: session.ownerUserId,
    origin: session.origin as unknown,
    title: session.title,
    visibility: session.visibility,
    status: session.status,
    turnActive: session.turnActive,
    lastTurnOutcome: session.lastTurnOutcome,
    signal: session.signal,
    stopped: session.stopped,
    needsUser: session.needsUser,
    attentionCount: session.attentionCount,
    placeRunnerId: session.placeRunnerId,
    model: session.model,
    usageTotals: session.usageTotals as unknown,
    listing,
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt,
  };
}

function scrubLiveAttachment(attachment: SessionAttachmentProjection | null) {
  if (attachment === null) return null;
  return {
    ...scrubSessionAttachment(attachment),
    failure: attachment.failure === null ? null : scrubSessionAttachmentFailure(attachment.failure),
  };
}

/**
 * The Session's current state: its listing row, how far it is folded, and
 * the bounded fold as renderer-safe JSON text (`state`, null until the first
 * fact is folded). `catchingUp` means a catch-up is still folding accepted
 * facts, so the state is behind the history.
 */
export const snapshot = query({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }) => {
    const { viewer } = await requireActor(ctx, PERSON_OR_AGENT);
    const { session } = await requireSessionVisible(ctx, sessionId, viewer);
    const doc = await ctx.db
      .query("sessionStates")
      .withIndex("by_session", (q) => q.eq("sessionId", session.id))
      .unique();
    const state = readStoredState(doc);
    const view = state === null ? null : cloudSessionView(state);
    return {
      session: sessionSummary(session, await listingFor(ctx, session, state)),
      foldedThrough: state?.throughSequence ?? 0,
      catchingUp: (doc?.catchUpAt ?? null) !== null,
      state:
        view === null
          ? null
          : JSON.stringify({
              ...view,
              liveAttachment: scrubLiveAttachment(view.liveAttachment),
              attention: {
                active: view.attention.active.map(scrubSessionAttention),
                primary:
                  view.attention.primary === null
                    ? null
                    : scrubSessionAttention(view.attention.primary),
                dropped: view.attention.dropped,
              },
              interactions: {
                active: view.interactions.active.map(scrubSessionInteraction),
                dropped: view.interactions.dropped,
              },
            }),
    };
  },
});

const HISTORY_DEFAULT_LIMIT = 100;
const HISTORY_MAX_LIMIT = 200;
/** A window stops early past this many stored bytes (it always holds at least one fact). */
const HISTORY_MAX_BYTES = 2 * 1024 * 1024;

function cursorArg(value: number | undefined, name: string): number | undefined {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new ConvexError({
      code: "invalid_request",
      message: `${name} must be a whole number ≥ 0.`,
    });
  }
  return value;
}

/**
 * A window of the Session's accepted facts by sequence: ascending after
 * `afterSequence` (default: from the start), or the newest ones before
 * `beforeSequence`. Each entry carries the renderer-safe event's JSON text;
 * a fact this build cannot read is listed with `status` and no event, so a
 * reader sees the gap rather than a silently shorter history.
 */
export const history = query({
  args: {
    sessionId: v.string(),
    afterSequence: v.optional(v.number()),
    beforeSequence: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const caller = await requireActor(ctx, PERSON_OR_AGENT);
    const { session } = await requireSessionVisible(ctx, args.sessionId, caller.viewer);
    const after = cursorArg(args.afterSequence, "afterSequence");
    const before = cursorArg(args.beforeSequence, "beforeSequence");
    const limit = Math.min(
      cursorArg(args.limit, "limit") ?? HISTORY_DEFAULT_LIMIT,
      HISTORY_MAX_LIMIT,
    );
    if (after !== undefined && before !== undefined) {
      throw new ConvexError({
        code: "invalid_request",
        message: "Give afterSequence or beforeSequence, not both.",
      });
    }
    const rows: Doc<"sessionEvents">[] = [];
    let bytes = 0;
    let hasMore = false;
    const range =
      before !== undefined
        ? ctx.db
            .query("sessionEvents")
            .withIndex("by_session_sequence", (q) =>
              q.eq("sessionId", session.id).lt("sequence", before),
            )
            .order("desc")
        : ctx.db
            .query("sessionEvents")
            .withIndex("by_session_sequence", (q) =>
              q.eq("sessionId", session.id).gt("sequence", after ?? 0),
            );
    if (limit > 0) {
      for await (const row of range) {
        if (rows.length >= limit || (rows.length > 0 && bytes + row.bytes > HISTORY_MAX_BYTES)) {
          hasMore = true;
          break;
        }
        rows.push(row);
        bytes += row.bytes;
      }
    }
    if (before !== undefined) rows.reverse();
    return {
      events: rows.map((row) => {
        // Read again with this build's codec: a kind it has learned since is
        // readable, and one retired since reads as unknown rather than failing.
        const read = row.quarantine === null ? readStoredFact(row) : null;
        const status =
          read === null
            ? "quarantined"
            : read.quarantine !== null
              ? "unreadable"
              : read.kindKnown
                ? "ok"
                : "unknown_kind";
        return {
          sequence: row.sequence,
          eventId: row.eventId,
          kind: row.kind,
          status,
          quarantine: row.quarantine,
          event:
            read !== null && read.quarantine === null && read.kindKnown
              ? JSON.stringify(scrubSessionEvent(read.event))
              : null,
        };
      }),
      hasMore,
    };
  },
});

function viewerCanSee(
  viewerId: UserId,
  session: Doc<"sessions">,
  workspaceId: string,
  membership: Awaited<ReturnType<typeof findMembership>>,
  policy: Awaited<ReturnType<typeof findPolicy>>,
): boolean {
  return (
    session.deletedAt === null &&
    canSeeSession(
      { userId: viewerId },
      { ownerUserId: session.ownerUserId as UserId, visibility: session.visibility },
      { workspaceId: workspaceId as WorkspaceId },
      membership,
      policy,
    )
  );
}

/**
 * The listing rows of a project's Sessions (or one ticket's), most recent
 * first, that the viewer may see. Pages follow Convex pagination; a page may
 * hold fewer rows than asked when some are not the viewer's to see.
 */
export const list = query({
  args: {
    projectId: v.string(),
    ticketId: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const caller = await requireActor(ctx, PERSON_OR_AGENT);
    const { viewer, project, membership } = await requireProject(
      ctx,
      args.projectId,
      caller.viewer,
    );
    const policy = await findPolicy(ctx, project.workspaceId);
    const ticketId = args.ticketId;
    const page =
      ticketId === undefined
        ? await ctx.db
            .query("sessions")
            .withIndex("by_project_activity", (q) => q.eq("projectId", project.id))
            .order("desc")
            .paginate(args.paginationOpts)
        : await ctx.db
            .query("sessions")
            .withIndex("by_ticket_activity", (q) => q.eq("ticketId", ticketId))
            .order("desc")
            .paginate(args.paginationOpts);
    const visible: ReturnType<typeof sessionSummary>[] = [];
    for (const session of page.page) {
      if (
        session.projectId === project.id &&
        viewerCanSee(viewer.userId, session, project.workspaceId, membership, policy)
      ) {
        visible.push(sessionSummary(session, await listingFor(ctx, session)));
      }
    }
    return { page: visible, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

const ATTENTION_LIMIT = 100;
/** Open items read at most, so a person with many items in projects they left stays cheap. */
const ATTENTION_SCAN_LIMIT = 500;

/**
 * The viewer's open attention items from their Sessions, newest first: all
 * of them, or one Session's. Items the viewer can no longer see (no longer an
 * active Member of the project's Workspace: `canSeeAttention`) are left out.
 */
export const attention = query({
  args: { sessionId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { viewer } = await requireActor(ctx, PERSON_OR_AGENT);
    let items: Doc<"attentionItems">[];
    if (args.sessionId !== undefined) {
      const { session } = await requireSessionVisible(ctx, args.sessionId, viewer);
      items = (
        await ctx.db
          .query("attentionItems")
          .withIndex("by_session", (q) => q.eq("sessionId", session.id).eq("clearedAt", null))
          .collect()
      )
        .filter((item) => item.userId === viewer.userId)
        .toSorted((left, right) => right.raisedAt - left.raisedAt)
        .slice(0, ATTENTION_LIMIT);
    } else {
      items = [];
      const canSee = attentionVisibility(ctx, viewer);
      const open = await ctx.db
        .query("attentionItems")
        .withIndex("by_user_open", (q) => q.eq("userId", viewer.userId).eq("clearedAt", null))
        .order("desc")
        .take(ATTENTION_SCAN_LIMIT);
      for (const item of open) {
        if (item.sessionId === null) continue;
        if (await canSee(item)) items.push(item);
        if (items.length >= ATTENTION_LIMIT) break;
      }
    }
    return items.map((item) => ({
      id: item.id,
      projectId: item.projectId,
      ticketId: item.ticketId,
      sessionId: item.sessionId,
      source: item.source,
      sourceId: item.sourceId,
      kind: item.kind,
      title: item.title,
      detail: item.detail,
      raisedAt: item.raisedAt,
      seenAt: item.seenAt,
    }));
  },
});
