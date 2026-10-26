/**
 * The GitHub App's cryptography, all WebCrypto so it runs in Convex's default
 * runtime (no Node action): the App JWT (RS256), webhook signatures
 * (HMAC-SHA256, constant time), and the flow secrets and PKCE pair.
 */

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function base64UrlJson(value: object): string {
  return base64Url(encoder.encode(JSON.stringify(value)));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function pemBody(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [A-Z ]+-----/u, "")
    .replace(/-----END [A-Z ]+-----/u, "")
    .replace(/\s+/gu, "");
  const binary = atob(body);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * A JWT that authenticates as the App: RS256, issued 60 s in the past against
 * clock drift, valid 9 minutes (GitHub's limit is 10), issuer the client id.
 */
export async function appJwt(
  clientId: string,
  privateKeyPem: string,
  now: number,
): Promise<string> {
  if (privateKeyPem.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY is PKCS#1; convert it with `openssl pkcs8 -topk8 -nocrypt`.",
    );
  }
  const key = await crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(pemBody(privateKeyPem)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const seconds = Math.floor(now / 1000);
  const signingInput = `${base64UrlJson({ alg: "RS256", typ: "JWT" })}.${base64UrlJson({
    iat: seconds - 60,
    exp: seconds + 9 * 60,
    iss: clientId,
  })}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    toArrayBuffer(encoder.encode(signingInput)),
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

function hexBytes(hex: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})+$/u.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Whether `X-Hub-Signature-256` (`sha256=<hex>`) is the HMAC of the raw body
 * under any of `secrets` (current, then the previous one during a rotation).
 * Constant time per comparison.
 */
export async function verifyWebhookSignature(
  secrets: readonly string[],
  body: ArrayBuffer,
  header: string | null,
): Promise<boolean> {
  if (header === null || !header.startsWith("sha256=")) return false;
  const given = hexBytes(header.slice("sha256=".length).toLowerCase());
  if (given === null) return false;
  let match = false;
  for (const secret of secrets) {
    const key = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(encoder.encode(secret)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
    if (equalBytes(expected, given)) match = true;
  }
  return match;
}

/** 32 random bytes, base64url: a flow's state secret or PKCE verifier. */
export function randomSecret(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Base64Url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(encoder.encode(text)));
  return base64Url(new Uint8Array(digest));
}
