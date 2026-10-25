import { describe, expect, it } from "vite-plus/test";
import {
  createSessionExecutorSlot,
  mapSessionExecutorSlot,
  selectSessionExecutor,
  type NativeHarnessAdapter,
} from "./index";

function runtime(id: string): NativeHarnessAdapter {
  return {
    id,
    durableIdNamespace: id,
    adapterVersion: "1",
    runtime: { path: `/trusted/${id}`, version: "1", fingerprint: `sha256:${id}` },
    attach: async () => {
      throw new Error("not attached in this test");
    },
  };
}

const attachments = (...adapterIds: string[]) => ({
  attachments: adapterIds.map((adapterId) => ({ adapterId })),
});

describe("executor slot (VC-916)", () => {
  it("registers the default under its own id, beside any others", () => {
    const pi = runtime("pi");
    const other = runtime("other");
    const slot = createSessionExecutorSlot(pi, [other]);

    expect(slot.defaultRuntime).toBe(pi);
    expect([...slot.runtimes.entries()]).toEqual([
      ["pi", pi],
      ["other", other],
    ]);
    expect([...createSessionExecutorSlot(pi).runtimes.keys()]).toEqual(["pi"]);
  });

  it("refuses two runtimes under one id rather than letting the later one win", () => {
    expect(() => createSessionExecutorSlot(runtime("pi"), [runtime("pi")])).toThrow(
      "Executor slot already holds a runtime with id pi",
    );
  });

  it("selects the default for a Session no registered runtime has attached", () => {
    const pi = runtime("pi");
    const slot = createSessionExecutorSlot(pi, [runtime("other")]);

    expect(selectSessionExecutor(slot, attachments())).toBe(pi);
    // A retired adapter and a terminal companion are history, not a choice.
    expect(selectSessionExecutor(slot, attachments("codex", "terminal"))).toBe(pi);
  });

  it("selects the runtime of the newest attachment a registered runtime opened", () => {
    const pi = runtime("pi");
    const other = runtime("other");
    const slot = createSessionExecutorSlot(pi, [other]);

    expect(selectSessionExecutor(slot, attachments("pi", "other", "terminal"))).toBe(other);
    expect(selectSessionExecutor(slot, attachments("other", "pi"))).toBe(pi);
  });

  it("wraps every runtime and keeps the default the default", () => {
    const pi = runtime("pi");
    const other = runtime("other");
    const wrapped = mapSessionExecutorSlot(createSessionExecutorSlot(pi, [other]), (inner) => ({
      ...inner,
      adapterVersion: `${inner.adapterVersion}+wrapped`,
    }));

    expect(wrapped.defaultRuntime).toMatchObject({ id: "pi", adapterVersion: "1+wrapped" });
    expect(
      [...wrapped.runtimes.values()].map(({ id, adapterVersion }) => [id, adapterVersion]),
    ).toEqual([
      ["pi", "1+wrapped"],
      ["other", "1+wrapped"],
    ]);
    expect(wrapped.runtimes.get("pi")).toBe(wrapped.defaultRuntime);
  });
});
