/** Byte helpers shared by the grant verifier and the sealed-key format. */

const encoder = new TextEncoder();

export function utf8(value: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(value);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** Unpadded base64url (RFC 4648 §5), as JWS and JWK use. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** The bytes of an unpadded base64url string, or `null` when it is not one. */
export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL.test(value) || value.length % 4 === 1) return null;
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}
