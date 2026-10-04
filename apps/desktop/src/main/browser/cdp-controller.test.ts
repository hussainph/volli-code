import { runInNewContext } from "node:vm";

import { BrowserRefusal } from "@volli/agent-runtime";
import { describe, expect, it, vi } from "vite-plus/test";

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

/** A flat page of `[role, name, backendDOMNodeId]` rows under one root, as CDP answers it. */
function tree(rows: [string, string, number][]): { nodes: object[] } {
  return {
    nodes: [
      {
        nodeId: "root",
        ignored: false,
        role: { value: "RootWebArea" },
        childIds: rows.map((_, index) => `n${index}`),
      },
      ...rows.map(([role, name, backendDOMNodeId], index) => ({
        nodeId: `n${index}`,
        ignored: false,
        role: { value: role },
        name: { value: name },
        backendDOMNodeId,
        childIds: [],
      })),
    ],
  };
}

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

  it("waits for rendering before reading a new generation, without depending on a preview", async () => {
    const rendered = Promise.withResolvers<object>();
    const page = wire({ "Accessibility.getFullAXTree": BUTTON_TREE });
    const controller = new BrowserTabController({
      send: async (method, params) => {
        const answer = page.transport.send(method, params);
        return method === "Runtime.evaluate" ? rendered.promise : answer;
      },
    });
    const reading = controller.snapshot();
    expect(page.sent).toEqual([
      {
        method: "Runtime.evaluate",
        params: {
          expression: expect.stringContaining("requestAnimationFrame"),
          awaitPromise: true,
          returnByValue: true,
        },
      },
    ]);
    rendered.resolve({});
    expect((await reading).text).toContain('button "Save"');
    await controller.snapshot();
    await controller.find("Save");
    expect(page.sent.filter((call) => call.method === "Runtime.evaluate")).toHaveLength(1);

    controller.syncGeneration(2);
    await controller.snapshot();
    controller.syncGeneration(1);
    await controller.snapshot();
    expect(page.sent.filter((call) => call.method === "Runtime.evaluate")).toHaveLength(2);
  });

  it("requires a completed rendering opportunity between two frame callbacks, not a timer", async () => {
    const page = wire({ "Accessibility.getFullAXTree": BUTTON_TREE });
    await new BrowserTabController(page.transport).snapshot();
    const params = page.sent[0]!.params as { expression: string };
    const frames: (() => void)[] = [];
    const rendering = runInNewContext(params.expression, {
      requestAnimationFrame: (frame: () => void) => frames.push(frame),
    }) as Promise<void>;
    let completed = false;
    void rendering.then(() => {
      completed = true;
    });
    expect(frames).toHaveLength(1);
    frames.shift()!();
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(frames).toHaveLength(1);
    frames.shift()!();
    await rendering;
    expect(completed).toBe(true);
    expect(frames).toHaveLength(0);
  });

  it("bounds rendering readiness and does not cache a late frame after timeout", async () => {
    vi.useFakeTimers();
    try {
      const rendered = Promise.withResolvers<object>();
      const page = wire({ "Accessibility.getFullAXTree": BUTTON_TREE });
      let evaluations = 0;
      const controller = new BrowserTabController(
        {
          send: async (method, params) => {
            const answer = page.transport.send(method, params);
            if (method === "Runtime.evaluate" && evaluations++ === 0) return rendered.promise;
            return answer;
          },
        },
        { maxCommandMs: 20 },
      );
      const reading = expect(controller.snapshot()).rejects.toThrow(
        "The Browser Tab did not become ready within 20ms",
      );
      await vi.advanceTimersByTimeAsync(20);
      await reading;
      expect(page.sent.map((call) => call.method)).toEqual(["Runtime.evaluate"]);
      rendered.resolve({});
      await Promise.resolve();
      await controller.snapshot();
      expect(evaluations).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("withdraws a rendering wait without minting refs or caching its late answer", async () => {
    const rendered = Promise.withResolvers<object>();
    const page = wire({ "Accessibility.getFullAXTree": BUTTON_TREE });
    let evaluations = 0;
    const controller = new BrowserTabController({
      send: async (method, params) => {
        const answer = page.transport.send(method, params);
        if (method === "Runtime.evaluate" && evaluations++ === 0) return rendered.promise;
        return answer;
      },
    });
    const abort = new AbortController();
    const reading = controller.snapshot(abort.signal);
    const failure = new Error("withdrawn before rendering");
    abort.abort(failure);
    await expect(reading).rejects.toBe(failure);
    rendered.resolve({});
    await Promise.resolve();
    expect(page.sent.map((call) => call.method)).toEqual(["Runtime.evaluate"]);
    await controller.snapshot();
    expect(evaluations).toBe(2);
  });

  it("does not cache failed rendering or relabel an older generation's frame", async () => {
    const rendered = Promise.withResolvers<object>();
    const page = wire({ "Accessibility.getFullAXTree": BUTTON_TREE });
    let evaluations = 0;
    const controller = new BrowserTabController({
      send: async (method, params) => {
        const answer = page.transport.send(method, params);
        if (method === "Runtime.evaluate") {
          evaluations += 1;
          if (evaluations === 1) return { exceptionDetails: { text: "frame failed" } };
          if (evaluations === 2) return rendered.promise;
        }
        return answer;
      },
    });
    await expect(controller.snapshot()).rejects.toThrow("could not finish rendering");
    expect(page.sent.map((call) => call.method)).toEqual(["Runtime.evaluate"]);
    const reading = controller.snapshot();
    controller.syncGeneration(2);
    rendered.resolve({});
    await reading;
    await controller.snapshot();
    expect(evaluations).toBe(3);
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

  it("keeps the same element's ref across snapshots of one generation", async () => {
    const page = wire({
      "Accessibility.getFullAXTree": BUTTON_TREE,
      "DOM.getBoxModel": BUTTON_BOX,
    });
    const controller = new BrowserTabController(page.transport);
    const first = await controller.snapshot();
    const second = await controller.snapshot();

    // Same backend node, same generation, same ref (VC-364) — and nothing new.
    expect(first.text).toBe('- button "Save" [ref=e1]');
    expect(second.text).toBe('- button "Save" [ref=e1]');
    await expect(
      controller.act({ generation: second.generation, kind: "click", ref: "e1" }),
    ).resolves.toEqual({ target: { ref: "e1", name: "Save" } });
  });

  it("marks an element no earlier read of the generation showed as [new]", async () => {
    const answers: Record<string, unknown> = { "Accessibility.getFullAXTree": BUTTON_TREE };
    const controller = new BrowserTabController(wire(answers).transport);
    await controller.snapshot();
    answers["Accessibility.getFullAXTree"] = tree([
      ["button", "Save", 77],
      ["button", "Undo", 78],
    ]);

    const second = await controller.snapshot();

    expect(second.text).toBe(
      ['- button "Save" [ref=e1]', '- button "Undo" [ref=e2] [new]'].join("\n"),
    );
  });

  it("refuses a ref whose element left the page, though the generation still remembers it", async () => {
    const answers: Record<string, unknown> = {
      "Accessibility.getFullAXTree": tree([
        ["button", "Save", 77],
        ["button", "Delete", 78],
      ]),
      "DOM.getBoxModel": BUTTON_BOX,
    };
    const page = wire(answers);
    const controller = new BrowserTabController(page.transport);
    await controller.snapshot();
    answers["Accessibility.getFullAXTree"] = tree([["button", "Save", 77]]);
    const after = await controller.snapshot();

    await expect(
      controller.act({ generation: after.generation, kind: "click", ref: "e2" }),
    ).rejects.toMatchObject({
      rule: "browser.unknown-ref",
      message: expect.stringContaining("no longer on the page"),
    });
    expect(page.sent.some((call) => call.method === "Input.dispatchMouseEvent")).toBe(false);

    // If the same node returns, it is the same element and gets its old ref.
    answers["Accessibility.getFullAXTree"] = tree([
      ["button", "Save", 77],
      ["button", "Delete", 78],
    ]);
    expect((await controller.snapshot()).text).toContain('- button "Delete" [ref=e2]');
  });

  it("forgets every ref when the generation changes", async () => {
    const answers: Record<string, unknown> = { "Accessibility.getFullAXTree": BUTTON_TREE };
    const controller = new BrowserTabController(wire(answers).transport);
    await controller.snapshot();

    controller.syncGeneration(1);
    answers["Accessibility.getFullAXTree"] = tree([["link", "Home", 500]]);
    const next = await controller.snapshot();

    // A new page starts numbering afresh, and its first read marks nothing.
    expect(next).toMatchObject({ text: '- link "Home" [ref=e1]', generation: 1 });
  });

  it("never leaves a ref the snapshot bound cut away actionable", async () => {
    const page = wire({
      "Accessibility.getFullAXTree": tree([
        ["button", "first button here", 77],
        ["button", "second one", 78],
      ]),
      "DOM.getBoxModel": BUTTON_BOX,
    });
    const controller = new BrowserTabController(page.transport, { maxSnapshotChars: 40 });
    const printed = await controller.snapshot();

    expect(printed).toMatchObject({
      text: '- button "first button here" [ref=e1]',
      truncated: true,
    });
    await expect(
      controller.act({ generation: printed.generation, kind: "click", ref: "e2" }),
    ).rejects.toMatchObject({ rule: "browser.unknown-ref" });
    expect(page.sent.some((call) => call.method.startsWith("Input."))).toBe(false);
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
    // the same snapshot that just failed. Rendering has already answered.
    const controller = new BrowserTabController(
      {
        send: async (method) =>
          method === "Runtime.evaluate" ? {} : new Promise<never>(() => undefined),
      },
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
        if (method === "Runtime.evaluate") return {};
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

/** 800 distinct buttons, backend ids from `from`: short enough to print whole. */
function batch(from: number): [string, string, number][] {
  return Array.from({ length: 800 }, (_, index) => ["button", `B${from + index}`, from + index]);
}

describe("BrowserTabController.find (VC-364)", () => {
  it("finds past the snapshot's bound, and its refs are the ones that act", async () => {
    const page = wire({
      "Accessibility.getFullAXTree": tree([
        ["button", "first button with a much longer name here", 77],
        ["button", "Delete account", 78],
      ]),
      "DOM.getBoxModel": BUTTON_BOX,
    });
    const controller = new BrowserTabController(page.transport, { maxSnapshotChars: 70 });
    const snapshot = await controller.snapshot();
    expect(snapshot.text).not.toContain("Delete");

    const found = await controller.find("delete ACCOUNT");

    expect(found).toEqual({
      text: ["...", '- button "Delete account" [ref=e2] [new] [match]'].join("\n"),
      generation: 0,
      matches: 1,
      shown: 1,
      truncated: false,
      empty: false,
    });
    // Rendering readiness once, then two AX reads: the search itself executes
    // no page script and never passes the query to Runtime.evaluate.
    expect(page.sent.map((call) => call.method)).toEqual([
      "Runtime.evaluate",
      "Accessibility.getFullAXTree",
      "Accessibility.getFullAXTree",
    ]);
    await expect(
      controller.act({ generation: found.generation, kind: "click", ref: "e2" }),
    ).resolves.toEqual({ target: { ref: "e2", name: "Delete account" } });
    expect(page.sent).toContainEqual({
      method: "DOM.scrollIntoViewIfNeeded",
      params: { backendNodeId: 78 },
    });
  });

  it("replaces the actionable set: a ref the find did not show needs a fresh read", async () => {
    const page = wire({
      "Accessibility.getFullAXTree": tree([
        ["button", "Save", 77],
        ["button", "Delete", 78],
      ]),
    });
    const controller = new BrowserTabController(page.transport);
    await controller.snapshot();
    const found = await controller.find("delete");

    await expect(
      controller.act({ generation: found.generation, kind: "click", ref: "e1" }),
    ).rejects.toMatchObject({
      rule: "browser.unknown-ref",
      message: expect.stringContaining("did not show it"),
    });
    expect(page.sent.some((call) => call.method.startsWith("Input."))).toBe(false);
  });

  it("leaves the latest snapshot's refs standing when a find shows nothing", async () => {
    const page = wire({
      "Accessibility.getFullAXTree": BUTTON_TREE,
      "DOM.getBoxModel": BUTTON_BOX,
    });
    const controller = new BrowserTabController(page.transport);
    const snapshot = await controller.snapshot();

    expect(await controller.find("checkout")).toMatchObject({ text: "", matches: 0 });
    await expect(
      controller.act({ generation: snapshot.generation, kind: "click", ref: "e1" }),
    ).resolves.toEqual({ target: { ref: "e1", name: "Save" } });
  });

  it("marks nothing new after an earlier read that showed nothing", async () => {
    const answers: Record<string, unknown> = { "Accessibility.getFullAXTree": { nodes: [] } };
    const controller = new BrowserTabController(wire(answers).transport);
    await controller.snapshot();
    answers["Accessibility.getFullAXTree"] = BUTTON_TREE;

    expect((await controller.snapshot()).text).toBe('- button "Save" [ref=e1]');
  });

  it("past its bound, the ledger keeps only the latest read and never reuses a number", async () => {
    const answers: Record<string, unknown> = {};
    const controller = new BrowserTabController(wire(answers).transport);
    // Thirteen reads of 800 distinct buttons each overflow the 10,000 bound.
    for (let read = 0; read < 13; read += 1) {
      answers["Accessibility.getFullAXTree"] = tree(batch(read * 800));
      expect((await controller.snapshot()).truncated).toBe(false);
    }
    // The early batches were forgotten, so a node from one comes back under a
    // fresh number past every number already shown — never an old one — while
    // the latest read's elements keep theirs.
    answers["Accessibility.getFullAXTree"] = tree([
      ["button", "B9600", 9_600],
      ["button", "B0", 0],
    ]);

    expect((await controller.snapshot()).text).toBe(
      ['- button "B9600" [ref=e9601]', '- button "B0" [ref=e10401] [new]'].join("\n"),
    );
  });

  it("tells no matches apart from an empty tree", async () => {
    const answers: Record<string, unknown> = { "Accessibility.getFullAXTree": BUTTON_TREE };
    const controller = new BrowserTabController(wire(answers).transport);

    expect(await controller.find("checkout")).toMatchObject({ matches: 0, empty: false });
    answers["Accessibility.getFullAXTree"] = { nodes: [] };
    expect(await controller.find("checkout")).toMatchObject({ matches: 0, empty: true });
  });

  it("refuses an empty or oversized query without reading the page", async () => {
    const page = wire({ "Accessibility.getFullAXTree": BUTTON_TREE });
    const controller = new BrowserTabController(page.transport);

    await expect(controller.find("   ")).rejects.toMatchObject({ rule: "browser.find-query" });
    await expect(controller.find("x".repeat(201))).rejects.toMatchObject({
      rule: "browser.find-query",
    });
    expect(page.sent).toEqual([]);
  });

  it("gives a timed-out find its own recovery guidance", async () => {
    const controller = new BrowserTabController(
      {
        send: async (method) =>
          method === "Runtime.evaluate" ? {} : new Promise<unknown>(() => undefined),
      },
      { maxCommandMs: 5 },
    );

    await expect(controller.find("save")).rejects.toThrow(/searching/);
  });
});
