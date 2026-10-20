/**
 * What a Volli terminal must NOT inherit.
 *
 * A session shell is spawned from the Electron process's own environment, and
 * that environment is whatever launched the app. Launch Volli from a terminal
 * that is itself inside an agent session and its markers become ambient in
 * every Volli terminal, including ones started days later. An inherited child
 * marker can disable Claude Code transcript saving; inherited surface markers
 * can make a PATH shim inject `--session-id`/`--settings` into a command Volli
 * is already configuring.
 *
 * The rule is one line long: a Volli terminal is a fresh top-level session, so
 * anything that claims a session is already running here is stale by
 * definition. Everything else about the user's shell — `HOME`, `SHELL`,
 * `TMPDIR`, `LANG`, the `XDG_*` roots, `PATH`, and every credential — survives
 * untouched. This drops names; it never adds or rewrites one.
 */
import { VOLLI_CONCURRENCY_HINT_ENV } from "../concurrency-budget";
import {
  VOLLI_ARTIFACTS_DIR_ENV,
  VOLLI_PROJECT_DIR_ENV,
  VOLLI_SESSION_ENV,
  VOLLI_SESSION_TOKEN_ENV,
  VOLLI_SOCKET_ENV,
  VOLLI_TICKET_ENV,
} from "../volli-dir";
import { VOLLI_OPERATOR_TOKEN_ENV } from "../operator-token";
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
 *
 * `VOLLI_SESSION_TOKEN` is in this list for a stronger reason than the rest
 * (VC-163). Every other inherited name costs a wrong attribution; an inherited
 * token costs an authentication. It would let every terminal this app opens
 * prove itself to be the outer Volli's Session — the exact cross-session
 * confusion the token was minted to defeat, arriving through the one channel
 * the token cannot inspect. A fresh attachment mints its own or has none.
 *
 * `VOLLI_CONCURRENCY_HINT` is here because it is an answer about THIS machine
 * at THIS moment (VC-339): the outer Volli divided its cores by the Sessions
 * IT had working, and that number is stale the instant this app computes its
 * own. Dropping it is also what keeps the no-clobber rule honest — the budget
 * is only ever skipped for a value a person set, never for one Volli itself
 * exported a launch ago.
 *
 * `VOLLI_OPERATOR_TOKEN` is here for the reason the Session token is, turned
 * around (VC-623): it proves a PERSON, and a terminal Volli spawns is where a
 * Session runs. An operator who exported it in the shell that launched the host
 * must not hand every Session that host starts a way to write as them.
 */
const VOLLI_SESSION_CONTRACT: readonly string[] = [
  VOLLI_SESSION_ENV,
  VOLLI_SESSION_TOKEN_ENV,
  VOLLI_SOCKET_ENV,
  VOLLI_TICKET_ENV,
  VOLLI_ARTIFACTS_DIR_ENV,
  VOLLI_PROJECT_DIR_ENV,
  VOLLI_BIN_DIR_ENV,
  VOLLI_CONCURRENCY_HINT_ENV,
  VOLLI_OPERATOR_TOKEN_ENV,
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
 * Foreign surface markers are dropped so inherited PATH shims cannot inject
 * a session id or settings file into a launch Volli is already configuring.
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
