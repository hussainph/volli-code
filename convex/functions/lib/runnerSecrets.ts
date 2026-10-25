/**
 * Minting runner secrets and signing runner tokens. ACTIONS ONLY: queries and
 * mutations run on a seeded generator so a retry repeats them, which is the
 * wrong property for a secret. An action mints the secret, hands only its
 * hash (`secretHash` from `@volli/shared/cloud`) to an internal mutation, and
 * returns the secret itself to the caller once.
 *
 * The runner token is an ES256 JWT signed with the deployment's
 * `VOLLI_RUNNER_SIGNING_KEY` (a private JWK carrying its `kid`). The matching
 * public JWKS is `VOLLI_RUNNER_JWKS`, which `auth.config.ts` trusts as a
 * second `customJwt` provider. Listing the next key in the JWKS before
 * switching the signing key rotates it without cutting anyone off.
 */

import {
  RUNNER_TOKEN_AUDIENCE,
  RUNNER_TOKEN_ISSUER,
  USER_CODE_ALPHABET,
  USER_CODE_LENGTH,
  runnerSubject,
  type RunnerId,
  type RunnerTokenClaims,
} from "@volli/shared/cloud";

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `prefix` + 256 random bits, base64url. */
export function mintSecret(prefix: string): string {
  return `${prefix}${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/** An unbiased device code from {@link USER_CODE_ALPHABET} (20 letters: reject bytes ≥ 240). */
export function mintUserCode(): string {
  let code = "";
  while (code.length < USER_CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(USER_CODE_LENGTH * 2))) {
      if (byte < 240 && code.length < USER_CODE_LENGTH) {
        code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
      }
    }
  }
  return code;
}

/** The deployment variable holding the private signing JWK. */
export const RUNNER_SIGNING_KEY_ENV = "VOLLI_RUNNER_SIGNING_KEY";

// The runtime throws on reading an unset variable in some contexts; absence is caught.
function optionalEnv(name: string): string | undefined {
  try {
    return process.env[name];
  } catch {
    return undefined;
  }
}

type SigningKey = { key: CryptoKey; kid: string };

/** The signing key, or `null` when this deployment has none (no runner can get a token). */
export async function runnerSigningKey(): Promise<SigningKey | null> {
  const raw = optionalEnv(RUNNER_SIGNING_KEY_ENV);
  if (!raw) return null;
  const jwk = JSON.parse(raw) as JsonWebKey & { kid?: string };
  if (typeof jwk.kid !== "string" || jwk.kid === "") {
    throw new Error(`${RUNNER_SIGNING_KEY_ENV} must be a private EC P-256 JWK with a kid`);
  }
  const { kid, ...material } = jwk;
  const key = await crypto.subtle.importKey(
    "jwk",
    material,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return { key, kid };
}

/** A runner token for `runnerId`, valid from `issuedAtMs` to `expiresAtMs`. */
export async function signRunnerToken(
  signing: SigningKey,
  runnerId: RunnerId,
  claims: RunnerTokenClaims,
  issuedAtMs: number,
  expiresAtMs: number,
): Promise<string> {
  const encode = (value: object) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const header = encode({ alg: "ES256", typ: "JWT", kid: signing.kid });
  const body = encode({
    ...claims,
    iss: RUNNER_TOKEN_ISSUER,
    aud: RUNNER_TOKEN_AUDIENCE,
    sub: runnerSubject(runnerId),
    iat: Math.floor(issuedAtMs / 1000),
    exp: Math.floor(expiresAtMs / 1000),
  });
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    signing.key,
    new TextEncoder().encode(`${header}.${body}`),
  );
  return `${header}.${body}.${base64url(new Uint8Array(signature))}`;
}
