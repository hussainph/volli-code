#!/usr/bin/env node
/**
 * Measures the router-generic IPC bridge's main-side dispatch (VC-608)
 * without Electron, so its own cost can be read apart from IPC clone cost.
 *
 * Two arms over the same Session router, context and handler map:
 *
 * - `direct`: the shape the bridge had before VC-608, one `createCaller` per
 *   request and a statically named procedure (`caller.session.projection`);
 * - `bridge`: `createIpcServer`'s request path, which validates the envelope,
 *   looks the path up in the routers' metadata and walks the same caller.
 *
 * Plus a push arm: tracked subscription frames pumped to a peer.
 *
 *   node apps/desktop/e2e/session-rpc-bridge-bench.mjs [--calls 20000] [--frames 20000]
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import benchmarkHelpers from "./bench/session-rpc/helpers.cjs";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "..", "..", "..");
const callCount = benchmarkHelpers.parsePositiveInteger("calls", 20_000);
const frameCount = benchmarkHelpers.parsePositiveInteger("frames", 20_000);

const vite = await createServer({
  root: repository,
  appType: "custom",
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true },
  logLevel: "error",
});

try {
  const { createIpcServer } = await vite.ssrLoadModule("/packages/host-protocol/src/ipc/server.ts");
  const rpc = await vite.ssrLoadModule("/packages/session-rpc/src/index.ts");
  const { sessionHandlersFrom } = await vite.ssrLoadModule("/packages/session-rpc/src/testing.ts");

  let emit = () => undefined;
  const runtime = {
    projection: async () => ({ projection: {}, throughSequence: 4 }),
    snapshot: async () => ({ projection: {}, throughSequence: 4, frames: [], transcript: [] }),
    command: async () => ({ sessionId: "s", receipt: null, throughSequence: 4, refusal: null }),
    subscribe: async (_input, next) => {
      emit = next;
      return () => undefined;
    },
    cancelInteraction: async () => undefined,
    reconcile: async () => undefined,
    close: async () => undefined,
  };
  const diagnostics = new rpc.RpcDiagnosticLog({ capacity: 16 });
  const context = () => ({
    caller: rpc.LOCAL_DESKTOP_CALLER,
    handlers: sessionHandlersFrom({ runtime }),
    diagnostics,
    transport: "electron-ipc",
  });
  const router = rpc.createSessionRouter();
  const server = createIpcServer({
    routers: [router],
    served: rpc.DESKTOP_IPC_PATHS,
    createContext: context,
  });
  const input = { sessionId: "session-1" };

  async function timeCalls(call) {
    for (let index = 0; index < 500; index += 1) await call();
    const startedAt = performance.now();
    for (let index = 0; index < callCount; index += 1) await call();
    const elapsedMs = performance.now() - startedAt;
    return { calls: callCount, elapsedMs, microsecondsPerCall: (elapsedMs * 1_000) / callCount };
  }

  const peer = (onFrame) => ({
    id: 1,
    isDestroyed: () => false,
    send: onFrame,
    onDestroyed: () => () => undefined,
  });
  const callPeer = peer(() => undefined);
  const request = { path: "session.projection", type: "query", input };

  const direct = await timeCalls(() => router.createCaller(context()).session.projection(input));
  const bridge = await timeCalls(() => server.request(callPeer, request));

  let received = 0;
  let done;
  const all = new Promise((resolveAll) => (done = resolveAll));
  const pushPeer = peer((event) => {
    // A terminal frame ends the arm too: an overflow must fail it, never hang it.
    if (event.kind !== "data") done(event);
    else if (++received === frameCount) done(null);
  });
  await server.request(pushPeer, {
    path: "session.subscribe",
    type: "subscription",
    input: { sessionId: "session-1", afterSequence: 0 },
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 0));
  const frame = (sequence) => ({
    sessionId: "session-1",
    sequence,
    transcript: null,
    event: {
      id: `event-${sequence}`,
      sessionId: "session-1",
      sequence,
      occurredAt: 1,
      recordedAt: 1,
      provenance: { source: { kind: "system", id: "bench", detail: null }, venue: null },
      payload: {
        kind: "session.created",
        session: {
          id: "session-1",
          projectId: "project-1",
          ticketId: null,
          role: "project",
          parentSessionId: null,
          title: null,
          createdAt: 1,
        },
      },
    },
  });
  const pushStartedAt = performance.now();
  // In chunks well under the stream's 4,096-frame queue, letting the pump
  // drain between them: one synchronous burst would end the stream with
  // `subscription-overflow`, which is the router's bound, not the bridge's cost.
  for (let sequence = 1; sequence <= frameCount; sequence += 1) {
    emit(frame(sequence));
    if (sequence % 1_000 === 0) await new Promise((resolveWait) => setImmediate(resolveWait));
  }
  let timer;
  const terminal = await Promise.race([
    all,
    new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout({ kind: "timeout" }), 30_000);
    }),
  ]);
  clearTimeout(timer);
  if (terminal !== null) {
    throw new Error(`Push arm ended early after ${received} frames: ${JSON.stringify(terminal)}`);
  }
  const pushElapsedMs = performance.now() - pushStartedAt;
  await server.close();

  const report = {
    schemaVersion: 1,
    direct,
    bridge,
    overheadMicrosecondsPerCall: bridge.microsecondsPerCall - direct.microsecondsPerCall,
    push: {
      frames: frameCount,
      elapsedMs: pushElapsedMs,
      framesPerSecond: frameCount / (pushElapsedMs / 1_000),
    },
  };
  console.log(`__SESSION_RPC_BRIDGE_BENCH__${JSON.stringify(report)}__SESSION_RPC_BRIDGE_BENCH__`);
} finally {
  await vite.close();
}
// Nothing this bench opened may keep the process alive.
process.exit(0);
