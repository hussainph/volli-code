import type { SessionRuntime } from "@volli/session-engine";
export { loadCanaryPeer } from "../../../../packages/session-rpc/src/canary-peer.test-support";
/**
 * Frozen public Session peer subset from 4c712841ae777dcc178d10552e7b0052fa905b81
 * (the pre-VC-669 PR base, not a released hostd binary). Only the four entries
 * exercised by the recordings are reproduced. Do not update this peer when
 * today's router changes: it deliberately has its own input grammar, renderer
 * shaping and cursor calculation, and the old unvalidated output contract.
 *
 * HostProcedureError is used only as the shared error carrier understood by
 * the real IPC bridge; the reason/code/message and WS formatter are pinned here.
 */
import { initTRPC, tracked } from "@trpc/server";
import type { HostProcedureError, RouterCaller, WorkspaceResource } from "@volli/session-rpc";
// Independent parsers avoid importing the current server's schema library or
// schema definitions. tRPC accepts the same { parse } interface as Zod.
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function identifier(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 512 && value.trim() === value
  );
}
function sequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function cursor(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value) && sequence(Number(value));
}
function parser<T>(check: (value: unknown) => boolean): {
  parse(value: unknown): T;
  safeParse(value: unknown): { success: boolean };
} {
  return {
    parse(value) {
      if (!check(value)) throw new Error("Value violates the frozen Session wire contract");
      return value as T;
    },
    safeParse: (value) => ({ success: check(value) }),
  };
}
type Selection = {
  providerId: string;
  modelId: string;
  reasoningLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
};
type Query = { sessionId: string };
type Command = Query & {
  commandId: string;
  command: { kind: "model.select"; selection: Selection };
};
type Subscribe = Query & { afterSequence?: number; lastEventId?: string };
function query(value: unknown): boolean {
  return record(value) && identifier(value.sessionId);
}
function selection(value: unknown): boolean {
  return (
    record(value) &&
    identifier(value.providerId) &&
    identifier(value.modelId) &&
    typeof value.reasoningLevel === "string" &&
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.reasoningLevel)
  );
}
export const oldQueryInput = parser<Query>(query);
export const oldCommandInput = parser<Command>(
  (value) =>
    record(value) &&
    query(value) &&
    identifier(value.commandId) &&
    record(value.command) &&
    value.command.kind === "model.select" &&
    selection(value.command.selection),
);
export const oldSubscribeInput = parser<Subscribe>(
  (value) =>
    record(value) &&
    query(value) &&
    (value.afterSequence === undefined || sequence(value.afterSequence)) &&
    (value.lastEventId === undefined || cursor(value.lastEventId)),
);

// Frozen consumer contract for this representative subset, independent of
// today's server output validators. Additional fields are tolerated; fields
// the old consumer reads may not disappear or change types.
function session(value: unknown): boolean {
  return (
    record(value) &&
    identifier(value.id) &&
    identifier(value.projectId) &&
    (value.ticketId === null || typeof value.ticketId === "string") &&
    (value.role === "project" || value.role === "ticket") &&
    (value.parentSessionId === null || typeof value.parentSessionId === "string") &&
    (value.title === null || typeof value.title === "string") &&
    typeof value.createdAt === "number"
  );
}
function projection(value: unknown): boolean {
  return (
    record(value) &&
    sequence(value.throughSequence) &&
    record(value.projection) &&
    (value.projection.session === undefined || session(value.projection.session)) &&
    (value.projection.modelSelection === undefined ||
      value.projection.modelSelection === null ||
      selection(value.projection.modelSelection))
  );
}
function isRecordedFrame(value: unknown): boolean {
  if (!record(value) || !record(value.event)) return false;
  const event = value.event;
  return (
    identifier(value.sessionId) &&
    sequence(value.sequence) &&
    value.transcript === null &&
    identifier(event.id) &&
    identifier(event.sessionId) &&
    sequence(event.sequence) &&
    typeof event.occurredAt === "number" &&
    typeof event.recordedAt === "number" &&
    record(event.provenance) &&
    event.provenance.venue === null &&
    record(event.provenance.source) &&
    event.provenance.source.kind === "system" &&
    identifier(event.provenance.source.id) &&
    event.provenance.source.detail === null &&
    record(event.payload) &&
    event.payload.kind === "session.created" &&
    session(event.payload.session)
  );
}
export const oldProjectionOutput = parser<unknown>(projection);
const oldFrameOutput = parser<{ sequence: number } & Record<string, unknown>>(isRecordedFrame);
export const oldSnapshotOutput = parser<unknown>(
  (value) =>
    projection(value) &&
    record(value) &&
    Array.isArray(value.frames) &&
    value.frames.every(isRecordedFrame),
);
export const oldCommandOutput = parser<unknown>((value) => {
  if (!record(value) || !record(value.receipt)) return false;
  const receipt = value.receipt;
  return (
    identifier(value.sessionId) &&
    sequence(value.throughSequence) &&
    value.refusal === null &&
    identifier(receipt.id) &&
    identifier(receipt.commandId) &&
    receipt.status === "accepted" &&
    typeof receipt.acceptedAt === "number" &&
    typeof receipt.recordedAt === "number" &&
    sequence(receipt.sequence) &&
    record(receipt.result) &&
    receipt.result.kind === "model.selected" &&
    identifier(receipt.result.sessionId)
  );
});
export const oldTrackedOutput = parser<unknown>(
  (value) => record(value) && cursor(value.id) && isRecordedFrame(value.data),
);

interface OldSessionRouterContext {
  caller: RouterCaller;
  runtime: SessionRuntime;
  resourceWorkspace?: (resource: WorkspaceResource) => string | null | Promise<string | null>;
}

/** No current catalog builders, schemas, presentation codec or AsyncQueue. */
export function createOldSessionRouter(ErrorCarrier: typeof HostProcedureError) {
  const rpc = initTRPC.context<OldSessionRouterContext>().create({
    errorFormatter: ({ shape, error }) => ({
      ...shape,
      data: {
        ...shape.data,
        hostError: {
          code: error.code,
          message: error.message,
          ...(error instanceof ErrorCarrier ? { reason: error.reason } : {}),
        },
      },
    }),
  });
  const scoped = rpc.procedure.use(async ({ ctx, getRawInput, next }) => {
    const input = oldQueryInput.parse(await getRawInput());
    const actor = ctx.caller.actor;
    if (
      actor.kind !== "device" ||
      !("workspaceId" in actor) ||
      (await ctx.resourceWorkspace?.({ kind: "session", id: input.sessionId })) !==
        actor.workspaceId
    ) {
      throw new ErrorCarrier("workspace-unknown", "Not found in this Workspace.");
    }
    return next();
  });

  return rpc.router({
    session: rpc.router({
      projection: scoped.input(oldQueryInput).query(async ({ ctx, input }) => {
        const value = await ctx.runtime.projection(input);
        return {
          projection: { session: value.projection.session },
          throughSequence: value.throughSequence,
        };
      }),
      snapshot: scoped.input(oldQueryInput).query(async ({ ctx, input }) => {
        const value = await ctx.runtime.snapshot(input);
        return {
          projection: { session: value.projection.session },
          throughSequence: value.throughSequence,
          frames: value.frames,
        };
      }),
      command: scoped.input(oldCommandInput).mutation(async ({ ctx, input }) => {
        const result = await ctx.runtime.command({ ...input, origin: { kind: "user" } });
        return {
          sessionId: result.sessionId,
          receipt: result.receipt,
          throughSequence: result.throughSequence,
          refusal: result.refusal,
        };
      }),
      subscribe: scoped.input(oldSubscribeInput).subscription(async function* ({
        ctx,
        input,
        signal,
      }) {
        const frames: unknown[] = [];
        let wake: (() => void) | undefined;
        const unsubscribe = await ctx.runtime.subscribe(
          {
            sessionId: input.sessionId,
            afterSequence: Math.max(input.afterSequence ?? 0, Number(input.lastEventId ?? 0)),
          },
          (frame) => {
            frames.push(frame);
            wake?.();
          },
        );
        const abort = () => wake?.();
        signal?.addEventListener("abort", abort, { once: true });
        try {
          // oxlint-disable-next-line no-unmodified-loop-condition -- AbortSignal changes outside this iterator.
          while (!signal?.aborted) {
            if (frames.length === 0) {
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
              continue;
            }
            const frame = oldFrameOutput.parse(frames.shift());
            yield tracked(String(frame.sequence), frame);
          }
        } finally {
          signal?.removeEventListener("abort", abort);
          unsubscribe();
        }
      }),
    }),
  });
}
