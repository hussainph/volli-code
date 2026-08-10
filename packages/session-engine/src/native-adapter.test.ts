import { describe, expect, it } from "vite-plus/test";
import {
  createNativeAdapterRegistry,
  observationCursor,
  type NativeHarnessAdapter,
} from "./native-adapter";

function adapter(id: string): NativeHarnessAdapter {
  return {
    manifest: {
      id,
      displayName: id || "Nameless",
      adapterVersion: "1.0.0",
      profiles: [
        {
          id: "native",
          label: "Native",
          transport: "native",
          runtime: { path: "/test/adapter", version: "1.0.0", fingerprint: "sha256:test" },
        },
      ],
    },
    attach: async () => {
      throw new Error("test adapter cannot attach");
    },
  };
}

describe("native adapter registry", () => {
  it("returns registered adapters without exposing mutable registry state", () => {
    const first = adapter("first");
    const registry = createNativeAdapterRegistry([first]);

    expect(registry.get("first")).toBe(first);
    expect(registry.get("missing")).toBeNull();
    expect(registry.list()).toEqual([first]);
    expect(registry.list()).not.toBe(registry.list());
  });

  it("rejects empty and duplicate adapter identities", () => {
    const duplicate = adapter("duplicate");
    expect(() => createNativeAdapterRegistry([duplicate, duplicate])).toThrow(
      "registered more than once",
    );
    expect(() => createNativeAdapterRegistry([adapter("")])).toThrow("cannot be empty");
  });
});

describe("observationCursor", () => {
  it("answers undefined for a kind that carries no cursor, and the value for one that does", () => {
    expect(
      observationCursor({
        id: "turn-1",
        kind: "turn.started",
        occurredAt: 10,
        turnId: "turn-1",
        cursor: { eventId: "provider-7" },
      }),
    ).toEqual({ eventId: "provider-7" });
    expect(
      observationCursor({ id: "turn-2", kind: "turn.completed", occurredAt: 11, turnId: "turn-1" }),
    ).toBeUndefined();
    expect(
      observationCursor({
        id: "delta-1",
        kind: "transcript.delta",
        occurredAt: 12,
        threadId: "thread:session:root",
        branchId: "branch:session:main",
        attemptId: "attempt:1",
        turnId: "turn-1",
        messageId: "assistant-1",
        delta: { op: "message.remove" },
      }),
    ).toBeUndefined();
  });
});
