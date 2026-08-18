/**
 * What a Volli terminal must NOT inherit.
 *
 * A session shell is spawned from the Electron process's own environment, and
 * that environment is whatever launched the app. Launch Volli from a terminal
 * that is itself inside an agent session — the ordinary case while dogfooding —
 * and every marker that session set is now ambient in EVERY Volli terminal,
 * including ones started days later. Two consequences were observed, not
 * theorised: `claude` sees an inherited child-session marker and turns
 * transcript saving off, and cmux's PATH shim sees an inherited surface id and
 * injects its own `--session-id`/`--settings` into a command line Volli is
 * already configuring — two managers writing the same invocation.
 *
 * The rule is one line long: a Volli terminal is a fresh top-level session, so
 * anything that claims a session is already running here is stale by
 * definition. Everything else about the user's shell — `HOME`, `SHELL`,
 * `TMPDIR`, `LANG`, the `XDG_*` roots, `PATH`, and every credential — survives
 * untouched. This drops names; it never adds or rewrites one.
 */
import {
  VOLLI_ARTIFACTS_DIR_ENV,
  VOLLI_PROJECT_DIR_ENV,
  VOLLI_SESSION_ENV,
  VOLLI_SOCKET_ENV,
  VOLLI_TICKET_ENV,
} from "../volli-dir";
import { VOLLI_BIN_DIR_ENV } from "./shell-init";
import type { HarnessAdapter } from "./types";

/**
 * Volli's own session contract, as inherited from an OUTER Volli.
 *
 * The layers above re-set what this session needs, so dropping these costs
 * nothing — and what they do NOT re-set is exactly the problem. A Project
 * Session sets no `VOLLI_TICKET`, so an inherited one survives and every `volli`
 * call in that terminal files its work against the outer window's ticket;
 * `VOLLI_SOCKET` inherited from another running Volli points the CLI at a
 * different app's planner entirely.
 */
const VOLLI_SESSION_CONTRACT: readonly string[] = [
  VOLLI_SESSION_ENV,
  VOLLI_SOCKET_ENV,
  VOLLI_TICKET_ENV,
  VOLLI_ARTIFACTS_DIR_ENV,
  VOLLI_PROJECT_DIR_ENV,
  VOLLI_BIN_DIR_ENV,
];

/**
 * Namespaces dropped wholesale.
 *
 * `VOLLI_HARNESS_*` is the rest of the contract, one variable per harness
 * (`VOLLI_HARNESS_ARGV_<SLUG>`, `VOLLI_HARNESS_BIN_<SLUG>`). It cannot be
 * listed by name because the names are generated from whichever harnesses that
 * other Volli had installed — and an inherited one holds argv pointing into
 * ANOTHER app's userData directory, which this Volli's wrappers would happily
 * prepend.
 *
 * `CMUX_*` is a different agent manager's surface markers, and belongs here for
 * the same reason our own do: a Volli terminal is not a cmux surface, and
 * saying it is makes cmux's `claude` shim inject a session id and a settings
 * file into a launch Volli is already configuring. cmux takes the same stance
 * from the other side — it unsets `CMUX_*` before exec'ing the real binary.
 */
const DROPPED_PREFIXES: readonly string[] = ["VOLLI_HARNESS_", "CMUX_"];

/**
 * `env` less every marker that would tell a harness it is resuming someone
 * else's session, ready to hand to a pty spawn.
 *
 * Takes the adapters rather than reaching for the registry, so the merged
 * built-in + registered set the app is actually running with is what gets
 * cleared — and so this stays a pure function of its inputs, which is what lets
 * it be tested without an environment at all.
 *
 * `undefined` values are dropped on the way through: `process.env` is typed as
 * possibly-undefined per key, and a pty spawn wants a plain string map.
 */
export function scrubInheritedSessionEnv(
  env: Readonly<Record<string, string | undefined>>,
  adapters: readonly HarnessAdapter[],
): Record<string, string> {
  const dropped = new Set<string>(VOLLI_SESSION_CONTRACT);
  for (const adapter of adapters) {
    for (const marker of adapter.sessionMarkers) dropped.add(marker);
  }
  const scrubbed: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || dropped.has(name)) continue;
    if (DROPPED_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    scrubbed[name] = value;
  }
  return scrubbed;
}
