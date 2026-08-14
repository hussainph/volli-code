/**
 * Pi's login vocabulary, translated into Volli's.
 *
 * The same job {@link import("./model-access").inspectPiModelAccess} does for
 * account state, done for the conversation that establishes one. Pi names its
 * prompt and event kinds in snake_case and Volli names them in kebab; that is
 * not the point of this module. The point is that `AuthPrompt` and `AuthEvent`
 * are `@earendil-works/pi-ai` types, `@volli/shared` may name no provider SDK
 * type, and so exactly one file may know both — this one. Above it the renderer
 * dispatches on Volli's four kinds and cannot tell which SDK produced them.
 *
 * Every mapping here is total and exhaustive on Pi's side. A pinned-revision
 * bump that adds a prompt or event kind is a compile error in this file rather
 * than a silently dropped step in a login the user is watching, which is the
 * failure this shape exists to prevent: a dropped prompt does not look like a
 * bug, it looks like a sign-in that hung.
 *
 * **Nothing here reads a credential.** A prompt states what it wants and an
 * event states what is happening; the answer travels the other way and is never
 * seen by this module.
 */

import type { AuthEvent, AuthPrompt, AuthType, Models, Provider } from "@earendil-works/pi-ai";
import type {
  ModelAccessSignInEvent,
  ModelAccessSignInMethod,
  ModelAccessSignInPrompt,
  ModelAccessSignInType,
} from "@volli/shared";

/**
 * Where a running login's questions and statements go.
 *
 * The inversion is the point. `AuthInteraction` hands pi-ai's own prompt and
 * event types to whoever drives a login; this hands Volli's, so the driver —
 * which lives in main, owns the attempt registry and is the thing that has to
 * be tested without a network — never names a provider SDK type and never has
 * to know that `manual_code` and `manual-code` are the same idea.
 */
export interface PiSignInSteps {
  /** Ids for the steps this login raises. Injectable so a test can read its own transcript. */
  newId(): string;
  /**
   * Asks one step and resolves with the answer.
   *
   * `withdrawn` is the flow's own per-step signal, and forwarding it is not
   * optional: Anthropic, OpenAI Codex and OpenRouter ask for a pasted code *as
   * a race* against a loopback callback server and abort exactly this signal
   * when the callback wins. A driver that ignored it would leave the question
   * on screen after the flow already had its answer. Reject to abort the step.
   */
  ask(prompt: ModelAccessSignInPrompt, withdrawn: AbortSignal | undefined): Promise<string>;
  /** States something with no answer to follow. */
  say(event: ModelAccessSignInEvent): void;
}

/** Login and logout for one provider collection, in Volli's vocabulary throughout. */
export interface PiSignIn {
  /** Whether this provider offers that method at all. False for an unknown provider. */
  offers(providerId: string, type: ModelAccessSignInType): boolean;
  /** Runs the provider's flow and persists what it returns. Rejects on failure or abort. */
  login(
    providerId: string,
    type: ModelAccessSignInType,
    signal: AbortSignal,
    steps: PiSignInSteps,
  ): Promise<void>;
  /** Removes the stored credential. Ambient sources are not Pi's to remove. */
  logout(providerId: string): Promise<void>;
}

/**
 * The seam main drives a sign-in through.
 *
 * `Models.login` already persists the credential it returns — through the
 * store this collection was built with, under that store's lock — so there is
 * nothing to write here and deliberately nowhere to hold what was written. The
 * returned `Credential` is dropped rather than returned: the only Volli
 * question it could answer is whether a credential now exists, and
 * {@link inspectPiModelAccess} answers that by reading the file.
 */
export function piSignIn(models: Models): PiSignIn {
  return {
    offers: (providerId, type) => {
      const provider = models.getProvider(providerId);
      return (
        provider !== undefined &&
        providerSignInMethods(provider).some((method) => method.type === type)
      );
    },
    login: async (providerId, type, signal, steps) => {
      await models.login(providerId, piAuthType(type), {
        signal,
        prompt: (prompt: AuthPrompt) =>
          steps.ask(toSignInPrompt(steps.newId(), prompt), prompt.signal),
        notify: (event: AuthEvent) => steps.say(toSignInEvent(event)),
      });
    },
    logout: (providerId) => models.logout(providerId),
  };
}

/** Volli's word for a login method, in Pi's. The two vocabularies differ only in spelling. */
export function piAuthType(type: ModelAccessSignInType): AuthType {
  return type === "api-key" ? "api_key" : "oauth";
}

/**
 * What a provider can be signed in to with, in the provider's own words.
 *
 * `apiKey.login` being optional is a real distinction rather than defensive
 * typing: pi-ai's own comment says "Absent = ambient-only", meaning a provider
 * that reads a key from the environment and has no interactive setup to offer.
 * Such a provider must advertise no API-key method, because a button that
 * opened a flow with no first step would park forever.
 *
 * The label is the provider's, never a generated one. "Sign in with SuperGrok
 * or X Premium" tells a person which of their subscriptions is about to be
 * charged, and "OAuth" does not.
 */
export function providerSignInMethods(provider: Provider): readonly ModelAccessSignInMethod[] {
  const methods: ModelAccessSignInMethod[] = [];
  const apiKey = provider.auth.apiKey;
  if (apiKey?.login !== undefined) {
    methods.push({ type: "api-key", label: apiKey.name, isSubscription: false });
  }
  const oauth = provider.auth.oauth;
  if (oauth !== undefined) {
    methods.push({
      type: "oauth",
      label: oauth.loginLabel ?? oauth.name,
      isSubscription: oauth.isSubscription === true,
    });
  }
  return methods;
}

/**
 * One step of a login, addressed so the answer can only land on it.
 *
 * `promptId` is minted by the caller rather than derived from the prompt,
 * because nothing in an `AuthPrompt` is unique: Cloudflare asks for two
 * different ids with the same shape, and Google Vertex asks four questions in a
 * row. An answer that named only its attempt could be applied to whichever
 * question happened to be pending when it arrived.
 */
export function toSignInPrompt(promptId: string, prompt: AuthPrompt): ModelAccessSignInPrompt {
  const base = { promptId, message: prompt.message };
  switch (prompt.type) {
    case "text":
      return { ...base, kind: "text", placeholder: prompt.placeholder ?? null, options: [] };
    case "secret":
      return { ...base, kind: "secret", placeholder: prompt.placeholder ?? null, options: [] };
    case "manual_code":
      return { ...base, kind: "manual-code", placeholder: prompt.placeholder ?? null, options: [] };
    case "select":
      return {
        ...base,
        kind: "select",
        placeholder: null,
        options: prompt.options.map((option) => ({
          id: option.id,
          label: option.label,
          description: option.description ?? null,
        })),
      };
  }
}

/**
 * Something to show while the flow works, with no answer to follow.
 *
 * All four kinds are shipped by real providers today and none is theoretical:
 * Anthropic and OpenRouter emit `auth_url`, xAI and Kimi emit `device_code`,
 * GitHub Copilot and OpenAI Codex emit both across their branches, and every
 * flow emits `progress` around its network calls. Dropping any one of them
 * would strand a person at a step whose instructions never arrived.
 */
export function toSignInEvent(event: AuthEvent): ModelAccessSignInEvent {
  switch (event.type) {
    case "info":
      return {
        kind: "info",
        message: event.message,
        links: (event.links ?? []).map((link) => ({ url: link.url, label: link.label ?? null })),
      };
    case "auth_url":
      return { kind: "auth-url", url: event.url, instructions: event.instructions ?? null };
    case "device_code":
      return {
        kind: "device-code",
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        intervalSeconds: event.intervalSeconds ?? null,
        expiresInSeconds: event.expiresInSeconds ?? null,
      };
    case "progress":
      return { kind: "progress", message: event.message };
  }
}
