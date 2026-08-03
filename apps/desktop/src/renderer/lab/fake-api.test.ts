import { afterEach, describe, expect, it } from "vite-plus/test";

import { installFakeApi } from "./fake-api";

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

function installWindow(): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
    writable: true,
  });
}

describe("Lab fake API", () => {
  it("keeps namespace and method identities stable for one scratch activation", () => {
    installWindow();
    installFakeApi();

    const harness = window.api.harness;

    expect(Object.is(window.api.harness, harness)).toBe(true);
    expect(Object.is(window.api.harness.pending, harness.pending)).toBe(true);
    expect(Object.is(window.api.tickets.move, window.api.tickets.move)).toBe(true);
  });

  it("isolates proxy identities between scratch activations", () => {
    installWindow();
    installFakeApi();
    const firstHarness = window.api.harness;

    installFakeApi();

    expect(Object.is(window.api.harness, firstHarness)).toBe(false);
  });
});
