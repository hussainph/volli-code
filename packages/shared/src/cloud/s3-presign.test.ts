import { describe, expect, test } from "vite-plus/test";

import {
  S3_PRESIGN_MAX_EXPIRES_SECONDS,
  presignS3Request,
  sha256ChecksumHeader,
} from "./s3-presign";

const AWS_EXAMPLE = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
};

describe("presignS3Request", () => {
  test("reproduces the published AWS SigV4 query-string example", () => {
    const signed = presignS3Request({
      ...AWS_EXAMPLE,
      method: "GET",
      endpoint: "https://s3.amazonaws.com",
      bucket: "examplebucket",
      key: "test.txt",
      now: Date.UTC(2013, 4, 24),
      expiresSeconds: 86400,
      addressing: "virtual",
    });
    expect(signed.url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt" +
        "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
        "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
        "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host" +
        "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
    expect(signed.headers).toEqual({});
    expect(signed.expiresAt).toBe(Date.UTC(2013, 4, 24) + 86400 * 1000);
  });

  test("path-style: the bucket leads the path, key bytes are encoded, headers are signed", () => {
    const base = {
      ...AWS_EXAMPLE,
      region: "auto",
      method: "PUT" as const,
      endpoint: "http://127.0.0.1:9000",
      bucket: "volli",
      key: "v1/p/x/s/y/pi/a:b/c d.jsonl.zst",
      now: Date.UTC(2026, 9, 25, 1, 2, 3),
      expiresSeconds: 300,
    };
    const signed = presignS3Request({
      ...base,
      headers: { "Content-Length": " 12 ", "x-amz-checksum-sha256": "q  q" },
    });
    const url = new URL(signed.url);
    expect(url.host).toBe("127.0.0.1:9000");
    expect(url.pathname).toBe("/volli/v1/p/x/s/y/pi/a%3Ab/c%20d.jsonl.zst");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;host;x-amz-checksum-sha256",
    );
    expect(url.searchParams.get("X-Amz-Date")).toBe("20261025T010203Z");
    expect(signed.headers).toEqual({ "content-length": "12", "x-amz-checksum-sha256": "q q" });
    // Every signed input changes the signature.
    const other = presignS3Request({ ...base, headers: { "content-length": "13" } });
    expect(new URL(other.url).searchParams.get("X-Amz-Signature")).not.toBe(
      url.searchParams.get("X-Amz-Signature"),
    );
  });

  test("refuses an expiry S3 would refuse, and an empty bucket or key", () => {
    const base = {
      ...AWS_EXAMPLE,
      method: "GET" as const,
      endpoint: "https://s3.amazonaws.com",
      bucket: "b",
      key: "k",
      now: 0,
    };
    for (const expiresSeconds of [0, 1.5, S3_PRESIGN_MAX_EXPIRES_SECONDS + 1]) {
      expect(() => presignS3Request({ ...base, expiresSeconds })).toThrow(RangeError);
    }
    expect(() => presignS3Request({ ...base, expiresSeconds: 1, key: "" })).toThrow(RangeError);
    expect(() => presignS3Request({ ...base, expiresSeconds: 1, bucket: "" })).toThrow(RangeError);
  });
});

test("sha256ChecksumHeader is base64 of the digest bytes", () => {
  // SHA-256 of the empty string.
  expect(
    sha256ChecksumHeader("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
  ).toBe("47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=");
  expect(() => sha256ChecksumHeader("nope")).toThrow(TypeError);
});
