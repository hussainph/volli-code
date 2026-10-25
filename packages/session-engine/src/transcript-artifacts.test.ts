import { describe, expect, it } from "vite-plus/test";
import type { UIMessage } from "ai";
import { canonicalJson, type SessionTranscriptArtifact } from "./transcript-artifacts";

function artifact(message: UIMessage): SessionTranscriptArtifact {
  return {
    version: 1,
    threadId: "thread-1",
    branchId: "branch-1",
    attemptId: "attempt-1",
    turnId: null,
    message,
  };
}

// What a store does with an artifact — content addressing, independent reads,
// reference validation, sizes — is the shared store contract
// (`testing/transcript-artifact-store-contract.ts`). These pin the canonical
// encoding every store addresses by.
describe("canonical transcript JSON", () => {
  it("refuses to encode an undefined artifact", () => {
    expect(() => canonicalJson(undefined)).toThrow(
      "Cannot serialize an undefined transcript artifact",
    );
  });

  it("encodes canonically equivalent messages to the same bytes", () => {
    const withOptionalValues = artifact({
      role: "assistant",
      id: "message-1",
      metadata: { omitted: undefined, retained: "value" },
      parts: [
        { text: "Hello", type: "text", metadata: { ignored: undefined } },
        undefined,
      ] as unknown as UIMessage["parts"],
    });
    const canonicalEquivalent = artifact({
      id: "message-1",
      metadata: { retained: "value" },
      parts: [{ metadata: {}, text: "Hello", type: "text" }, null] as unknown as UIMessage["parts"],
      role: "assistant",
    });

    expect(canonicalJson(withOptionalValues)).toBe(canonicalJson(canonicalEquivalent));
    expect(JSON.parse(canonicalJson(withOptionalValues))).toEqual(canonicalEquivalent);
  });

  it("rejects non-plain objects nested in message parts", () => {
    const badValues = [new Date("2025-01-01T00:00:00.000Z"), new Map([["key", "value"]])];

    for (const [index, value] of badValues.entries()) {
      const message = {
        id: `message-${index}`,
        role: "user",
        parts: [{ type: "data-example", data: { nested: value } }],
      } as unknown as UIMessage;

      expect(() => canonicalJson(artifact(message))).toThrowError(
        new TypeError("Cannot serialize a non-plain object in a transcript artifact"),
      );
    }
  });

  it("uses JSON-compatible undefined and key-order semantics", () => {
    expect(canonicalJson({ z: undefined, b: 1, a: [undefined, 2] })).toBe('{"a":[null,2],"b":1}');
  });
});
