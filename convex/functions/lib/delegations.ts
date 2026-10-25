/** The cloud projection of runner-owned slots; never starts an agent loop. */
import {
  encodeSessionJson,
  noticeProse,
  NOTICE_PROSE_LIMIT,
  SUBAGENT_ANSWER_NOTICE_LIMIT,
  type NoticeAnswer,
  type SessionEvent,
} from "@volli/shared";
import {
  JOB_PAYLOAD_MAX_CHARS,
  JOB_TITLE_MAX_CHARS,
  SESSION_COMMAND_FORMAT,
  SESSION_NOTICE_FORMAT,
  isDerivedId,
  isSubagentHostNoticeOrigin,
  newId,
  parseId,
  sessionAttentionId,
  subagentCommandOrigin,
  subagentNoticeIds,
  subagentOutcome,
  suppressSubagentAnswer,
  type CloudSessionView,
  type SubagentNoticeJobPayload,
  type SessionId,
  type TicketId,
  type UserId,
} from "@volli/shared/cloud";
import type { Doc } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server";
import { findAttention, raiseSessionAttention } from "./attention";
import { tryEnqueueJob } from "./jobs";

type Reader = Pick<MutationCtx, "db">;
type Slot = Doc<"delegations">;
type Watch = NonNullable<Slot["watch"]>;

/** Pending work is an armed watch, not merely a child waiting for Retry. */
export function delegationWatchIsActive(slot: Slot): boolean {
  return slot.watch === undefined
    ? slot.status === "running" || slot.status === "starting"
    : slot.watch.active !== null;
}

function watchOf(slot: Slot): Watch {
  return (
    slot.watch ?? {
      throughSequence: 0,
      originalSettled: slot.settledAt !== null,
      originalOutcome: slot.settledAt !== null,
      active:
        slot.status === "running" && slot.settledAt === null
          ? {
              afterSequence: 0,
              resumed: false,
              commandId: subagentNoticeIds(`${slot.parentSessionId}:${slot.toolCallId}`).commandId,
            }
          : null,
    }
  );
}

async function sessionRow(ctx: Reader, id: string) {
  return ctx.db
    .query("sessions")
    .withIndex("by_uuid", (q) => q.eq("id", id))
    .unique();
}

async function intakeRow(ctx: Reader, sessionId: string) {
  return ctx.db
    .query("sessionIntake")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .unique();
}

/** Sequence one is the only birth evidence; arbitrary subagents are not slots. */
async function projectBirth(ctx: MutationCtx, child: Doc<"sessions">, fact: SessionEvent) {
  if (
    child.role !== "subagent" ||
    child.parentSessionId === null ||
    fact.sequence !== 1 ||
    fact.payload.kind !== "command.recorded" ||
    fact.payload.command.intent.kind !== "session.create"
  )
    return;
  const createCommandId = fact.payload.command.id;
  const prefix = `${child.parentSessionId}:`;
  const suffix = ":create";
  if (!createCommandId.startsWith(prefix) || !createCommandId.endsWith(suffix)) return;
  const toolCallId = createCommandId.slice(prefix.length, -suffix.length);
  if (!isDerivedId(toolCallId)) return;
  const parent = await sessionRow(ctx, child.parentSessionId);
  if (
    parent === null ||
    parent.ownerUserId !== child.ownerUserId ||
    parent.projectId !== child.projectId
  )
    return;
  const slot = await ctx.db
    .query("delegations")
    .withIndex("by_parent_call", (q) =>
      q.eq("parentSessionId", parent.id).eq("toolCallId", toolCallId),
    )
    .unique();
  if (slot !== null) {
    if (slot.childSessionId !== child.id) {
      // Durable source id: even a replay after a person clears it must not
      // raise the same duplicate-slot incident a second time.
      const sourceId = `volli:delegation-slot:${toolCallId}`;
      if ((await findAttention(ctx, sessionAttentionId(parent.id, sourceId))) === null) {
        await raiseSessionAttention(ctx, parent, {
          source: "runner_alert",
          sourceId,
          kind: "runner_alert",
          title: "Duplicate subagent slot",
          detail: `More than one child claimed this delegation. Session ${slot.childSessionId} keeps the slot; Session ${child.id} remains in history.`,
          raisedAt: Date.now(),
        });
      }
    }
    return;
  }
  const byChild = await ctx.db
    .query("delegations")
    .withIndex("by_child", (q) => q.eq("childSessionId", child.id))
    .unique();
  if (byChild !== null) return;
  await ctx.db.insert("delegations", {
    childSessionId: child.id,
    parentSessionId: parent.id,
    ticketId: child.ticketId,
    depth: 1,
    toolCallId,
    createCommandId,
    status: "starting",
    watch: {
      throughSequence: fact.sequence,
      originalSettled: false,
      originalOutcome: false,
      active: null,
    },
    answerRef: null,
    createdAt: fact.payload.command.createdAt,
    settledAt: null,
  });
}

/** Mutations read staging only. Packed, spilled and missing bodies remain pointers. */
async function answerOf(
  ctx: Reader,
  child: Doc<"sessions">,
  view: CloudSessionView,
): Promise<{
  answer: NoticeAnswer;
  answerRef: { digest: string; chars: number | null } | null;
}> {
  const reference = view.latestReply?.reference;
  if (reference === undefined) return { answer: { state: "none" }, answerRef: null };
  const answerRef = { digest: reference.id, chars: null as number | null };
  const row = await ctx.db
    .query("transcriptArtifacts")
    .withIndex("by_session_digest", (q) => q.eq("sessionId", child.id).eq("digest", reference.id))
    .unique();
  if (row?.body == null) return { answer: { state: "unread" }, answerRef };
  try {
    const artifact = JSON.parse(row.body) as {
      message?: { role?: string; parts?: { type?: string; text?: unknown }[] };
    };
    if (artifact?.message?.role !== "assistant" || !Array.isArray(artifact.message.parts))
      return { answer: { state: "unread" }, answerRef };
    const text = artifact.message.parts
      .flatMap((part) =>
        part?.type === "text" && typeof part.text === "string" ? [part.text] : [],
      )
      .join("\n")
      .trim();
    answerRef.chars = text.length;
    return {
      answer:
        text.length === 0
          ? { state: "none" }
          : {
              state: "text",
              message: noticeProse(text, SUBAGENT_ANSWER_NOTICE_LIMIT),
            },
      answerRef,
    };
  } catch {
    return { answer: { state: "unread" }, answerRef };
  }
}

/** A routing refusal is visible recovery work, never a reason to reject a fact. */
async function deliveryFault(
  ctx: MutationCtx,
  parent: Doc<"sessions">,
  sourceId: string,
  code: string,
) {
  await raiseSessionAttention(ctx, parent, {
    source: "session_attention",
    sourceId,
    kind: "runner_alert",
    title: "Subagent delivery could not be routed",
    detail: `Delivery was refused (${code}). The child's outcome remains in Session history; read its answer there.`,
    raisedAt: Date.now(),
  });
}

/** Local delivery can reach the parent before the child's drain reaches us. */
async function originalWasSettled(ctx: Reader, slot: Slot, watch: Watch): Promise<boolean> {
  if (watch.originalSettled) return true;
  const commandId = subagentNoticeIds(`${slot.parentSessionId}:${slot.toolCallId}`).commandId;
  const recorded = await ctx.db
    .query("sessionEvents")
    .withIndex("by_session_command", (q) =>
      q
        .eq("sessionId", slot.parentSessionId)
        .eq("commandId", commandId)
        .eq("kind", "command.recorded"),
    )
    .first();
  return recorded !== null && recorded.kindKnown && recorded.quarantine === null;
}

async function settleChild(
  ctx: MutationCtx,
  child: Doc<"sessions">,
  fact: SessionEvent,
  view: CloudSessionView,
) {
  if (child.role !== "subagent") return;
  const slot = await ctx.db
    .query("delegations")
    .withIndex("by_child", (q) => q.eq("childSessionId", child.id))
    .unique();
  if (slot === null) return;
  const watch = { ...watchOf(slot) };
  if (fact.sequence <= watch.throughSequence) return;
  watch.throughSequence = fact.sequence;
  const operationId = `${slot.parentSessionId}:${slot.toolCallId}`;
  const originalCommandId = subagentNoticeIds(operationId).commandId;
  const { payload } = fact;
  let status = slot.status;
  let armed = false;
  if (watch.active === null) {
    const startReceipt =
      payload.kind === "command.receipt.recorded" &&
      payload.receipt.commandId === `${operationId}:start`
        ? payload.receipt
        : null;
    if (
      slot.status === "starting" &&
      !watch.originalOutcome &&
      (startReceipt?.status === "accepted" || startReceipt?.status === "completed")
    ) {
      // The start facade calls this ready only for this durable receipt.
      // Everything before it (especially a failed first attach) is outside
      // the original watch. Holding the task is runner-local, not inferred
      // from the asynchronously published queue mirror's absence.
      watch.active = {
        afterSequence: fact.sequence,
        resumed: false,
        commandId: originalCommandId,
      };
      armed = true;
    } else if (payload.kind === "turn.started") {
      watch.originalSettled = await originalWasSettled(ctx, slot, watch);
      if (!watch.originalSettled || !isSubagentHostNoticeOrigin(view.latestTurnOrigin)) {
        watch.active = {
          afterSequence: fact.sequence,
          resumed: true,
          commandId: subagentNoticeIds(
            operationId,
            watch.originalSettled ? payload.turnId : undefined,
          ).commandId,
        };
        armed = true;
      }
    } else if (
      payload.kind === "command.recorded" &&
      payload.command.intent.kind === "message.submit" &&
      view.turnActive &&
      view.latestTurnId !== null &&
      !isSubagentHostNoticeOrigin(subagentCommandOrigin(fact))
    ) {
      watch.originalSettled = await originalWasSettled(ctx, slot, watch);
      if (watch.originalSettled) {
        // A person/Session joining a host-notice turn is a resumption too.
        watch.active = {
          afterSequence: fact.sequence,
          resumed: true,
          commandId: subagentNoticeIds(operationId, view.latestTurnId).commandId,
        };
        armed = true;
      }
    } else if (
      slot.status === "starting" &&
      (payload.kind === "attachment.failed" || startReceipt?.status === "rejected")
    ) {
      status = "failed";
    }
  }
  if (armed) status = "running";
  const active = watch.active;
  const outcome =
    active !== null && fact.sequence > active.afterSequence
      ? subagentOutcome(payload, operationId, active.resumed)
      : null;
  if (outcome === null || active === null) {
    await ctx.db.patch(slot._id, { watch, status, ...(armed ? { settledAt: null } : {}) });
    return;
  }
  const isOriginal = active.commandId === originalCommandId;
  const alreadyReported = isOriginal && watch.originalOutcome;
  const suppressed = suppressSubagentAnswer(outcome, slot.parentSessionId);
  if (isOriginal) {
    watch.originalOutcome = true;
    if (suppressed) watch.originalSettled = true;
  }
  watch.active = null;
  const { answer, answerRef } = await answerOf(ctx, child, view);
  // Accepted sequence chooses the first outcome AFTER this watch's boundary.
  // A later stop cannot overwrite it, nor can a stale kickoff end a retry.
  await ctx.db.patch(slot._id, {
    watch,
    status:
      outcome.state === "completed"
        ? "answered"
        : outcome.state === "stopped"
          ? "stopped"
          : "failed",
    settledAt: fact.occurredAt,
    answerRef,
  });
  if (suppressed || alreadyReported) return;
  const parent = await sessionRow(ctx, slot.parentSessionId);
  if (parent === null) return;
  const intake = await intakeRow(ctx, parent.id);
  const sourceId = `volli:delegation-answer:${slot.toolCallId}`;
  if (intake === null || intake.state === "released") {
    await deliveryFault(ctx, parent, sourceId, "not_claimed");
    return;
  }
  // Frozen pre-cloud id: the local path and this inbox path race into the
  // same first-writer-wins outbox slot on the parent's CURRENT runner.
  const commandId = active.commandId;
  const detail = outcome.stopDetail;
  const noticePayload: SubagentNoticeJobPayload = {
    format: SESSION_NOTICE_FORMAT,
    notice: "subagent",
    commandId,
    childSessionId: parseId("session", child.id),
    title: noticeProse(view.session.title ?? "Delegated task", JOB_TITLE_MAX_CHARS).text,
    state: outcome.state,
    reason: null,
    stoppedBy: outcome.stoppedBy,
    stopDetail:
      detail === null
        ? null
        : {
            ...detail,
            message:
              detail.message === null ? null : noticeProse(detail.message, NOTICE_PROSE_LIMIT).text,
            providerType:
              detail.providerType === null ? null : noticeProse(detail.providerType, 200).text,
          },
    answer,
  };
  // JSON escaping can make even a 16k excerpt exceed the wire cap. Fall
  // back to the pointer rather than ever letting another author's prose
  // break the child's drain.
  if (JSON.stringify(noticePayload).length > JOB_PAYLOAD_MAX_CHARS)
    noticePayload.answer = { state: "unread" };
  const result = await tryEnqueueJob(ctx, {
    id: commandId,
    commandId,
    kind: "session.notice",
    runnerId: intake.claim.runnerId,
    projectId: parent.projectId,
    sessionId: parent.id,
    ticketId: parent.ticketId,
    payload: noticePayload,
    onBehalfOf: parent.ownerUserId,
    createdBy: {
      kind: "volli",
      reason: "subagent_notice",
      onBehalfOf: parent.ownerUserId as UserId,
    },
  });
  if ("refused" in result) await deliveryFault(ctx, parent, sourceId, result.refused);
}

async function stopOtherRunnerChildren(ctx: MutationCtx, parent: Doc<"sessions">) {
  const parentIntake = await intakeRow(ctx, parent.id);
  if (parentIntake === null) return;
  const slots = await ctx.db
    .query("delegations")
    .withIndex("by_parent_status", (q) =>
      q.eq("parentSessionId", parent.id).eq("status", "running"),
    )
    .collect();
  for (const slot of slots) {
    const watch = watchOf(slot);
    if (slot.stopCommandId !== undefined || watch.active === null || watch.active.resumed) continue;
    const childIntake = await intakeRow(ctx, slot.childSessionId);
    if (
      childIntake === null ||
      childIntake.state === "released" ||
      childIntake.claim.runnerId === parentIntake.claim.runnerId
    )
      continue;
    // An accepted catch-up batch may already contain the child's outcome,
    // while its projection still says running. Its caught-up head rechecks
    // the cascade AFTER settling; never act on that stale projection.
    const state = await ctx.db
      .query("sessionStates")
      .withIndex("by_session", (q) => q.eq("sessionId", slot.childSessionId))
      .unique();
    if (state === null || state.throughSequence < childIntake.acceptedThrough) continue;
    const child = await sessionRow(ctx, slot.childSessionId);
    if (child === null || child.stopped !== null || child.deletedAt !== null) continue;
    const payload = {
      format: SESSION_COMMAND_FORMAT as typeof SESSION_COMMAND_FORMAT,
      intent: encodeSessionJson({
        kind: "session.stop",
        reason: "Parent Session stopped",
        by: { kind: "session", sessionId: parent.id },
      }),
    };
    // Keep the minted command on the slot, beyond the inbox's seven-day
    // retention: replay never scans command history or repeats the cascade.
    const commandId = newId("command");
    const result = await tryEnqueueJob(ctx, {
      commandId,
      kind: "session.command",
      runnerId: childIntake.claim.runnerId,
      projectId: child.projectId,
      sessionId: child.id,
      ticketId: child.ticketId,
      payload,
      onBehalfOf: parent.ownerUserId,
      createdBy: {
        kind: "agent",
        userId: parent.ownerUserId as UserId,
        sessionId: parent.id as SessionId,
        ticketId: parent.ticketId as TicketId | null,
      },
    });
    if ("refused" in result)
      await deliveryFault(ctx, parent, `volli:delegation-stop:${slot.toolCallId}`, result.refused);
    else await ctx.db.patch(slot._id, { stopCommandId: commandId });
  }
}

/** Production caller: sessionDerived.deriveFromFact, BEFORE the B2 watch hook. */
export async function onDelegationFact(
  ctx: MutationCtx,
  session: Doc<"sessions">,
  fact: SessionEvent,
  view: CloudSessionView,
): Promise<void> {
  await projectBirth(ctx, session, fact);
  await settleChild(ctx, session, fact, view);
  if (fact.payload.kind === "session.stopped") await stopOtherRunnerChildren(ctx, session);
}

/** Production caller: sessionIntake.applyFold, after a caught-up listing sync. */
export async function onDelegationHead(
  ctx: MutationCtx,
  session: Doc<"sessions">,
  view: CloudSessionView,
): Promise<void> {
  if (view.stopped !== null) await stopOtherRunnerChildren(ctx, session);
  if (session.role === "subagent" && session.parentSessionId !== null) {
    const parent = await sessionRow(ctx, session.parentSessionId);
    if (parent?.stopped != null) await stopOtherRunnerChildren(ctx, parent);
  }
}
