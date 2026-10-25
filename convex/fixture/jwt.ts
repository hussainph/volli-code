/**
 * A test-only token issuer, so a test can act as any user without OAuth.
 *
 * Each run makes a fresh ES256 key pair in memory. The backend trusts its
 * public half through the `VOLLI_TEST_JWKS` deployment variable, which
 * `functions/auth.config.ts` turns into a `customJwt` provider; the private
 * half never leaves the test process. The backend makes no network call to
 * verify it: the JWKS is a `data:` URI.
 *
 * `VOLLI_TEST_JWKS` is set only by this fixture. No cloud deployment may ever
 * carry it.
 */

import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";

import { TEST_AUDIENCE, TEST_ISSUER } from "../functions/auth.config.ts";

const TEST_KEY_ID = "volli-test-1";

export type TestIssuer = {
  /** The value for the `VOLLI_TEST_JWKS` deployment variable. */
  jwksDataUri: string;
  /** PKCS#8 PEM of the signing key, to hand to test workers. */
  privateKeyPem: string;
};

export type MintOptions = {
  /** Lifetime from now; negative mints an already-expired token. */
  ttlSeconds?: number;
  /** Extra profile claims (`email`, `email_verified`, `name`, …), as a real provider would send. */
  claims?: Record<string, string | boolean>;
};

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

export function createTestIssuer(): TestIssuer {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = {
    ...publicKey.export({ format: "jwk" }),
    kid: TEST_KEY_ID,
    alg: "ES256",
    use: "sig",
  };
  return {
    jwksDataUri: `data:text/plain;charset=utf-8;base64,${Buffer.from(JSON.stringify({ keys: [jwk] })).toString("base64")}`,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** Sign a token for `subject` that the fixture's backend accepts. */
export function mintTestToken(
  privateKeyPem: string,
  subject: string,
  options: MintOptions = {},
): string {
  const key = createPrivateKey(privateKeyPem);
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: TEST_KEY_ID }));
  const body = base64url(
    JSON.stringify({
      ...options.claims,
      iss: TEST_ISSUER,
      aud: TEST_AUDIENCE,
      sub: subject,
      iat: now,
      exp: now + (options.ttlSeconds ?? 3600),
    }),
  );
  const signature = sign("sha256", Buffer.from(`${header}.${body}`), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${body}.${base64url(signature)}`;
}
