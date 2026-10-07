/**
 * The credential verifier port (VC-663): how a host's door turns the
 * credential a hello carries into an actor, and learns when that stops being
 * true. Transport-neutral and enrollment-neutral: pairing (VC-575), the
 * same-machine bootstrap (VC-577) and account-issued credentials from a
 * hosted control plane each plug in here as one more verifier.
 *
 * A door never logs, echoes or stores the credential; it hands it to the
 * verifier and keeps only the grant.
 */
import type { HostActor, HostConnectionActor } from "./actor";
import type { HostHello, HostNonce } from "./handshake";
import type { WorkspaceId } from "./identity";

/** What a verifier is shown: the credential and the hello facts it may bind to. */
export interface HostCredentialPresentation {
  readonly credential: string;
  readonly workspaceId: WorkspaceId;
  readonly nonce: HostNonce;
  /** Self-description only; never a reason to grant more. */
  readonly client: HostHello["client"];
}

/** Host-wide credential presentation: no Workspace, even a null one. */
export interface HostScopeCredentialPresentation {
  readonly scope: "host";
  readonly credential: string;
  readonly nonce: HostNonce;
  readonly client: HostHello["client"];
}

export type HostConnectionCredentialPresentation =
  | HostCredentialPresentation
  | HostScopeCredentialPresentation;

/** One verified credential, for as long as it stays valid. */
export interface HostCredentialGrant {
  /**
   * Who the credential names. The door re-checks it with `isHostActor`, so a
   * verifier can never mint the reserved local device or a malformed actor.
   */
  readonly actor: HostActor;
  /**
   * Whether the grant is still valid now: `false` once revoked or expired.
   * Asked at every dispatch and on the door's periodic re-check.
   */
  current(): boolean;
  /**
   * Push revocation, for a verifier that learns of it (a control plane's
   * revocation feed). Calls `revoked` at most once; answers a disposer the
   * door calls when the connection closes. Absent, the door's periodic
   * re-check of {@link current} is the only path, and it still closes
   * every open stream when the grant lapses.
   */
  watch?(revoked: () => void): () => void;
}

export type HostConnectionCredentialGrant = Omit<HostCredentialGrant, "actor"> & {
  readonly actor: HostConnectionActor;
};

export interface HostCredentialVerifier {
  /**
   * The grant this credential carries, or `null` for any credential it does
   * not accept: unknown, expired, revoked, malformed or for another
   * Workspace. A throw is treated as `null`.
   */
  verify(
    presentation: HostConnectionCredentialPresentation,
  ): HostConnectionCredentialGrant | null | Promise<HostConnectionCredentialGrant | null>;
}

/**
 * Accepts nothing. A host with no production verifier configured serves this,
 * so every handshake is `UNAUTHORIZED` / `credential-invalid` (D5) until
 * VC-575/VC-577 supply real ones.
 */
export const REFUSING_CREDENTIAL_VERIFIER: HostCredentialVerifier = Object.freeze({
  verify: () => null,
});
