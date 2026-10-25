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
 * **Tokens.** {@link AccountService.accessToken} answers the in-memory token
 * while it has a minute left, else refreshes once (concurrent callers share
 * the refresh), rotating the sealed refresh token. A refusal (a revoked or
 * expired grant) signs out; any other failure (offline) keeps the sign-in and
 * marks the backend unreachable, so the board can stay a read-only cache.
 * Nothing here ever hands a token to the window.
 *
 * **Restore.** The saved sign-in is read the first time the window asks for
 * the snapshot, not at launch: no new unattended keychain access.
 *
 * **Sign-out** forgets the tokens and the sealed record, then opens the
 * provider's logout page so its browser session ends too. **Deletion** asks
 * the backend (`accounts.requestDeletion` / `cancelDeletion`); the window
 * shows the pending date and offers a restore.
 */
import {
  ACCOUNT_TEXT_MAX,
  OperationUnavailableError,
  UNCONFIGURED_ACCOUNT,
  isAccountConnection,
  type AccountBackendState,
  type AccountConnection,
  type AccountSnapshot,
  type AccountState,
} from "@volli/shared";

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
export const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
/** An access token with less than this left is refreshed before use. */
export const ACCESS_TOKEN_MARGIN_MS = 60 * 1000;

export const ACCOUNT_CLOUD_OFF = "Volli Cloud is off. Turn it on in Settings → Experimental.";

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
  /** Opens the system browser (harness mode records instead). */
  readonly openBrowser: (url: string) => void | Promise<void>;
  readonly listen?: typeof listenForCallback;
  readonly signInTimeoutMs?: number;
  readonly now?: () => number;
  readonly log?: AccountLogger;
}

export interface AccountService {
  snapshot(): AccountSnapshot;
  subscribe(listener: (snapshot: AccountSnapshot) => void): () => void;
  signIn(connection: AccountConnection): Promise<void>;
  cancelSignIn(): void;
  signOut(): Promise<void>;
  requestDeletion(): Promise<void>;
  cancelDeletion(): Promise<void>;
  /**
   * A current access token for a backend call, refreshed when it is about to
   * expire; `null` while signed out. Main only: never sent to the window.
   */
  accessToken(): Promise<string | null>;
  /** Waits for a restore or a sign-in in flight to settle (tests, quit). */
  settled(): Promise<void>;
  dispose(): void;
}

interface Session {
  saved: SavedAccountSession;
  ref: SavedSessionRef;
  accessToken: string | null;
  accessExpiresAt: number;
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

  let state: Exclude<AccountState, "unconfigured"> = "signed-out";
  let session: Session | null = null;
  let viewer: BackendViewer | null = null;
  let backendState: AccountBackendState = backend === null ? "none" : "unreachable";
  let failure: string | null = null;
  let flow: Flow | null = null;
  let restore: Promise<void> | null = null;
  let pending: Promise<unknown> = Promise.resolve();
  let refreshing: Promise<string | null> | null = null;
  // Bumped by every sign-in and sign-out: work begun under an older epoch drops its result.
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

  const signedOut = (reason: string | null): void => {
    session = null;
    viewer = null;
    backendState = backend === null ? "none" : "unreachable";
    state = "signed-out";
    failure = reason;
  };

  const adopt = (tokens: ProviderTokens, saved: SavedAccountSession, ref: SavedSessionRef) => {
    session = {
      saved,
      ref,
      accessToken: tokens.accessToken,
      accessExpiresAt: tokens.accessExpiresAt,
    };
  };

  /** Refreshes the access token once; concurrent callers share it. */
  const refreshAccess = (live: AccountProvider): Promise<string | null> => {
    if (refreshing !== null) return refreshing;
    const startedIn = epoch;
    const base = session;
    if (base === null) return Promise.resolve(null);
    refreshing = (async () => {
      let tokens: ProviderTokens;
      try {
        tokens = await live.refresh(base.saved.refreshToken);
      } catch (error) {
        if (epoch !== startedIn) return null;
        if (isProviderRefused(error)) {
          log.info("account sign-in expired", { reason: "refresh-refused" });
          await store.clear().catch((clearError: unknown) => {
            log.warn("could not forget the expired sign-in", { error: clearError });
          });
          signedOut("Your sign-in expired. Sign in again.");
          emit();
          return null;
        }
        backendState = backend === null ? "none" : "unreachable";
        emit();
        throw error;
      }
      if (epoch !== startedIn) return null;
      const saved = savedFrom(live, tokens, base.saved);
      try {
        const ref = await store.save(saved, base.ref);
        if (epoch !== startedIn) return null;
        adopt(tokens, saved, ref);
      } catch (error) {
        if (error instanceof SavedSessionChangedError) return null;
        // The rotated token could not be sealed: the old one is spent, so the
        // sign-in survives only for this launch. Keep it in memory.
        log.warn("could not seal the refreshed sign-in", { error });
        adopt(tokens, saved, base.ref);
      }
      return tokens.accessToken;
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  };

  const accessToken = async (): Promise<string | null> => {
    if (provider === null || session === null) return null;
    if (session.accessToken !== null && session.accessExpiresAt - ACCESS_TOKEN_MARGIN_MS > now()) {
      return session.accessToken;
    }
    return refreshAccess(provider);
  };

  /** Asks the backend for the person; on failure keeps the sign-in and says so. */
  const syncViewer = async (): Promise<void> => {
    if (backend === null) return;
    const startedIn = epoch;
    try {
      const token = await accessToken();
      if (token === null || epoch !== startedIn) return;
      const answered = await backend.ensureViewer(token);
      if (epoch !== startedIn) return;
      viewer = answered;
      backendState = "synced";
      failure = null;
    } catch (error) {
      if (epoch !== startedIn) return;
      if (error instanceof BackendRefusedError && error.code === "account_deleted") {
        await store.clear().catch(() => {});
        signedOut("This account has been deleted.");
      } else if (session !== null) {
        backendState = "unreachable";
        failure = "Couldn't reach Volli Cloud. Your sign-in is kept.";
        log.warn("account backend unreachable", { error: message(error, "unknown") });
      }
    }
    emit();
  };

  const ensureRestored = (): void => {
    if (restore !== null || provider === null) return;
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
          await store.clear().catch(() => {});
          signedOut(null);
          emit();
          return;
        }
        session = { saved: loaded.session, ref: loaded.ref, accessToken: null, accessExpiresAt: 0 };
        state = "signed-in";
        emit();
        try {
          await refreshAccess(live);
        } catch {
          // Offline: signed in from the saved profile, backend unreachable.
          if (epoch === startedIn && session !== null) {
            failure = "Couldn't reach Volli Cloud. Your sign-in is kept.";
            emit();
          }
          return;
        }
        if (epoch === startedIn && session !== null) await syncViewer();
      })(),
    );
  };

  const endFlow = (): void => {
    flow?.abort.abort();
    flow = null;
  };

  const runFlow = async (
    live: AccountProvider,
    callback: LoopbackCallback,
    verifier: string,
    startedIn: number,
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
    try {
      const tokens = await live.exchangeCode({
        code: result.code,
        codeVerifier: verifier,
        redirectUri: callback.redirectUri,
      });
      if (epoch !== startedIn) return;
      const saved = savedFrom(live, tokens);
      const ref = await store.save(saved, session?.ref ?? null).catch(async (error: unknown) => {
        if (!(error instanceof SavedSessionChangedError)) throw error;
        // A record this service did not read (a sign-in from before a reset): replace it.
        await store.clear();
        return store.save(saved, null);
      });
      if (epoch !== startedIn) return;
      flow = null;
      viewer = null;
      adopt(tokens, saved, ref);
      state = "signed-in";
      failure = null;
      log.info("account signed in", { provider: live.kind });
      emit();
      await syncViewer();
    } catch (error) {
      if (epoch !== startedIn) return;
      flow = null;
      log.warn("account sign-in failed", { error: message(error, "unknown") });
      signedOut(message(error, "Sign-in failed. Try again."));
      emit();
    }
  };

  const signedInBackend = async (): Promise<{ backend: AccountBackend; token: string }> => {
    requireEnabled();
    if (session === null || state !== "signed-in") throw new Error("Sign in to Volli first.");
    if (backend === null) throw new Error("This build has no Volli Cloud backend configured.");
    const token = await accessToken();
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
    viewer = answered;
    backendState = "synced";
    failure = null;
    emit();
  };

  return {
    snapshot() {
      requireCloud();
      ensureRestored();
      return current();
    },
    subscribe(listener) {
      requireCloud();
      ensureRestored();
      listeners.add(listener);
      listener(current());
      return () => {
        listeners.delete(listener);
      };
    },
    async signIn(connection) {
      const live = requireEnabled();
      if (!isAccountConnection(connection)) throw new Error("Unknown sign-in provider.");
      if (state === "signed-in") throw new Error("Already signed in. Sign out first.");
      if (state === "restoring") {
        throw new Error("Still reading the saved sign-in. Try again in a moment.");
      }
      endFlow();
      // Nothing to restore once the person has started a sign-in.
      restore ??= Promise.resolve();
      epoch += 1;
      const startedIn = epoch;
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
        if (epoch !== startedIn) {
          callback.close();
          return;
        }
        void track(runFlow(live, callback, pkce.verifier, startedIn));
        await options.openBrowser(url);
      } catch (error) {
        if (epoch === startedIn) {
          // A new epoch first, so the aborted flow does not report over this.
          epoch += 1;
          endFlow();
          signedOut(message(error, "Couldn't start the sign-in."));
          emit();
        }
        throw error;
      }
    },
    cancelSignIn() {
      requireEnabled();
      if (flow === null) return;
      // The flow's own end reports it (signed out, no failure).
      flow.abort.abort();
    },
    async signOut() {
      const live = requireEnabled();
      endFlow();
      epoch += 1;
      restore ??= Promise.resolve();
      const ended = session;
      signedOut(null);
      emit();
      await store.clear();
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
    accessToken,
    async settled() {
      let seen: Promise<unknown>;
      do {
        seen = pending;
        await seen;
      } while (seen !== pending);
    },
    dispose() {
      endFlow();
      listeners.clear();
      provider?.dispose?.();
    },
  };
}
