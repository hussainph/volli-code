import { describe, expect, it } from "vite-plus/test";

import { createSessionTokenRegistry } from "./session-tokens";

describe("createSessionTokenRegistry", () => {
  it("authenticates the Session a minted token was minted for", () => {
    const registry = createSessionTokenRegistry();

    const token = registry.mint({ sessionId: "session-1", attachmentId: "attachment-1" });

    expect(registry.verify(token)).toBe("session-1");
  });

  it("refuses a token nobody minted, however well-formed", () => {
    const registry = createSessionTokenRegistry();
    registry.mint({ sessionId: "session-1", attachmentId: "attachment-1" });

    expect(registry.verify("not-a-real-token")).toBeNull();
    expect(registry.verify("")).toBeNull();
    expect(registry.verify(undefined)).toBeNull();
  });

  // The whole point of the token: `VOLLI_SESSION` alone is a claim, and a
  // caller that names a Session it was not handed a token for is not that
  // Session. Two live Sessions must not be able to speak as each other.
  it("never authenticates one Session's token as another Session", () => {
    const registry = createSessionTokenRegistry();

    const first = registry.mint({ sessionId: "session-1", attachmentId: "attachment-1" });
    const second = registry.mint({ sessionId: "session-2", attachmentId: "attachment-2" });

    expect(registry.verify(first)).toBe("session-1");
    expect(registry.verify(second)).toBe("session-2");
    expect(first).not.toBe(second);
  });

  it("mints a distinct token per attachment, and unguessable ones", () => {
    const registry = createSessionTokenRegistry();

    const tokens = Array.from({ length: 32 }, (_, index) =>
      registry.mint({ sessionId: "session-1", attachmentId: `attachment-${index}` }),
    );

    expect(new Set(tokens).size).toBe(32);
    // 256 bits of randomness, hex-encoded. Asserted as a shape rather than a
    // length alone so a future encoding change cannot quietly shorten it.
    for (const token of tokens) expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  // Per-ATTACHMENT, not per-Session: the token's life is the attachment's life.
  // Closing one terminal on a Session must not disarm the others.
  it("revokes one attachment's token without touching its siblings", () => {
    const registry = createSessionTokenRegistry();
    const first = registry.mint({ sessionId: "session-1", attachmentId: "attachment-1" });
    const second = registry.mint({ sessionId: "session-1", attachmentId: "attachment-2" });

    registry.revoke("attachment-1");

    expect(registry.verify(first)).toBeNull();
    expect(registry.verify(second)).toBe("session-1");
  });

  it("lists a session exactly while at least one attachment token remains live", () => {
    const registry = createSessionTokenRegistry();
    registry.mint({ sessionId: "session-1", attachmentId: "attachment-1" });
    registry.mint({ sessionId: "session-1", attachmentId: "attachment-2" });
    registry.mint({ sessionId: "session-2", attachmentId: "attachment-3" });

    expect(registry.liveSessionIds()).toEqual(["session-1", "session-2"]);
    registry.revoke("attachment-1");
    expect(registry.liveSessionIds()).toEqual(["session-1", "session-2"]);
    registry.revoke("attachment-2");
    expect(registry.liveSessionIds()).toEqual(["session-2"]);
  });

  it("retires the previous token when one attachment mints again", () => {
    const registry = createSessionTokenRegistry();
    const first = registry.mint({ sessionId: "session-1", attachmentId: "attachment-1" });

    const second = registry.mint({ sessionId: "session-1", attachmentId: "attachment-1" });

    // A reattachment re-mints, and the old value must stop working rather than
    // accumulate: a token that outlives the process holding it is a token
    // nothing will ever revoke.
    expect(registry.verify(first)).toBeNull();
    expect(registry.verify(second)).toBe("session-1");
  });

  it("ignores a revoke for an attachment it never minted for", () => {
    const registry = createSessionTokenRegistry();
    const token = registry.mint({ sessionId: "session-1", attachmentId: "attachment-1" });

    expect(() => registry.revoke("attachment-unknown")).not.toThrow();
    expect(registry.verify(token)).toBe("session-1");
  });
});
