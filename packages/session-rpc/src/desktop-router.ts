/**
 * The desktop-only tier's router (VC-608; HP § Command catalog, D-A1 = (c)):
 * host commands only the desktop's own window calls, moved off per-channel
 * IPC onto the router-generic bridge without the public catalog's ceremony.
 *
 * Built like any area router, from one family of catalog builders, but over
 * the desktop-only entries (`DESKTOP_CATALOG_ENTRIES`, `@volli/shared`),
 * whose policy is derived from each channel's VC-574 placement and nothing
 * else: a `workspace` entry is a `workspaceProcedure` that names every
 * resource its input addresses, a `host` entry a `hostProcedure`; both are the
 * person's, on no network door. Every procedure calls `ctx.handlers[key]`,
 * the host's one map, exactly as a public procedure does.
 *
 * Adding a desktop-only command, the template the area tickets copy:
 *
 * 1. append its declaration to `DESKTOP_ENTRIES` (key, the channel's
 *    placement, idempotency, summary);
 * 2. move the channel's handler body into host-core's map
 *    (`HostHandlerSignatures`, `createHostHandlers`), and declare its slice
 *    below in {@link DesktopRouterHandlers};
 * 3. build its procedure here with both zod validators (and, for a
 *    `workspace` entry, its resources);
 * 4. classify its path `ipc` in `DESKTOP_IPC_EXPOSURE`, give it a
 *    `SAMPLE_INPUTS` row, regenerate the protocol schema (its `desktop`
 *    tier), and move its renderer callers onto the Session RPC client;
 * 5. delete the channel from `contract.ts`, `ipc-descriptors.ts`,
 *    `preload/index.ts` and `data-ipc.ts`, and record it in placement.ts's
 *    `BRIDGED_CHANNELS`.
 *
 * Every step but the last is checked by `pnpm typecheck` or a test.
 */
import {
  DESKTOP_CATALOG_ENTRIES,
  type AddHostAnswer,
  type AddHostEvent,
  type AddHostFacts,
  type AddHostStartInput,
  type AddHostStepId,
  type DesktopCatalogEntry,
  type DesktopKey,
  type HandlerCall,
  type HostHandler,
  type HostSetGitCredentialInput,
  type HostSignInRunEvent,
  type HostSignInSendResult,
  type HostSignInStatus,
  type RemoteHostDevices,
  type RemoteHostsSnapshot,
  type RenameRemoteHostInput,
  type WorktreeTrimSettings,
} from "@volli/shared";
import type { JsonUnsafeProcedures } from "@volli/host-protocol";
import { z } from "zod";

import { AsyncQueue } from "./async-queue";
import {
  createCatalogBuilders,
  hostAnswer,
  HostProcedureError,
  type CatalogCallerContext,
  type CatalogMismatch,
  type ProcedurePaths,
  type RouterContextPorts,
} from "./catalog";
import { procedureSchemas } from "./procedure-schema";
import {
  addHostEventSchema,
  addHostStartInputSchema,
  flowInputSchema,
  hostAddAnswerInputSchema,
  addHostFactsSchema,
  hostAddRetryInputSchema,
  hostInputSchema,
  remoteHostDevicesSchema,
  remoteHostsSnapshotSchema,
  renameHostInputSchema,
  signInInputSchema,
  sudoPasswordInputSchema,
  updateHostInputSchema,
} from "./remote-hosts-schema";
import {
  hostSignInStatusSchema,
  hostSignInUpdateSchema,
  identifier,
  promptAnswer,
  secretValue,
} from "./sign-ins";

/** A desktop-only stream's sink, as the host's map feeds it (`HandlerSink`, host-core). */
export interface DesktopStreamSink<Emission> {
  emit(emission: Emission): void | Promise<void>;
  fail(error: unknown): void;
}

/** A desktop-only subscription's entry in the map: it opens, feeds the sink, and answers the unsubscribe. */
export type DesktopSubscriptionHandler<Input, Emission> = (
  input: Input,
  call: HandlerCall,
  sink: DesktopStreamSink<Emission>,
) => Promise<() => void>;

/** The slice of the host's handler map the desktop router projects (D2: structural). */
export interface DesktopRouterHandlers {
  readonly "project.reorder": HostHandler<{ orderedIds: readonly string[] }, null>;
  readonly "worktree.trimSettings": HostHandler<void, WorktreeTrimSettings>;
  /** Remote hosts this desktop added over SSH (VC-700 PR 2): desktop main's registry. */
  readonly "hosts.snapshot": HostHandler<void, RemoteHostsSnapshot>;
  readonly "hosts.subscribe": DesktopSubscriptionHandler<void, RemoteHostsSnapshot>;
  readonly "hosts.retry": HostHandler<{ hostId: string }, null>;
  readonly "hosts.updateHost": HostHandler<{ hostId: string; when: "now" | "when-idle" }, null>;
  readonly "hosts.cancelScheduledUpdate": HostHandler<{ hostId: string }, null>;
  readonly "hosts.signIn": HostHandler<{ hostId: string; providerId: string }, null>;
  readonly "hosts.forget": HostHandler<{ hostId: string }, null>;
  readonly "hostAdd.start": HostHandler<AddHostStartInput, { flowId: string }>;
  readonly "hostAdd.subscribe": DesktopSubscriptionHandler<{ flowId: string }, AddHostEvent>;
  readonly "hostAdd.answer": HostHandler<
    { flowId: string; questionId: string; answer: AddHostAnswer },
    null
  >;
  readonly "hostAdd.sudoPassword": HostHandler<
    { flowId: string; questionId: string; password: string },
    null
  >;
  readonly "hostAdd.retry": HostHandler<{ flowId: string; from?: AddHostStepId }, null>;
  readonly "hostAdd.cancel": HostHandler<{ flowId: string }, null>;
  /** Sign-ins on a remote host, from this desktop (VC-702 PR 2): desktop main's, over its link. */
  readonly "hostSignIns.status": HostHandler<{ hostId: string }, HostSignInStatus>;
  readonly "hostSignIns.macKeys": HostHandler<void, readonly string[]>;
  readonly "hostSignIns.sendFromThisMac": HostHandler<
    { hostId: string; providerId: string; confirmed: true },
    HostSignInSendResult
  >;
  readonly "hostSignIns.setApiKey": HostHandler<
    { hostId: string; providerId: string; key: string },
    HostSignInStatus
  >;
  readonly "hostSignIns.setGitCredential": HostHandler<
    { hostId: string } & HostSetGitCredentialInput,
    HostSignInStatus
  >;
  readonly "hostSignIns.run": DesktopSubscriptionHandler<
    { hostId: string; providerId: string; runId?: string | undefined },
    HostSignInRunEvent
  >;
  readonly "hostSignIns.answer": HostHandler<
    {
      hostId: string;
      providerId: string;
      promptId: string;
      value: string;
      runId?: string | undefined;
    },
    null
  >;
  readonly "hostSignIns.cancel": HostHandler<
    { hostId: string; providerId: string; runId?: string | undefined },
    null
  >;
  /** Managing a host (VC-700 PR 3): this Mac's label, and the host's devices read over SSH. */
  readonly "hosts.rename": HostHandler<RenameRemoteHostInput, null>;
  readonly "hosts.devices": HostHandler<{ hostId: string }, RemoteHostDevices>;
  readonly "hostAdd.facts": HostHandler<{ flowId: string }, AddHostFacts>;
}

type AssertNever<Type extends never> = Type;

/** The desktop tier's keys and the slice's keys are one set: a missing handler fails here. */
export type DesktopRouterHandlersCoverage = AssertNever<
  CatalogMismatch<keyof DesktopRouterHandlers & string, DesktopKey>
>;

/** The desktop router's context: the catalog's ports and the map, nothing else. */
export interface DesktopRouterContext extends CatalogCallerContext {
  handlers: DesktopRouterHandlers;
}

export type DesktopRouterContextPorts = AssertNever<RouterContextPorts<DesktopRouterContext>>;

const { hostProcedure, catalogRouter } = createCatalogBuilders<
  DesktopRouterContext,
  DesktopCatalogEntry
>({ entries: DESKTOP_CATALOG_ENTRIES });

const hostId = z.uuid();
const providerId = z.string().min(1).max(256);
/**
 * The window's name for one sign-in run, minted per run: an answer or cancel
 * naming an older run reaches nothing (VC-702 review B3). Optional, so a
 * caller without one reaches the host and provider's current run.
 */
const runId = identifier.optional();
const hostSignInInputSchema = z.strictObject({ hostId, providerId, runId });

/**
 * What a remote host's sign-in says on this desktop: the host's own updates,
 * less the relay grant desktop main consumes, plus the relay's state and
 * `lost` when the host went away before the end. Open on `kind`, like the
 * updates it carries.
 */
export const hostSignInRunEventSchema = z
  .discriminatedUnion("kind", [
    ...hostSignInUpdateSchema.options.filter(
      (option) => option.shape.kind.value !== "auth-callback",
    ),
    z.object({
      kind: z.literal("relay"),
      state: z.enum(["listening", "paste", "delivered", "failed"]),
    }),
    z.object({ kind: z.literal("lost") }),
  ] as unknown as [z.ZodObject, ...z.ZodObject[]])
  .meta({ "x-volli-open-union": "kind" });

const hostSignInSendResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), status: hostSignInStatusSchema }),
  z.object({ ok: z.literal(false), reason: z.enum(["no-key", "subscription", "send-failed"]) }),
]);

/** Where a sign-in run ends: `done`, `failed`, `cancelled`, or the host lost. */
function runEnds(event: HostSignInRunEvent): boolean {
  return (
    event.kind === "done" ||
    event.kind === "failed" ||
    event.kind === "cancelled" ||
    event.kind === "lost"
  );
}

const trimSettingsSchema = z.object({
  keepPatterns: z.array(z.string()),
  trimOnFinish: z.boolean(),
});

/** What one desktop-only stream may hold unsent to its window before it ends. */
export const DESKTOP_STREAM_CAPACITY = 256;
const SUBSCRIPTION_OVERFLOW_CODE = "SUBSCRIPTION_OVERFLOW";
export const DESKTOP_STREAM_OVERFLOW_MESSAGE =
  "The subscription fell behind; subscribe again for the current state";
export const DESKTOP_STREAM_SOURCE_FAILURE_MESSAGE =
  "The subscription's source failed; subscribe again for the current state";

/**
 * One desktop-only stream: the map's subscription entry opened with a sink
 * that feeds a bounded queue, drained until the window aborts it. Every
 * emission is whole (a snapshot, a view, a log line), so nothing resumes: a
 * stream that overflowed or whose source failed ends with an error naming
 * the recovery, never a clean end the window would read as "nothing more".
 * A handler's "unavailable" is mapped as the policy middleware maps a
 * query's (the stream's body runs past it).
 */
async function* desktopStream<Emission>(
  ctx: DesktopRouterContext,
  procedure: DesktopKey,
  signal: AbortSignal | undefined,
  open: (sink: DesktopStreamSink<Emission>) => Promise<() => void>,
  /** A stream with an end (a sign-in): it completes after the emission this answers true for. */
  ends?: (emission: Emission) => boolean,
): AsyncGenerator<Emission, void, unknown> {
  if (signal?.aborted) return;
  const queue = new AsyncQueue<Emission>(DESKTOP_STREAM_CAPACITY);
  const failure: { current: { error: unknown } | null } = { current: null };
  const abort = (): void => queue.close();
  signal?.addEventListener("abort", abort, { once: true });
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = await hostAnswer(() =>
      open({
        emit: (emission) => {
          queue.push(emission);
          // Closed after the end, keeping what is held: the end is a frame.
          if (ends?.(emission) === true) queue.close(false);
        },
        // Buffered emissions still drain; then the stream ends in error.
        fail: (error) => {
          failure.current = { error };
          queue.close(false);
        },
      }),
    );
    for await (const emission of queue) yield emission;
    if (queue.overflowed) {
      throw new HostProcedureError("subscription-overflow", DESKTOP_STREAM_OVERFLOW_MESSAGE);
    }
    if (failure.current !== null) {
      throw new HostProcedureError(
        "subscription-source-failed",
        DESKTOP_STREAM_SOURCE_FAILURE_MESSAGE,
        failure.current.error,
      );
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    unsubscribe?.();
    if (queue.overflowed) {
      ctx.diagnostics.record({
        procedure,
        phase: "error",
        transport: ctx.transport ?? "unknown",
        code: SUBSCRIPTION_OVERFLOW_CODE,
        message: DESKTOP_STREAM_OVERFLOW_MESSAGE,
      });
    }
  }
}

/**
 * Every desktop-only command so far is host-placed (VC-574), so each is a
 * `hostProcedure`: device-as-user, no Workspace resource to name. A
 * workspace-placed command is a `workspaceProcedure` naming every resource
 * its input addresses, exactly as a public area's is.
 */
export function createDesktopRouter() {
  return catalogRouter({
    project: {
      /** Was `volli:project-reorder`: the rail's order, across every Workspace. */
      reorder: hostProcedure("project.reorder")
        .input(z.object({ orderedIds: z.array(z.string()) }))
        .output(z.null())
        .mutation(({ ctx, input }) => ctx.handlers["project.reorder"](input, ctx.call)),
    },
    worktree: {
      /** Was `volli:worktree-trim-settings-get`: the host-level trim settings. */
      trimSettings: hostProcedure("worktree.trimSettings")
        .output(trimSettingsSchema)
        .query(({ ctx }) => ctx.handlers["worktree.trimSettings"](undefined, ctx.call)),
    },
    /**
     * Remote hosts this desktop added over SSH (VC-700 PR 2). No channel
     * preceded them: they were born on the bridge. Host-placed, the person's
     * own window only; desktop main's registry answers through the map, and
     * every other host answers unavailable.
     */
    hosts: {
      snapshot: hostProcedure("hosts.snapshot")
        .output(remoteHostsSnapshotSchema)
        .query(({ ctx }) => ctx.handlers["hosts.snapshot"](undefined, ctx.call)),
      /** The current snapshot first, then the whole snapshot again on every change. */
      subscribe: hostProcedure("hosts.subscribe").subscription(async function* ({ ctx, signal }) {
        yield* desktopStream<RemoteHostsSnapshot>(ctx, "hosts.subscribe", signal, (sink) =>
          ctx.handlers["hosts.subscribe"](undefined, ctx.call, sink),
        );
      }),
      retry: hostProcedure("hosts.retry")
        .input(hostInputSchema)
        .output(z.null())
        .mutation(({ ctx, input }) => ctx.handlers["hosts.retry"](input, ctx.call)),
      updateHost: hostProcedure("hosts.updateHost")
        .input(updateHostInputSchema)
        .output(z.null())
        .mutation(({ ctx, input }) => ctx.handlers["hosts.updateHost"](input, ctx.call)),
      cancelScheduledUpdate: hostProcedure("hosts.cancelScheduledUpdate")
        .input(hostInputSchema)
        .output(z.null())
        .mutation(({ ctx, input }) => ctx.handlers["hosts.cancelScheduledUpdate"](input, ctx.call)),
      signIn: hostProcedure("hosts.signIn")
        .input(signInInputSchema)
        .output(z.null())
        .mutation(({ ctx, input }) => ctx.handlers["hosts.signIn"](input, ctx.call)),
      forget: hostProcedure("hosts.forget")
        .input(hostInputSchema)
        .output(z.null())
        .mutation(({ ctx, input }) => ctx.handlers["hosts.forget"](input, ctx.call)),
      /** This Mac's label for the host: the host's own name is untouched. */
      rename: hostProcedure("hosts.rename")
        .input(renameHostInputSchema)
        .output(z.null())
        .mutation(({ ctx, input }) => ctx.handlers["hosts.rename"](input, ctx.call)),
      /** The devices the host has enrolled, read over SSH when asked, never cached. */
      devices: hostProcedure("hosts.devices")
        .input(hostInputSchema)
        .output(remoteHostDevicesSchema)
        .query(({ ctx, input }) => ctx.handlers["hosts.devices"](input, ctx.call)),
    },
    hostAdd: {
      start: hostProcedure("hostAdd.start")
        .input(addHostStartInputSchema)
        .output(z.object({ flowId: z.string() }))
        .mutation(({ ctx, input }) => ctx.handlers["hostAdd.start"](input, ctx.call)),
      /**
       * One bounded replay first (the view and the newest of the log), then
       * every change to the view and each new log line.
       */
      subscribe: hostProcedure("hostAdd.subscribe")
        .input(flowInputSchema)
        .subscription(async function* ({ ctx, input, signal }) {
          yield* desktopStream<AddHostEvent>(ctx, "hostAdd.subscribe", signal, (sink) =>
            ctx.handlers["hostAdd.subscribe"](input, ctx.call, sink),
          );
        }),
      answer: hostProcedure("hostAdd.answer")
        .input(hostAddAnswerInputSchema)
        .output(z.null())
        .mutation(({ ctx, input }) => ctx.handlers["hostAdd.answer"](input, ctx.call)),
      /**
       * Write-only. The router records a call's route and its error's
       * message, never its input; the map scrubs the password from any error
       * that names it.
       */
      sudoPassword: hostProcedure("hostAdd.sudoPassword")
        .input(sudoPasswordInputSchema)
        .output(z.null())
        .mutation(({ ctx, input }) => ctx.handlers["hostAdd.sudoPassword"](input, ctx.call)),
      retry: hostProcedure("hostAdd.retry")
        .input(hostAddRetryInputSchema)
        .output(z.null())
        .mutation(({ ctx, input }) => ctx.handlers["hostAdd.retry"](input, ctx.call)),
      cancel: hostProcedure("hostAdd.cancel")
        .input(flowInputSchema)
        .output(z.null())
        .mutation(({ ctx, input }) => ctx.handlers["hostAdd.cancel"](input, ctx.call)),
      /**
       * What the flow has found so far, read on each view: beside
       * `subscribe`, whose closed event union cannot carry it.
       */
      facts: hostProcedure("hostAdd.facts")
        .input(flowInputSchema)
        .output(addHostFactsSchema)
        .query(({ ctx, input }) => ctx.handlers["hostAdd.facts"](input, ctx.call)),
    },
    /**
     * Sign-ins on a remote host, from this desktop (VC-702 PR 2). Values go in
     * and onto the host link; nothing here answers one. The router records a
     * call's route and its error's message, never its input.
     */
    hostSignIns: {
      status: hostProcedure("hostSignIns.status")
        .input(hostInputSchema)
        .output(hostSignInStatusSchema)
        .query(async ({ ctx, input }) =>
          hostSignInStatusSchema.parse(await ctx.handlers["hostSignIns.status"](input, ctx.call)),
        ),
      macKeys: hostProcedure("hostSignIns.macKeys")
        .output(z.array(z.string()))
        .query(async ({ ctx }) => [
          ...(await ctx.handlers["hostSignIns.macKeys"](undefined, ctx.call)),
        ]),
      sendFromThisMac: hostProcedure("hostSignIns.sendFromThisMac")
        .input(z.strictObject({ hostId, providerId, confirmed: z.literal(true) }))
        .output(hostSignInSendResultSchema)
        .mutation(async ({ ctx, input }) =>
          hostSignInSendResultSchema.parse(
            await ctx.handlers["hostSignIns.sendFromThisMac"](input, ctx.call),
          ),
        ),
      setApiKey: hostProcedure("hostSignIns.setApiKey")
        .input(z.strictObject({ hostId, providerId, key: secretValue }))
        .output(hostSignInStatusSchema)
        .mutation(async ({ ctx, input }) =>
          hostSignInStatusSchema.parse(
            await ctx.handlers["hostSignIns.setApiKey"](input, ctx.call),
          ),
        ),
      setGitCredential: hostProcedure("hostSignIns.setGitCredential")
        .input(
          z.strictObject({
            hostId,
            host: z.string().trim().min(1).max(260),
            username: z.string().min(1).max(256),
            password: secretValue,
          }),
        )
        .output(hostSignInStatusSchema)
        .mutation(async ({ ctx, input }) =>
          hostSignInStatusSchema.parse(
            await ctx.handlers["hostSignIns.setGitCredential"](input, ctx.call),
          ),
        ),
      /** The sign-in, to its end; ending the stream cancels it on the host. */
      run: hostProcedure("hostSignIns.run")
        .input(hostSignInInputSchema)
        .subscription(async function* ({ ctx, input, signal }) {
          yield* desktopStream<HostSignInRunEvent>(
            ctx,
            "hostSignIns.run",
            signal,
            (sink) => ctx.handlers["hostSignIns.run"](input, ctx.call, sink),
            runEnds,
          );
        }),
      answer: hostProcedure("hostSignIns.answer")
        .input(
          z.strictObject({ hostId, providerId, promptId: identifier, value: promptAnswer, runId }),
        )
        .output(z.null())
        .mutation(({ ctx, input }) => ctx.handlers["hostSignIns.answer"](input, ctx.call)),
      cancel: hostProcedure("hostSignIns.cancel")
        .input(hostSignInInputSchema)
        .output(z.null())
        .mutation(({ ctx, input }) => ctx.handlers["hostSignIns.cancel"](input, ctx.call)),
    },
  });
}

export type DesktopRouter = ReturnType<typeof createDesktopRouter>;

/** Every desktop procedure has its entry, and every desktop entry its procedure. */
export type DesktopRouterCatalogBinding = AssertNever<
  CatalogMismatch<ProcedurePaths<DesktopRouter["_def"]["record"]>, DesktopKey>
>;

/** Every desktop procedure's input and output survive JSON (docs/BOUNDARIES.md, rule 3). */
export type DesktopRouterJsonSafety = AssertNever<JsonUnsafeProcedures<DesktopRouter>>;

/** The desktop tier's published grammar, from its actual validators: diffed additive-only. */
export function desktopProcedureSchemas(router: DesktopRouter = createDesktopRouter()) {
  // A subscription's emission is published from its documented schema: tRPC
  // binds no output validator to a stream.
  return procedureSchemas(router, {
    "hosts.subscribe": remoteHostsSnapshotSchema,
    "hostAdd.subscribe": addHostEventSchema,
    "hostSignIns.run": hostSignInRunEventSchema,
  });
}
