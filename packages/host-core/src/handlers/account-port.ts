/**
 * The Volli Cloud account port (VC-884): what the handler map's desktop-only
 * `account.*` entries call.
 *
 * Desktop main implements it with its account service
 * (`apps/desktop/src/main/account/`): the browser sign-in, the sealed refresh
 * token and the backend calls. Every other host (hostd) supplies none, and
 * each entry answers `OperationUnavailableError` ("Accounts are unavailable
 * on this host"). A port that cannot act now (the `cloud` flag is off)
 * throws `OperationUnavailableError` itself. Structural, so host-core imports
 * nothing of the desktop's.
 *
 * **Secrets.** A snapshot holds a profile and a state, never a token or a
 * provider subject. The one exception is {@link AccountPort.accessToken}: a
 * short-lived access token for the person's own window's Volli Cloud client
 * (VC-889), never the refresh token.
 *
 * It also answers for the launch the account chose (VC-889): which product
 * store this process uses, and the restart into the other one.
 */
import type {
  AccountAccessToken,
  AccountConnection,
  AccountSnapshot,
  CloudLaunch,
} from "@volli/shared";

type Answer<Value> = Value | Promise<Value>;

export interface AccountPort {
  /** Where the account stands now. */
  snapshot(): Answer<AccountSnapshot>;
  /** Calls `listener` with the snapshot now, then on every change, until the answer is called. */
  subscribe(listener: (snapshot: AccountSnapshot) => void): Answer<() => void>;
  /** Opens the browser on the provider's page for `connection`; the snapshot follows the flow. */
  signIn(connection: AccountConnection): Answer<void>;
  /** Stops waiting for the browser; quiet when no sign-in is in flight. */
  cancelSignIn(): Answer<void>;
  /** Forgets the sign-in on this Mac; quiet when signed out. */
  signOut(): Answer<void>;
  /** Asks the backend to schedule the account's deletion. */
  requestDeletion(): Answer<void>;
  /** Asks the backend to restore an account whose deletion is scheduled. */
  cancelDeletion(): Answer<void>;
  /** A short-lived access token for the window's Convex client; `force` refreshes first. */
  accessToken(force: boolean): Answer<AccountAccessToken>;
  /** The product store this launch chose before the window opened; fixed for the process. */
  launch(): Answer<CloudLaunch>;
  /** Restarts the app through the normal quit gates, into the store the account now chooses. */
  relaunch(): Answer<void>;
  /** The window's board writes still unanswered, for the quit gate to ask about. */
  reportUnsavedWrites(count: number): Answer<void>;
  /** Keeps the window's last-seen board for an offline launch of this account (VC-889, D3). */
  saveSnapshot(text: string): Answer<void>;
  /** The last-seen board kept for this launch's account, or `null`. */
  readSnapshot(): Answer<string | null>;
}
