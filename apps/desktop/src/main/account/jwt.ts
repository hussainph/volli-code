/**
 * The two JWT operations desktop main needs: reading a token's claims (never
 * trusting them: the backend verifies every token it is sent; main reads
 * `exp` to know when to refresh, and `sid` to end the provider's session),
 * and signing one with ES256, for the local dev issuer only.
 */
import { createPrivateKey, sign } from "node:crypto";

const base64url = (value: string | Buffer): string => Buffer.from(value).toString("base64url");

/** The payload of a compact JWT, or `null` when it is not one. Unverified. */
export function readJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] === undefined || parts[1] === "") return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** When the token expires, in milliseconds since the epoch, or `null` when it names no `exp`. */
export function jwtExpiry(token: string): number | null {
  const exp = readJwtClaims(token)?.["exp"];
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
}

/** A compact ES256 JWT over `claims`, signed with a PKCS#8 P-256 key. */
export function signEs256Jwt(
  privateKeyPem: string,
  keyId: string,
  claims: Record<string, unknown>,
): string {
  const header = base64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: keyId }));
  const body = base64url(JSON.stringify(claims));
  const signature = sign("sha256", Buffer.from(`${header}.${body}`), {
    key: createPrivateKey(privateKeyPem),
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${body}.${base64url(signature)}`;
}
