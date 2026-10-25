/**
 * Desktop main's Volli Cloud account (VC-884): the sign-in flow, the tokens,
 * and the snapshot the window sees. It is the handler map's `AccountPort`
 * (`@volli/host-core/handlers`), served only with the `cloud` flag on.
 *
 * **Sign-in.** A button names GitHub or Google. Main makes a PKCE pair and a
 * `state`, opens a loopback listener (`./loopback`) and sends the system
 * browser to the provider's authorization URL. The provider redirects to the
 * listener; main checks `state`, trades the code (proving the verifier) for
 * tokens, seals the refresh token (`./session-store`) and keeps the access
 * token in memory. Then the backend's `accounts.ensureViewer` creates or
 * finds the person. One flow at a time: a new start, a cancel or a sign-out
 * ends the one in flight, and the browser has ten minutes.
 *
 * **Epochs.** Every sign-in, cancel and sign-out starts a new epoch. Work
 * begun under an older one (a restore, a refresh, a code exchange) drops its
 * result when it lands, and a record it sealed meanwhile is removed again, so
 * nothing the person ended comes back at the next launch.
 *
 * **Tokens.** {@link AccountService.accessToken} answers the in-memory token
 * while it has a minute left, else refreshes once (concurrent callers share
 * the refresh), rotating the sealed refresh token. A refusal (a revoked or
 * expired grant) signs out; any other failure (offline) keeps the sign-in and
 * marks the backend unreachable, so the board can stay a read-only cache.
 * The window's own Volli Cloud client gets a short-lived access token on
 * demand ({@link AccountService.windowToken}, VC-889); the refresh token
 * never leaves main.
 *
 * **The launch marker** (VC-889, `../cloud-launch.ts`): written when the
 * backend answers for a sign-in, cleared whenever the account ends up signed
 * out, so the next launch opens the store the account now chooses.
 *
 * **Restore.** The saved sign-in is read when it is first asked for: the
 * window's first snapshot, or the first {@link AccountService.accessToken}.
 * Stable preview launches with a deliberate sign-in marker restore before
 * choosing the product store; other launches read it only on demand, so
 * there is no keychain access before a deliberate sign-in. While the backend is
 * unreachable, each new window subscription tries it again.
 *
 * **Sign-out** forgets the tokens and the sealed record, then opens the
 * provider's logout page so its browser session ends too. **Deletion** asks
 * the backend (`accounts.requestDeletion` / `cancelDeletion`); the window
 * shows the pending date and offers a restore.
 */
import {
  ACCOUNT_TEXT_MAX,
  ACCOUNT_TOKEN_RETRY_MS,
  OperationUnavailableError,
  UNCONFIGURED_ACCOUNT,
  isAccountConnection,
  type AccountAccessToken,
  type AccountBackendState,
  type AccountConnection,
  type AccountSnapshot,
  type AccountState,
} from "@volli/shared";

import { previewAccountGranted } from "../preview-gate";
import { BackendRefusedError, type AccountBackend, type BackendViewer } from "./backend";
import { CallbackAbortedError, listenForCallback, type LoopbackCallback } from "./loopback";
import { createPkcePair, newState } from "./pkce";
import { isProviderRefused, type AccountProvider, type ProviderTokens } from "./provider";
import {
  SavedSessionChangedError,
  type AccountSessionStore,
  type SavedAccountSession,
  type SavedSessionRef,
} from "./session-store";

/** How long the browser has to come back. */
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
/** An access token with less than this left is refreshed before use. */
const ACCESS_TOKEN_MARGIN_MS = 60 * 1000;
/**
 * A forced token request within this long of the last refresh answers the
 * token that refresh issued: the window's client asks for a cached token and
 * then at once a forced one whenever it starts, and each forced refresh
 * rotates the provider's refresh token.
 */
const FORCED_REFRESH_FLOOR_MS = 30 * 1000;

const SIGNED_OUT_TOKEN: AccountAccessToken = Object.freeze({ kind: "signed-out" });
const UNAVAILABLE_TOKEN: AccountAccessToken = Object.freeze({
  kind: "unavailable",
  retryAfterMs: ACCOUNT_TOKEN_RETRY_MS,
});

export const PREVIEW_WAITLIST =
  "Volli Cloud is invite-only. You're on the waitlist; your local projects are unchanged.";

export const ACCOUNT_CLOUD_OFF = "Volli Cloud is off. Turn it on in Settings → Experimental.";

const OFFLINE = "Couldn't reach Volli Cloud. Your sign-in is kept.";
const NOT_ACCEPTED = "Volli Cloud didn't accept this sign-in. Sign out and sign in again.";

export interface AccountLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface AccountServiceOptions {
  /** The `cloud` flag, read on every call. */
  readonly enabled: () => boolean;
  /** `null`: this build names no sign-in provider (`unconfigured`). */
  readonly provider: AccountProvider | null;
  /** `null`: this build names no backend; sign-in still works, nothing syncs. */
  readonly backend: AccountBackend | null;
  readonly store: AccountSessionStore;
  /** Opens the system browser (harness mode records instead); rejects when it cannot. */
  readonly openBrowser: (url: string) => void | Promise<void>;
  readonly listen?: typeof listenForCallback;
  readonly signInTimeoutMs?: number;
  readonly now?: () => number;
  readonly log?: AccountLogger;
  /** The next launch's product store (`../cloud-launch.ts`): who is signed in, or nobody. */
  readonly marker?: { write(userId: string): void; clear(): void };
}

export interface AccountService {
  /** Fresh backend grant only, never a saved profile or launch marker. */
  previewUserId(): string | null;
  snapshot(): AccountSnapshot;
  subscribe(listener: (snapshot: AccountSnapshot) => void): () => void;
  signIn(connection: AccountConnection, inviteCode?: string): Promise<void>;
  cancelSignIn(): void;
  signOut(): Promise<void>;
  requestDeletion(): Promise<void>;
  cancelDeletion(): Promise<void>;
  /**
   * A current access token for a backend call, refreshed when it is about to
   * expire; `null` while signed out or with `cloud` off. Reads the saved
   * sign-in first if nothing has yet. Main's own backend calls use it.
   */
  accessToken(): Promise<string | null>;
  /**
   * {@link accessToken} for the window's own Volli Cloud client (VC-889):
   * sent to the window only as this short-lived access token, never the
   * refresh token. `force` refreshes first, unless the last refresh was a
   * moment ago. A transient failure is `unavailable`, never `signed-out`, so
   * the client keeps the board it holds rather than clearing its auth.
   */
  windowToken(force: boolean): Promise<AccountAccessToken>;
  /** Waits for the work in flight (a restore, a sign-in) to settle. */
  settled(): Promise<void>;
  /** Ends a sign-in in flight and stops the dev issuer. At quit. */
  dispose(): void;
}

interface Session {
  saved: SavedAccountSession;
  ref: SavedSessionRef;
  accessToken: string | null;
  accessExpiresAt: number;
  /** When main last received an access token for this sign-in; 0 for none yet. */
  accessIssuedAt: number;
}

interface Flow {
  readonly connection: AccountConnection;
  readonly abort: AbortController;
}

const SILENT: AccountLogger = { info: () => {}, warn: () => {} };

/** Within the wire's bound: a provider or backend may answer a longer name than the window takes. */
function clip(text: string): string;
function clip(text: string | null): string | null;
function clip(text: string | null): string | null {
  return text === null ? null : text.slice(0, ACCOUNT_TEXT_MAX);
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

/** What a sign-in or refresh leaves sealed: its refresh token, and the profile it knows. */
function savedFrom(
  live: AccountProvider,
  tokens: ProviderTokens,
  previous?: SavedAccountSession,
): SavedAccountSession {
  return {
    provider: live.kind,
    refreshToken: tokens.refreshToken,
    sessionId: tokens.sessionId ?? previous?.sessionId ?? null,
    profile: {
      displayName: tokens.profile.displayName ?? previous?.profile.displayName ?? null,
      email: tokens.profile.email ?? previous?.profile.email ?? null,
    },
  };
}

export function createAccountService(options: AccountServiceOptions): AccountService {
  const { provider, backend, store } = options;
  const now = options.now ?? Date.now;
  const listen = options.listen ?? listenForCallback;
  const log = options.log ?? SILENT;
  const listeners = new Set<(snapshot: AccountSnapshot) => void>();
  const disconnected: AccountBackendState = backend === null ? "none" : "unreachable";

  let state: Exclude<AccountState, "unconfigured"> = "signed-out";
  let session: Session | null = null;
  let viewer: BackendViewer | null = null;
  let backendState: AccountBackendState = disconnected;
  let failure: string | null = null;
  let flow: Flow | null = null;
  let restore: Promise<void> | null = null;
  let syncing: Promise<void> | null = null;
  let pending: Promise<unknown> = Promise.resolve();
  let refreshing: { epoch: number; token: Promise<string | null> } | null = null;
  let epoch = 0;

  const current = (): AccountSnapshot => {
    if (provider === null) return UNCONFIGURED_ACCOUNT;
    const signedIn = state === "signed-in" && session !== null;
    return {
      state,
      provider: provider.kind,
      signingInWith: state === "signing-in" ? (flow?.connection ?? null) : null,
      account: signedIn
        ? {
            displayName: clip(
              viewer?.displayName ??
                session!.saved.profile.displayName ??
                session!.saved.profile.email ??
                "Volli user",
            ),
            email: clip(viewer?.primaryEmail ?? session!.saved.profile.email),
            userId: clip(viewer?.userId ?? null),
            deletionPurgeAfter: viewer?.status === "deletion_pending" ? viewer.purgeAfter : null,
            backend: backendState,
          }
        : null,
      failure: clip(failure),
    };
  };

  const emit = (): void => {
    const snapshot = current();
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        log.warn("account listener failed", { error });
      }
    }
  };

  const track = <T>(work: Promise<T>): Promise<T> => {
    pending = Promise.allSettled([pending, work]);
    return work;
  };

  const requireCloud = (): void => {
    if (!options.enabled()) throw new OperationUnavailableError(ACCOUNT_CLOUD_OFF);
  };

  const requireEnabled = (): AccountProvider => {
    requireCloud();
    if (provider === null) {
      throw new OperationUnavailableError("This build has no Volli Cloud sign-in configured.");
    }
    return provider;
  };

  /** A new epoch: whatever is in flight drops its result. */
  const advance = (): number => {
    epoch += 1;
    refreshing = null;
    return epoch;
  };

  const signedOut = (reason: string | null): void => {
    options.marker?.clear();
    session = null;
    viewer = null;
    backendState = disconnected;
    state = "signed-out";
    failure = reason;
  };

  /** Forgets the saved sign-in, then signs out with `reason`, unless the epoch moved meanwhile. */
  const forget = async (reason: string | null, startedIn: number): Promise<void> => {
    await store.clear().catch((error: unknown) => {
      log.warn("could not forget the saved sign-in", { error });
    });
    if (epoch !== startedIn) return;
    signedOut(reason);
    emit();
  };

  /** Seals `saved` in place of `expect`; when the epoch moved meanwhile, removes it again. */
  const seal = async (
    saved: SavedAccountSession,
    expect: SavedSessionRef | null,
    startedIn: number,
  ): Promise<SavedSessionRef | null> => {
    const ref = await store.save(saved, expect);
    if (epoch === startedIn) return ref;
    // Signed out (or in again) while this was sealing: it must not outlive the epoch.
    await store.discard(ref).catch(() => {});
    return null;
  };

  const adopt = (tokens: ProviderTokens, saved: SavedAccountSession, ref: SavedSessionRef) => {
    session = {
      saved,
      ref,
      accessToken: tokens.accessToken,
      accessExpiresAt: tokens.accessExpiresAt,
      accessIssuedAt: now(),
    };
  };

  /** Refreshes the access token once; concurrent callers in the same epoch share it. */
  const refreshAccess = (live: AccountProvider): Promise<string | null> => {
    if (refreshing !== null && refreshing.epoch === epoch) return refreshing.token;
    const startedIn = epoch;
    const base = session;
    if (base === null) return Promise.resolve(null);
    const token = (async () => {
      let tokens: ProviderTokens;
      try {
        tokens = await live.refresh(base.saved.refreshToken);
      } catch (error) {
        if (epoch !== startedIn) return null;
        if (isProviderRefused(error)) {
          log.info("account sign-in expired", { reason: "refresh-refused" });
          await forget("Your sign-in expired. Sign in again.", startedIn);
          return null;
        }
        backendState = disconnected;
        emit();
        throw error;
      }
      if (epoch !== startedIn) return null;
      const saved = savedFrom(live, tokens, base.saved);
      try {
        const ref = await seal(saved, base.ref, startedIn);
        if (ref === null) return null;
        adopt(tokens, saved, ref);
      } catch (error) {
        if (error instanceof SavedSessionChangedError || epoch !== startedIn) return null;
        // The rotated token could not be sealed: the old one is spent, so the
        // sign-in survives only for this launch. Keep it in memory.
        log.warn("could not seal the refreshed sign-in", { error });
        adopt(tokens, saved, base.ref);
      }
      return tokens.accessToken;
    })().finally(() => {
      if (refreshing?.token === token) refreshing = null;
    });
    refreshing = { epoch: startedIn, token };
    return token;
  };

  const freshToken = async (): Promise<string | null> => {
    if (provider === null || session === null) return null;
    if (session.accessToken !== null && session.accessExpiresAt - ACCESS_TOKEN_MARGIN_MS > now()) {
      return session.accessToken;
    }
    return refreshAccess(provider);
  };

  /** Every backend answer follows the same preview gate, including account restoration. */
  const acceptViewer = (answered: BackendViewer): void => {
    viewer = answered;
    const granted = previewAccountGranted(answered);
    backendState = granted ? "synced" : "refused";
    failure = granted || answered.status === "deletion_pending" ? null : PREVIEW_WAITLIST;
    if (granted) options.marker?.write(answered.userId);
    else options.marker?.clear();
  };

  /** Asks the backend for the person; on failure keeps the sign-in and says why. */
  const syncViewer = (inviteCode?: string): Promise<void> => {
    if (backend === null) return Promise.resolve();
    if (syncing !== null) return syncing;
    const startedIn = epoch;
    const run = (async () => {
      try {
        const token = await freshToken();
        if (token === null || epoch !== startedIn) return;
        const answered = await backend.ensureViewer(token, inviteCode);
        if (epoch !== startedIn) return;
        acceptViewer(answered);
      } catch (error) {
        if (epoch !== startedIn) return;
        if (error instanceof BackendRefusedError && error.code === "preview_waitlisted") {
          backendState = "refused";
          failure = error.message;
          options.marker?.clear();
          emit();
          return;
        }
        if (error instanceof BackendRefusedError && error.code === "account_deleted") {
          await forget("This account has been deleted.", startedIn);
          return;
        }
        if (session !== null) {
          const refused = error instanceof BackendRefusedError && error.code === "unauthenticated";
          backendState = refused ? "refused" : "unreachable";
          failure = refused ? NOT_ACCEPTED : OFFLINE;
          log.warn("account backend unreachable", { error: message(error, "unknown") });
        }
      }
      emit();
    })().finally(() => {
      syncing = null;
    });
    syncing = run;
    return run;
  };

  const ensureRestored = (): Promise<void> => {
    if (provider === null) return Promise.resolve();
    if (restore !== null) return restore;
    const live = provider;
    const startedIn = epoch;
    state = "restoring";
    restore = track(
      (async () => {
        let loaded: Awaited<ReturnType<AccountSessionStore["load"]>>;
        try {
          loaded = await store.load();
        } catch (error) {
          if (epoch !== startedIn) return;
          log.warn("could not read the saved sign-in", { error });
          signedOut("Couldn't read the saved sign-in. Sign in again.");
          emit();
          return;
        }
        if (epoch !== startedIn) return;
        if (loaded === null) {
          signedOut(null);
          emit();
          return;
        }
        if (loaded.session.provider !== live.kind) {
          // Saved against another provider (a dev sign-in in a WorkOS build): not this one's.
          await forget(null, startedIn);
          return;
        }
        session = {
          saved: loaded.session,
          ref: loaded.ref,
          accessToken: null,
          accessExpiresAt: 0,
          accessIssuedAt: 0,
        };
        state = "signed-in";
        emit();
        try {
          await refreshAccess(live);
        } catch {
          // Offline: signed in from the saved profile, backend unreachable.
          if (epoch === startedIn && session !== null) {
            failure = OFFLINE;
            emit();
          }
          return;
        }
        if (epoch === startedIn && session !== null) await syncViewer();
      })(),
    );
    return restore;
  };

  /** Ends the flow in flight, if any; it reports nothing (its epoch has passed). */
  const endFlow = (): void => {
    flow?.abort.abort();
    flow = null;
  };

  const runFlow = async (
    live: AccountProvider,
    callback: LoopbackCallback,
    verifier: string,
    startedIn: number,
    inviteCode?: string,
  ): Promise<void> => {
    let result: Awaited<LoopbackCallback["result"]>;
    try {
      result = await callback.result;
    } catch (error) {
      if (epoch !== startedIn) return;
      flow = null;
      signedOut(
        error instanceof CallbackAbortedError && error.reason === "cancelled"
          ? null
          : message(error, "The browser sign-in did not finish."),
      );
      emit();
      return;
    }
    if (epoch !== startedIn) return;
    if (result.kind === "error") {
      flow = null;
      signedOut(
        result.error === "access_denied"
          ? "Sign-in was declined in the browser."
          : `Sign-in failed: ${(result.description ?? result.error).slice(0, 200)}`,
      );
      emit();
      return;
    }
    let tokens: ProviderTokens;
    try {
      tokens = await live.exchangeCode({
        code: result.code,
        codeVerifier: verifier,
        redirectUri: callback.redirectUri,
      });
    } catch (error) {
      if (epoch !== startedIn) return;
      flow = null;
      log.warn("account sign-in failed", { error: message(error, "unknown") });
      signedOut(
        isProviderRefused(error)
          ? error.message
          : "Couldn't reach the sign-in provider. Try again.",
      );
      emit();
      return;
    }
    if (epoch !== startedIn) return;
    const saved = savedFrom(live, tokens);
    let ref: SavedSessionRef | null;
    try {
      // Whatever was saved before belongs to no one now: this sign-in replaces it.
      await store.clear();
      ref = await seal(saved, null, startedIn);
    } catch (error) {
      if (epoch !== startedIn) return;
      flow = null;
      log.warn("could not seal the sign-in", { error });
      signedOut("Couldn't save the sign-in on this Mac. Try again.");
      emit();
      return;
    }
    if (ref === null) return;
    flow = null;
    viewer = null;
    adopt(tokens, saved, ref);
    state = "signed-in";
    failure = null;
    log.info("account signed in", { provider: live.kind });
    emit();
    await syncViewer(inviteCode);
  };

  const signedInBackend = async (): Promise<{ backend: AccountBackend; token: string }> => {
    requireEnabled();
    if (session === null || state !== "signed-in") throw new Error("Sign in to Volli first.");
    if (backend === null) throw new Error("This build has no Volli Cloud backend configured.");
    const token = await freshToken();
    if (token === null) throw new Error("Sign in to Volli again.");
    return { backend, token };
  };

  const deletionCall = async (
    call: (backend: AccountBackend, token: string) => Promise<BackendViewer>,
  ): Promise<void> => {
    const startedIn = epoch;
    const { backend: live, token } = await signedInBackend();
    const answered = await call(live, token);
    if (epoch !== startedIn) return;
    acceptViewer(answered);
    emit();
  };

  return {
    previewUserId() {
      return backendState === "synced" && viewer !== null && previewAccountGranted(viewer)
        ? viewer.userId
        : null;
    },
    snapshot() {
      requireCloud();
      void ensureRestored();
      return current();
    },
    subscribe(listener) {
      requireCloud();
      void ensureRestored();
      listeners.add(listener);
      listener(current());
      // A window opening while the backend is unreachable is the moment to try again.
      if (state === "signed-in" && backendState === "unreachable") void track(syncViewer());
      return () => {
        listeners.delete(listener);
      };
    },
    async signIn(connection, inviteCode) {
      const live = requireEnabled();
      if (!isAccountConnection(connection)) throw new Error("Unknown sign-in provider.");
      if (state === "signed-in") throw new Error("Already signed in. Sign out first.");
      if (state === "restoring") {
        throw new Error("Still reading the saved sign-in. Try again in a moment.");
      }
      endFlow();
      // Nothing to restore once the person has started a sign-in.
      restore ??= Promise.resolve();
      const startedIn = advance();
      const abort = new AbortController();
      flow = { connection, abort };
      state = "signing-in";
      failure = null;
      emit();
      try {
        const pkce = createPkcePair();
        const flowState = newState();
        const callback = await listen({
          state: flowState,
          timeoutMs: options.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS,
          signal: abort.signal,
        });
        const url = await live.authorizationUrl({
          redirectUri: callback.redirectUri,
          state: flowState,
          codeChallenge: pkce.challenge,
          connection,
        });
        // Cancelled (or replaced) while the listener and URL were made: no browser.
        if (epoch !== startedIn) {
          callback.close();
          return;
        }
        void track(runFlow(live, callback, pkce.verifier, startedIn, inviteCode));
        await options.openBrowser(url);
      } catch (error) {
        if (epoch === startedIn) {
          advance();
          endFlow();
          log.warn("could not start the sign-in", { error: message(error, "unknown") });
          signedOut("Couldn't open the browser to sign in. Try again.");
          emit();
        }
        throw error;
      }
    },
    cancelSignIn() {
      requireCloud();
      if (flow === null) return;
      advance();
      endFlow();
      signedOut(null);
      emit();
    },
    async signOut() {
      const live = requireEnabled();
      const startedIn = advance();
      endFlow();
      restore ??= Promise.resolve();
      const ended = session;
      signedOut(null);
      emit();
      await store.clear();
      if (epoch !== startedIn) return;
      log.info("account signed out", { provider: live.kind });
      const logout = ended?.saved.sessionId ? live.logoutUrl(ended.saved.sessionId) : null;
      if (logout !== null) {
        try {
          await options.openBrowser(logout);
        } catch (error) {
          log.warn("could not open the provider's sign-out page", { error });
        }
      }
    },
    requestDeletion: () => deletionCall((live, token) => live.requestDeletion(token)),
    cancelDeletion: () => deletionCall((live, token) => live.cancelDeletion(token)),
    async accessToken() {
      if (!options.enabled() || provider === null) return null;
      await ensureRestored();
      return freshToken();
    },
    async windowToken(force) {
      if (!options.enabled() || provider === null) return SIGNED_OUT_TOKEN;
      await ensureRestored();
      const live = session;
      if (live === null || state !== "signed-in") return SIGNED_OUT_TOKEN;
      const recent =
        live.accessToken !== null &&
        now() - live.accessIssuedAt < FORCED_REFRESH_FLOOR_MS &&
        live.accessExpiresAt - ACCESS_TOKEN_MARGIN_MS > now();
      try {
        const token = force && !recent ? await refreshAccess(provider) : await freshToken();
        if (token !== null && session !== null) {
          return { kind: "token", token, expiresAt: session.accessExpiresAt };
        }
      } catch {
        // In transit (offline): the sign-in is kept, and the window asks again.
      }
      return session === null ? SIGNED_OUT_TOKEN : UNAVAILABLE_TOKEN;
    },
    async settled() {
      let seen: Promise<unknown>;
      do {
        seen = pending;
        await seen;
      } while (seen !== pending);
    },
    dispose() {
      advance();
      endFlow();
      listeners.clear();
      provider?.dispose?.();
    },
  };
}
