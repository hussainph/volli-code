// The release before VC-643 (N-1), as a plain `node` child process: host-core
// sources load as they do in `ts-hooks.mjs`, except that a file pinned under
// `n1/` (main's exact copy at the base commit, checked by git blob id in
// `n1-compatibility.test.ts`) replaces the current one at that path. A pinned
// file resolves its own imports as if it sat at its real path, so it imports
// the same modules main's copy did. Every other host-core file the child
// loads is recorded in `globalThis.volliN1Loaded`, for the test to check against
// the set this ticket changed. Test support only.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const SRC = new URL("../../", import.meta.url).href;
const N1 = new URL("./n1/", import.meta.url).href;
const loaded = new Set();
globalThis.volliN1Loaded = loaded;

function resolveTs(specifier, context, nextResolve) {
  try {
    return nextResolve(specifier, context);
  } catch (error) {
    if (!specifier.startsWith(".")) throw error;
    for (const suffix of [".ts", "/index.ts"]) {
      const url = new URL(specifier + suffix, context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
    throw error;
  }
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parentURL =
      context.parentURL?.startsWith(N1) === true
        ? SRC + context.parentURL.slice(N1.length)
        : context.parentURL;
    const resolved = resolveTs(specifier, { ...context, parentURL }, nextResolve);
    if (!resolved.url.startsWith(SRC) || resolved.url.startsWith(N1)) return resolved;
    const relative = resolved.url.slice(SRC.length);
    const pinned = N1 + relative;
    if (existsSync(fileURLToPath(pinned))) return { url: pinned, shortCircuit: true };
    loaded.add(relative);
    return resolved;
  },
});
