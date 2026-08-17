/**
 * Names the environment when the database refuses to open (VC-76).
 *
 * A failed `openVolliDb` disables the whole agent surface — session runtime,
 * model access, sign-in — and every degraded IPC handler answers with the
 * reason recorded at open time. When that reason is a native-module ABI
 * mismatch (better-sqlite3 built for the wrong Node), the raw message is
 * `NODE_MODULE_VERSION 127 ... requires NODE_MODULE_VERSION 137` — accurate
 * and useless to the person staring at a greyed-out Sign in button. This
 * module translates that class of failure into the actual problem (a Node
 * version incompatibility) and the actual fix (a supported Node and a
 * reinstall), while leaving every other failure — disk permissions, a
 * corrupt file — to speak for itself.
 */

import { errorMessage } from "@volli/shared";

/**
 * The supported Node range, as printed in diagnostics. Kept in sync with the
 * root package.json `engines.node` by an assertion in db-open-failure.test.ts
 * — main cannot read the root manifest at runtime (it is not packaged), so
 * the test is what keeps this string from drifting into a lie.
 */
export const REQUIRED_NODE_RANGE = "^24.13.0";

/**
 * The signatures a wrong-ABI or missing native build leaves in its error.
 * Matched as substrings against the message: the first two are Node's own
 * wording for a version-mismatched addon, the rest are how a build that never
 * happened (an install under a Node that could not compile it) surfaces.
 */
const NATIVE_MODULE_SIGNATURES = [
  "NODE_MODULE_VERSION",
  "was compiled against a different Node.js version",
  "ERR_DLOPEN_FAILED",
  "Could not locate the bindings file",
  "better_sqlite3.node",
] as const;

/** Whether this message is the native-module class rather than an I/O one. */
export function isNativeModuleFailure(message: string): boolean {
  return NATIVE_MODULE_SIGNATURES.some((signature) => message.includes(signature));
}

/**
 * The message a failed database open is recorded — and answered — with.
 * Native-module failures get the incompatibility named and the remedy
 * appended; everything else passes through untouched, because inventing a
 * Node story for a permissions error would be exactly the misdirection this
 * exists to end.
 */
export function describeDbOpenFailure(error: unknown): string {
  const message = errorMessage(error);
  if (!isNativeModuleFailure(message)) return message;
  return (
    `${message} — better-sqlite3 (the app's database engine) is missing or ` +
    `built for a different Node ABI. This is a Node version incompatibility: ` +
    `Volli requires Node ${REQUIRED_NODE_RANGE}. Switch to a supported Node ` +
    `(\`nvm use\` reads the repo's .nvmrc), re-run \`pnpm install\` to rebuild ` +
    `native modules, and relaunch.`
  );
}
