import { describe, expect, it } from "vite-plus/test";

import {
  readSessionToolCallScope,
  SESSION_TOOL_CALL_SCOPE_METADATA_KEY,
} from "./session-tool-call";

const scope = { attachmentId: "attachment:opaque", turnId: "turn:opaque" };
const metadata = (value: unknown) => ({ [SESSION_TOOL_CALL_SCOPE_METADATA_KEY]: value });

function throws(): never {
  throw new Error("not readable");
}

class NotARecord {
  attachmentId = scope.attachmentId;
  turnId = scope.turnId;
}

const invalidRecords: unknown[] = [
  undefined,
  null,
  false,
  1,
  "scope",
  Symbol("scope"),
  () => scope,
  [],
  new Date(0),
  new NotARecord(),
  Object.create(scope),
];

describe("readSessionToolCallScope", () => {
  it("reads scope from the documented metadata key, preserving opaque ids", () => {
    expect(SESSION_TOOL_CALL_SCOPE_METADATA_KEY).toBe("volli.tool-call-scope");
    const result = readSessionToolCallScope({ ...metadata(scope), unrelated: true });
    expect(result).toEqual(scope);
    expect(result).not.toBe(scope);
    expect(readSessionToolCallScope(metadata({ ...scope, extra: "ignored" }))).toEqual(scope);
  });

  it("accepts plain records with null prototypes", () => {
    const nullScope = Object.assign(Object.create(null), scope);
    const nullMetadata = Object.assign(Object.create(null), metadata(nullScope));
    expect(readSessionToolCallScope(nullMetadata)).toEqual(scope);
  });

  it("does not normalize nonempty ids", () => {
    expect(readSessionToolCallScope(metadata({ attachmentId: " ", turnId: "\t" }))).toEqual({
      attachmentId: " ",
      turnId: "\t",
    });
  });

  it("rejects absent metadata and non-plain records at either level", () => {
    expect(readSessionToolCallScope({})).toBeNull();
    expect(readSessionToolCallScope(scope)).toBeNull();
    for (const value of invalidRecords) {
      expect(readSessionToolCallScope(value)).toBeNull();
      expect(readSessionToolCallScope(metadata(value))).toBeNull();
    }
  });

  it("requires two nonempty string fields", () => {
    expect(readSessionToolCallScope(metadata({}))).toBeNull();
    expect(readSessionToolCallScope(metadata({ attachmentId: scope.attachmentId }))).toBeNull();
    expect(readSessionToolCallScope(metadata({ turnId: scope.turnId }))).toBeNull();
    for (const value of [undefined, null, false, 0, [], {}, ""]) {
      expect(readSessionToolCallScope(metadata({ ...scope, attachmentId: value }))).toBeNull();
      expect(readSessionToolCallScope(metadata({ ...scope, turnId: value }))).toBeNull();
    }
  });

  it("is total even for throwing accessors and revoked proxies", () => {
    expect(
      readSessionToolCallScope(
        Object.defineProperty({}, SESSION_TOOL_CALL_SCOPE_METADATA_KEY, { get: throws }),
      ),
    ).toBeNull();
    expect(
      readSessionToolCallScope(
        metadata(Object.defineProperty({}, "attachmentId", { get: throws })),
      ),
    ).toBeNull();
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(readSessionToolCallScope(proxy)).toBeNull();
    expect(readSessionToolCallScope(metadata(proxy))).toBeNull();
  });
});
