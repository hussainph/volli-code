import { describe, expect, it } from "vite-plus/test";
import type { UIMessage } from "ai";
import {
  canonicalJson,
  createInMemoryTranscriptArtifactStore,
  type SessionTranscriptArtifact,
} from "./transcript-artifacts";

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

describe("in-memory transcript artifacts", () => {
  it("returns independent values and validates content-addressed references", async () => {
    const artifacts = createInMemoryTranscriptArtifactStore();
    const reference = await artifacts.write(
      artifact({ id: "artifact-1", role: "user", parts: [{ type: "text", text: "Hello" }] }),
    );
    const first = await artifacts.read(reference);
    first.message.parts[0] = { type: "text", text: "mutated by caller" };

    expect((await artifacts.read(reference)).message.parts).toMatchObject([{ text: "Hello" }]);
    await expect(
      artifacts.read({
        ...reference,
        id: "fnv1a64:0000000000000000",
        digest: "fnv1a64:0000000000000000",
      }),
    ).rejects.toThrow("was not found");
    await expect(artifacts.read({ ...reference, mediaType: "application/json" })).rejects.toThrow(
      "reference is invalid",
    );
    await expect(
      artifacts.write(undefined as unknown as SessionTranscriptArtifact),
    ).rejects.toThrow("Cannot serialize an undefined transcript artifact");
  });

  it("content-addresses messages by canonical JSON value", async () => {
    const artifacts = createInMemoryTranscriptArtifactStore();
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

    const first = await artifacts.write(withOptionalValues);
    const second = await artifacts.write(canonicalEquivalent);

    expect(second).toEqual(first);
    await expect(artifacts.read(first)).resolves.toEqual(canonicalEquivalent);
  });

  it("uses JSON-compatible undefined and key-order semantics", () => {
    expect(canonicalJson({ z: undefined, b: 1, a: [undefined, 2] })).toBe('{"a":[null,2],"b":1}');
  });
});
