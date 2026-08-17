/**
 * Refuses to start dev tooling under a Node the repo does not support.
 *
 *     node apps/desktop/scripts/check-node-version.mjs             # the gate
 *     node apps/desktop/scripts/check-node-version.mjs --self-test # the matcher's own tests
 *
 * WHY THIS EXISTS (VC-76). The supported Node range lives in the root
 * package.json `engines` field, README, CONTRIBUTING, and CI — but none of
 * those stops a local `pnpm dev` under the wrong Node. What the wrong Node
 * produces is not a version error: native modules (better-sqlite3, node-pty)
 * end up built for the wrong ABI, the desktop app fails to open its database,
 * the agent runtime never comes up, and the first visible symptom is a Sign in
 * button that does nothing. Adrian's onboarding hit exactly that. A machine
 * with several Nodes installed (Homebrew's current beside an old
 * /usr/local/bin/node) makes it a matter of PATH order, so the failure must be
 * named at the door, under the exact `node` that will run the tooling.
 *
 * `dev.mjs` and `start-electron.mjs` import {@link assertSupportedNode} as
 * their first act. The self-test keeps the tiny range matcher honest in CI: a
 * future `engines` shape this parser cannot read fails there, naming this
 * file, instead of silently letting every version pass.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

/**
 * Whether `version` satisfies a caret range (`^major.minor.patch`) — the one
 * shape the root `engines.node` uses. Caret semantics: nothing left of the
 * left-most non-zero digit may change, everything at or right of it may grow.
 * Any other range shape throws, so drift in `engines` breaks the CI self-test
 * loudly instead of turning this gate into a yes-machine.
 */
export function satisfiesCaretRange(version, range) {
  const rangeMatch = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  if (rangeMatch === null) {
    throw new Error(
      `check-node-version.mjs only understands caret ranges ("^x.y.z"); ` +
        `engines.node is "${range}" — update the matcher alongside the pin.`,
    );
  }
  const versionMatch = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (versionMatch === null) return false;
  const [minMajor, minMinor, minPatch] = rangeMatch.slice(1).map(Number);
  const [major, minor, patch] = versionMatch.slice(1).map(Number);
  if (major !== minMajor) return false;
  if (minMajor > 0) {
    return minor > minMinor || (minor === minMinor && patch >= minPatch);
  }
  // ^0.y.z pins the minor too (left-most non-zero digit).
  if (minor !== minMinor) return false;
  return patch >= minPatch;
}

/** The root manifest's `engines.node` — the one source the pin is read from. */
export function requiredNodeRange() {
  const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"));
  const range = manifest.engines?.node;
  if (typeof range !== "string" || range.length === 0) {
    throw new Error("root package.json has no engines.node — the Node pin is gone.");
  }
  return range;
}

/**
 * The gate. Exits the process with a loud, named diagnostic when the running
 * Node is outside the supported range — the actual problem (wrong-ABI native
 * modules, dead database, disabled sign-in) and the actual fix, not a bare
 * version number.
 */
export function assertSupportedNode() {
  const range = requiredNodeRange();
  const running = process.versions.node;
  if (satisfiesCaretRange(running, range)) return;
  console.error(
    [
      `[volli] Unsupported Node for dev: v${running} (required: ${range}).`,
      ``,
      `  This Node is ${process.execPath}`,
      ``,
      `Native modules (better-sqlite3, node-pty) are built against the pinned`,
      `Node's ABI. Under v${running} the desktop app cannot open its database,`,
      `the agent runtime never starts, and Sign in is disabled — a greyed-out`,
      `button, not an error. Refusing to start instead.`,
      ``,
      `Fix: switch to a supported Node (\`nvm use\` reads the repo's .nvmrc),`,
      `re-run \`pnpm install\` so native modules are rebuilt, then start again.`,
    ].join("\n"),
  );
  process.exit(1);
}

function selfTest() {
  const cases = [
    // Caret with non-zero major: same major, at-or-above minor.patch.
    ["24.13.0", "^24.13.0", true],
    ["v24.13.0", "^24.13.0", true],
    ["24.18.0", "^24.13.0", true],
    ["24.13.1", "^24.13.0", true],
    ["24.12.9", "^24.13.0", false],
    ["22.16.0", "^24.13.0", false],
    ["25.0.0", "^24.13.0", false],
    // Pre-release / build suffixes compare on the numeric triple.
    ["24.13.0-nightly", "^24.13.0", true],
    // ^0.y.z pins the minor.
    ["0.2.5", "^0.2.4", true],
    ["0.3.0", "^0.2.4", false],
    ["0.2.3", "^0.2.4", false],
    // Garbage versions never satisfy.
    ["not-a-version", "^24.13.0", false],
  ];
  for (const [version, range, expected] of cases) {
    const actual = satisfiesCaretRange(version, range);
    if (actual !== expected) {
      console.error(
        `check-node-version self-test failed: satisfiesCaretRange(${version}, ${range}) ` +
          `returned ${actual}, expected ${expected}`,
      );
      process.exit(1);
    }
  }
  // A range shape the matcher cannot read must throw, never silently pass.
  for (const badRange of [">=24", "24.x", "^24", "*"]) {
    let threw = false;
    try {
      satisfiesCaretRange("24.13.0", badRange);
    } catch {
      threw = true;
    }
    if (!threw) {
      console.error(`check-node-version self-test failed: range "${badRange}" did not throw`);
      process.exit(1);
    }
  }
  // The live pin itself must be a shape the matcher understands.
  satisfiesCaretRange(process.versions.node, requiredNodeRange());
  console.log("check-node-version self-test passed");
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  if (process.argv.includes("--self-test")) {
    selfTest();
  } else {
    assertSupportedNode();
    console.log(`[volli] Node v${process.versions.node} satisfies ${requiredNodeRange()}`);
  }
}
