import { describe, expect, test } from "vite-plus/test";

import {
  InvalidKeyPartError,
  artifactSpillKey,
  environmentRunLogKey,
  eventArchiveKey,
  eventSpillKey,
  exportKey,
  legacyArchiveKey,
  migrationKey,
  piLogSegmentKey,
  projectBlobKey,
  projectConfigBundleKey,
  projectPrefix,
  sessionPrefix,
  transcriptPackKey,
  userBlobKey,
  userConfigBundleKey,
  userPrefix,
  workspaceBlobKey,
  workspaceConfigBundleKey,
  workspacePrefix,
} from "./r2-keys";

const P = "11111111-1111-4111-8111-111111111111";
const S = "22222222-2222-4222-8222-222222222222";
const W = "33333333-3333-4333-8333-333333333333";
const U = "44444444-4444-4444-8444-444444444444";
const E = "55555555-5555-4555-8555-555555555555";
const SHA = "ab".repeat(32);
const scope = { projectId: P, sessionId: S };

describe("the v1 key grammar", () => {
  test("Session history lives under the project and Session", () => {
    expect(transcriptPackKey({ ...scope, firstSequence: 1, lastSequence: 240 })).toBe(
      `v1/p/${P}/s/${S}/tx/000000000001-000000000240.pack.zst`,
    );
    expect(artifactSpillKey({ ...scope, sha256: SHA })).toBe(`v1/p/${P}/s/${S}/a/${SHA}.json.zst`);
    expect(eventArchiveKey({ ...scope, firstSequence: 1, lastSequence: 10_000 })).toBe(
      `v1/p/${P}/s/${S}/ev/000000000001-000000010000.ndjson.zst`,
    );
    expect(eventSpillKey({ ...scope, sequence: 42 })).toBe(
      `v1/p/${P}/s/${S}/e/000000000042.json.zst`,
    );
    expect(
      piLogSegmentKey({
        ...scope,
        attachmentId: "runtime-pi:0d1e8f6a",
        piFileId: "01a0f892-d611-7758-a14e-541793f7f4c0",
        offset: 1_048_576,
      }),
    ).toBe(
      `v1/p/${P}/s/${S}/pi/runtime-pi:0d1e8f6a/01a0f892-d611-7758-a14e-541793f7f4c0/000000001048576.jsonl.zst`,
    );
  });

  test("project, Workspace and person objects", () => {
    expect(projectBlobKey(P, SHA)).toBe(`v1/p/${P}/b/${SHA}`);
    expect(environmentRunLogKey(P, E)).toBe(`v1/p/${P}/env/${E}.log.zst`);
    expect(projectConfigBundleKey(P, E, 3)).toBe(`v1/p/${P}/cfg/${E}/3.tar.zst`);
    expect(legacyArchiveKey(P, "automation-ledger")).toBe(
      `v1/p/${P}/legacy/automation-ledger.ndjson.zst`,
    );
    expect(workspaceBlobKey(W, SHA)).toBe(`v1/w/${W}/b/${SHA}`);
    expect(workspaceConfigBundleKey(W, E, 0)).toBe(`v1/w/${W}/cfg/${E}/0.tar.zst`);
    expect(userBlobKey(U, SHA)).toBe(`v1/u/${U}/b/${SHA}`);
    expect(userConfigBundleKey(U, E, 12)).toBe(`v1/u/${U}/cfg/${E}/12.tar.zst`);
    expect(exportKey(E, "part-0001.ndjson.zst")).toBe(`v1/x/${E}/part-0001.ndjson.zst`);
    expect(migrationKey(E, "blobs.tar")).toBe(`v1/m/${E}/blobs.tar`);
  });

  test("purge prefixes contain every key of their owner", () => {
    expect(sessionPrefix(scope)).toBe(`v1/p/${P}/s/${S}/`);
    expect(eventSpillKey({ ...scope, sequence: 1 }).startsWith(sessionPrefix(scope))).toBe(true);
    expect(sessionPrefix(scope).startsWith(projectPrefix(P))).toBe(true);
    expect(projectBlobKey(P, SHA).startsWith(projectPrefix(P))).toBe(true);
    expect(workspaceBlobKey(W, SHA).startsWith(workspacePrefix(W))).toBe(true);
    expect(userBlobKey(U, SHA).startsWith(userPrefix(U))).toBe(true);
  });

  test("zero padding keeps lexical order equal to sequence order", () => {
    const keys = [9, 10, 100, 2].map((n) => eventSpillKey({ ...scope, sequence: n }));
    expect(keys.toSorted()).toEqual(
      [2, 9, 10, 100].map((n) => eventSpillKey({ ...scope, sequence: n })),
    );
  });
});

describe("key parts are validated", () => {
  const bad: [string, () => string][] = [
    ["an uppercase id", () => projectPrefix("0d1e8f6a-3b2c-4d5e-8f70-123456789ABC")],
    ["a non-uuid Session id", () => sessionPrefix({ projectId: P, sessionId: "VC-12" })],
    ["a non-uuid Workspace id", () => workspacePrefix("acme")],
    ["a non-uuid user id", () => userPrefix("alice")],
    ["a short hash", () => projectBlobKey(P, "abc")],
    ["an uppercase hash", () => userBlobKey(U, SHA.toUpperCase())],
    ["a negative sequence", () => eventSpillKey({ ...scope, sequence: -1 })],
    ["a fractional sequence", () => eventSpillKey({ ...scope, sequence: 1.5 })],
    ["a sequence wider than its padding", () => eventSpillKey({ ...scope, sequence: 1e12 })],
    ["an inverted range", () => transcriptPackKey({ ...scope, firstSequence: 5, lastSequence: 4 })],
    ["a bad range start", () => eventArchiveKey({ ...scope, firstSequence: NaN, lastSequence: 4 })],
    ["a bad range end", () => eventArchiveKey({ ...scope, firstSequence: 1, lastSequence: -4 })],
    [
      "a path in an attachment id",
      () => piLogSegmentKey({ ...scope, attachmentId: "a/b", piFileId: "f", offset: 0 }),
    ],
    [
      "traversal in a Pi file id",
      () => piLogSegmentKey({ ...scope, attachmentId: "a", piFileId: "x..y", offset: 0 }),
    ],
    ["a leading dot", () => exportKey(E, ".hidden")],
    ["a negative revision", () => projectConfigBundleKey(P, E, -1)],
    ["a fractional revision", () => workspaceConfigBundleKey(W, E, 0.5)],
    ["a non-uuid entry id", () => userConfigBundleKey(U, "skill", 1)],
    ["a non-uuid run id", () => environmentRunLogKey(P, "run-1")],
    ["a legacy name with a slash", () => legacyArchiveKey(P, "../escape")],
    ["a non-uuid migration id", () => migrationKey("m1", "part")],
  ];
  test.each(bad)("%s", (_label, build) => {
    expect(build).toThrow(InvalidKeyPartError);
  });

  test("the error is typed", () => {
    expect(() => projectPrefix("x")).toThrow(
      expect.objectContaining({ code: "invalid_key_part", name: "InvalidKeyPartError" }),
    );
  });
});
