#!/usr/bin/env node
/**
 * Exercises the real renderer tRPC link without Electron so its own dispatch,
 * consumer, and pre-ack buffering cost can be separated from IPC clone cost.
 *
 *   node apps/desktop/e2e/session-rpc-link-bench.mjs [--frames 20000]
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "..", "..", "..");
const frameArgument = process.argv.indexOf("--frames");
const frameCount = frameArgument === -1 ? 20_000 : Number(process.argv[frameArgument + 1]);
if (!Number.isSafeInteger(frameCount) || frameCount < 1)
  throw new Error("--frames must be positive");

const vite = await createServer({
  root: repository,
  appType: "custom",
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
  logLevel: "error",
});
try {
  const { createSessionRpcClient } = await vite.ssrLoadModule(
    "/apps/desktop/src/renderer/src/lib/session-rpc-ipc-link.ts",
  );
  const listeners = new Set();
  const pending = [];
  const bridge = {
    request: (request) =>
      new Promise((resolveRequest, rejectRequest) => {
        pending.push({ request, resolve: resolveRequest, reject: rejectRequest });
      }),
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cancel: () => undefined,
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
  };
  let observedPushFrames = 0;
  let delivered = 0;
  let buffered = 0;
  let maxPreAckBacklog = 0;
  let totalHandlerMs = 0;
  let maxHandlerMs = 0;
  const client = createSessionRpcClient(bridge, {
    record(sample) {
      if (sample.kind !== "push") return;
      observedPushFrames += 1;
      totalHandlerMs += sample.durationMs;
      maxHandlerMs = Math.max(maxHandlerMs, sample.durationMs);
      maxPreAckBacklog = Math.max(maxPreAckBacklog, sample.bufferedFrames);
      if (sample.disposition === "delivered") delivered += 1;
      if (sample.disposition === "buffered-before-ack") buffered += 1;
    },
  });

  let consumed = 0;
  const handles = Array.from({ length: 4 }, (_value, index) =>
    client.session.subscribe.subscribe(
      { sessionId: `session-${index}` },
      { onData: () => (consumed += 1) },
    ),
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 0));
  for (let sequence = 0; sequence < 400; sequence += 1) {
    bridge.emit({
      kind: "data",
      subscriptionId: `subscription-${sequence % 4}`,
      eventId: String(sequence),
      data: { sequence },
    });
  }
  for (let index = 0; index < 4; index += 1) {
    pending.shift().resolve({ ok: true, subscriptionId: `subscription-${index}` });
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 0));

  const startedAt = performance.now();
  for (let sequence = 0; sequence < frameCount; sequence += 1) {
    bridge.emit({
      kind: "data",
      subscriptionId: `subscription-${sequence % 4}`,
      eventId: String(sequence + 400),
      data: { sequence },
    });
  }
  const elapsedMs = performance.now() - startedAt;
  for (const handle of handles) handle.unsubscribe();

  const report = {
    subscriptions: 4,
    preAckFrames: 400,
    liveFrames: frameCount,
    observedPushFrames,
    consumed,
    delivered,
    buffered,
    maxPreAckBacklog,
    elapsedMs,
    framesPerSecond: frameCount / (elapsedMs / 1_000),
    handlerMs: {
      mean: totalHandlerMs / observedPushFrames,
      max: maxHandlerMs,
    },
  };
  console.log(`__SESSION_RPC_LINK_BENCH__${JSON.stringify(report)}__SESSION_RPC_LINK_BENCH__`);
} finally {
  await vite.close();
}
