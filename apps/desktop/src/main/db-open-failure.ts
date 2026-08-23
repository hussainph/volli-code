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
 * version incompatibility) and the actual fix, while leaving every other
 * failure — disk permissions, a corrupt file — to speak for itself.
 *
 * The fix is where the two audiences part (VC-160). `nvm use` reads a `.nvmrc`
 * this app has only inside its own repository, and `pnpm install` rebuilds
 * native modules only where sources and a toolchain exist: that remedy is a
 * dev-loop instruction, and it was being shown to whoever hit the failure —
 * including a packaged-app user with no repo, no nvm and no pnpm, for whom it
 * is unfollowable advice about somebody else's machine. So the remedy is split
 * by audience rather than dropped: {@link describeDbOpenFailure} answers the
 * person in front of the app, and the dev loop keeps its own copy in the dev
 * build and in {@link dbOpenFailureLogLine}, which is where a developer looks.
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
 * What a person who did not build this app can actually do about it: the one
 * failure named in plain words, then the two recoveries available to them and
 * nothing else. No ABI number, no module path, no package manager — none of it
 * is actionable without a checkout, and printing it only asks a user to debug
 * a build they never ran.
 */
const USER_NATIVE_MODULE_REMEDY =
  "Volli's database engine did not load, so your boards, tickets and sessions " +
  "are unavailable. Quit and reopen Volli. If it fails again, reinstall the " +
  "app — and if that does not help, report this.";

/**
 * The dev-loop remedy, unchanged from when it was the only one (VC-76). It
 * survives in two places a developer actually looks: a dev build's own surfaces
 * and {@link dbOpenFailureLogLine}.
 */
const DEV_NATIVE_MODULE_REMEDY =
  `better-sqlite3 (the app's database engine) is missing or built for a ` +
  `different Node ABI. This is a Node version incompatibility: Volli requires ` +
  `Node ${REQUIRED_NODE_RANGE}. Switch to a supported Node (\`nvm use\` reads ` +
  `the repo's .nvmrc), re-run \`pnpm install\` to rebuild native modules, and ` +
  `relaunch.`;

/** Who the message is for. `dev` is `!app.isPackaged` at the one call site. */
export interface DbOpenFailureAudience {
  /** A development build, where the repo, nvm and pnpm all exist. */
  dev: boolean;
}

/**
 * The message a failed database open is recorded — and answered — with.
 *
 * Native-module failures get the incompatibility named and a remedy its reader
 * can carry out; everything else passes through untouched, because inventing a
 * Node story for a permissions error would be exactly the misdirection this
 * exists to end.
 *
 * The audience defaults to the USER. A caller that forgets to say where it is
 * running gets the copy that is true everywhere, rather than shipping a
 * dev-loop instruction to somebody who has no repository to run it in.
 */
export function describeDbOpenFailure(
  error: unknown,
  audience: DbOpenFailureAudience = { dev: false },
): string {
  const message = errorMessage(error);
  if (!isNativeModuleFailure(message)) return message;
  // A dev build keeps the raw message in front of the remedy: the ABI numbers
  // are the fastest way to see which Node built the addon.
  return audience.dev ? `${message} — ${DEV_NATIVE_MODULE_REMEDY}` : USER_NATIVE_MODULE_REMEDY;
}

/**
 * The same failure for the log, where the audience is always a developer —
 * packaged or not, whoever reads this line has a terminal open. Carries the raw
 * message and, for the native-module class, the dev-loop remedy, so a user's
 * report of the plain-language message can still be diagnosed from the log they
 * attach.
 */
export function dbOpenFailureLogLine(error: unknown): string {
  const message = errorMessage(error);
  return isNativeModuleFailure(message) ? `${message} — ${DEV_NATIVE_MODULE_REMEDY}` : message;
}
