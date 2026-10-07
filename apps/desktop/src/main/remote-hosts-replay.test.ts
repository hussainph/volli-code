/**
 * The #815 review's B4 probe, ported: a late subscriber to a flow whose log
 * is full reads it through the real desktop router, twice in a row, never
 * overflowing the 256-event stream. The engine is the real one over the
 * package's fakes (no SSH, no keychain).
 */
import { flush, harness, watch } from "@volli/host-install/testing";
import { createDesktopRouter, LOCAL_DESKTOP_CALLER, RpcDiagnosticLog } from "@volli/session-rpc";
import type { AddHostEvent } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { remoteHostsPort } from "./remote-hosts";

describe("a late subscriber to a long add flow", () => {
  it("reads one bounded replay through the desktop router, and again on resubscribe", async () => {
    const h = harness({ tunnelMode: "hold" });
    const { flowId } = await h.engine.startAdd({ target: "deploy@fake" });
    await watch(h.engine, flowId).until((view) => view.steps[6]?.status === "running");
    await flush();
    // Far past both the flow's log cap (500) and the stream's capacity (256).
    for (let index = 0; index < 600; index += 1) {
      h.tunnels.made[0]!.options.logger.debug(`line ${index}`);
    }
    const port = remoteHostsPort(h.engine);
    const caller = createDesktopRouter().createCaller({
      caller: LOCAL_DESKTOP_CALLER,
      transport: "electron-ipc",
      diagnostics: new RpcDiagnosticLog(),
      resourceWorkspace: () => null,
      handlers: {
        "hostAdd.subscribe": async (
          input: { flowId: string },
          _call: unknown,
          sink: { emit(event: AddHostEvent): unknown },
        ) => port.subscribeAdd(input.flowId, (event) => void sink.emit(event)),
      } as never,
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const stream = await caller.hostAdd.subscribe({ flowId });
      const iterator = stream[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.done).toBe(false);
      const event = first.value as AddHostEvent;
      if (event.kind !== "replay") throw new Error(`expected a replay, got ${event.kind}`);
      expect(event.view.flowId).toBe(flowId);
      expect(event.log.at(-1)?.message).toBe(attempt === 0 ? "line 599" : "after 0");
      expect(event.omitted + event.log.length).toBeGreaterThan(600);
      expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(80 * 1024);
      // Still live: the next line arrives as its own event.
      h.tunnels.made[0]!.options.logger.debug(`after ${attempt}`);
      const next = await iterator.next();
      expect(next.value).toMatchObject({ kind: "log", line: { message: `after ${attempt}` } });
      await iterator.return?.();
    }
    await h.engine.cancelAdd(flowId);
    await h.engine.close();
  });
});
