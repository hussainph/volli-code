/**
 * Sign-ins on a host, owned by the connection that asked (VC-702; HP §
 * Sign-ins on a host).
 *
 * What the `sign-ins` and `auth.callback` features do, once, for every door
 * that projects them:
 *
 * - **Status** is availability only: per provider signed-in, expired or
 *   missing, and the kind; per git host, that it holds a push credential.
 * - **API keys and git push credentials** come in write-only and go straight
 *   to the host's key-provider port ({@link HostSignInKeyProvider}). No answer
 *   carries one back, and no failure message quotes one.
 * - **Subscription logins run here**, on {@link ModelAccessSignInService}
 *   over the host's own Pi collection, so the refresh token is minted on, and
 *   never leaves, the host. A flow belongs to the connection that started it:
 *   every later call names its `flowId` and is answered only on that
 *   connection; on any other, the flow answers exactly as an absent one
 *   (`sign-in-unknown`), so one device can neither drive nor discover
 *   another's. When the connection ends, its flows are cancelled.
 * - **The auth-callback relay** ({@link relayTargetOf}): when a flow emits a
 *   loopback authorization URL and the connection was granted
 *   `auth.callback`, the flow's stream carries `auth-callback {flowId,
 *   redirectUri}` before the `auth-url`, and `auth.callback.deliver` replays
 *   one request, once, to the host's own listener. The grant ends with the
 *   flow. A Client that cannot bind the port answers the flow's pasted-code
 *   prompt with `signIns.answer` instead; Pi races the two.
 *
 * Nothing here logs. A value a person typed is handed to the provider's flow
 * and redacted out of any failure the flow reports (`redactSubmitted`).
 */
import { randomUUID } from "node:crypto";

import type { PiSignIn } from "@volli/agent-runtime";
import {
  OperationUnavailableError,
  SignInRefusedError,
  normalizeGitHost,
  type HandlerCall,
  type HandlerConnection,
  type HostAuthCallbackDeliverInput,
  type HostAuthCallbackDeliverResult,
  type HostProviderSignIn,
  type HostSetApiKeyInput,
  type HostSetGitCredentialInput,
  type HostSignInAnswerInput,
  type HostSignInFlow,
  type HostSignInStartInput,
  type HostSignInStatus,
  type HostSignInUpdate,
  type ModelAccessProvider,
  type ModelAccessSignInType,
  type ModelAccessSignInUpdate,
  type ModelAccessSnapshot,
} from "@volli/shared";

import { ModelAccessSignInService } from "../model-access/sign-in-service";
import { gitCredentialFieldValid } from "./git-credentials";
import type { HostSignInKeyProvider, StoredModelCredential } from "./ports";
import {
  deliveryMatches,
  fetchCallbackReplay,
  relayTargetOf,
  replayUrl,
  type CallbackReplay,
  type RelayTarget,
} from "./relay";

/** The feature a connection asks for to say it can relay a loopback callback. */
export const AUTH_CALLBACK_FEATURE = "auth.callback";

/** A flow says a handful of things; one that says more than this is cut off, never truncated. */
export const MAX_FLOW_UPDATES = 256;

/** Flows one connection may hold, settled ones included until it reads them or leaves. */
export const MAX_FLOWS_PER_CONNECTION = 8;

export interface HostSignInsOptions {
  /** Login and logout over the host's own Pi collection. */
  readonly pi: PiSignIn;
  /** The host's Model Access snapshot: which providers exist and whether each authenticates. */
  readonly inspect: () => Promise<ModelAccessSnapshot>;
  /** Where sent keys and push credentials are kept. */
  readonly keys: HostSignInKeyProvider;
  /** The relay's replay to the host's own listener. Injectable so a test needs no socket. */
  readonly replay?: CallbackReplay;
  readonly now?: () => number;
  readonly newId?: () => string;
}

type FlowSink = {
  emit(update: HostSignInUpdate): void | Promise<void>;
  fail(error: unknown): void;
};

interface Flow {
  id: string;
  readonly providerId: string;
  readonly type: ModelAccessSignInType;
  readonly connection: HandlerConnection;
  readonly updates: HostSignInUpdate[];
  readonly sinks: Set<FlowSink>;
  settled: boolean;
  /** The person (or the connection's end) cancelled it; Pi's own unwinding may still be under way. */
  cancelled: boolean;
  /** The relay grant: at most one per flow, spent by its first delivery. */
  relay: { readonly target: RelayTarget; used: boolean } | null;
  /**
   * Aborts when the flow is cancelled: a replay still running is abandoned
   * with it. Not when it settles: Pi settles while its listener is still
   * answering the replay that signed it in.
   */
  readonly abandoned: AbortController;
}

const NO_CONNECTION = "Sign-ins on a host belong to a network connection, and this door has none.";
const UNKNOWN_FLOW = "There is no such sign-in on this connection.";

export class HostSignIns {
  readonly #pi: PiSignIn;
  readonly #flowsService: ModelAccessSignInService;
  readonly #inspect: () => Promise<ModelAccessSnapshot>;
  readonly #keys: HostSignInKeyProvider;
  readonly #replay: CallbackReplay;
  readonly #now: () => number;
  readonly #flows = new Map<string, Flow>();
  /** Connections whose end this service already listens for. */
  readonly #watched = new Set<string>();

  constructor(options: HostSignInsOptions) {
    this.#pi = options.pi;
    this.#inspect = options.inspect;
    this.#keys = options.keys;
    this.#replay = options.replay ?? fetchCallbackReplay;
    this.#now = options.now ?? Date.now;
    this.#flowsService = new ModelAccessSignInService({
      pi: options.pi,
      newId: options.newId ?? (() => randomUUID()),
    });
  }

  /** `signIns.status`: availability for every provider and stored git host, never a value. */
  async status(): Promise<HostSignInStatus> {
    // Inspect first: its auth probe is what refreshes an OAuth token, so the
    // expiry read after it is the one that refresh left behind.
    const snapshot = await this.#inspect();
    const [stored, gitHosts] = await Promise.all([
      this.#keys.models.stored(),
      this.#keys.git.hosts(),
    ]);
    const storedById = new Map(stored.map((credential) => [credential.providerId, credential]));
    const now = this.#now();
    return {
      providers: snapshot.providers
        .filter((provider) => provider.signIn.length > 0 || storedById.has(provider.id))
        .map((provider) => providerRow(provider, storedById.get(provider.id), now)),
      git: gitHosts.map((host) => ({ host, state: "signed-in", kind: "git" })),
    };
  }

  /** `signIns.setApiKey`: write-only into the host's Pi auth storage. */
  async setApiKey(input: HostSetApiKeyInput): Promise<HostSignInStatus> {
    if (!this.#pi.offers(input.providerId, "api-key")) {
      throw new SignInRefusedError(
        "sign-in-unsupported",
        "This host cannot take an API key for that provider.",
      );
    }
    try {
      await this.#keys.models.setApiKey(input.providerId, input.key);
    } catch {
      // The store's own error is not repeated: it is not ours to vouch that
      // it does not quote what it was asked to write.
      throw new Error("This host could not store the API key.");
    }
    return this.status();
  }

  /** `signIns.signOut`: removes the stored credential; an ambient one stays. */
  async signOut(input: { providerId: string }): Promise<HostSignInStatus> {
    const result = await this.#flowsService.signOut(input.providerId);
    if (!result.ok) throw new Error(result.error);
    return this.status();
  }

  /** `signIns.setGitCredential`: write-only into the host's push-credential store. */
  async setGitCredential(input: HostSetGitCredentialInput): Promise<HostSignInStatus> {
    const host = gitHostOf(input.host);
    if (!gitCredentialFieldValid(input.username) || !gitCredentialFieldValid(input.password)) {
      throw new SignInRefusedError(
        "sign-in-unsupported",
        "A git push credential's user and password must each be one line.",
      );
    }
    try {
      await this.#keys.git.set(host, { username: input.username, password: input.password });
    } catch {
      throw new Error("This host could not store the git push credential.");
    }
    return this.status();
  }

  /** `signIns.clearGitCredential`: removes one host's push credential, if it held one. */
  async clearGitCredential(input: { host: string }): Promise<HostSignInStatus> {
    await this.#keys.git.clear(gitHostOf(input.host));
    return this.status();
  }

  /**
   * `signIns.start`: begins a flow owned by the asking connection. A repeat
   * from the same connection for a provider it is already signing in answers
   * that flow.
   */
  start(input: HostSignInStartInput, call: HandlerCall): HostSignInFlow {
    const connection = connectionOf(call);
    if (connection.closed.aborted) throw new SignInRefusedError("sign-in-unknown", UNKNOWN_FLOW);
    const type = input.type ?? "oauth";
    const running = [...this.#flows.values()].find(
      (flow) =>
        !flow.settled &&
        flow.connection.id === connection.id &&
        flow.providerId === input.providerId,
    );
    if (running !== undefined) {
      if (running.type !== type) {
        throw new SignInRefusedError(
          "sign-in-conflict",
          "This connection is already signing that provider in another way.",
        );
      }
      return { flowId: running.id };
    }
    if (!this.#pi.offers(input.providerId, type)) {
      throw new SignInRefusedError(
        "sign-in-unsupported",
        "This host cannot sign in to that provider that way.",
      );
    }
    this.#makeRoom(connection.id);
    const flow: Flow = {
      id: "",
      providerId: input.providerId,
      type,
      connection,
      updates: [],
      sinks: new Set(),
      settled: false,
      cancelled: false,
      relay: null,
      abandoned: new AbortController(),
    };
    const begun = this.#flowsService.begin(input.providerId, type, {
      // The flow may speak before `begin` returns; its updates carry the id.
      send: (update) => {
        if (flow.id === "") flow.id = update.attemptId;
        this.#receive(flow, update);
      },
    });
    if (!begun.ok) {
      throw new SignInRefusedError("sign-in-conflict", "That provider is already signing in.");
    }
    flow.id = begun.attemptId;
    this.#flows.set(flow.id, flow);
    this.#watch(connection);
    return { flowId: flow.id };
  }

  /** `signIns.subscribe`: everything the flow said so far, then live, to its end. */
  async subscribe(input: HostSignInFlow, call: HandlerCall, sink: FlowSink): Promise<() => void> {
    const flow = this.#owned(input.flowId, call);
    for (const update of flow.updates) await sink.emit(update);
    if (flow.settled) return () => {};
    flow.sinks.add(sink);
    return () => {
      flow.sinks.delete(sink);
    };
  }

  /** `signIns.answer`: the step the flow waits on, the pasted redirect included. */
  answer(input: HostSignInAnswerInput, call: HandlerCall): void {
    const flow = this.#owned(input.flowId, call);
    if (flow.settled || flow.cancelled) {
      throw new SignInRefusedError("sign-in-conflict", "This sign-in has already ended.");
    }
    const answered = this.#flowsService.respond(flow.id, input.promptId, input.value);
    if (!answered.ok) throw new SignInRefusedError("sign-in-conflict", answered.error);
  }

  /**
   * `signIns.cancel`: ends the flow; a flow that already ended stays as it
   * ended. The relay grant is revoked here, synchronously, and a replay still
   * running is abandoned: nothing waits on Pi's own unwinding, so no
   * redirect is delivered after cancel returns.
   */
  cancel(input: HostSignInFlow, call: HandlerCall): void {
    const flow = this.#owned(input.flowId, call);
    if (flow.settled) return;
    this.#abandon(flow);
  }

  /**
   * `auth.callback.deliver`: replays the browser's redirect to the host's own
   * listener, once. The grant is spent by the first delivery that matches its
   * path, whatever the listener answers, and ends with the flow.
   */
  async deliverCallback(
    input: HostAuthCallbackDeliverInput,
    call: HandlerCall,
  ): Promise<HostAuthCallbackDeliverResult> {
    const flow = this.#owned(input.flowId, call);
    const relay = flow.relay;
    if (flow.settled || flow.cancelled || relay === null || relay.used) {
      throw new SignInRefusedError(
        "sign-in-conflict",
        "This sign-in holds no callback grant to deliver to.",
      );
    }
    if (!deliveryMatches(relay.target, input.pathAndQuery)) {
      throw new SignInRefusedError(
        "sign-in-conflict",
        "That request is not this sign-in's callback.",
      );
    }
    relay.used = true;
    try {
      const status = await this.#replay(
        replayUrl(relay.target, input.pathAndQuery),
        AbortSignal.any([flow.connection.closed, flow.abandoned.signal]),
      );
      // Cancelled while the listener answered: say so, never a success.
      if (flow.cancelled) throw new Error("cancelled");
      return { status };
    } catch {
      throw new SignInRefusedError(
        "sign-in-conflict",
        "The host's sign-in listener did not answer the callback.",
      );
    }
  }

  /** Flows this service holds: a test's view of what a connection's end released. */
  get flowCount(): number {
    return this.#flows.size;
  }

  #owned(flowId: string, call: HandlerCall): Flow {
    const connection = connectionOf(call);
    const flow = this.#flows.get(flowId);
    if (flow === undefined || flow.connection.id !== connection.id) {
      throw new SignInRefusedError("sign-in-unknown", UNKNOWN_FLOW);
    }
    return flow;
  }

  #receive(flow: Flow, update: ModelAccessSignInUpdate): void {
    for (const translated of this.#translate(flow, update)) this.#publish(flow, translated);
  }

  #translate(flow: Flow, update: ModelAccessSignInUpdate): HostSignInUpdate[] {
    switch (update.kind) {
      case "prompt":
        return [{ kind: "prompt", prompt: update.prompt }];
      case "prompt-withdrawn":
        return [{ kind: "prompt-withdrawn", promptId: update.promptId }];
      case "event": {
        const event = update.event;
        if (event.kind !== "auth-url") return [event];
        const target = relayTargetOf(event.url);
        if (
          target === null ||
          flow.cancelled ||
          flow.relay !== null ||
          !flow.connection.features.includes(AUTH_CALLBACK_FEATURE)
        ) {
          return [event];
        }
        flow.relay = { target, used: false };
        // Before the URL, so the Client listens before the browser can redirect.
        return [
          { kind: "auth-callback", flowId: update.attemptId, redirectUri: target.redirectUri },
          event,
        ];
      }
      case "settled":
        flow.settled = true;
        flow.relay = null;
        switch (update.outcome.kind) {
          case "signed-in":
            return [{ kind: "done" }];
          case "cancelled":
            return [{ kind: "cancelled" }];
          case "failed":
            return [{ kind: "failed", message: update.outcome.message }];
        }
    }
  }

  #publish(flow: Flow, update: HostSignInUpdate): void {
    const final = update.kind === "done" || update.kind === "failed" || update.kind === "cancelled";
    if (!final && flow.updates.length >= MAX_FLOW_UPDATES) {
      // Never a silent gap: a flow that says too much is ended, and its end
      // is what the stream reports.
      this.#abandon(flow);
      return;
    }
    flow.updates.push(update);
    for (const sink of flow.sinks) void sink.emit(update);
    if (final) flow.sinks.clear();
  }

  /** Cancels a running flow: its grant goes at once, then Pi unwinds. */
  #abandon(flow: Flow): void {
    flow.cancelled = true;
    flow.relay = null;
    flow.abandoned.abort();
    this.#flowsService.cancel(flow.id);
  }

  /** Cancels and forgets every flow of a connection when it ends. */
  #watch(connection: HandlerConnection): void {
    if (this.#watched.has(connection.id)) return;
    this.#watched.add(connection.id);
    connection.closed.addEventListener(
      "abort",
      () => {
        this.#watched.delete(connection.id);
        for (const flow of this.#flows.values()) {
          if (flow.connection.id !== connection.id) continue;
          if (!flow.settled) this.#abandon(flow);
          this.#flows.delete(flow.id);
        }
      },
      { once: true },
    );
  }

  /** Keeps a connection under its flow budget by forgetting its oldest ended flow. */
  #makeRoom(connectionId: string): void {
    const mine = [...this.#flows.values()].filter((flow) => flow.connection.id === connectionId);
    if (mine.length < MAX_FLOWS_PER_CONNECTION) return;
    const oldestSettled = mine.find((flow) => flow.settled);
    if (oldestSettled === undefined) {
      throw new SignInRefusedError(
        "sign-in-conflict",
        "This connection is already running as many sign-ins as it may.",
      );
    }
    this.#flows.delete(oldestSettled.id);
  }
}

function connectionOf(call: HandlerCall): HandlerConnection {
  if (call.connection === undefined) throw new OperationUnavailableError(NO_CONNECTION);
  return call.connection;
}

function gitHostOf(value: string): string {
  const host = normalizeGitHost(value);
  if (host === null) {
    throw new SignInRefusedError(
      "sign-in-unsupported",
      "A git host is a host name with an optional port, like github.com.",
    );
  }
  return host;
}

/**
 * One provider's row. Expired is a stored credential that no longer
 * authenticates: the probe asked for a sign-in, or an OAuth token is past
 * its expiry after the probe's refresh and the provider is not available.
 */
function providerRow(
  provider: ModelAccessProvider,
  stored: StoredModelCredential | undefined,
  now: number,
): HostProviderSignIn {
  const base = { providerId: provider.id, label: provider.label, methods: provider.signIn };
  if (stored === undefined) {
    // An ambient key (an environment variable) is signed in, but not by
    // anything this host stores or a Client sent.
    return {
      ...base,
      state: provider.state === "available" ? "signed-in" : "missing",
      kind: null,
    };
  }
  const subscription =
    stored.type === "oauth" &&
    provider.signIn.some((method) => method.type === "oauth" && method.isSubscription);
  const lapsed =
    stored.type === "oauth" &&
    stored.expiresAt !== null &&
    stored.expiresAt <= now &&
    provider.state !== "available";
  return {
    ...base,
    state: provider.state === "authentication-required" || lapsed ? "expired" : "signed-in",
    kind: subscription ? "subscription" : "api-key",
  };
}
