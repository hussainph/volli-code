import { describe, expect, it } from "vite-plus/test";

import { BrowserPlaneController, type BrowserPlaneGateway } from "./browser-plane";

function gateway(calls: string[]): BrowserPlaneGateway {
  return {
    setBounds: async (input: {
      tabId: string;
      bounds: { x: number; y: number; width: number; height: number };
    }) => {
      calls.push(`bounds:${input.tabId}:${JSON.stringify(input.bounds)}`);
      return { ok: true } as const;
    },
    show: async ({ tabId }: { tabId: string }) => {
      calls.push(`show:${tabId}`);
      return { ok: true } as const;
    },
    hide: async ({ tabId }: { tabId: string }) => {
      calls.push(`hide:${tabId}`);
      return { ok: true } as const;
    },
  };
}

describe("BrowserPlaneController", () => {
  it("reports the rounded content rectangle before showing the native view", () => {
    const calls: string[] = [];
    const plane = new BrowserPlaneController("tab-7", gateway(calls), () => undefined);

    plane.reportBounds({ x: 20.4, y: 81.6, width: 799.8, height: 500.2 });
    plane.setVisible(true);

    expect(calls).toEqual(['bounds:tab-7:{"x":20,"y":82,"width":800,"height":500}', "show:tab-7"]);
  });

  it("does not resend an unchanged ResizeObserver rectangle", () => {
    const calls: string[] = [];
    const plane = new BrowserPlaneController("tab-7", gateway(calls), () => undefined);
    const rect = { x: 20, y: 82, width: 800, height: 500 };

    plane.reportBounds(rect);
    plane.reportBounds(rect);

    expect(calls).toEqual(['bounds:tab-7:{"x":20,"y":82,"width":800,"height":500}']);
  });

  it("hides a visible native view when its React surface unmounts", () => {
    const calls: string[] = [];
    const plane = new BrowserPlaneController("tab-7", gateway(calls), () => undefined);
    plane.setVisible(true);

    plane.dispose();

    expect(calls).toEqual(["show:tab-7", "hide:tab-7"]);
  });

  it("reports a failed disposal hide because remote pixels may still cover the app", async () => {
    const api = gateway([]);
    api.hide = async () => ({ ok: false, error: "host unavailable" });
    const errors: string[] = [];
    const plane = new BrowserPlaneController("tab-7", api, (message) => errors.push(message));
    plane.setVisible(true);

    plane.dispose();
    await Promise.resolve();

    expect(errors).toEqual(["Could not hide Browser Tab: host unavailable"]);
  });

  it("does not report a late IPC failure into an unmounted React surface", async () => {
    let rejectShow: ((reason: Error) => void) | undefined;
    const api = gateway([]);
    api.show = () =>
      new Promise((_, reject) => {
        rejectShow = reject;
      });
    const errors: string[] = [];
    const plane = new BrowserPlaneController("tab-7", api, (message) => errors.push(message));
    plane.setVisible(true);
    plane.dispose();

    rejectShow?.(new Error("window gone"));
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toEqual([]);
  });
});
