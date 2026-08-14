/**
 * The vocabulary of one in-app provider sign-in, as the renderer may see it.
 *
 * Signing in to a provider is a conversation: the flow asks for a key, or opens
 * a browser and waits for a code, and only the person at the keyboard can
 * answer. That makes it structurally a {@link import("./session-ledger").SessionInteraction} —
 * and it must not be one. A Session Interaction is durable Session history, and
 * two facts here disqualify it: this belongs to Model Access rather than to any
 * Session, and a `secret` prompt carries an API key while the Session ledger is
 * written to disk. So the shapes below name a **separate ephemeral channel** —
 * correlated by an attempt id, cancellable from either end, never persisted and
 * never logged.
 *
 * These are the target vocabulary only. The translation from the executor's own
 * prompt and event types lives with the executor, in `@volli/agent-runtime`,
 * exactly as {@link import("./agent-runtime").ModelAccessSnapshot}'s does — this
 * package names no provider SDK type.
 *
 * **Nothing here may carry a credential.** The value a person types travels
 * renderer → main as a bare argument to a respond call and is never echoed into
 * any shape defined in this file. A prompt states what it wants; it never
 * restates what was given.
 */

/** How a provider can be signed in to. Pi's `AuthType`, in Volli's words. */
export type ModelAccessSignInType = "api-key" | "oauth";

/**
 * One offer on a provider's sign-in menu.
 *
 * A provider may offer both — Anthropic takes an API key or a Claude Pro/Max
 * subscription — and which one a person wants is not derivable, so both are
 * named and the choice is theirs. `label` is the provider's own wording for the
 * method (`loginLabel`, then the auth method's display name), because "Sign in
 * with SuperGrok or X Premium" carries product detail no generic label has.
 */
export interface ModelAccessSignInMethod {
  type: ModelAccessSignInType;
  label: string;
  /** Access billed through a provider subscription rather than per token. */
  isSubscription: boolean;
}

/** What a sign-in step is asking for. */
export type ModelAccessSignInPromptKind = "text" | "secret" | "select" | "manual-code";

/** One choice in a `select` step. */
export interface ModelAccessSignInOption {
  id: string;
  label: string;
  description: string | null;
}

/**
 * The step a sign-in attempt is blocked on, waiting for an answer.
 *
 * `promptId` is what makes an answer unambiguous. A flow can ask several times —
 * Cloudflare wants a key, an account id and a gateway id in sequence — and an
 * answer that named only its attempt could be applied to the wrong question if
 * a withdrawal and a reply crossed. An answer to a prompt that is no longer
 * pending is dropped rather than guessed at.
 */
export interface ModelAccessSignInPrompt {
  promptId: string;
  kind: ModelAccessSignInPromptKind;
  message: string;
  placeholder: string | null;
  /** Populated for `select` and empty for every other kind. */
  options: readonly ModelAccessSignInOption[];
}

/** A link a provider offered alongside an `info` step. */
export interface ModelAccessSignInLink {
  url: string;
  label: string | null;
}

/**
 * Something the flow wants shown while it works, which no answer follows.
 *
 * `auth-url` and `device-code` are the two the repo's copy rule bends for: one
 * needs an openable link and the other a copyable code, and no label alone
 * expresses either.
 */
export type ModelAccessSignInEvent =
  | { kind: "info"; message: string; links: readonly ModelAccessSignInLink[] }
  | { kind: "auth-url"; url: string; instructions: string | null }
  | {
      kind: "device-code";
      userCode: string;
      verificationUri: string;
      intervalSeconds: number | null;
      expiresInSeconds: number | null;
    }
  | { kind: "progress"; message: string };

/**
 * How an attempt ended.
 *
 * `failed` carries a sanitized message and nothing else. There is no
 * "verified" outcome and cannot be: no provider offers a validation call, so a
 * `signed-in` outcome states that a credential was **stored**, not that it
 * works. A wrong key surfaces on first use, and the UI must not claim otherwise.
 */
export type ModelAccessSignInOutcome =
  | { kind: "signed-in" }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

/**
 * Everything main pushes about one attempt, on one ordered channel.
 *
 * One channel rather than three, because the order across kinds is the meaning.
 * Anthropic's flow emits `auth-url`, then asks for a `manual-code`, then — if
 * the loopback callback wins the race first — withdraws that prompt and reports
 * `progress`. Split across channels those four could arrive in any interleaving,
 * and a renderer that applied the withdrawal before the prompt would leave a
 * dead input box on screen waiting for a code nothing will ever consume.
 */
export type ModelAccessSignInUpdate =
  | { attemptId: string; kind: "prompt"; prompt: ModelAccessSignInPrompt }
  | { attemptId: string; kind: "prompt-withdrawn"; promptId: string }
  | { attemptId: string; kind: "event"; event: ModelAccessSignInEvent }
  | { attemptId: string; kind: "settled"; outcome: ModelAccessSignInOutcome };

/**
 * Whether the answer to this step is a credential.
 *
 * The one predicate the renderer needs and the one place the rule is written:
 * a `secret` step masks its input, never restores a draft, and never survives
 * the attempt. `manual-code` deliberately is not one — an OAuth authorization
 * code is single-use, already visible in the browser the person just used, and
 * masking it only makes a hand-transcribed value harder to check.
 */
export function signInPromptIsSecret(prompt: ModelAccessSignInPrompt): boolean {
  return prompt.kind === "secret";
}

/**
 * Whether an attempt is over, whatever the verdict.
 *
 * Cancelled and failed are different things to say and the same thing to do:
 * the attempt holds nothing open, and the row goes back to offering sign-in.
 */
export function signInUpdateIsFinal(update: ModelAccessSignInUpdate): boolean {
  return update.kind === "settled";
}
