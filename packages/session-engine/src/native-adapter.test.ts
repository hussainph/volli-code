import { describe, expect, it } from "vite-plus/test";
import { createNativeAdapterRegistry, type NativeHarnessAdapter } from "./native-adapter";

function adapter(id: string): NativeHarnessAdapter {
  return {
    manifest: {
      id,
      displayName: id || "Nameless",
      adapterVersion: "1.0.0",
      profiles: [{ id: "native", label: "Native", transport: "native" }],
    },
    probe: async () => ({
      status: "unavailable",
      runtime: null,
      reason: "test adapter",
    }),
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
