// Loads a PREVIOUS build's host sources in a plain `node` child (VC-633): the
// N-1 compatibility job's resolve hooks, the whole-tree form of VC-642/643's
// pinned-source technique (`src/web/test-support/n1-hooks.mjs`).
//
// That technique swaps in main's exact copy of each file a ticket changed,
// pinned by git blob id. This one pins N-1 by COMMIT: `prepare.mjs` extracts
// the whole tree at a release tag (or the PR's base) with `git archive` and
// installs that tree's own lockfile, so every file the child loads, and every
// dependency those files import, is the one that shipped. Nothing is copied
// into this repository and nothing from this checkout's sources can leak in:
// the driver (`child.mjs`) imports N-1 only through `n1:` specifiers, which
// resolve as if imported from N-1's own host source directory, and N-1's
// files then resolve their own imports beside themselves.
//
//   n1:./db/index           → <tree>/<hostSrc>/db/index.ts
//   n1:@volli/session-engine → N-1's own workspace package
//
// `VOLLI_N1_TREE` is the extracted tree; `VOLLI_N1_HOST_SRC` is its host
// source directory relative to the tree (`packages/host-core/src` since the
// host-core extraction, `apps/desktop/src/main` before it). Node strips the
// types itself; extensionless relative imports resolve to `.ts` or `/index.ts`
// as the bundler resolves them (the same rule as `ts-hooks.mjs`).
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const tree = process.env.VOLLI_N1_TREE;
const hostSrc = process.env.VOLLI_N1_HOST_SRC;
if (!tree || !hostSrc) throw new Error("VOLLI_N1_TREE and VOLLI_N1_HOST_SRC must be set");
// A file that need not exist: only its directory is used to resolve against.
const N1_PARENT = pathToFileURL(join(tree, hostSrc, "__n1__.ts")).href;
const PREFIX = "n1:";

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
    if (specifier.startsWith(PREFIX)) {
      return resolveTs(
        specifier.slice(PREFIX.length),
        { ...context, parentURL: N1_PARENT },
        nextResolve,
      );
    }
    return resolveTs(specifier, context, nextResolve);
  },
});
