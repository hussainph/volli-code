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
  transport: CdpTransport;
} {
  const sent: { method: string; params?: object }[] = [];
  return {
    sent,
    transport: {
      send: async (method, params) => {
        sent.push(params === undefined ? { method } : { method, params });
        return answers[method] ?? {};
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
    expect(snapshot.generation).toBe(0);
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

  it("never aliases a ref from an older snapshot onto the latest snapshot", async () => {
    const page = wire({
      "Accessibility.getFullAXTree": BUTTON_TREE,
      "DOM.getBoxModel": BUTTON_BOX,
    });
    const controller = new BrowserTabController(page.transport);
    const first = await controller.snapshot();
    const second = await controller.snapshot();

    expect(first.text).toContain("[ref=e1]");
    expect(second.text).toContain("[ref=e2]");
    await expect(
      controller.act({ generation: first.generation, kind: "click", ref: "e1" }),
    ).rejects.toMatchObject({ rule: "browser.unknown-ref" });
    expect(page.sent.some((call) => call.method === "Input.dispatchMouseEvent")).toBe(false);
  });

  it("refuses a ref from a stale generation without dispatching anything", async () => {
    const page = wire({ "Accessibility.getFullAXTree": BUTTON_TREE });
    const controller = new BrowserTabController(page.transport);
    await controller.snapshot();
    controller.syncGeneration(1);

    await expect(controller.act({ generation: 0, kind: "click", ref: "e1" })).rejects.toThrow(
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

  it("refuses malformed action-specific input rather than silently defaulting it", async () => {
    const page = wire({ "Accessibility.getFullAXTree": BUTTON_TREE });
    const controller = new BrowserTabController(page.transport);
    const snapshot = await controller.snapshot();

    await expect(
      controller.act({ generation: snapshot.generation, kind: "type", ref: "e1" }),
    ).rejects.toMatchObject({ rule: "browser.unactionable" });
    await expect(
      controller.act({ generation: snapshot.generation, kind: "scroll" }),
    ).rejects.toMatchObject({ rule: "browser.unactionable" });
    await expect(
      controller.act({ generation: snapshot.generation, kind: "press", key: "Mystery+Enter" }),
    ).rejects.toMatchObject({ rule: "browser.unactionable" });
    expect(page.sent.some((call) => call.method.startsWith("Input."))).toBe(false);
  });

  it("reports a select that did not match instead of returning a false success", async () => {
    const page = wire({
      "Accessibility.getFullAXTree": BUTTON_TREE,
      "DOM.resolveNode": { object: { objectId: "object-1" } },
      "Runtime.callFunctionOn": { result: { value: false } },
    });
    const controller = new BrowserTabController(page.transport);
    const snapshot = await controller.snapshot();

    await expect(
      controller.act({
        generation: snapshot.generation,
        kind: "select",
        ref: "e1",
        text: "missing",
      }),
    ).rejects.toMatchObject({ rule: "browser.unactionable" });
  });

  it("withdraws a wait action as soon as its call is aborted", async () => {
    const page = wire({ "Accessibility.getFullAXTree": BUTTON_TREE });
    const controller = new BrowserTabController(page.transport);
    const snapshot = await controller.snapshot();
    const abort = new AbortController();

    const waiting = controller.act(
      { generation: snapshot.generation, kind: "wait", waitMs: 5_000 },
      abort.signal,
    );
    abort.abort(new Error("withdrawn"));

    await expect(waiting).rejects.toThrow("withdrawn");
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

  it("fails a command the engine never answers instead of wedging the call", async () => {
    // A throttled, crashed or torn-down engine can hold a debugger command
    // open forever; the caller must get one readable failure, not a hang.
    const controller = new BrowserTabController(
      { send: () => new Promise<never>(() => undefined) },
      { maxCommandMs: 20 },
    );

    await expect(controller.snapshot()).rejects.toThrow(
      "did not answer Accessibility.getFullAXTree within 20ms",
    );
  });

  it("withdraws an unanswered command as soon as its call is aborted", async () => {
    const controller = new BrowserTabController({
      send: () => new Promise<never>(() => undefined),
    });
    const abort = new AbortController();

    const pending = controller.snapshot(abort.signal);
    abort.abort(new Error("withdrawn"));

    await expect(pending).rejects.toThrow("withdrawn");
  });

  it("releases the mouse button even when the press itself times out", async () => {
    // The bound can fall between the two halves of one click. A page left
    // holding a button down selects text on every move and starts drags, and
    // the next Session to reach the tab inherits it (VC-252 review).
    const sent: { method: string; params?: object }[] = [];
    const controller = new BrowserTabController(
      {
        send: async (method, params) => {
          sent.push({ method, ...(params === undefined ? {} : { params }) });
          if ((params as { type?: string } | undefined)?.type === "mousePressed") {
            return await new Promise<never>(() => undefined);
          }
          if (method === "Accessibility.getFullAXTree") return BUTTON_TREE;
          if (method === "DOM.getBoxModel") return BUTTON_BOX;
          return {};
        },
      },
      { maxCommandMs: 20 },
    );
    const snapshot = await controller.snapshot();

    await expect(
      controller.act({ generation: snapshot.generation, kind: "click", ref: "e1" }),
    ).rejects.toThrow("did not answer Input.dispatchMouseEvent within 20ms");

    // The caller still hears the press failure, and the page still gets its up.
    const types = sent
      .filter((call) => call.method === "Input.dispatchMouseEvent")
      .map((call) => (call.params as { type?: string }).type);
    expect(types).toEqual(["mousePressed", "mouseReleased"]);
  });

  it("lifts the key even when the turn is withdrawn mid-press", async () => {
    // A key down with no key up latches on the page: every later keystroke
    // arrives wearing a modifier nobody asked for.
    const sent: { method: string; params?: object }[] = [];
    const abort = new AbortController();
    const controller = new BrowserTabController({
      send: async (method, params) => {
        sent.push({ method, ...(params === undefined ? {} : { params }) });
        if ((params as { type?: string } | undefined)?.type === "rawKeyDown") {
          abort.abort(new Error("withdrawn"));
          return await new Promise<never>(() => undefined);
        }
        if (method === "Accessibility.getFullAXTree") return BUTTON_TREE;
        return {};
      },
    });
    const snapshot = await controller.snapshot();

    await expect(
      controller.act(
        { generation: snapshot.generation, kind: "press", key: "Shift+a" },
        abort.signal,
      ),
    ).rejects.toThrow("withdrawn");

    const types = sent
      .filter((call) => call.method === "Input.dispatchKeyEvent")
      .map((call) => (call.params as { type?: string }).type);
    expect(types).toEqual(["rawKeyDown", "keyUp"]);
  });

  it("attaches nothing when the turn was already withdrawn before enable", async () => {
    // `ensureReady` attaches Chromium's debugger as a side effect. A withdrawn
    // turn that still ran it would leave the tab owned by a debugger nobody
    // will detach, and the person could no longer open their own DevTools.
    let readied = 0;
    const controller = new BrowserTabController({
      send: async () => ({}),
      ensureReady: async () => {
        readied += 1;
      },
    });
    const abort = new AbortController();
    abort.abort(new Error("withdrawn"));

    await expect(controller.enable(abort.signal)).rejects.toThrow("withdrawn");
    expect(readied).toBe(0);
  });

  it("sends no key up when the key spec never named a real key", async () => {
    // The gesture never started, so there is nothing to undo: a refusal must
    // not dispatch input of its own.
    const page = wire({ "Accessibility.getFullAXTree": BUTTON_TREE });
    const controller = new BrowserTabController(page.transport);
    const snapshot = await controller.snapshot();

    await expect(
      controller.act({ generation: snapshot.generation, kind: "press", key: "Mystery+Enter" }),
    ).rejects.toThrow(BrowserRefusal);

    expect(page.sent.map((call) => call.method)).not.toContain("Input.dispatchKeyEvent");
  });
});
