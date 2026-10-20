import { createServer } from "vite-plus";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
// Run from the repository root after preparing the independent source archive (README.md).
const root = resolve(".tmp/vc729-base");
const require = createRequire(resolve("packages/session-rpc/package.json"));
const { WebSocket } = require("ws");
const alias = [];
for (const name of ["shared", "session-engine", "host-protocol", "session-rpc"]) {
  const pkg = JSON.parse(readFileSync(resolve(root, `packages/${name}/package.json`)));
  for (const [sub, value] of Object.entries(pkg.exports)) {
    const path = typeof value === "string" ? value : value.import;
    alias.push({
      find: `@volli/${name}${sub === "." ? "" : sub.slice(1)}`,
      replacement: resolve(root, `packages/${name}`, path),
    });
  }
}
alias.sort((a, b) => b.find.length - a.find.length);
const vite = await createServer({
  root,
  configFile: false,
  resolve: { alias },
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, watch: null },
  appType: "custom",
});
let listener;
try {
  const { createHostRouter, RpcDiagnosticLog } = await vite.ssrLoadModule(
    "/packages/session-rpc/src/index.ts",
  );
  const { startHostProtocolListener } = await vite.ssrLoadModule(
    "/packages/session-rpc/src/websocket-server.ts",
  );
  const { buildHostHello, encodeHostHello } = await vite.ssrLoadModule(
    "/packages/host-protocol/src/index.ts",
  );
  const { HOST_FEATURE_OPERATIONS } = await vite.ssrLoadModule(
    "/packages/host-protocol/src/features.ts",
  );
  if ("host.model-defaults" in HOST_FEATURE_OPERATIONS)
    throw new Error("Not an independent pre-change peer");
  const host = { id: "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b", version: "pre-vc729-main" };
  const actor = { kind: "device", deviceId: "8a9b0c1d-2e3f-4a5b-9c6d-7e8f9a0b1c2d", scope: "host" };
  listener = await startHostProtocolListener({
    router: createHostRouter(),
    bind: { host: "127.0.0.1", port: 0 },
    host,
    features: ["host.workspaces"],
    hostFeatures: ["host.workspaces"],
    workspace: () => null,
    verifier: { verify: () => ({ actor, current: () => true }) },
    context: () => ({ handlers: {}, diagnostics: new RpcDiagnosticLog() }),
  });
  const socket = new WebSocket(`${listener.url}?connectionParams=1`);
  await once(socket, "open");
  const sent = [],
    received = [];
  socket.on("message", (data) => received.push(JSON.parse(data.toString())));
  async function send(frame, answer = false) {
    const response = answer ? once(socket, "message") : null;
    sent.push(frame);
    socket.send(JSON.stringify(frame));
    if (response) await response;
  }
  const hello = buildHostHello({
    scope: "host",
    client: { kind: "desktop", version: "pre-vc729-main" },
    features: ["host.workspaces", "host.model-defaults"],
    credential: "fixture-not-a-secret",
  });
  await send({ method: "connectionParams", data: encodeHostHello(hello) });
  await send({ id: 1, method: "query", params: { path: "protocol.hostWelcome" } }, true);
  await send({ id: 2, method: "query", params: { path: "hostModels.defaults" } }, true);
  socket.close();
  await once(socket, "close");
  writeFileSync(
    "packages/host-protocol/fixtures/pre-vc729-host-models.json",
    JSON.stringify(
      {
        sourceRevision: execFileSync(
          "git",
          ["rev-parse", "49fc56278edba86607999b7c1d366e87ac02a800"],
          { encoding: "utf8" },
        ).trim(),
        api: "Independent git archive origin/main; production startHostProtocolListener + raw ws; test-only verifier; captured before hostModels exists",
        sent,
        received,
      },
      null,
      2,
    ) + "\n",
  );
  console.log("Recorded independent old-host welcome and missing-operation answer");
} finally {
  await listener?.close();
  await vite.close();
}
