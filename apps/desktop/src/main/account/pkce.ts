/**
 * PKCE (RFC 7636, S256 only) and the `state` nonce for the desktop's
 * public-client sign-in. Both are single-use: one pair per browser flow,
 * held only in main's memory, never logged.
 */
import { createHash, randomBytes } from "node:crypto";

export interface PkcePair {
  /** 43 base64url characters (32 random bytes): the secret the token request proves. */
  readonly verifier: string;
  /** `BASE64URL(SHA256(verifier))`, sent in the authorization URL. */
  readonly challenge: string;
}

/** The S256 challenge for `verifier`. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}

/** An unguessable `state` that ties a callback to the flow that started it. */
export function newState(): string {
  return randomBytes(24).toString("base64url");
}
