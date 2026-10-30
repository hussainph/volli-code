import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { describe, expect, test } from "vite-plus/test";

import { presignS3ListObjects, presignS3Request, type S3PresignInput } from "@volli/shared/cloud";

import {
  verifyS3ListRequest,
  verifyS3MoveRequest,
  verifyS3Request,
} from "../fixture/s3-boundary.ts";

const CONFIG = {
  endpoint: "http://127.0.0.1:9000",
  bucket: "fixture-history",
  accessKeyId: "fixture-access",
  secretAccessKey: "fixture-secret",
  region: "auto",
};
const NOW = Date.UTC(2026, 9, 25, 1, 2, 3);
const KEY =
  "v1/p/project/s/session/pi/attachment/2026-10-25T01:02:03Z_é/complete lines!().jsonl.zst";
const HEADERS = {
  "content-length": "8",
  "x-amz-checksum-sha256": createHash("sha256").update("history\n").digest("base64"),
};

function signedRequest(method: "PUT" | "GET" = "PUT", overrides: Partial<S3PresignInput> = {}) {
  const signed = presignS3Request({
    ...CONFIG,
    method,
    endpoint: "http://127.0.0.1:9000",
    key: KEY,
    now: NOW,
    expiresSeconds: 300,
    headers: method === "PUT" ? HEADERS : undefined,
    ...overrides,
  });
  const url = new URL(signed.url);
  const request: Pick<IncomingMessage, "method" | "headers"> = {
    method: signed.method,
    headers: { host: url.host, ...signed.headers },
  };
  return { request, url };
}

function verify(input: ReturnType<typeof signedRequest>, now = NOW, config = CONFIG) {
  return verifyS3Request(input.request, input.url, config, now);
}

describe("independent fixture S3 boundary", () => {
  test.each(["PUT", "GET"] as const)("accepts a signed %s and decodes its exact key", (method) => {
    expect(verify(signedRequest(method))).toBe(KEY);
  });

  test("canonicalizes signed header whitespace", () => {
    const input = signedRequest();
    input.request.headers["content-length"] = " 8 ";
    input.request.headers["x-amz-checksum-sha256"] = ` ${HEADERS["x-amz-checksum-sha256"]} `;
    expect(verify(input)).toBe(KEY);
  });

  test.each(["PUT", "GET"] as const)("rejects a mutated %s method, key or signature", (method) => {
    const changedMethod = signedRequest(method);
    changedMethod.request.method = method === "PUT" ? "GET" : "PUT";
    expect(() => verify(changedMethod)).toThrow(/signed headers/u);

    const changedKey = signedRequest(method);
    changedKey.url.pathname = changedKey.url.pathname.replace("/session/", "/other-session/");
    expect(() => verify(changedKey)).toThrow(/signature/u);

    const changedSignature = signedRequest(method);
    const signature = changedSignature.url.searchParams.get("X-Amz-Signature")!;
    changedSignature.url.searchParams.set(
      "X-Amz-Signature",
      `${signature[0] === "0" ? "1" : "0"}${signature.slice(1)}`,
    );
    expect(() => verify(changedSignature)).toThrow(/signature/u);
  });

  test("rejects a GET signature reused for PUT even with complete signed upload headers", () => {
    const input = signedRequest("GET", { headers: HEADERS });
    input.request.method = "PUT";
    expect(() => verify(input)).toThrow(/signature/u);
  });

  test.each(["HEAD", "DELETE", "POST", undefined])("rejects unsupported method %s", (method) => {
    const input = signedRequest("GET");
    input.request.method = method;
    expect(() => verify(input)).toThrow(/method/u);
  });

  test.each([
    ["host", "elsewhere.example"],
    ["content-length", "9"],
    ["x-amz-checksum-sha256", Buffer.alloc(32).toString("base64")],
  ])("rejects a changed signed header %s", (name, value) => {
    const input = signedRequest();
    input.request.headers[name] = value;
    expect(() => verify(input)).toThrow(/signed host|signature/u);
  });

  test.each(["host", "content-length", "x-amz-checksum-sha256"])(
    "rejects missing or repeated %s",
    (name) => {
      const missing = signedRequest();
      delete missing.request.headers[name];
      expect(() => verify(missing)).toThrow(/signed header/u);
      const repeated = signedRequest();
      repeated.request.headers[name] = ["8", "8"];
      expect(() => verify(repeated)).toThrow(/signed header/u);
    },
  );

  test.each([
    "host",
    "content-length;host",
    "host;x-amz-checksum-sha256",
    "host;content-length;x-amz-checksum-sha256",
    "content-length;host;host;x-amz-checksum-sha256",
    "content-length;host;x-amz-checksum-sha256;x-extra",
  ])("requires the exact PUT signed headers: %s", (names) => {
    const input = signedRequest();
    input.url.searchParams.set("X-Amz-SignedHeaders", names);
    expect(() => verify(input)).toThrow(/signed headers/u);
  });

  test("requires GET to sign exactly host", () => {
    expect(() => verify(signedRequest("GET", { headers: HEADERS }))).toThrow(/signed headers/u);
  });

  test.each(["-1", "1.5", "NaN", "", "01", "9007199254740992"])(
    "rejects an invalid signed length: %s",
    (length) => {
      expect(() =>
        verify(signedRequest("PUT", { headers: { ...HEADERS, "content-length": length } })),
      ).toThrow(/signed length/u);
    },
  );

  test.each([
    "not-base64",
    Buffer.alloc(31).toString("base64"),
    Buffer.alloc(32).toString("base64").slice(0, -1),
  ])("rejects an invalid signed checksum: %s", (checksum) => {
    expect(() =>
      verify(signedRequest("PUT", { headers: { ...HEADERS, "x-amz-checksum-sha256": checksum } })),
    ).toThrow(/signed SHA-256 checksum/u);
  });

  test.each([
    "X-Amz-Algorithm",
    "X-Amz-Credential",
    "X-Amz-Date",
    "X-Amz-Expires",
    "X-Amz-SignedHeaders",
    "X-Amz-Signature",
  ])("requires exactly one %s", (name) => {
    const missing = signedRequest("GET");
    missing.url.searchParams.delete(name);
    expect(() => verify(missing)).toThrow(/six SigV4 parameters/u);
    const repeated = signedRequest("GET");
    repeated.url.searchParams.append(name, repeated.url.searchParams.get(name)!);
    expect(() => verify(repeated)).toThrow(/six SigV4 parameters/u);
  });

  test("rejects additional or substituted query parameters", () => {
    const extra = signedRequest("GET");
    extra.url.searchParams.set("extra", "1");
    expect(() => verify(extra)).toThrow(/six SigV4 parameters/u);
    extra.url.searchParams.delete("X-Amz-Expires");
    expect(() => verify(extra)).toThrow(/six SigV4 parameters/u);
  });

  test("rejects a wrong algorithm", () => {
    const input = signedRequest("GET");
    input.url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA1");
    expect(() => verify(input)).toThrow(/algorithm/u);
  });

  test.each([
    { endpoint: "http://127.0.0.1:9001" },
    { accessKeyId: "other-access" },
    { region: "us-east-1" },
    { bucket: "other-bucket" },
    { secretAccessKey: "other-secret" },
  ])("rejects a different boundary configuration: %j", (change) => {
    expect(() => verify(signedRequest("GET"), NOW, { ...CONFIG, ...change })).toThrow(
      /S3 fixture configuration mismatch; check shared deployment VOLLI_S3_\*/u,
    );
  });

  test.each([
    "20261024/auto/s3/aws4_request",
    "20261025/auto/ec2/aws4_request",
    "20261025/auto/s3/other_request",
  ])("rejects a wrong credential scope: %s", (scope) => {
    const input = signedRequest("GET");
    input.url.searchParams.set("X-Amz-Credential", `${CONFIG.accessKeyId}/${scope}`);
    expect(() => verify(input)).toThrow(/credential or scope/u);
  });

  test.each([`/${CONFIG.bucket}/`, `/${CONFIG.bucket}/a%2Fb`, "/other-bucket/key"])(
    "rejects an empty, noncanonical or wrong-bucket path: %s",
    (path) => {
      const input = signedRequest("GET");
      input.url.pathname = path;
      expect(() => verify(input)).toThrow(/path/u);
    },
  );

  test("accepts only unexpired URLs, with at most five seconds of clock skew", () => {
    expect(verify(signedRequest("GET"), NOW + 299_999)).toBe(KEY);
    expect(() => verify(signedRequest("GET"), NOW + 300_000)).toThrow(/Expired/u);
    expect(verify(signedRequest("GET", { now: NOW + 5_000 }))).toBe(KEY);
    expect(() => verify(signedRequest("GET", { now: NOW + 6_000 }))).toThrow(/future/u);
    expect(verify(signedRequest("GET", { expiresSeconds: 1 }), NOW + 999)).toBe(KEY);
  });

  test("rejects a correctly signed URL valid for longer than 300 seconds", () => {
    expect(() => verify(signedRequest("GET", { expiresSeconds: 301 }))).toThrow(/lifetime/u);
  });

  test.each(["0", "-1", "1.5", "NaN", "Infinity"])("rejects an invalid expiry: %s", (expiry) => {
    const input = signedRequest("GET");
    input.url.searchParams.set("X-Amz-Expires", expiry);
    expect(() => verify(input)).toThrow(/lifetime/u);
  });

  test.each(["20260230T010203Z", "20261301T010203Z", "20261025T240000Z", "2026-10-25T01:02:03Z"])(
    "rejects an invalid signature date: %s",
    (stamp) => {
      const input = signedRequest("GET");
      input.url.searchParams.set("X-Amz-Date", stamp);
      expect(() => verify(input)).toThrow(/Invalid signature date/u);
    },
  );
});

const asRequest = (signed: { method: string; url: string; headers: Record<string, string> }) => {
  const url = new URL(signed.url);
  return {
    url,
    request: { method: signed.method, headers: { host: url.host, ...signed.headers } } as Pick<
      IncomingMessage,
      "method" | "headers"
    >,
  };
};

describe("the purge's list and delete, and write-once PUTs", () => {
  const ENDPOINT = "http://127.0.0.1:9000";
  const list = (continuationToken: string | null = null) =>
    asRequest(
      presignS3ListObjects({
        ...CONFIG,
        endpoint: ENDPOINT,
        now: NOW,
        expiresSeconds: 300,
        prefix: "v1/p/project/",
        continuationToken,
        maxKeys: 1000,
      }),
    );

  test("accepts a signed list and decodes what it asks for", () => {
    const first = list();
    expect(verifyS3ListRequest(first.request, first.url, CONFIG, NOW)).toEqual({
      prefix: "v1/p/project/",
      continuationToken: null,
      maxKeys: 1000,
    });
    const next = list("token/+=");
    expect(verifyS3ListRequest(next.request, next.url, CONFIG, NOW)).toMatchObject({
      continuationToken: "token/+=",
    });
  });

  test.each([
    ["prefix", "v1/p/other/"],
    ["max-keys", "999"],
    ["list-type", "1"],
  ])("rejects a list whose %s changed after signing", (name, value) => {
    const input = list();
    input.url.searchParams.set(name, value);
    expect(() => verifyS3ListRequest(input.request, input.url, CONFIG, NOW)).toThrow(
      /signature|ListObjectsV2/u,
    );
  });

  test("rejects a list with a parameter added or a key in its path", () => {
    const added = list();
    added.url.searchParams.set("delimiter", "/");
    expect(() => verifyS3ListRequest(added.request, added.url, CONFIG, NOW)).toThrow(
      /parameters|list signs/u,
    );
    const keyed = list();
    keyed.url.pathname = `${keyed.url.pathname}/key`;
    expect(() => verifyS3ListRequest(keyed.request, keyed.url, CONFIG, NOW)).toThrow(
      /bucket itself/u,
    );
  });

  test("accepts a signed DELETE and a write-once PUT; refuses GET and a changed If-None-Match", () => {
    const remove = signedRequest("GET", { method: "DELETE" });
    expect(verifyS3MoveRequest(remove.request, remove.url, CONFIG, NOW)).toBe(KEY);
    const put = signedRequest("PUT", { headers: { ...HEADERS, "if-none-match": "*" } });
    expect(verifyS3MoveRequest(put.request, put.url, CONFIG, NOW)).toBe(KEY);
    const get = signedRequest("GET");
    expect(() => verifyS3MoveRequest(get.request, get.url, CONFIG, NOW)).toThrow(/method/u);
    const changed = signedRequest("PUT", { headers: { ...HEADERS, "if-none-match": "*" } });
    changed.request.headers["if-none-match"] = "etag";
    expect(() => verifyS3MoveRequest(changed.request, changed.url, CONFIG, NOW)).toThrow(
      /If-None-Match/u,
    );
    const dropped = signedRequest("PUT", { headers: { ...HEADERS, "if-none-match": "*" } });
    delete dropped.request.headers["if-none-match"];
    expect(() => verifyS3MoveRequest(dropped.request, dropped.url, CONFIG, NOW)).toThrow(
      /signed header/u,
    );
    // A move's PUT is write-once; a plain PUT is not one, and the old verifier takes neither the other way.
    const plain = signedRequest("PUT");
    expect(() => verifyS3MoveRequest(plain.request, plain.url, CONFIG, NOW)).toThrow(
      /signed headers/u,
    );
    const writeOnce = signedRequest("PUT", { headers: { ...HEADERS, "if-none-match": "*" } });
    expect(() => verify(writeOnce)).toThrow(/signed headers/u);
  });
});
