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
  const params = url.searchParams;
  assert.ok(
    params.size === PARAMETERS.length && PARAMETERS.every((name) => params.has(name)),
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
  const prefix = `/${encode(config.bucket)}/`;
  assert.ok(url.pathname.startsWith(prefix), "Wrong S3 bucket or path");
  const encodedKey = url.pathname.slice(prefix.length);
  const key = decodeURIComponent(encodedKey);
  assert.ok(
    key.length > 0 && key.split("/").map(encode).join("/") === encodedKey,
    "Invalid S3 object path",
  );

  const signedNames = params.get("X-Amz-SignedHeaders")!;
  assert.ok(
    signedNames ===
      (request.method === "PUT" ? "content-length;host;x-amz-checksum-sha256" : "host"),
    "Wrong signed headers (PUT must sign length and checksum; GET must sign host)",
  );
  assert.ok(header(request, "host") === url.host, "Wrong signed host");
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
  }
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
  return key;
}
