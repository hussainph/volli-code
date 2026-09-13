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

    const acted = await controller.act({
      generation: snapshot.generation,
      kind: "click",
      ref: "e1",
    });

    // What was acted on, in the page's own words, so the transcript can say
    // `Clicked "Save"` (VC-238). The name is page content and stays bounded.
    expect(acted).toEqual({ target: { ref: "e1", name: "Save" } });
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

  it("presses Enter with the CDP text payload that triggers form defaults", async () => {
    const page = wire({ "Accessibility.getFullAXTree": BUTTON_TREE });
    const controller = new BrowserTabController(page.transport);
    const snapshot = await controller.snapshot();

    await controller.act({
      generation: snapshot.generation,
      kind: "type",
      ref: "e1",
      text: "search terms",
    });
    await controller.act({ generation: snapshot.generation, kind: "press", key: "Enter" });

    expect(page.sent).toContainEqual({
      method: "Input.dispatchKeyEvent",
      params: {
        type: "keyDown",
        modifiers: 0,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        text: "\r",
        unmodifiedText: "\r",
      },
    });
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

  it("refuses a select whose resolved element detached before the fixed page function ran", async () => {
    const page = wire({
      "Accessibility.getFullAXTree": BUTTON_TREE,
      "DOM.resolveNode": { object: { objectId: "object-1" } },
      "Runtime.callFunctionOn": { result: { value: "detached" } },
    });
    const controller = new BrowserTabController(page.transport);
    const snapshot = await controller.snapshot();

    await expect(
      controller.act({
        generation: snapshot.generation,
        kind: "select",
        ref: "e1",
        text: "two",
      }),
    ).rejects.toMatchObject({ rule: "browser.unknown-ref" });
  });

  it("accepts the explicit success result from the fixed select function", async () => {
    const page = wire({
      "Accessibility.getFullAXTree": BUTTON_TREE,
      "DOM.resolveNode": { object: { objectId: "object-1" } },
      "Runtime.callFunctionOn": { result: { value: "selected" } },
    });
    const controller = new BrowserTabController(page.transport);
    const snapshot = await controller.snapshot();

    await expect(
      controller.act({
        generation: snapshot.generation,
        kind: "select",
        ref: "e1",
        text: "two",
      }),
    ).resolves.toEqual({ target: { ref: "e1", name: "Save" } });
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

  it("reports PNG device-pixel dimensions rather than CSS layout dimensions", async () => {
    const page = wire({
      "Page.captureScreenshot": { data: "iVBORw0KGgoAAAANSUhEUgAABkAAAASw" },
      "Page.getLayoutMetrics": { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } },
    });
    const controller = new BrowserTabController(page.transport);

    const shot = await controller.screenshot();

    expect(shot).toEqual({
      base64Png: "iVBORw0KGgoAAAANSUhEUgAABkAAAASw",
      width: 1600,
      height: 1200,
    });
    expect(page.sent.map((call) => call.method)).not.toContain("Page.getLayoutMetrics");
  });

  it.each(["", "aGVsbG8=", "iVBORw0KGgoAAAANSUhEUgAAAAAAAAAA"])(
    "rejects empty or malformed screenshot data %s",
    async (data) => {
      const page = wire({ "Page.captureScreenshot": { data } });
      await expect(new BrowserTabController(page.transport).screenshot()).rejects.toThrow(
        /screenshot|pixels/,
      );
    },
  );

  it("gives a timed-out screenshot accurate recovery guidance", async () => {
    const controller = new BrowserTabController(
      { send: () => new Promise<never>(() => undefined) },
      { maxCommandMs: 20 },
    );

    await expect(controller.screenshot()).rejects.toHaveProperty(
      "message",
      "The Browser Tab did not finish taking a screenshot within 20ms. The page may still be busy or too heavy to capture in time. Take a snapshot to check its current state, then try the screenshot again.",
    );
  });

  it("gives a timed-out snapshot non-circular recovery guidance", async () => {
    // A throttled, crashed or torn-down page can hold a command open forever;
    // the caller must get one readable failure, not a hang or advice to take
    // the same snapshot that just failed.
    const controller = new BrowserTabController(
      { send: () => new Promise<never>(() => undefined) },
      { maxCommandMs: 20 },
    );

    await expect(controller.snapshot()).rejects.toHaveProperty(
      "message",
      "The Browser Tab did not finish taking a snapshot within 20ms. Wait for the page to settle, then try the snapshot again.",
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
    ).rejects.toHaveProperty(
      "message",
      "The Browser Tab did not finish the requested action within 20ms. The action may or may not have reached the page; check its current state before trying again.",
    );

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

  it("reports readiness timeouts without suggesting a snapshot the tab cannot take yet", async () => {
    const controller = new BrowserTabController(
      {
        send: async () => ({}),
        ensureReady: () => new Promise<never>(() => undefined),
      },
      { maxCommandMs: 20 },
    );

    await expect(controller.enable()).rejects.toHaveProperty(
      "message",
      "The Browser Tab did not become ready within 20ms. Try the Browser Tab command again.",
    );
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

  it("refuses a node the page dropped since the snapshot instead of failing the host", async () => {
    // An SPA can remove an element without navigating, so no generation bumps
    // and the map still holds the ref. CDP answers with a raw node error; the
    // model must hear the same "take a fresh snapshot" refusal a stale ref
    // gets, not a broken-port failure.
    const sent: { method: string }[] = [];
    const controller = new BrowserTabController({
      send: async (method) => {
        sent.push({ method });
        if (method === "Accessibility.getFullAXTree") return BUTTON_TREE;
        if (method === "DOM.scrollIntoViewIfNeeded" || method === "DOM.getBoxModel") {
          throw new Error("No node with given id found");
        }
        return {};
      },
    });
    const snapshot = await controller.snapshot();

    await expect(
      controller.act({ generation: snapshot.generation, kind: "click", ref: "e1" }),
    ).rejects.toMatchObject({ rule: "browser.unknown-ref" });
    expect(sent.some((call) => call.method === "Input.dispatchMouseEvent")).toBe(false);
  });

  it("refuses a type whose element vanished before the focus, as a refusal not a fault", async () => {
    const controller = new BrowserTabController({
      send: async (method) => {
        if (method === "Accessibility.getFullAXTree") return BUTTON_TREE;
        if (method === "DOM.focus") throw new Error("No node with given id found");
        return {};
      },
    });
    const snapshot = await controller.snapshot();

    await expect(
      controller.act({ generation: snapshot.generation, kind: "type", ref: "e1", text: "hi" }),
    ).rejects.toMatchObject({ rule: "browser.unknown-ref" });
  });

  it("keeps a real fault a fault when the turn was withdrawn, not the node gone", async () => {
    // The node-error conversion must not swallow aborts: a withdrawn turn is
    // still a withdrawn turn, not a missing element.
    const abort = new AbortController();
    const controller = new BrowserTabController({
      send: async (method) => {
        if (method === "Accessibility.getFullAXTree") return BUTTON_TREE;
        if (method === "DOM.focus") {
          abort.abort(new Error("withdrawn"));
          throw new Error("No node with given id found");
        }
        return {};
      },
    });
    const snapshot = await controller.snapshot();

    await expect(
      controller.act(
        { generation: snapshot.generation, kind: "type", ref: "e1", text: "hi" },
        abort.signal,
      ),
    ).rejects.toThrow("withdrawn");
  });

  it.each([
    new Error("debugger disconnected"),
    new BrowserRefusal("browser.debugger-unavailable", "DevTools is busy"),
  ])("preserves non-node failures rather than claiming a stale ref", async (failure) => {
    const controller = new BrowserTabController({
      send: async (method) => {
        if (method === "Accessibility.getFullAXTree") return BUTTON_TREE;
        throw failure;
      },
    });
    await controller.snapshot();
    await expect(controller.act({ generation: 0, kind: "click", ref: "e1" })).rejects.toBe(failure);
  });

  it("delivers the shifted character when press names Shift with a letter", async () => {
    // A real keyboard puts `A` in the field for Shift+a; the char event must
    // carry the shifted character, not the bare key.
    const page = wire({ "Accessibility.getFullAXTree": BUTTON_TREE });
    const controller = new BrowserTabController(page.transport);
    const snapshot = await controller.snapshot();

    await controller.act({ generation: snapshot.generation, kind: "press", key: "Shift+a" });

    expect(page.sent).toContainEqual({
      method: "Input.dispatchKeyEvent",
      params: { type: "char", modifiers: 8, text: "A", key: "A" },
    });
  });

  it("delivers the shifted symbol and physical key identity for Shift+1", async () => {
    const page = wire({ "Accessibility.getFullAXTree": BUTTON_TREE });
    const controller = new BrowserTabController(page.transport);
    await controller.snapshot();

    await controller.act({ generation: 0, kind: "press", key: "Shift+1" });

    expect(page.sent).toContainEqual({
      method: "Input.dispatchKeyEvent",
      params: {
        type: "rawKeyDown",
        modifiers: 8,
        key: "!",
        code: "Digit1",
        windowsVirtualKeyCode: 49,
      },
    });
    expect(page.sent).toContainEqual({
      method: "Input.dispatchKeyEvent",
      params: { type: "char", modifiers: 8, text: "!", key: "!" },
    });
  });

  it.each(["click", "press"] as const)(
    "reports a failed %s release rather than a successful action",
    async (kind) => {
      const failure = new Error("input release failed");
      const controller = new BrowserTabController({
        send: async (method, params) => {
          if (method === "Accessibility.getFullAXTree") return BUTTON_TREE;
          if (method === "DOM.getBoxModel") return BUTTON_BOX;
          const type = (params as { type?: string } | undefined)?.type;
          if (type === "mouseReleased" || type === "keyUp") throw failure;
          return {};
        },
      });
      await controller.snapshot();
      await expect(controller.act({ generation: 0, kind, ref: "e1", key: "Enter" })).rejects.toBe(
        failure,
      );
    },
  );

  it.each(["Control+a", "Meta+a"])(
    "runs the native select-all editing command for %s",
    async (key) => {
      const page = wire({ "Accessibility.getFullAXTree": BUTTON_TREE });
      const controller = new BrowserTabController(page.transport);
      await controller.snapshot();
      await controller.act({ generation: 0, kind: "press", key });
      expect(page.sent).toContainEqual({
        method: "Input.dispatchKeyEvent",
        params: expect.objectContaining({ type: "rawKeyDown", commands: ["selectAll"] }),
      });
    },
  );

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
