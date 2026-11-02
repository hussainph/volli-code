// Runs the real extraction worker under plain Node in a test, the way a host's
// bundled entry does. The resolve hook lets extensionless relative imports find
// the `.ts` sources the way the bundler does, and Node strips the types itself.
// Test support only.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".")) throw error;
      const url = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      throw error;
    }
  },
});

const { serveWebExtractWorker } = await import("../extract-worker.ts");
serveWebExtractWorker();
