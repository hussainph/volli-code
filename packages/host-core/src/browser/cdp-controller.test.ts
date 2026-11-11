import { runInNewContext } from "node:vm";
import { PassThrough } from "node:stream";

import { BrowserRefusal } from "@volli/agent-runtime";
import { describe, expect, it, vi } from "vite-plus/test";

import { BrowserTabController, type CdpTransport } from "./cdp-controller";
import { CdpPipeConnection } from "./chromium-pipe";

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

  it("reads structure without running or awaiting frame callbacks", async () => {
    const page = wire({ "Accessibility.getFullAXTree": BUTTON_TREE });
    const controller = new BrowserTabController({
      send: async (method, params) =>
        method === "Runtime.evaluate"
          ? await new Promise<never>(() => undefined)
          : await page.transport.send(method, params),
    });
    expect((await controller.snapshot()).text).toContain('button "Save"');
    expect((await controller.find("Save")).matches).toBe(1);
    controller.syncGeneration(2);
    expect((await controller.snapshot()).generation).toBe(2);
    expect(page.sent.map((call) => call.method)).toEqual(
      Array.from({ length: 3 }, () => [
        "Memory.getDOMCounters",
        "Accessibility.getFullAXTree",
      ]).flat(),
    );
  });

  it("requires two frame callbacks before visual input, independently of structural reads", async () => {
    const rendered = Promise.withResolvers<object>();
    const page = wire({
      "Accessibility.getFullAXTree": BUTTON_TREE,
      "DOM.getBoxModel": BUTTON_BOX,
    });
    const controller = new BrowserTabController({
      send: async (method, params) => {
        const answer = page.transport.send(method, params);
        return method === "Runtime.evaluate" ? rendered.promise : answer;
      },
    });
    await controller.snapshot();
    const acting = controller.act({ generation: 0, kind: "hover", ref: "e1" });
    const params = page.sent.at(-1)!.params as { expression: string };
    expect(page.sent.at(-1)!.method).toBe("Runtime.evaluate");
    const frames: (() => void)[] = [];
    const rendering = runInNewContext(params.expression, {
      requestAnimationFrame: (frame: () => void) => frames.push(frame),
    }) as Promise<void>;
    let completed = false;
    void rendering.then(() => {
      completed = true;
    });
    frames.shift()!();
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(frames).toHaveLength(1);
    expect(page.sent.some((call) => call.method === "Input.dispatchMouseEvent")).toBe(false);
    frames.shift()!();
    await rendering;
    rendered.resolve({});
    await acting;
    await controller.act({ generation: 0, kind: "hover", ref: "e1" });
    expect(page.sent.filter((call) => call.method === "Runtime.evaluate")).toHaveLength(1);
    controller.syncGeneration(2);
    await controller.snapshot();
    await controller.act({ generation: 2, kind: "hover", ref: "e1" });
    expect(page.sent.filter((call) => call.method === "Runtime.evaluate")).toHaveLength(2);
  });

  it("bounds visual readiness, keeps structural reads working, and never caches a late frame", async () => {
    vi.useFakeTimers();
    try {
      const rendered = Promise.withResolvers<object>();
      const onTimeout = vi.fn();
      const page = wire({
        "Accessibility.getFullAXTree": BUTTON_TREE,
        "DOM.getBoxModel": BUTTON_BOX,
      });
      let evaluations = 0;
      const controller = new BrowserTabController(
        {
          onTimeout,
          send: async (method, params) => {
            const answer = page.transport.send(method, params);
            if (method === "Runtime.evaluate" && evaluations++ === 0) return rendered.promise;
            return answer;
          },
        },
        { maxCommandMs: 20 },
      );
      await controller.snapshot();
      const failed = expect(
        controller.act({ generation: 0, kind: "click", ref: "e1" }),
      ).rejects.toThrow("did not produce a rendered frame within 20ms");
      await vi.advanceTimersByTimeAsync(20);
      await failed;
      expect(onTimeout).toHaveBeenCalledWith({
        phase: "frame-fence",
        method: "Runtime.evaluate",
        elapsedMs: 20,
        generation: 0,
      });
      expect(page.sent.some((call) => call.method === "Input.dispatchMouseEvent")).toBe(false);
      expect((await controller.find("Save")).matches).toBe(1);
      rendered.resolve({});
      await Promise.resolve();
      await controller.act({ generation: 0, kind: "hover", ref: "e1" });
      expect(evaluations).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("withdraws a frame wait without dispatching input or caching its late answer", async () => {
    const rendered = Promise.withResolvers<object>();
    const page = wire({
      "Accessibility.getFullAXTree": BUTTON_TREE,
      "DOM.getBoxModel": BUTTON_BOX,
    });
    let evaluations = 0;
    const controller = new BrowserTabController({
      send: async (method, params) => {
        const answer = page.transport.send(method, params);
        if (method === "Runtime.evaluate" && evaluations++ === 0) return rendered.promise;
        return answer;
      },
    });
    await controller.snapshot();
    const abort = new AbortController();
    const acting = controller.act({ generation: 0, kind: "hover", ref: "e1" }, abort.signal);
    const failure = new Error("withdrawn before rendering");
    abort.abort(failure);
    await expect(acting).rejects.toBe(failure);
    rendered.resolve({});
    await Promise.resolve();
    expect(page.sent.map((call) => call.method)).toEqual([
      "Memory.getDOMCounters",
      "Accessibility.getFullAXTree",
      "Runtime.evaluate",
    ]);
    await controller.act({ generation: 0, kind: "hover", ref: "e1" });
    expect(evaluations).toBe(2);
  });

  it("does not cache failed rendering or use an older generation's frame for input", async () => {
    const rendered = Promise.withResolvers<object>();
    const page = wire({
      "Accessibility.getFullAXTree": BUTTON_TREE,
      "DOM.getBoxModel": BUTTON_BOX,
    });
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
    await controller.snapshot();
    await expect(controller.act({ generation: 0, kind: "click", ref: "e1" })).rejects.toThrow(
      "could not finish rendering",
    );
    const acting = controller.act({ generation: 0, kind: "click", ref: "e1" });
    controller.syncGeneration(2);
    rendered.resolve({});
    await expect(acting).rejects.toMatchObject({ rule: "browser.stale-ref" });
    expect(page.sent.some((call) => call.method === "Input.dispatchMouseEvent")).toBe(false);
    await controller.snapshot();
    await controller.act({ generation: 2, kind: "hover", ref: "e1" });
    expect(evaluations).toBe(3);
  });

  it("omits optional photos when the frame fence stalls, without certifying late pixels", async () => {
    vi.useFakeTimers();
    try {
      const frame = Promise.withResolvers<object>();
      const send = vi.fn(async (method: string) =>
        method === "Runtime.evaluate" ? await frame.promise : BUTTON_TREE,
      );
      const controller = new BrowserTabController({ send });
      const preview = controller.preparePreview();
      await vi.advanceTimersByTimeAsync(500);
      expect(await preview).toBe(false);
      expect((await controller.snapshot()).text).toContain("Save");
      frame.resolve({});
      await Promise.resolve();
      expect(await controller.preparePreview()).toBe(true);
      expect(send.mock.calls.filter(([method]) => method === "Runtime.evaluate")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not certify a late preview frame through the real CDP codec", async () => {
    vi.useFakeTimers();
    const records: Record<string, unknown>[] = [];
    const toBrowser = new PassThrough();
    const fromBrowser = new PassThrough();
    const connection = new CdpPipeConnection(toBrowser, fromBrowser);
    const commands: { id: number; method: string }[] = [];
    toBrowser.on("data", (bytes: Buffer) => {
      for (const frame of bytes.toString("utf8").split("\0").filter(Boolean)) {
        commands.push(JSON.parse(frame));
      }
    });
    const controller = new BrowserTabController({
      send: (method, params) => connection.send(method, params),
      // The composition's listener (VC-1150); the first call proves a failing
      // sink cannot change the fence's answer.
      onPreviewFrame: (diagnostic) => {
        records.push({ ...diagnostic });
        if (records.length === 1) throw new Error("diagnostic sink failed");
      },
    });
    try {
      const preview = controller.preparePreview();
      await vi.advanceTimersByTimeAsync(500);
      expect(await preview).toBe(false);
      expect(commands.map(({ method }) => method)).toEqual(["Runtime.evaluate"]);
      const first = commands[0]!;
      fromBrowser.write(`${JSON.stringify({ id: first.id, result: {} })}\0`);
      await Promise.resolve();
      const next = controller.preparePreview();
      await vi.advanceTimersByTimeAsync(0);
      expect(commands).toHaveLength(2);
      // A second wire response is required; the abandoned first reply is not readiness.
      fromBrowser.write(`${JSON.stringify({ id: commands[1]!.id, result: {} })}\0`);
      expect(await next).toBe(true);
      expect(records.map(({ outcome }) => outcome)).toEqual(["deadline", "ready"]);
      for (const record of records) {
        expect(Object.keys(record).toSorted()).toEqual(
          ["currentGeneration", "elapsedMs", "generation", "outcome"].toSorted(),
        );
      }
    } finally {
      connection.close();
      toBrowser.destroy();
      fromBrowser.destroy();
      vi.useRealTimers();
    }
  });

  it("names each declined preview frame without changing what the fence answers", async () => {
    const outcomes: string[] = [];
    const onPreviewFrame = (diagnostic: { outcome: string }) =>
      void outcomes.push(diagnostic.outcome);
    const broken = new BrowserTabController({
      send: async () => ({ exceptionDetails: { text: "private page error" } }),
      onPreviewFrame,
    });
    expect(await broken.preparePreview()).toBe(false);
    let generation = 0;
    const moving = new BrowserTabController({
      currentGeneration: () => generation,
      send: async () => {
        generation = 1;
        return {};
      },
      onPreviewFrame,
    });
    expect(await moving.preparePreview()).toBe(false);
    const withdrawn = new AbortController();
    withdrawn.abort();
    const gone = new BrowserTabController({ send: async () => ({}), onPreviewFrame });
    await expect(gone.preparePreview(withdrawn.signal)).rejects.toBeDefined();
    expect(outcomes).toEqual(["frame-error", "generation-changed", "withdrawn"]);
  });

  it("reports only fixed timeout metadata, even when the diagnostic sink fails", async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn(() => {
        throw new Error("diagnostic sink failed");
      });
      const page = wire({ "Accessibility.getFullAXTree": BUTTON_TREE });
      const controller = new BrowserTabController(
        {
          onTimeout,
          send: async (method, params) =>
            method === "Input.insertText"
              ? await new Promise<never>(() => undefined)
              : await page.transport.send(method, params),
        },
        { maxCommandMs: 20 },
      );
      controller.syncGeneration(7);
      await controller.snapshot();
      const failed = expect(
        controller.act({ generation: 7, kind: "type", ref: "e1", text: "private page text" }),
      ).rejects.toThrow("may or may not have reached the page");
      await vi.advanceTimersByTimeAsync(20);
      await failed;
      expect(onTimeout.mock.calls).toEqual([
        [{ phase: "action", method: "Input.insertText", elapsedMs: 20, generation: 7 }],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not mint current refs from an older generation's late AX tree", async () => {
    const lateTree = Promise.withResolvers<object>();
    const controller = new BrowserTabController({ send: () => lateTree.promise });
    const reading = controller.snapshot();
    controller.syncGeneration(1);
    lateTree.resolve(BUTTON_TREE);
    await expect(reading).rejects.toMatchObject({ rule: "browser.stale-ref" });
    await expect(controller.act({ generation: 1, kind: "click", ref: "e1" })).rejects.toMatchObject(
      { rule: "browser.stale-ref" },
    );
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
      {
        send: async (method) =>
          method === "Runtime.evaluate" ? {} : await new Promise<never>(() => undefined),
      },
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

  it("never dispatches abandoned input when deferred transport initialization answers after timeout", async () => {
    vi.useFakeTimers();
    try {
      const initialized = Promise.withResolvers<void>();
      const page = wire({ "Accessibility.getFullAXTree": BUTTON_TREE });
      const controller = new BrowserTabController(
        {
          ...page.transport,
          sendGuarded: async (method, params, beforeDispatch) => {
            if (method.startsWith("Input.")) await initialized.promise;
            beforeDispatch();
            return await page.transport.send(method, params);
          },
        },
        { maxCommandMs: 20 },
      );
      await controller.snapshot();
      const acting = expect(
        controller.act({ generation: 0, kind: "press", key: "Enter" }),
      ).rejects.toThrow("did not finish the requested action");
      await vi.advanceTimersByTimeAsync(20);
      await acting;
      initialized.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(page.sent.filter(({ method }) => method.startsWith("Input."))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
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

  it.each([false, true])(
    "releases the mouse button after an unanswered dispatched press (guarded=%s)",
    async (guarded) => {
      // A dispatched press may have applied even when its answer never arrived.
      const sent: { method: string; params?: object }[] = [];
      const send: CdpTransport["send"] = async (method, params) => {
        sent.push({ method, ...(params === undefined ? {} : { params }) });
        if ((params as { type?: string } | undefined)?.type === "mousePressed") {
          return await new Promise<never>(() => undefined);
        }
        if (method === "Accessibility.getFullAXTree") return BUTTON_TREE;
        if (method === "DOM.getBoxModel") return BUTTON_BOX;
        return {};
      };
      const controller = new BrowserTabController(
        {
          send,
          ...(guarded
            ? {
                sendGuarded: async (
                  method: string,
                  params: object | undefined,
                  beforeDispatch: () => void,
                ) => {
                  await Promise.resolve();
                  beforeDispatch();
                  return await send(method, params);
                },
              }
            : {}),
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
    },
  );

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

  it("reports domain readiness timeouts without inviting replay of a mutation", async () => {
    const controller = new BrowserTabController(
      {
        send: async () => ({}),
        ensureReady: () => new Promise<never>(() => undefined),
      },
      { maxCommandMs: 20 },
    );

    await expect(controller.enable()).rejects.toHaveProperty(
      "message",
      "The Browser Tab did not become ready within 20ms. Check the tab with a fresh snapshot before repeating any navigation or action; it may already have happened.",
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
    // Structural reads execute no page script, including no frame fence;
    // each AX read is first sized by the renderer's own counter (VC-1082).
    expect(page.sent.map((call) => call.method)).toEqual([
      "Memory.getDOMCounters",
      "Accessibility.getFullAXTree",
      "Memory.getDOMCounters",
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

// The digest's walk is bounded like a find's: a change past 20,000 nodes
// costs nothing to read and goes unseen.
const long = (last: string) =>
  tree(
    Array.from({ length: 20_001 }, (_, index): [string, string, number] => [
      "button",
      index === 20_000 ? last : `B${index}`,
      index,
    ]),
  );

const fingerprintTree = (extra: object = {}) => ({
  nodes: [
    { ...BUTTON_TREE.nodes[0]!, childIds: ["2", "3"] },
    BUTTON_TREE.nodes[1]!,
    {
      nodeId: "3",
      ignored: false,
      role: { value: "checkbox" },
      name: { value: "Remember me" },
      backendDOMNodeId: 78,
      properties: [{ name: "checked", value: { value: "false" } }],
      ...extra,
    },
  ],
});

describe("BrowserTabController empty trees, failed reads and tree digests (VC-277)", () => {
  /** A blank document, as Chromium answers it: the root and nothing under it. */
  const BLANK = {
    nodes: [{ nodeId: "1", ignored: false, role: { value: "RootWebArea" }, childIds: [] }],
  };

  it("says a tree with nothing to print is empty, and a tree the bound cut is not", async () => {
    const answers: Record<string, unknown> = { "Accessibility.getFullAXTree": BLANK };
    const controller = new BrowserTabController(wire(answers).transport);

    expect(await controller.snapshot()).toEqual({
      text: "",
      generation: 0,
      truncated: false,
      empty: true,
    });

    answers["Accessibility.getFullAXTree"] = BUTTON_TREE;
    expect(await controller.snapshot()).toMatchObject({ empty: false });

    // A bound too small for even one line prints nothing, but the page is
    // not empty, and the answer says it was cut instead — with the tree the
    // cut lost beside it, for the runtime to save (VC-237). Its button was
    // never shown, so it carries no ref there.
    const narrow = new BrowserTabController(wire(answers).transport, { maxSnapshotChars: 5 });
    expect(await narrow.snapshot()).toEqual({
      text: "",
      generation: 0,
      truncated: true,
      empty: false,
      whole: { text: '- button "Save"', bounded: false },
    });
  });

  it("calls a tree whose walk hit its node bound before any content cut, never empty", async () => {
    // A hidden sprite sheet ahead of the content can spend the whole node
    // budget on ignored nodes: nothing printed, but the page is not blank.
    const hidden = Array.from({ length: 20_001 }, (_, index) => ({
      nodeId: `h${index}`,
      ignored: true,
      role: { value: "generic" },
      childIds: [],
    }));
    const sprite = {
      nodes: [
        { ...BUTTON_TREE.nodes[0]!, childIds: [...hidden.map((node) => node.nodeId), "2"] },
        ...hidden,
        BUTTON_TREE.nodes[1]!,
      ],
    };
    const controller = new BrowserTabController(
      wire({ "Accessibility.getFullAXTree": sprite }).transport,
    );

    expect(await controller.snapshot()).toEqual({
      text: "",
      generation: 0,
      truncated: true,
      empty: false,
    });
    expect(await controller.find("save")).toMatchObject({
      matches: 0,
      truncated: true,
      empty: false,
    });
  });

  it("fails a read whose answer carried no tree, rather than calling the page empty", async () => {
    const controller = new BrowserTabController(
      wire({ "Accessibility.getFullAXTree": {} }).transport,
    );

    await expect(controller.snapshot()).rejects.toThrow(
      "The Browser Tab answered without an accessibility tree, so nothing was read.",
    );
    await expect(controller.find("save")).rejects.toThrow("answered without an accessibility tree");
    expect(controller.treeDigest).toBeNull();
  });

  it("fingerprints what an action could visibly change, whichever read saw it, and nothing else", async () => {
    const answers: Record<string, unknown> = { "Accessibility.getFullAXTree": fingerprintTree() };
    const controller = new BrowserTabController(wire(answers).transport);
    expect(controller.treeDigest).toBeNull();

    await controller.snapshot();
    const settled = controller.treeDigest;
    expect(settled).toMatch(/^[0-9a-f]{64}$/);
    // A find walks the same tree, printing far less: the digest is the page's.
    await controller.find("remember");
    expect(controller.treeDigest).toBe(settled);

    // Focus moves on every click, so it is not a change anyone could see.
    answers["Accessibility.getFullAXTree"] = fingerprintTree({
      properties: [
        { name: "checked", value: { value: "false" } },
        { name: "focused", value: { value: true } },
      ],
    });
    await controller.snapshot();
    expect(controller.treeDigest).toBe(settled);

    // A state the page flipped, a value it took, and an element it added are.
    const seen = new Set([settled]);
    for (const changed of [
      fingerprintTree({ properties: [{ name: "checked", value: { value: "true" } }] }),
      fingerprintTree({ value: { value: "on" } }),
      tree([
        ["button", "Save", 77],
        ["dialog", "Composer", 79],
      ]),
    ]) {
      answers["Accessibility.getFullAXTree"] = changed;
      await controller.snapshot();
      expect(seen.has(controller.treeDigest)).toBe(false);
      seen.add(controller.treeDigest);
    }
    answers["Accessibility.getFullAXTree"] = long("first");
    await controller.snapshot();
    const bounded = controller.treeDigest;
    answers["Accessibility.getFullAXTree"] = long("second");
    await controller.snapshot();
    expect(controller.treeDigest).toBe(bounded);

    // A new generation forgets the old page's digest with its refs.
    controller.syncGeneration(1);
    expect(controller.treeDigest).toBeNull();
  });
});

/**
 * A page's whole AX tree, flat in document order the way `getFullAXTree`
 * answers it: nested sections of ignored wrappers, headings, links, buttons
 * and text leaves whose inline-text-box children no print walks, `size`
 * sections wide, plus one chain deeper than the prints' depth bound.
 */
function bigTree(size: number, chainDepth = 0): { nodes: AXNodeShape[] } {
  const nodes: AXNodeShape[] = [];
  let next = 0;
  const add = (node: Omit<AXNodeShape, "nodeId">): AXNodeShape => {
    const made = { nodeId: `ax${next++}`, ...node };
    nodes.push(made);
    return made;
  };
  const root = add({ role: { value: "RootWebArea" }, name: { value: "Big" }, childIds: [] });
  const text = (name: string): string => {
    const leaf = add({ role: { value: "StaticText" }, name: { value: name }, childIds: [] });
    leaf.childIds = [
      add({ role: { value: "InlineTextBox" }, name: { value: name }, childIds: [] }).nodeId,
    ];
    return leaf.nodeId;
  };
  for (let index = 0; index < size; index += 1) {
    const wrapper = add({ ignored: true, role: { value: "none" }, childIds: [] });
    const section = add({ role: { value: "region" }, name: { value: `S${index}` }, childIds: [] });
    wrapper.childIds = [section.nodeId];
    section.childIds = [
      add({ role: { value: "heading" }, name: { value: `Heading ${index}` }, childIds: [] }).nodeId,
      text(`Body ${index}`),
      add({
        role: { value: "link" },
        name: { value: `Link ${index}` },
        backendDOMNodeId: 10_000 + index,
        childIds: [text(`Link ${index}`)],
      }).nodeId,
      add({
        role: { value: "button" },
        name: { value: `Go ${index}` },
        backendDOMNodeId: 50_000 + index,
        childIds: [],
      }).nodeId,
    ];
    root.childIds!.push(wrapper.nodeId);
  }
  let parent = root;
  for (let depth = 0; depth < chainDepth; depth += 1) {
    const child = add({
      role: { value: "group" },
      name: { value: `Level ${depth}` },
      childIds: [],
    });
    parent.childIds!.push(child.nodeId);
    parent = child;
  }
  return { nodes };
}

interface AXNodeShape {
  nodeId: string;
  ignored?: boolean;
  role?: { value: string };
  name?: { value: string };
  backendDOMNodeId?: number;
  childIds?: string[];
}

/**
 * A wire that answers the piecewise read from a whole tree the way Chromium
 * does: a node's children, spliced through ignored ones (their children come
 * with them), and the full tree to anyone who still asks for it.
 */
function piecewiseWire(
  whole: { nodes: AXNodeShape[] },
  domNodes: number,
  fail: (nodeId: string) => boolean = () => false,
): ReturnType<typeof wire> {
  const byId = new Map(whole.nodes.map((node) => [node.nodeId, node]));
  const page = wire({
    "Memory.getDOMCounters": { documents: 1, nodes: domNodes, jsEventListeners: 0 },
    "Accessibility.getFullAXTree": whole,
    "Accessibility.getRootAXNode": { node: whole.nodes[0] },
  });
  const send = page.transport.send;
  page.transport = {
    send: async (method, params) => {
      if (method !== "Accessibility.getChildAXNodes") return send(method, params);
      page.sent.push({ method, params });
      const { id } = params as { id: string };
      if (fail(id)) throw new Error("Could not find node with given id");
      const answer: AXNodeShape[] = [];
      const spliced = (nodeId: string): void => {
        const node = byId.get(nodeId);
        if (node === undefined) return;
        answer.push(node);
        if (node.ignored === true) for (const child of node.childIds ?? []) spliced(child);
      };
      for (const child of byId.get(id)?.childIds ?? []) spliced(child);
      return { nodes: answer };
    },
  };
  return page;
}

async function readBoth(
  whole: { nodes: AXNodeShape[] },
  read: (controller: BrowserTabController) => Promise<unknown>,
): Promise<{ full: unknown; pieces: unknown; page: ReturnType<typeof wire> }> {
  const fullPage = piecewiseWire(whole, 5_000);
  const piecePage = piecewiseWire(whole, 5_001);
  const full = await read(new BrowserTabController(fullPage.transport));
  const pieces = await read(new BrowserTabController(piecePage.transport));
  expect(fullPage.sent.map((call) => call.method)).toContain("Accessibility.getFullAXTree");
  return { full, pieces, page: piecePage };
}

describe("BrowserTabController piecewise tree reads (VC-1082)", () => {
  it("reads a page at the size bound in one answer, and past it a piece at a time", async () => {
    const { page } = await readBoth(bigTree(3), (controller) => controller.snapshot());
    const methods = page.sent.map((call) => call.method);
    expect(methods).not.toContain("Accessibility.getFullAXTree");
    expect(methods).toContain("Accessibility.getRootAXNode");
    expect(methods).toContain("Accessibility.getChildAXNodes");
  });

  it("prints a normal page past the size bound exactly as the one-answer read does", async () => {
    const { full, pieces } = await readBoth(bigTree(40), async (controller) => [
      await controller.snapshot(),
      await controller.find("go 3"),
      controller.treeDigest !== null,
    ]);
    expect(pieces).toEqual(full);
    expect((full as [{ truncated: boolean }])[0].truncated).toBe(false);
  });

  it("cuts a huge page where the prints' own bounds cut it, whole print included, without reading the rest", async () => {
    const whole = bigTree(4_000, 140);
    const { full, pieces, page } = await readBoth(whole, async (controller) => [
      await controller.snapshot(),
      await controller.find("Go 3999"),
      await controller.find("Level 120"),
    ]);
    expect(pieces).toEqual(full);
    const [snapshot] = full as [{ truncated: boolean; whole?: { bounded: boolean } }];
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.whole?.bounded).toBe(true);
    // The walk stops at its node bound; the far end of the page is never asked for.
    const asked = new Set(
      page.sent
        .filter((call) => call.method === "Accessibility.getChildAXNodes")
        .map((call) => (call.params as { id: string }).id),
    );
    expect(asked.size).toBeLessThan(whole.nodes.length / 3);
  });

  it("reports a read whose node vanished between rounds as cut, and still prints the rest", async () => {
    const whole = bigTree(5);
    const section = whole.nodes.find((node) => node.name?.value === "S2")!;
    const page = piecewiseWire(whole, 9_000, (nodeId) => nodeId === section.nodeId);
    const controller = new BrowserTabController(page.transport);

    const snapshot = await controller.snapshot();
    const found = await controller.find("Go 4");

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.text).toContain('button "Go 4"');
    expect(snapshot.text).not.toContain('button "Go 2"');
    expect(found).toMatchObject({ matches: 1, truncated: true });
  });

  it("keeps the one-answer read when the renderer cannot count its nodes", async () => {
    const page = wire({ "Accessibility.getFullAXTree": BUTTON_TREE });
    const controller = new BrowserTabController({
      send: async (method, params) => {
        if (method === "Memory.getDOMCounters")
          throw new Error("'Memory.getDOMCounters' wasn't found");
        return page.transport.send(method, params);
      },
    });
    expect((await controller.snapshot()).text).toContain('button "Save"');
    expect(page.sent.map((call) => call.method)).toContain("Accessibility.getFullAXTree");
  });

  it("fails a piecewise read with no root rather than calling the page empty", async () => {
    const page = wire({ "Memory.getDOMCounters": { nodes: 9_000 } });
    const controller = new BrowserTabController(page.transport);
    await expect(controller.snapshot()).rejects.toThrow("without an accessibility tree");
  });

  it("stops a piecewise read the moment its turn is withdrawn", async () => {
    const whole = bigTree(50);
    const page = piecewiseWire(whole, 9_000);
    const withdraw = new AbortController();
    const controller = new BrowserTabController({
      send: async (method, params) => {
        if (method === "Accessibility.getChildAXNodes") withdraw.abort(new Error("withdrawn"));
        return page.transport.send(method, params);
      },
    });
    await expect(controller.snapshot(withdraw.signal)).rejects.toThrow("withdrawn");
  });
});
