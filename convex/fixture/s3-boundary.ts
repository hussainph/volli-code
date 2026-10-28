/**
 * Test-only path-style S3 verifier shared by the backend and desktop fixtures.
 * Deliberately independent of the production signer: only Node crypto computes
 * the canonical request's digest and SigV4 HMAC. Callers verify uploaded bodies.
 * This module also loads directly under Node's TypeScript stripping.
 */
import assert from "node:assert/strict";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

type S3Request = Pick<IncomingMessage, "method" | "headers">;

interface S3BoundaryConfig {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

const PARAMETERS = [
  "X-Amz-Algorithm",
  "X-Amz-Credential",
  "X-Amz-Date",
  "X-Amz-Expires",
  "X-Amz-SignedHeaders",
  "X-Amz-Signature",
];
const encode = (text: string) =>
  encodeURIComponent(text).replace(
    /[!'()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const hmac = (key: string | Buffer, text: string) =>
  createHmac("sha256", key).update(text).digest();

function header(request: S3Request, name: string): string {
  const value = request.headers[name];
  assert.ok(typeof value === "string", `Missing or repeated signed header ${name}`);
  return value.trim().replace(/\s+/gu, " ");
}

/** Verify a PUT/GET's signed method, path and headers; return its decoded key. */
export function verifyS3Request(
  request: S3Request,
  url: URL,
  config: S3BoundaryConfig,
  now = Date.now(),
): string {
  assert.ok(request.method === "PUT" || request.method === "GET", "Unexpected S3 method");
  return verifyObjectRequest(request, url, config, now, false);
}

/**
 * Verify a move's write-once PUT (it also signs `if-none-match: *`) or a
 * purge's DELETE of one object; return its decoded key.
 */
export function verifyS3MoveRequest(
  request: S3Request,
  url: URL,
  config: S3BoundaryConfig,
  now = Date.now(),
): string {
  assert.ok(request.method === "PUT" || request.method === "DELETE", "Unexpected S3 method");
  return verifyObjectRequest(request, url, config, now, request.method === "PUT");
}

/** Verify a signed ListObjectsV2 of the bucket; return what it asks for. */
export function verifyS3ListRequest(
  request: S3Request,
  url: URL,
  config: S3BoundaryConfig,
  now = Date.now(),
): { prefix: string; continuationToken: string | null; maxKeys: number } {
  assert.ok(request.method === "GET", "Unexpected S3 method");
  const params = url.searchParams;
  const token = params.has("continuation-token") ? ["continuation-token"] : [];
  const listParams = ["encoding-type", "list-type", "max-keys", "prefix"];
  const signing = checkParameters(url, config, now, [...listParams, ...token]);
  assert.ok(
    params.size === PARAMETERS.length + listParams.length + token.length &&
      [...listParams, ...token].every((name) => params.getAll(name).length === 1),
    "A list signs exactly list-type, encoding-type, max-keys, prefix and an optional token",
  );
  assert.ok(
    params.get("list-type") === "2" && params.get("encoding-type") === "url",
    "A list is ListObjectsV2 with url-encoded keys",
  );
  const maxKeys = Number(params.get("max-keys"));
  assert.ok(Number.isInteger(maxKeys) && maxKeys >= 1 && maxKeys <= 1000, "Invalid max-keys");
  const prefix = params.get("prefix")!;
  assert.ok(prefix.length > 0, "A list names a prefix");
  assert.ok(url.pathname === `/${encode(config.bucket)}`, "A list is of the bucket itself");
  assert.ok(
    params.get("X-Amz-SignedHeaders") === "host",
    "Wrong signed headers (a list signs host)",
  );
  checkSignature(request, url, config, signing, "host");
  return { prefix, continuationToken: params.get("continuation-token"), maxKeys };
}

function verifyObjectRequest(
  request: S3Request,
  url: URL,
  config: S3BoundaryConfig,
  now: number,
  writeOnce: boolean,
): string {
  const signing = checkParameters(url, config, now, []);
  const prefix = `/${encode(config.bucket)}/`;
  assert.ok(url.pathname.startsWith(prefix), "Wrong S3 bucket or path");
  const encodedKey = url.pathname.slice(prefix.length);
  const key = decodeURIComponent(encodedKey);
  assert.ok(
    key.length > 0 && key.split("/").map(encode).join("/") === encodedKey,
    "Invalid S3 object path",
  );
  const signedNames =
    request.method === "PUT"
      ? writeOnce
        ? "content-length;host;if-none-match;x-amz-checksum-sha256"
        : "content-length;host;x-amz-checksum-sha256"
      : "host";
  assert.ok(
    url.searchParams.get("X-Amz-SignedHeaders") === signedNames,
    "Wrong signed headers (PUT must sign length and checksum; GET must sign host)",
  );
  if (request.method === "PUT") {
    const length = header(request, "content-length");
    assert.ok(
      /^(0|[1-9]\d*)$/u.test(length) && Number.isSafeInteger(Number(length)),
      "Invalid signed length",
    );
    const checksum = header(request, "x-amz-checksum-sha256");
    const digest = Buffer.from(checksum, "base64");
    assert.ok(
      digest.length === 32 && digest.toString("base64") === checksum,
      "Invalid signed SHA-256 checksum",
    );
    if (writeOnce) assert.ok(header(request, "if-none-match") === "*", "Invalid If-None-Match");
  }
  checkSignature(request, url, config, signing, signedNames);
  return key;
}

interface Signing {
  stamp: string;
  day: string;
  scope: string;
}

/**
 * The SigV4 parameters every request carries: exactly the six (plus `extra`,
 * the request's own), a valid date within its lifetime, the credential scope.
 */
function checkParameters(
  url: URL,
  config: S3BoundaryConfig,
  now: number,
  extra: readonly string[],
): Signing {
  const params = url.searchParams;
  assert.ok(
    params.size === PARAMETERS.length + extra.length &&
      PARAMETERS.every((name) => params.getAll(name).length === 1),
    "Only the six SigV4 parameters are accepted, without duplicates",
  );
  assert.ok(params.get("X-Amz-Algorithm") === "AWS4-HMAC-SHA256", "Wrong signing algorithm");
  const stamp = params.get("X-Amz-Date")!;
  assert.match(stamp, /^\d{8}T\d{6}Z$/u, "Invalid signature date");
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.000Z`;
  const datedAt = Date.parse(iso);
  assert.ok(
    Number.isFinite(datedAt) && new Date(datedAt).toISOString() === iso,
    "Invalid signature date",
  );
  const expires = Number(params.get("X-Amz-Expires"));
  assert.ok(
    /^[1-9]\d*$/u.test(params.get("X-Amz-Expires")!) && Number.isInteger(expires) && expires <= 300,
    "Invalid signature lifetime (1 to 300 seconds)",
  );
  assert.ok(
    datedAt <= now + 5_000 && now < datedAt + expires * 1_000,
    "Expired or future signature date",
  );
  const day = stamp.slice(0, 8);
  const scope = `${day}/${config.region}/s3/aws4_request`;
  assert.ok(
    params.get("X-Amz-Credential") === `${config.accessKeyId}/${scope}`,
    "Wrong signing credential or scope",
  );
  return { stamp, day, scope };
}

/** The signature over the method, path, query and exactly `signedNames`. */
function checkSignature(
  request: S3Request,
  url: URL,
  config: S3BoundaryConfig,
  { stamp, day, scope }: Signing,
  signedNames: string,
): void {
  const params = url.searchParams;
  assert.ok(header(request, "host") === url.host, "Wrong signed host");
  const query = [...params]
    .filter(([name]) => name !== "X-Amz-Signature")
    .map(([name, value]) => `${encode(name)}=${encode(value)}`)
    .toSorted()
    .join("&");
  const canonical = [
    request.method,
    url.pathname,
    query,
    signedNames
      .split(";")
      .map((name) => `${name}:${header(request, name)}\n`)
      .join(""),
    signedNames,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, day), config.region), "s3"),
    "aws4_request",
  );
  const expected = hmac(
    signingKey,
    ["AWS4-HMAC-SHA256", stamp, scope, createHash("sha256").update(canonical).digest("hex")].join(
      "\n",
    ),
  );
  const signature = params.get("X-Amz-Signature")!;
  assert.ok(
    /^[0-9a-f]{64}$/u.test(signature) && timingSafeEqual(Buffer.from(signature, "hex"), expected),
    "Invalid S3 signature (method, key and headers must match)",
  );
}
