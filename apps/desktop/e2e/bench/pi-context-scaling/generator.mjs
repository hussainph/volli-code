/**
 * Load VC-445's TypeScript sidecar generator into plain Node.
 *
 * `packages/agent-runtime/bench/context-scaling/sidecar-history.ts` imports
 * the runtime's TypeScript source, so it goes through a middleware-mode Vite
 * server's `ssrLoadModule` — the same door `concurrency-budget-vc403.mjs`
 * uses — and the server is closed however `work` ends.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const GENERATOR = join(
  REPOSITORY,
  "packages",
  "agent-runtime",
  "bench",
  "context-scaling",
  "sidecar-history.ts",
);

export async function withGenerator(work) {
  const vite = await createServer({
    root: REPOSITORY,
    appType: "custom",
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
    logLevel: "error",
  });
  try {
    return await work(await vite.ssrLoadModule(GENERATOR));
  } finally {
    await vite.close();
  }
}
