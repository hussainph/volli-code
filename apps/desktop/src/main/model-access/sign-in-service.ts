/**
 * One provider sign-in at a time, conducted in main.
 *
 * pi-ai states the division: "Login/logout orchestration is app-owned." What it
 * hands over is `AuthInteraction` — a callback bag whose `prompt()` returns a
 * promise the flow blocks on until a human answers. That is a request/response
 * protocol pointed the wrong way for a process boundary: the flow runs here and
 * the human is over there, so every parked `prompt()` is a promise this service
 * holds open across IPC and must eventually settle, in every direction it can
 * be settled from.
 *
 * There are four such directions and all four are live. The renderer answers.
 * The renderer cancels. Main aborts — the window went away, and a flow parked
 * on a question nobody can see would hold the provider's one attempt slot until
 * quit. And **the flow itself withdraws the question**: Anthropic, OpenAI Codex
 * and OpenRouter open a browser, start a loopback callback server, and ask for
 * a pasted code *as a race against it*, aborting the prompt's own `signal` when
 * the callback wins. A service that ignored that signal would leave a dead
 * input box on screen asking for a code the flow already has.
 *
 * **Transport-free and SDK-free by construction.** Attempts publish through an
 * injected {@link SignInOwner} rather than reaching for `webContents`, and they
 * drive a login through the {@link PiSignIn} port rather than pi-ai directly.
 * Together those let the whole orchestration — success, cancellation, abort,
 * out-of-order answers, the withdrawal race, the one-attempt rule — be tested
 * against a scripted flow with no Electron and no network in the room.
 *
 * **Secrets travel one way and are held only as long as redaction needs them.**
 * A submitted value is handed straight to the provider's flow. The service
 * keeps a copy for exactly one purpose: a provider that rejects a key by
 * echoing the request would otherwise put it in the failure message this sends
 * back, and {@link redactSubmitted} cannot remove what it cannot recognise. The
 * copies are dropped the moment the attempt settles.
 */

import type { PiSignIn, PiSignInSteps } from "@volli/agent-runtime";
import type {
  ModelAccessSignInBeginResult,
  ModelAccessSignInEvent,
  ModelAccessSignInPrompt,
  ModelAccessSignInType,
  ModelAccessSignInUpdate,
  Result,
} from "@volli/shared";

/**
 * Where one attempt's updates go, and the only thing this service knows about
 * the window that asked for it. Send is best-effort: a closed window is not an
 * error, it is the reason {@link ModelAccessSignInService.abandonOwner} exists.
 */
export interface SignInOwner {
  send(update: ModelAccessSignInUpdate): void;
}

export interface ModelAccessSignInDeps {
  /**
   * Login and logout over the same collection the runtime holds. Sharing it is
   * not an optimization: `login` writes through that collection's credential
   * store, and a second store over the same file would be a second write chain
   * serializing nothing against the first.
   *
   * A port rather than pi-ai's `Models`, so nothing in this process names a
   * provider SDK type and every test below runs against a scripted flow.
   */
  pi: PiSignIn;
  /** Attempt and prompt ids. Injectable so a test can read its own transcript. */
  newId?: () => string;
}

/** A failure message longer than this is a stack trace, not an explanation. */
const MAX_FAILURE_MESSAGE = 300;

/** What a person is told when the flow ended because they said so. */
const CANCELLED_BY_USER = "cancel";

interface PendingPrompt {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  /** Detaches the per-prompt and attempt-level abort listeners. Idempotent. */
  release: () => void;
}

interface Attempt {
  id: string;
  providerId: string;
  owner: SignInOwner;
  abort: AbortController;
  pending: Map<string, PendingPrompt>;
  /** Values submitted during this attempt, held only to redact them back out. */
  submitted: Set<string>;
  cancelled: boolean;
  settled: boolean;
}

export class ModelAccessSignInService {
  readonly #pi: PiSignIn;
  readonly #newId: () => string;
  readonly #attempts = new Map<string, Attempt>();
  /** The one-at-a-time rule, indexed by what it is one of. */
  readonly #byProvider = new Map<string, Attempt>();

  constructor(deps: ModelAccessSignInDeps) {
    this.#pi = deps.pi;
    this.#newId = deps.newId ?? (() => crypto.randomUUID());
  }

  /**
   * Starts an attempt, or explains why it did not.
   *
   * Returns before the flow has done anything, on purpose: `Models.login` may
   * emit its first prompt synchronously, and a caller still waiting on the id
   * could not tell whose prompt it was. The id is minted first and every
   * message about the attempt carries it.
   *
   * One attempt per provider, because the second would race the first through
   * the same credential file with two half-finished logins and no way for the
   * user to tell which browser tab belongs to which.
   */
  begin(
    providerId: string,
    type: ModelAccessSignInType,
    owner: SignInOwner,
  ): ModelAccessSignInBeginResult {
    if (this.#byProvider.has(providerId)) {
      return { ok: false, error: "This provider is already signing in." };
    }
    if (!this.#pi.offers(providerId, type)) {
      return { ok: false, error: "This provider does not offer that sign-in method." };
    }

    const attempt: Attempt = {
      id: this.#newId(),
      providerId,
      owner,
      abort: new AbortController(),
      pending: new Map(),
      submitted: new Set(),
      cancelled: false,
      settled: false,
    };
    this.#attempts.set(attempt.id, attempt);
    this.#byProvider.set(providerId, attempt);

    // Deliberately not awaited: this method's contract is that the caller gets
    // the id, and the flow's whole life is reported on the update channel.
    void this.#pi.login(providerId, type, attempt.abort.signal, this.#steps(attempt)).then(
      () => this.#settle(attempt, { kind: "signed-in" }),
      (error: unknown) => this.#settle(attempt, this.#failure(attempt, error)),
    );

    return { ok: true, attemptId: attempt.id };
  }

  /**
   * Answers the step an attempt is parked on.
   *
   * An answer for a prompt that is not pending is refused rather than applied
   * to whatever is pending now. That is not defensiveness about a misbehaving
   * renderer — it is the withdrawal race: a code pasted a moment after the
   * loopback callback won would otherwise be delivered to the *next* question
   * the flow asks, and in a multi-step api-key login the next question is a
   * different field entirely.
   */
  respond(attemptId: string, promptId: string, value: string): Result {
    const attempt = this.#attempts.get(attemptId);
    if (attempt === undefined) return { ok: false, error: "This sign-in is no longer running." };
    const pending = attempt.pending.get(promptId);
    if (pending === undefined) {
      return { ok: false, error: "This sign-in step is no longer waiting for an answer." };
    }
    attempt.pending.delete(promptId);
    attempt.submitted.add(value);
    pending.release();
    pending.resolve(value);
    return { ok: true };
  }

  /** Abandons an attempt at the person's request; the flow unwinds through its own abort. */
  cancel(attemptId: string): Result {
    const attempt = this.#attempts.get(attemptId);
    if (attempt === undefined) return { ok: false, error: "This sign-in is no longer running." };
    this.#abandon(attempt);
    return { ok: true };
  }

  /**
   * Drops every attempt one window started.
   *
   * Called when that window is gone. Nothing else can end these: the flow is
   * parked on a prompt whose only answer was going to come from a renderer that
   * no longer exists, and the provider's attempt slot would stay taken for the
   * life of the process.
   */
  abandonOwner(owner: SignInOwner): void {
    // Iterated live rather than over a copy: `#abandon` only aborts, and the
    // `#settle` that deletes the entry runs a microtask later on the login
    // promise's rejection — and a Map iterator tolerates deletion regardless.
    for (const attempt of this.#attempts.values()) {
      if (attempt.owner === owner) this.#abandon(attempt);
    }
  }

  /**
   * Deletes this profile's stored credential for a provider.
   *
   * Stored, and only stored. A provider that also resolves a key from an
   * ambient environment variable stays usable afterwards, which is correct and
   * is why {@link import("@volli/shared").ModelAccessProvider.hasStoredCredential}
   * is a separate question from whether the provider is available.
   */
  async signOut(providerId: string): Promise<Result> {
    try {
      await this.#pi.logout(providerId);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: truncate(errorMessage(error)) };
    }
  }

  /** The bag the flow is driven through. Its whole surface is these three members. */
  #steps(attempt: Attempt): PiSignInSteps {
    return {
      newId: this.#newId,
      ask: (prompt, withdrawn) => this.#ask(attempt, prompt, withdrawn),
      say: (event: ModelAccessSignInEvent) => {
        this.#publish(attempt, { attemptId: attempt.id, kind: "event", event });
      },
    };
  }

  /**
   * Parks a promise until the renderer answers, someone cancels, or the flow
   * takes the question back.
   *
   * Both signals are wired before the prompt is published. A flow is entitled to
   * abort a prompt in the same tick it raised one — pi-ai's own comment
   * describes exactly that race — and a listener attached after the publish
   * could miss the abort and park forever.
   */
  #ask(
    attempt: Attempt,
    prompt: ModelAccessSignInPrompt,
    withdrawn: AbortSignal | undefined,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const promptId = prompt.promptId;
      const withdraw = (reason: string): void => {
        if (!attempt.pending.delete(promptId)) return;
        release();
        // The withdrawal is announced only when the flow or main took the
        // question back. A cancelled attempt is about to publish `settled`,
        // which retires every question at once.
        if (reason !== CANCELLED_BY_USER) {
          this.#publish(attempt, { attemptId: attempt.id, kind: "prompt-withdrawn", promptId });
        }
        reject(abortError(reason));
      };
      const onPromptAbort = (): void => withdraw("withdrawn");
      const onAttemptAbort = (): void => withdraw(CANCELLED_BY_USER);
      const release = (): void => {
        withdrawn?.removeEventListener("abort", onPromptAbort);
        attempt.abort.signal.removeEventListener("abort", onAttemptAbort);
      };

      attempt.pending.set(promptId, { resolve, reject, release });
      withdrawn?.addEventListener("abort", onPromptAbort, { once: true });
      attempt.abort.signal.addEventListener("abort", onAttemptAbort, { once: true });
      if (withdrawn?.aborted === true) return withdraw("withdrawn");
      if (attempt.abort.signal.aborted) return withdraw(CANCELLED_BY_USER);

      this.#publish(attempt, { attemptId: attempt.id, kind: "prompt", prompt });
    });
  }

  #abandon(attempt: Attempt): void {
    attempt.cancelled = true;
    // Rejects every parked prompt through the abort listeners registered in
    // #ask, which is what makes `Models.login` itself reject and reach #settle.
    attempt.abort.abort(abortError(CANCELLED_BY_USER));
  }

  /**
   * Publishes the verdict once and forgets everything the attempt was holding.
   *
   * Idempotent because both ends can reach it: an abort rejects the parked
   * prompt *and* the login promise, and those are two paths to one ending.
   */
  #settle(attempt: Attempt, outcome: SettleOutcome): void {
    if (attempt.settled) return;
    attempt.settled = true;
    this.#attempts.delete(attempt.id);
    if (this.#byProvider.get(attempt.providerId) === attempt) {
      this.#byProvider.delete(attempt.providerId);
    }
    attempt.pending.clear();
    this.#publish(attempt, { attemptId: attempt.id, kind: "settled", outcome });
    // The last reference to anything the person typed.
    attempt.submitted.clear();
  }

  /**
   * A cancelled attempt is cancelled however the rejection was spelled.
   *
   * `Models.login` reports an abort as whatever the aborted step threw, and
   * those vary by provider. What is not ambiguous is whether *we* aborted it,
   * so that flag decides the verdict and the provider's message is dropped —
   * telling someone who clicked Cancel that "the operation was aborted" is
   * repeating their own input back at them as news.
   */
  #failure(attempt: Attempt, error: unknown): SettleOutcome {
    if (attempt.cancelled) return { kind: "cancelled" };
    return {
      kind: "failed",
      message: truncate(redactSubmitted(errorMessage(error), attempt.submitted)),
    };
  }

  #publish(attempt: Attempt, update: ModelAccessSignInUpdate): void {
    attempt.owner.send(update);
  }
}

type SettleOutcome = Extract<ModelAccessSignInUpdate, { kind: "settled" }>["outcome"];

/**
 * Removes anything the person typed from a message about to leave main.
 *
 * A last line rather than the only one: the values are handed to the provider
 * and never composed into a message here, so this catches the case Volli does
 * not control — a provider that rejects a credential by quoting the request it
 * rejected. Substring replacement, not a pattern, because it is matching values
 * it already has rather than guessing what a credential looks like.
 */
export function redactSubmitted(message: string, submitted: ReadonlySet<string>): string {
  let redacted = message;
  for (const value of submitted) {
    // A short answer is a menu choice or a project id, not a credential, and
    // blanking every occurrence of a two-character string would shred the
    // message without protecting anything.
    if (value.length < 8) continue;
    redacted = redacted.split(value).join("[redacted]");
  }
  return redacted;
}

function truncate(message: string): string {
  return message.length <= MAX_FAILURE_MESSAGE
    ? message
    : `${message.slice(0, MAX_FAILURE_MESSAGE - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(reason: string): Error {
  const error = new Error(`Sign-in ${reason}.`);
  error.name = "AbortError";
  return error;
}
