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

function request() {
  return Promise.resolve({ ok: true, data: 1 });
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

  it("routes captured singleton requests to the current scratch only", async () => {
    installWindow();
    installFakeApi({ sessionRpc: { request } });
    const captured = window.api.sessionRpc.request;
    installFakeApi({ sessionRpc: { request: async () => ({ ok: true, data: 2 }) } });
    expect(window.api.sessionRpc.request).toBe(captured);
    await expect(captured({ path: "x", type: "query", input: null })).resolves.toEqual({
      ok: true,
      data: 2,
    });
    installFakeApi();
    await expect(captured({ path: "x", type: "query", input: null })).resolves.toMatchObject({
      ok: false,
    });
  });

  it("keeps an overridden namespace's members when it is spread", async () => {
    installWindow();
    installFakeApi({ sessionRpc: { request } });

    const spread = { ...window.api.sessionRpc };

    expect(spread.request).toBe(window.api.sessionRpc.request);
    expect(Object.keys(spread)).toEqual(["request", "onEvent", "cancel"]);
    // Unnamed members are still the proxy's own stubs, reached through it.
    expect(typeof window.api.sessionRpc.onEvent(() => {})).toBe("function");
    // An un-overridden namespace spreads to nothing, as before.
    expect({ ...window.api.harness }).toEqual({});
    expect(Object.getOwnPropertyDescriptor(window.api.sessionRpc, "missing")).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(window.api.harness, "pending")).toBeUndefined();
    await expect(spread.request({ path: "x", type: "query", input: null })).resolves.toEqual({
      ok: true,
      data: 1,
    });
  });
});
