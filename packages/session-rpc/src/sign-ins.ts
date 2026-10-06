/**
 * Sign-ins on a host over the host protocol (VC-702; HP § Sign-ins on a
 * host): the `sign-ins` and `auth.callback` features.
 *
 * Every procedure is a projection of one handler in the host's map
 * (`ctx.handlers[key]`), person-only and host-scoped (`SIGN_IN_ENTRIES`).
 * Built from the Session router's family and served by its router until
 * VC-565 composes area routers into one served router.
 *
 * **Values travel in, never out.** `setApiKey`, `setGitCredential` and
 * `answer` take a secret as input; no output schema here has a field that
 * could hold one, and the router's diagnostics record route metadata only.
 */
import {
  hostSignInUpdateIsFinal,
  type HandlerCall,
  type HostAuthCallbackDeliverInput,
  type HostAuthCallbackDeliverResult,
  type HostHandler,
  type HostSetApiKeyInput,
  type HostSetGitCredentialInput,
  type HostSignInAnswerInput,
  type HostSignInFlow,
  type HostSignInStartInput,
  type HostSignInStatus,
  type HostSignInUpdate,
} from "@volli/shared";
import { z } from "zod";

import { hostAnswer, HostProcedureError } from "./catalog";
import { AsyncQueue } from "./index";
import { hostProcedure } from "./session-catalog";

/** The slice of the host's handler map these procedures project. */
export interface SignInRouterHandlers {
  readonly "signIns.status": HostHandler<void, HostSignInStatus>;
  readonly "signIns.setApiKey": HostHandler<HostSetApiKeyInput, HostSignInStatus>;
  readonly "signIns.signOut": HostHandler<{ providerId: string }, HostSignInStatus>;
  readonly "signIns.start": HostHandler<HostSignInStartInput, HostSignInFlow>;
  readonly "signIns.subscribe": (
    input: HostSignInFlow,
    call: HandlerCall,
    sink: { emit(update: HostSignInUpdate): void | Promise<void>; fail(error: unknown): void },
  ) => Promise<() => void>;
  readonly "signIns.answer": HostHandler<HostSignInAnswerInput, void>;
  readonly "signIns.cancel": HostHandler<HostSignInFlow, void>;
  readonly "signIns.setGitCredential": HostHandler<HostSetGitCredentialInput, HostSignInStatus>;
  readonly "signIns.clearGitCredential": HostHandler<{ host: string }, HostSignInStatus>;
  readonly "auth.callback.deliver": HostHandler<
    HostAuthCallbackDeliverInput,
    HostAuthCallbackDeliverResult
  >;
}

/** An identifier a flow or a provider is named by. */
const identifier = z.string().trim().min(1).max(256);

/**
 * A secret's input bound: generous for a key or a token, small enough that a
 * frame carrying one is never mistaken for a payload. No pattern: a value is
 * never described, only bounded.
 */
const secretValue = z.string().min(1).max(16_384);

/**
 * A step's answer: a pasted redirect, a choice, a value. May be empty: some
 * steps take blank as their ordinary answer (GitHub Copilot's "GitHub
 * Enterprise URL/domain (blank for github.com)"). Bounded like a secret,
 * because a pasted API key is an answer too.
 */
const promptAnswer = z.string().max(16_384);

const stateSchema = z.enum(["signed-in", "expired", "missing"]);

const methodSchema = z.object({
  type: z.enum(["api-key", "oauth"]),
  label: z.string(),
  isSubscription: z.boolean(),
});

export const hostSignInStatusSchema = z.object({
  providers: z.array(
    z.object({
      providerId: z.string(),
      label: z.string(),
      state: stateSchema,
      kind: z.enum(["api-key", "subscription"]).nullable(),
      methods: z.array(methodSchema),
    }),
  ),
  git: z.array(z.object({ host: z.string(), state: stateSchema, kind: z.literal("git") })),
});

const promptSchema = z.object({
  promptId: z.string(),
  kind: z.enum(["text", "secret", "select", "manual-code"]),
  message: z.string(),
  placeholder: z.string().nullable(),
  options: z.array(
    z.object({ id: z.string(), label: z.string(), description: z.string().nullable() }),
  ),
});

/**
 * What `signIns.subscribe` yields, published as documentation (subscription
 * yields are not validated by tRPC). Open on `kind`: a Client ignores a kind
 * it does not know, and `done`, `failed` and `cancelled` stay the only ends.
 */
export const hostSignInUpdateSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("auth-url"), url: z.string(), instructions: z.string().nullable() }),
    z.object({
      kind: z.literal("device-code"),
      userCode: z.string(),
      verificationUri: z.string(),
      intervalSeconds: z.number().nullable(),
      expiresInSeconds: z.number().nullable(),
    }),
    z.object({
      kind: z.literal("info"),
      message: z.string(),
      links: z.array(z.object({ url: z.string(), label: z.string().nullable() })),
    }),
    z.object({ kind: z.literal("progress"), message: z.string() }),
    z.object({ kind: z.literal("auth-callback"), flowId: z.string(), redirectUri: z.string() }),
    z.object({ kind: z.literal("prompt"), prompt: promptSchema }),
    z.object({ kind: z.literal("prompt-withdrawn"), promptId: z.string() }),
    z.object({ kind: z.literal("done") }),
    z.object({ kind: z.literal("failed"), message: z.string() }),
    z.object({ kind: z.literal("cancelled") }),
  ])
  .meta({ "x-volli-open-union": "kind" });

const flowSchema = z.object({ flowId: identifier });

/** Room for a subscription's buffered updates; a flow says a handful. */
const SIGN_IN_STREAM_CAPACITY = 256;

/** The procedures, spread into the Session router's `catalogRouter`. */
export function signInProcedures() {
  return {
    signIns: {
      status: hostProcedure("signIns.status")
        .output(hostSignInStatusSchema)
        .query(async ({ ctx }) =>
          hostSignInStatusSchema.parse(await ctx.handlers["signIns.status"](undefined, ctx.call)),
        ),
      setApiKey: hostProcedure("signIns.setApiKey")
        .input(z.object({ providerId: identifier, key: secretValue }))
        .output(hostSignInStatusSchema)
        .mutation(async ({ ctx, input }) =>
          hostSignInStatusSchema.parse(await ctx.handlers["signIns.setApiKey"](input, ctx.call)),
        ),
      signOut: hostProcedure("signIns.signOut")
        .input(z.object({ providerId: identifier }))
        .output(hostSignInStatusSchema)
        .mutation(async ({ ctx, input }) =>
          hostSignInStatusSchema.parse(await ctx.handlers["signIns.signOut"](input, ctx.call)),
        ),
      start: hostProcedure("signIns.start")
        .input(z.object({ providerId: identifier, type: z.enum(["api-key", "oauth"]).optional() }))
        .output(flowSchema)
        .mutation(async ({ ctx, input }) =>
          flowSchema.parse(await ctx.handlers["signIns.start"](input, ctx.call)),
        ),
      subscribe: hostProcedure("signIns.subscribe")
        .input(flowSchema)
        .subscription(async function* ({ ctx, input, signal }) {
          if (signal?.aborted) return;
          const queue = new AsyncQueue<HostSignInUpdate>(SIGN_IN_STREAM_CAPACITY);
          const failure: { current: { error: unknown } | null } = { current: null };
          const abort = (): void => queue.close();
          signal?.addEventListener("abort", abort, { once: true });
          const unsubscribe = await hostAnswer(() =>
            ctx.handlers["signIns.subscribe"](input, ctx.call, {
              emit: (update) => {
                queue.push(update);
                // Closed after the end, keeping what is held: the end is a frame.
                if (hostSignInUpdateIsFinal(update)) queue.close(false);
              },
              fail: (error) => {
                failure.current = { error };
                queue.close(false);
              },
            }),
          );
          try {
            for await (const update of queue) yield update;
            // A stream that dropped an update never ends as if it were whole.
            if (queue.overflowed) {
              throw new HostProcedureError(
                "subscription-overflow",
                "This sign-in said more than its stream holds.",
              );
            }
            if (failure.current !== null) {
              await hostAnswer(() => {
                throw failure.current!.error;
              });
            }
          } finally {
            signal?.removeEventListener("abort", abort);
            unsubscribe();
          }
        }),
      answer: hostProcedure("signIns.answer")
        .input(z.object({ flowId: identifier, promptId: identifier, value: promptAnswer }))
        .output(z.null())
        .mutation(async ({ ctx, input }) => {
          await ctx.handlers["signIns.answer"](input, ctx.call);
          return null;
        }),
      cancel: hostProcedure("signIns.cancel")
        .input(flowSchema)
        .output(z.null())
        .mutation(async ({ ctx, input }) => {
          await ctx.handlers["signIns.cancel"](input, ctx.call);
          return null;
        }),
      setGitCredential: hostProcedure("signIns.setGitCredential")
        .input(
          z.object({
            host: z.string().trim().min(1).max(260),
            username: z.string().min(1).max(256),
            password: secretValue,
          }),
        )
        .output(hostSignInStatusSchema)
        .mutation(async ({ ctx, input }) =>
          hostSignInStatusSchema.parse(
            await ctx.handlers["signIns.setGitCredential"](input, ctx.call),
          ),
        ),
      clearGitCredential: hostProcedure("signIns.clearGitCredential")
        .input(z.object({ host: z.string().trim().min(1).max(260) }))
        .output(hostSignInStatusSchema)
        .mutation(async ({ ctx, input }) =>
          hostSignInStatusSchema.parse(
            await ctx.handlers["signIns.clearGitCredential"](input, ctx.call),
          ),
        ),
    },
    auth: {
      callback: {
        deliver: hostProcedure("auth.callback.deliver")
          .input(
            z.object({
              flowId: identifier,
              // A request target, never a URL: the host replays it to the one
              // origin the flow registered, so no input names where it goes.
              pathAndQuery: z.string().min(1).max(8192).startsWith("/"),
            }),
          )
          .output(z.object({ status: z.number().int() }))
          .mutation(async ({ ctx, input }) => ({
            status: (await ctx.handlers["auth.callback.deliver"](input, ctx.call)).status,
          })),
      },
    },
  };
}

/** The documentation-only yield schema the protocol schema publishes. */
export const signInSupplementalOutputs: Readonly<Record<string, z.ZodType>> = {
  "signIns.subscribe": hostSignInUpdateSchema,
};

/** Outputs that are `null` sentinels, not domain values. */
export const SIGN_IN_VOID_OUTPUTS = ["signIns.answer", "signIns.cancel"] as const;
