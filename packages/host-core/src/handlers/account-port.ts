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
 * **Secrets.** Nothing here carries one out: a snapshot holds a profile and a
 * state, never a token or a provider subject.
 */
import type { AccountConnection, AccountSnapshot } from "@volli/shared";

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
}
