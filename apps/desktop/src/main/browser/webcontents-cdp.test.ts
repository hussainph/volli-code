import { describe, expect, it, vi } from "vite-plus/test";

import { debuggerTransport, loadWaiter } from "./webcontents-cdp";

describe("the WebContentsView backend's engine wire", () => {
  it("speaks CDP through the app-private debugger, attaching once and never opening a port", async () => {
    const commands: { method: string; params?: object }[] = [];
    let attached = false;
    const attaches: string[] = [];
    let detaches = 0;
    const contents = {
      debugger: {
        isAttached: () => attached,
        attach: (version: string) => {
          attached = true;
          attaches.push(version);
        },
        sendCommand: async (method: string, params?: object) => {
          commands.push(params === undefined ? { method } : { method, params });
          return { ok: true };
        },
        detach: () => {
          attached = false;
          detaches += 1;
        },
      },
    };

    const transport = debuggerTransport(contents as never);
    await transport.send("Page.enable");
    await transport.send("Page.captureScreenshot", { format: "png" });

    expect(attaches).toEqual(["1.3"]);
    expect(commands.map((one) => one.method)).toEqual([
      "Accessibility.enable",
      "DOM.enable",
      "Page.enable",
      "Page.enable",
      "Page.captureScreenshot",
    ]);

    // DevTools or a renderer restart can detach the app-private debugger. The
    // next command establishes a fresh attachment and re-enables its domains.
    attached = false;
    await transport.send("Page.getLayoutMetrics");
    expect(attaches).toEqual(["1.3", "1.3"]);
    expect(commands.slice(-4).map((one) => one.method)).toEqual([
      "Accessibility.enable",
      "DOM.enable",
      "Page.enable",
      "Page.getLayoutMetrics",
    ]);

    transport.dispose?.();
    expect(detaches).toBe(1);
    expect(attached).toBe(false);
  });

  it("waits for a loading tab to settle and returns at once for one already settled", async () => {
    let loading = true;
    const listeners = new Map<string, () => void>();
    const contents = {
      isLoading: () => loading,
      on: (event: string, listener: () => void) => listeners.set(event, listener),
      removeListener: () => undefined,
    };
    const wait = loadWaiter(() => contents as never);

    const pending = wait("tab-1", new AbortController().signal);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    loading = false;
    listeners.get("did-stop-loading")?.();
    await pending;

    // Already-settled tabs never subscribe at all.
    listeners.clear();
    await wait("tab-1", new AbortController().signal);
    expect(listeners.size).toBe(0);
  });

  it("waits for a required navigation that has not started yet", async () => {
    let loading = false;
    const listeners = new Map<string, () => void>();
    const contents = {
      isLoading: () => loading,
      on: (event: string, listener: () => void) => listeners.set(event, listener),
      removeListener: (event: string) => listeners.delete(event),
    };
    const wait = loadWaiter(() => contents as never, 1_000);

    const pending = wait("tab-1", new AbortController().signal, "required-navigation");
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    loading = true;
    listeners.get("did-start-loading")?.();
    await Promise.resolve();
    expect(settled).toBe(false);

    loading = false;
    listeners.get("did-stop-loading")?.();
    await pending;
    expect(settled).toBe(true);
  });

  it.each(["destroyed", "render-process-gone", "abort", "gap"])(
    "ends a load wait on %s and removes every listener",
    async (end) => {
      vi.useFakeTimers();
      try {
        const listeners = new Map<string, () => void>();
        let reads = 0;
        const contents = {
          isLoading: () => ++reads === 1 || end !== "gap",
          on: (event: string, listener: () => void) => listeners.set(event, listener),
          removeListener: (event: string) => listeners.delete(event),
        };
        const abort = new AbortController();
        const pending = loadWaiter(() => contents as never)("one", abort.signal);
        if (end === "abort") abort.abort();
        else if (end !== "gap") listeners.get(end)?.();
        await pending;
        expect(listeners.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("does not resume debugger initialization after disposal", async () => {
    const domain = Promise.withResolvers<unknown>();
    let attached = false;
    const sendCommand = vi.fn(() => domain.promise);
    const transport = debuggerTransport({
      debugger: {
        isAttached: () => attached,
        attach: () => {
          attached = true;
        },
        detach: () => {
          attached = false;
        },
        sendCommand,
      },
    } as never);
    const pending = transport.send("Accessibility.getFullAXTree");
    transport.dispose?.();
    domain.resolve({});
    await expect(pending).rejects.toThrow(/disposed/i);
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(attached).toBe(false);
    await expect(transport.send("Page.enable")).rejects.toThrow(/disposed/i);
  });
});
