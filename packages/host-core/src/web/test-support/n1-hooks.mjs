// The release before VC-643 (N-1), as a plain `node` child process: host-core
// sources load as they do in `ts-hooks.mjs`, except that a file pinned under
// `n1/` (main's exact copy at the base commit, as `<path>.pinned`, checked by
// git blob id in `n1-compatibility.test.ts`) replaces the current one at that
// path. A pinned file resolves its own imports as if it sat at its real path,
// so it imports the same modules main's copy did. The `.pinned` suffix keeps
// these copies out of the compiler, formatter and the host import checker,
// which would otherwise try to resolve their imports beside them. Every other host-core file the child
// loads is recorded in `globalThis.volliN1Loaded`, for the test to check against
// the set this ticket changed. Test support only.
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const SRC = new URL("../../", import.meta.url).href;
const N1 = new URL("./n1/", import.meta.url).href;
const PINNED = ".pinned";
const SELF = "@volli/host-core/";
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

/**
 * A pinned file is main's copy from before VC-632, when every host-core file
 * was a package subpath: `@volli/host-core/<path>` named `src/<path>.ts` (or
 * `src/<path>/index.ts`). The package exports only cluster entries now, so
 * the pin's own-name imports resolve to the file they named then.
 */
function resolvePinnedSelfImport(specifier) {
  const path = specifier.slice(SELF.length);
  for (const suffix of [".ts", "/index.ts"]) {
    const url = new URL(path + suffix, SRC);
    if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromPin = context.parentURL?.startsWith(N1) === true;
    const parentURL = fromPin
      ? SRC + context.parentURL.slice(N1.length, -PINNED.length)
      : context.parentURL;
    const resolved =
      (fromPin && specifier.startsWith(SELF) ? resolvePinnedSelfImport(specifier) : null) ??
      resolveTs(specifier, { ...context, parentURL }, nextResolve);
    if (!resolved.url.startsWith(SRC) || resolved.url.startsWith(N1)) return resolved;
    const relative = resolved.url.slice(SRC.length);
    const pinned = N1 + relative + PINNED;
    if (existsSync(fileURLToPath(pinned))) return { url: pinned, shortCircuit: true };
    loaded.add(relative);
    return resolved;
  },
  load(url, context, nextLoad) {
    if (!url.startsWith(N1) || !url.endsWith(PINNED)) return nextLoad(url, context);
    return {
      format: "module-typescript",
      source: readFileSync(fileURLToPath(url), "utf8"),
      shortCircuit: true,
    };
  },
});
