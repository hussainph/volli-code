#!/usr/bin/env node
/**
 * Exercises the real renderer tRPC link without Electron so its own dispatch,
 * consumer, and pre-ack buffering cost can be separated from IPC clone cost.
 *
 * Two live arms are required: the observer-free arm is the published link
 * throughput, while the observer-enabled arm quantifies the optional JSON byte
 * accounting and timing tap. They run against fresh bridges with the same
 * subscription and frame counts.
 *
 *   node apps/desktop/e2e/session-rpc-link-bench.mjs [--frames 20000]
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import benchmarkHelpers from "./bench/session-rpc/helpers.cjs";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "..", "..", "..");
const frameCount = benchmarkHelpers.parsePositiveInteger("frames", 20_000);

async function runPushArm({ observe, frames }) {
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
  const observer = observe
    ? {
        record(sample) {
          if (sample.kind !== "push") return;
          observedPushFrames += 1;
          totalHandlerMs += sample.durationMs;
          maxHandlerMs = Math.max(maxHandlerMs, sample.durationMs);
          maxPreAckBacklog = Math.max(maxPreAckBacklog, sample.bufferedFrames);
          if (sample.disposition === "delivered") delivered += 1;
          if (sample.disposition === "buffered-before-ack") buffered += 1;
        },
      }
    : undefined;

  const { createSessionRpcClient } = await vite.ssrLoadModule(
    "/apps/desktop/src/renderer/src/lib/session-rpc-ipc-link.ts",
  );
  const client = createSessionRpcClient(bridge, observer);
  let consumed = 0;
  const handles = Array.from({ length: 4 }, (_value, index) =>
    client.session.subscribe.subscribe(
      { sessionId: `session-${index}` },
      { onData: () => (consumed += 1) },
    ),
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 0));

  const preAckFrames = 400;
  for (let sequence = 0; sequence < preAckFrames; sequence += 1) {
    bridge.emit({
      kind: "data",
      subscriptionId: `subscription-${sequence % 4}`,
      eventId: String(sequence),
      data: { sequence },
    });
  }
  if (!observe) {
    buffered = preAckFrames;
    maxPreAckBacklog = preAckFrames;
  }
  for (let index = 0; index < 4; index += 1) {
    const request = pending.shift();
    if (!request) throw new Error("Expected one pending subscription request per arm");
    request.resolve({ ok: true, subscriptionId: `subscription-${index}` });
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 0));

  const startedAt = performance.now();
  for (let sequence = 0; sequence < frames; sequence += 1) {
    bridge.emit({
      kind: "data",
      subscriptionId: `subscription-${sequence % 4}`,
      eventId: String(sequence + preAckFrames),
      data: { sequence },
    });
  }
  const elapsedMs = performance.now() - startedAt;
  for (const handle of handles) handle.unsubscribe();

  return {
    observerEnabled: observe,
    subscriptions: 4,
    preAckFrames,
    liveFrames: frames,
    observedPushFrames: observe ? observedPushFrames : null,
    consumed,
    delivered: observe ? delivered + buffered : preAckFrames + frames,
    buffered,
    maxPreAckBacklog,
    elapsedMs,
    framesPerSecond: frames / (elapsedMs / 1_000),
    handlerMs: observe
      ? {
          mean: totalHandlerMs / observedPushFrames,
          max: maxHandlerMs,
        }
      : null,
  };
}

const vite = await createServer({
  root: repository,
  appType: "custom",
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
  logLevel: "error",
});
try {
  const observerFree = await runPushArm({ observe: false, frames: frameCount });
  const observerEnabled = await runPushArm({ observe: true, frames: frameCount });
  const report = {
    schemaVersion: 1,
    observerFree,
    observerEnabled,
  };
  console.log(`__SESSION_RPC_LINK_BENCH__${JSON.stringify(report)}__SESSION_RPC_LINK_BENCH__`);
} finally {
  await vite.close();
}
