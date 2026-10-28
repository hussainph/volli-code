/**
 * AWS Signature Version 4 presigned URLs for an S3-compatible object store
 * (Cloudflare R2 speaks this API).
 *
 * The backend signs; the runner and clients only ever hold a URL bound to one
 * method, one key, one expiry and the exact headers listed in it (for an
 * upload: its content length and its SHA-256 checksum, so the store refuses
 * any other bytes). Pure and synchronous: the same inputs give the same URL,
 * which is what lets a test check it against the published AWS example and a
 * mock store recompute a signature it received.
 *
 * Reference: "Authenticating Requests: Using Query Parameters (AWS Signature
 * Version 4)", Amazon S3 API reference.
 */

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

const ALGORITHM = "AWS4-HMAC-SHA256";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
/** S3 refuses a presigned URL valid for longer than seven days. */
export const S3_PRESIGN_MAX_EXPIRES_SECONDS = 7 * 24 * 60 * 60;

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** R2 signs with `auto`. */
  region: string;
}

export interface S3PresignInput extends S3Credentials {
  method: "GET" | "PUT" | "HEAD" | "DELETE";
  /** The store's origin, e.g. `https://<account>.r2.cloudflarestorage.com`. */
  endpoint: string;
  bucket: string;
  key: string;
  /** Epoch milliseconds the signature is dated at. */
  now: number;
  expiresSeconds: number;
  /**
   * Headers the request must send exactly, and that the signature covers.
   * Names are matched case-insensitively and signed lower-case.
   */
  headers?: Readonly<Record<string, string>>;
  /** `path` (default): `/<bucket>/<key>`. `virtual`: the bucket in the host name. */
  addressing?: "path" | "virtual";
}

export interface PresignedS3Request {
  method: S3PresignInput["method"];
  url: string;
  /** What the request must send besides `host` (lower-case names). */
  headers: Record<string, string>;
  /** Epoch milliseconds after which the store refuses the URL. */
  expiresAt: number;
}

/** RFC 3986 unreserved characters pass; every other byte is `%XX` (upper-case). */
function uriEncode(text: string, keepSlash: boolean): string {
  let out = "";
  for (const byte of utf8ToBytes(text)) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(char) || (keepSlash && char === "/")) out += char;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function amzDate(now: number): { stamp: string; day: string } {
  const iso = new Date(now).toISOString(); // 2013-05-24T00:00:00.000Z
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return { stamp, day: stamp.slice(0, 8) };
}

function hmacOf(key: Uint8Array, message: string): Uint8Array {
  return hmac(sha256, key, utf8ToBytes(message));
}

/** A presigned URL for one request. Throws `RangeError` on an expiry S3 would refuse. */
export function presignS3Request(input: S3PresignInput): PresignedS3Request {
  if (input.key.length === 0) throw new RangeError("A presigned URL needs a bucket and a key");
  return sign(input, input.key, []);
}

/** The most keys one ListObjectsV2 page returns (S3's own ceiling). */
export const S3_LIST_MAX_KEYS = 1000;

export interface S3ListInput extends Omit<S3PresignInput, "method" | "key" | "headers"> {
  /** Only keys starting with this; never empty (a list of a whole bucket is never signed). */
  prefix: string;
  /** The previous page's `NextContinuationToken`, or `null` for the first page. */
  continuationToken: string | null;
  /** 1 to {@link S3_LIST_MAX_KEYS}. */
  maxKeys: number;
}

/**
 * A presigned ListObjectsV2 (`GET /<bucket>?list-type=2&prefix=…`): one page
 * of the keys under `prefix`, percent-encoded (`encoding-type=url`). Throws `RangeError` on an empty prefix or a page
 * size S3 would refuse.
 */
export function presignS3ListObjects(input: S3ListInput): PresignedS3Request {
  if (input.prefix.length === 0) throw new RangeError("A list is signed for a prefix");
  if (!Number.isInteger(input.maxKeys) || input.maxKeys < 1 || input.maxKeys > S3_LIST_MAX_KEYS) {
    throw new RangeError(`A list page holds 1 to ${S3_LIST_MAX_KEYS} keys`);
  }
  const query: Array<[string, string]> = [
    // Keys come back percent-encoded, so any key survives the XML.
    ["encoding-type", "url"],
    ["list-type", "2"],
    ["max-keys", String(input.maxKeys)],
    ["prefix", input.prefix],
  ];
  if (input.continuationToken !== null) {
    query.push(["continuation-token", input.continuationToken]);
  }
  return sign({ ...input, method: "GET" }, null, query);
}

/** Signs one request for `key` (`null`: the bucket itself), with extra query parameters. */
function sign(
  input: Omit<S3PresignInput, "key">,
  key: string | null,
  extraQuery: ReadonlyArray<[string, string]>,
): PresignedS3Request {
  if (
    !Number.isInteger(input.expiresSeconds) ||
    input.expiresSeconds < 1 ||
    input.expiresSeconds > S3_PRESIGN_MAX_EXPIRES_SECONDS
  ) {
    throw new RangeError("A presigned URL expires after 1 second to 7 days");
  }
  if (input.bucket.length === 0) {
    throw new RangeError("A presigned URL needs a bucket and a key");
  }
  const endpoint = new URL(input.endpoint);
  if (endpoint.pathname !== "/" || endpoint.search !== "" || endpoint.hash !== "") {
    throw new RangeError("An endpoint is an origin, with no path or query");
  }
  const virtual = input.addressing === "virtual";
  const host = virtual ? `${input.bucket}.${endpoint.host}` : endpoint.host;
  const objectPath = key === null ? "" : uriEncode(key, true);
  const path = virtual
    ? `/${objectPath}`
    : `/${uriEncode(input.bucket, false)}${key === null ? "" : `/${objectPath}`}`;

  const { stamp, day } = amzDate(input.now);
  const scope = `${day}/${input.region}/s3/aws4_request`;

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    // `host` is the endpoint's, never a caller's.
    if (name.toLowerCase() === "host") throw new RangeError("The host header is the endpoint's");
    headers[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
  }
  const signed: Record<string, string> = { ...headers, host };
  const signedNames = Object.keys(signed).toSorted();
  const signedHeaders = signedNames.join(";");

  const query: Array<[string, string]> = [
    ...extraQuery,
    ["X-Amz-Algorithm", ALGORITHM],
    ["X-Amz-Credential", `${input.accessKeyId}/${scope}`],
    ["X-Amz-Date", stamp],
    ["X-Amz-Expires", String(input.expiresSeconds)],
    ["X-Amz-SignedHeaders", signedHeaders],
  ];
  const canonicalQuery = query
    .map(([name, value]) => `${uriEncode(name, false)}=${uriEncode(value, false)}`)
    .toSorted()
    .join("&");

  const canonicalRequest = [
    input.method,
    path,
    canonicalQuery,
    signedNames.map((name) => `${name}:${signed[name]}\n`).join(""),
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join("\n");
  const stringToSign = [
    ALGORITHM,
    stamp,
    scope,
    bytesToHex(sha256(utf8ToBytes(canonicalRequest))),
  ].join("\n");

  const dateKey = hmacOf(utf8ToBytes(`AWS4${input.secretAccessKey}`), day);
  const signingKey = hmacOf(hmacOf(hmacOf(dateKey, input.region), "s3"), "aws4_request");
  const signature = bytesToHex(hmacOf(signingKey, stringToSign));

  return {
    method: input.method,
    url: `${endpoint.protocol}//${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    headers,
    expiresAt: input.now + input.expiresSeconds * 1000,
  };
}

/** The `x-amz-checksum-sha256` header value (base64 of the digest) for a SHA-256 hex. */
export function sha256ChecksumHeader(sha256Hex: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256Hex)) throw new TypeError("Expected a SHA-256 hex digest");
  return btoa(String.fromCharCode(...hexToBytes(sha256Hex)));
}
