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
 *
 * CONTRACT: {@link describeDbOpenFailure} returns a COMPLETE, standalone
 * sentence that names what happened. Its result is what every degraded IPC
 * surface answers with verbatim, so it cannot be a fragment that only reads
 * correctly after some caller's prefix — that split is what made four call
 * sites glue "The local database failed to open:" onto a paragraph already
 * saying so. The framing therefore lives HERE, in the one module that knows
 * how to phrase this failure, and callers add only their own surface's name.
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
 * How this failure is named to a reader who gets the raw message with it. Every
 * caller used to spell some variant of this itself; it lives here so the
 * sentence is written once and cannot be doubled onto a message that already
 * contains it.
 */
const DB_OPEN_FRAME = "The local database failed to open";

/**
 * What a person who did not build this app can actually do about it: the one
 * failure named in plain words, then the two recoveries available to them and
 * nothing else. No ABI number, no module path, no package manager — none of it
 * is actionable without a checkout, and printing it only asks a user to debug
 * a build they never ran.
 *
 * Carries its own framing (it replaces {@link DB_OPEN_FRAME} rather than
 * following it) because "database" is not the user's word for what broke.
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
 * The raw message with the dev-loop remedy appended when the failure class
 * earns one. The single definition of "what a developer is told", shared by the
 * dev build's surfaces and {@link dbOpenFailureLogLine} so the two cannot drift.
 */
function developerDetail(message: string): string {
  return isNativeModuleFailure(message) ? `${message} — ${DEV_NATIVE_MODULE_REMEDY}` : message;
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
 *
 * Always a complete sentence — see the CONTRACT note at the top of this module.
 */
export function describeDbOpenFailure(
  error: unknown,
  audience: DbOpenFailureAudience = { dev: false },
): string {
  const message = errorMessage(error);
  // The only arm whose reader cannot act on the raw text, so it is the only one
  // that replaces it. Everything else — a dev build, and any I/O failure, whose
  // message ('disk full', 'permission denied') speaks for itself — keeps the
  // message and gets the frame that says which subsystem it came from.
  if (!audience.dev && isNativeModuleFailure(message)) return USER_NATIVE_MODULE_REMEDY;
  return `${DB_OPEN_FRAME}: ${developerDetail(message)}`;
}

/**
 * The same failure for the log, where the audience is always a developer —
 * packaged or not, whoever reads this line has a terminal open. Carries the raw
 * message and, for the native-module class, the dev-loop remedy, so a user's
 * report of the plain-language message can still be diagnosed from the log they
 * attach.
 *
 * Unframed: the one call site's `console.error` prefix already says a database
 * open failed, and repeating it in the payload is the doubling this module's
 * CONTRACT exists to prevent.
 */
export function dbOpenFailureLogLine(error: unknown): string {
  return developerDetail(errorMessage(error));
}
