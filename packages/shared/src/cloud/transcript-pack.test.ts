import { describe, expect, test } from "vite-plus/test";

import {
  TRANSCRIPT_PACK_FORMAT,
  artifactDigestHex,
  encodeTranscriptPack,
  encodeTranscriptPackEntry,
  isArtifactDigest,
  isSha256Hex,
  utf8Length,
} from "./transcript-pack";

const HEX = "a".repeat(64);
const DIGEST = `sha256:${HEX}`;
const SESSION = "22222222-2222-4222-8222-222222222222";

describe("digests", () => {
  test("artifact digests and object hashes", () => {
    expect(isArtifactDigest(DIGEST)).toBe(true);
    expect(isArtifactDigest(HEX)).toBe(false);
    expect(isArtifactDigest(`sha256:${"A".repeat(64)}`)).toBe(false);
    expect(isArtifactDigest(7)).toBe(false);
    expect(artifactDigestHex(DIGEST)).toBe(HEX);
    expect(artifactDigestHex("sha1:abc")).toBeNull();
    expect(isSha256Hex(HEX)).toBe(true);
    expect(isSha256Hex(DIGEST)).toBe(false);
    expect(isSha256Hex(null)).toBe(false);
  });

  test("utf8Length counts bytes", () => {
    expect(utf8Length("é")).toBe(2);
  });
});

describe("encodeTranscriptPack", () => {
  const body = '{"message":{"id":"m1","parts":[{"text":"héllo","type":"text"}]},"version":1}';

  test("a header line, then one line per artifact with its body embedded verbatim", () => {
    const text = encodeTranscriptPack(
      { sessionId: SESSION, firstSequence: 4, lastSequence: 9, turnIds: ["t1"], createdAt: 10 },
      [
        { digest: DIGEST, mediaType: "application/x", body, redacted: false },
        {
          digest: `sha256:${"b".repeat(64)}`,
          mediaType: "application/x",
          body: "{}",
          redacted: true,
        },
      ],
    );
    const lines = text.split("\n");
    expect(lines.at(-1)).toBe("");
    expect(JSON.parse(lines[0]!)).toEqual({
      format: TRANSCRIPT_PACK_FORMAT,
      sessionId: SESSION,
      firstSequence: 4,
      lastSequence: 9,
      turnIds: ["t1"],
      createdAt: 10,
      artifactCount: 2,
      enc: null,
    });
    expect(lines[1]).toBe(
      `{"digest":"${DIGEST}","mediaType":"application/x","bytes":${utf8Length(body)},"body":${body}}`,
    );
    expect(JSON.parse(lines[2]!)).toEqual({
      digest: `sha256:${"b".repeat(64)}`,
      mediaType: "application/x",
      bytes: 2,
      redacted: true,
      body: {},
    });
  });

  test("names missing bodies only when there are some", () => {
    const header = {
      sessionId: SESSION,
      firstSequence: 1,
      lastSequence: 1,
      turnIds: [],
      createdAt: 0,
    };
    expect(
      JSON.parse(encodeTranscriptPack({ ...header, missing: [] }, []).split("\n")[0]!),
    ).not.toHaveProperty("missing");
    expect(
      JSON.parse(encodeTranscriptPack({ ...header, missing: [DIGEST] }, []).split("\n")[0]!),
    ).toMatchObject({ artifactCount: 0, missing: [DIGEST] });
  });

  test("refuses an entry without an artifact digest", () => {
    expect(() =>
      encodeTranscriptPackEntry({ digest: "x", mediaType: "m", body: "{}", redacted: false }),
    ).toThrow(TypeError);
  });
});
