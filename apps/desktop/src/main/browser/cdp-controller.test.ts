import { BrowserRefusal } from "@volli/agent-runtime";
import { describe, expect, it } from "vite-plus/test";

import { BrowserTabController, type CdpTransport } from "./cdp-controller";

/**
 * A recording CDP wire: every command lands in `sent`, and each method answers
 * with what the test scripted for it. The controller under test never learns
 * it is not talking to a real `webContents.debugger` — the transport is the
 * pre-agreed seam, exactly as the pty tests fake their process.
 */
function wire(answers: Record<string, unknown> = {}): {
  sent: { method: string; params?: object }[];
  emit: (method: string, params: unknown) => void;
  transport: CdpTransport;
} {
  const sent: { method: string; params?: object }[] = [];
  const listeners = new Set<(method: string, params: unknown) => void>();
  return {
    sent,
    emit: (method, params) => {
      for (const listener of listeners) listener(method, params);
    },
    transport: {
      send: async (method, params) => {
        sent.push(params === undefined ? { method } : { method, params });
        return answers[method] ?? {};
      },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}

/** A one-button page, as the CDP tree answer the transport scripts. */
const BUTTON_TREE = {
  nodes: [
    {
      nodeId: "1",
      ignored: false,
      role: { value: "RootWebArea" },
      name: { value: "Fixture" },
      childIds: ["2"],
    },
    {
      nodeId: "2",
      ignored: false,
      role: { value: "button" },
      name: { value: "Save" },
      backendDOMNodeId: 77,
      childIds: [],
    },
  ],
};

/** A 10×10 box at (100, 200), in CDP's content-quad spelling. */
const BUTTON_BOX = { model: { content: [100, 200, 110, 200, 110, 210, 100, 210] } };

describe("BrowserTabController", () => {
  it("prints a snapshot from the tree the page's own engine computed, stamped with the tab generation", async () => {
    const page = wire({ "Accessibility.getFullAXTree": BUTTON_TREE });
    const controller = new BrowserTabController(page.transport);

    const snapshot = await controller.snapshot();

    expect(page.sent.map((call) => call.method)).toContain("Accessibility.getFullAXTree");
    expect(snapshot.text).toBe('- button "Save" [ref=e1]');
    expect(snapshot.generation).toBe(1);
    expect(snapshot.truncated).toBe(false);
  });

  it("clicks a ref by dispatching real input at the element the snapshot named", async () => {
    const page = wire({
      "Accessibility.getFullAXTree": BUTTON_TREE,
      "DOM.getBoxModel": BUTTON_BOX,
    });
    const controller = new BrowserTabController(page.transport);
    const snapshot = await controller.snapshot();

    await controller.act({ generation: snapshot.generation, kind: "click", ref: "e1" });

    // The element is brought into view and resolved by the handle the ref
    // minted — never by a selector the page could have moved.
    expect(page.sent).toContainEqual({
      method: "DOM.scrollIntoViewIfNeeded",
      params: { backendNodeId: 77 },
    });
    const mouse = page.sent.filter((call) => call.method === "Input.dispatchMouseEvent");
    expect(mouse.map((call) => (call.params as { type: string }).type)).toEqual([
      "mousePressed",
      "mouseReleased",
    ]);
    // At the box's center: x = (100+110)/2, y = (200+210)/2.
    expect(mouse[0]?.params).toMatchObject({ x: 105, y: 205, button: "left", clickCount: 1 });
  });

  it("refuses a ref from a stale generation without dispatching anything", async () => {
    const page = wire({ "Accessibility.getFullAXTree": BUTTON_TREE });
    const controller = new BrowserTabController(page.transport);
    await controller.snapshot();
    controller.bumpGeneration();

    await expect(controller.act({ generation: 1, kind: "click", ref: "e1" })).rejects.toThrow(
      BrowserRefusal,
    );
    expect(page.sent.some((call) => call.method.startsWith("Input."))).toBe(false);
  });

  it("adopts the host's generation so navigation observed elsewhere stales refs here", async () => {
    const page = wire({ "Accessibility.getFullAXTree": BUTTON_TREE });
    const controller = new BrowserTabController(page.transport);
    const snapshot = await controller.snapshot();

    // The host watched the webContents navigate twice; the controller adopts
    // the larger count and never moves backward on a smaller one.
    controller.syncGeneration(3);
    controller.syncGeneration(2);

    expect(controller.generation).toBe(3);
    await expect(
      controller.act({ generation: snapshot.generation, kind: "click", ref: "e1" }),
    ).rejects.toThrow(BrowserRefusal);
  });

  it("refuses a ref no snapshot minted, naming the rule", async () => {
    const page = wire({ "Accessibility.getFullAXTree": BUTTON_TREE });
    const controller = new BrowserTabController(page.transport);
    const snapshot = await controller.snapshot();

    const refusal = controller
      .act({ generation: snapshot.generation, kind: "click", ref: "e9" })
      .then(
        () => null,
        (error: unknown) => error,
      );

    await expect(refusal).resolves.toBeInstanceOf(BrowserRefusal);
    await expect(refusal.then((error) => (error as BrowserRefusal).rule)).resolves.toBe(
      "browser.unknown-ref",
    );
  });

  it("types into a ref by focusing the element and inserting the text as input", async () => {
    const page = wire({ "Accessibility.getFullAXTree": BUTTON_TREE });
    const controller = new BrowserTabController(page.transport);
    const snapshot = await controller.snapshot();

    await controller.act({
      generation: snapshot.generation,
      kind: "type",
      ref: "e1",
      text: "hello",
    });

    expect(page.sent).toContainEqual({ method: "DOM.focus", params: { backendNodeId: 77 } });
    expect(page.sent).toContainEqual({ method: "Input.insertText", params: { text: "hello" } });
  });

  it("keeps a bounded, most-recent console record from the page's own events", async () => {
    const page = wire();
    const controller = new BrowserTabController(page.transport, { maxConsoleMessages: 2 });

    page.emit("Runtime.consoleAPICalled", {
      type: "log",
      args: [{ value: "first" }],
    });
    page.emit("Runtime.consoleAPICalled", {
      type: "warning",
      args: [{ value: "second" }],
    });
    page.emit("Runtime.exceptionThrown", {
      exceptionDetails: { text: "Uncaught", exception: { description: "Error: boom" } },
    });

    const record = controller.console();

    // Two survive the bound of two, oldest first out; the flag says the rest
    // existed. A warning is a warn, an exception is an error.
    expect(record.truncated).toBe(true);
    expect(record.messages).toEqual([
      { level: "warn", text: "second" },
      { level: "error", text: "Uncaught Error: boom" },
    ]);
  });

  it("captures the page as the PNG the engine rendered", async () => {
    const page = wire({
      "Page.captureScreenshot": { data: "aGVsbG8=" },
      "Page.getLayoutMetrics": { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } },
    });
    const controller = new BrowserTabController(page.transport);

    const shot = await controller.screenshot();

    expect(shot).toEqual({ base64Png: "aGVsbG8=", width: 800, height: 600 });
  });
});
