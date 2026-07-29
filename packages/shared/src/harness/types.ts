/**
 * What a harness *is*, as data. An adapter carries no behaviour — no methods,
 * no closures, nothing that only a built-in could supply — so a harness Volli
 * ships and one a user registers from `~/.agents/harnesses/<slug>/harness.json`
 * are the same type, and the engine reads capabilities instead of branching on
 * identity.
 *
 * Paths are templated strings (`{home}/.claude/skills`) rather than resolved
 * ones: this package must stay free of Node/Electron/DOM imports, so main
 * substitutes them when it touches the filesystem.
 */
import type { FirstClassHarnessId, HarnessId } from "../ticket";

export type InstallAction =
  | { kind: "write"; path: string; content: string; managed: true }
  | { kind: "symlink"; path: string; target: string; managed: true }
  | { kind: "fenced"; path: string; content: string; version: number; managed: true };

/**
 * The involuntary signals Volli understands. Harness-native event names never
 * leave the adapter — the rest of the app consumes this union alone.
 *
 * `input.needed` is the one that earns the feature: it means a human is
 * blocking the agent's progress, and it drives the "Needs you" tier and the
 * native notification.
 */
export const HARNESS_EVENTS = [
  "session.started",
  "session.ended",
  "turn.started",
  "turn.completed",
  "input.needed",
  "permission.requested",
  "tool.started",
  "subagent.completed",
] as const;

export type HarnessEvent = (typeof HARNESS_EVENTS)[number];

/**
 * Whether `value` is one of the {@link HARNESS_EVENTS}. The vocabulary guard for
 * every untrusted edge that names an event — a registered manifest's bindings, a
 * stored ledger row, a fired hook's argv.
 */
export function isHarnessEvent(value: unknown): value is HarnessEvent {
  return typeof value === "string" && (HARNESS_EVENTS as readonly string[]).includes(value);
}

export interface HarnessEventBinding {
  event: HarnessEvent;
  /**
   * The harness's own name for this signal (`Stop`, `session.idle`) — opaque
   * to the engine, meaningful only to the injection strategy that renders it.
   * A harness whose signals arrive by more than one mechanism namespaces them
   * (`hooks:PermissionRequest` vs `notify:agent-turn-complete`); the prefix is
   * part of the opaque string and only that harness's renderer reads it.
   */
  native: string;
  /**
   * `sync` blocks the harness until Volli answers. Nothing declares it yet —
   * answering permission requests on the agent's behalf is a product surface
   * of its own — but the model has to be able to say it.
   */
  delivery: "async" | "sync";
  timeoutMs: number;
}

/**
 * The harness's own name for a signal, with any mechanism namespace stripped.
 * Lives here rather than in one renderer because every mechanism that writes a
 * native name has to strip it the same way — including the manifest parser,
 * which has to judge the name that will actually key an object, not the
 * namespaced string it arrived as.
 */
export function nativeName(binding: Pick<HarnessEventBinding, "native">): string {
  const separator = binding.native.indexOf(":");
  return separator === -1 ? binding.native : binding.native.slice(separator + 1);
}

/**
 * How a harness accepts configuration AT LAUNCH — never by editing the user's
 * own config. Each kind names both a mechanism and the native config shape
 * that mechanism expects, which is why the launch builder can switch on it
 * without ever knowing which harness it is holding.
 */
export type HarnessConfigInjection =
  | { kind: "none" }
  /** claude-code: `--settings` takes a settings JSON string, merged additively over the user's scopes. */
  | { kind: "argv-settings-json"; flag: string }
  /** codex: `-c key=value`, repeated once per override. */
  | { kind: "argv-config-override"; flag: string }
  /** cursor: `CURSOR_CONFIG_DIR` points at a directory holding `filename`; auth stays in `~/.cursor`. */
  | { kind: "config-dir-env"; envVar: string; filename: string }
  /** opencode: `OPENCODE_CONFIG` points at `filename` itself, layered over the user's config. */
  | { kind: "plugin-config-env"; envVar: string; filename: string };

/**
 * Where a harness's own session id comes from. `argv` means Volli mints it at
 * spawn, so `sessions.harness_session_id` is known before the agent produces a
 * byte; `reported` means it arrives on the events; `none` leaves `volli
 * session link` as the only way to learn it.
 */
export type HarnessSessionIdSource =
  | { kind: "argv"; flag: string; format: "uuid" }
  | { kind: "reported" }
  | { kind: "none" };

export interface HarnessResume {
  /**
   * Argv template that resumes a specific prior session, containing exactly
   * one `"{id}"` token — a template rather than a fragment plus an appended
   * id, because a harness may embed the id in the flag (`--session={id}`).
   * `null` when the harness has no by-id resume.
   */
  byId: readonly string[] | null;
  /** Argv that resumes the most recent session in the cwd, or `null`. */
  latest: readonly string[] | null;
  /**
   * Argv tokens meaning "I'm driving resume myself". When the user's own
   * command line contains one, the wrapper suppresses its session-id
   * injection rather than fighting them for the session.
   */
  userResumeTokens: readonly string[];
}

/** Where a harness reads shared agent assets from, templated on `{home}`. */
export interface HarnessSurfaces {
  skillsDir: string | null;
  commandsDir: string | null;
  instructionsFile: string | null;
}

/** A bare executable name: no directory traversal, no whitespace, nothing a shell would read. */
const BARE_HARNESS_COMMAND_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Who a name inside Volli's `bin/` already belongs to. */
export type HarnessCommandOwner = "volli-cli" | FirstClassHarnessId;

/**
 * The names inside Volli's `bin/` that are already spoken for: the CLI launcher
 * every agent reaches Volli through, and the wrapper each built-in harness gets.
 * A wrapper is written as `<binDir>/<command>` and that directory wins `PATH`
 * inside a session, so a name claimed twice is one file written twice — the
 * later writer silently taking over the earlier one's argv injection, or the
 * launcher itself.
 *
 * Keyed case-folded, and that is not fastidiousness: APFS is case-INSENSITIVE by
 * default, so on the only OS we ship `Volli` and `volli` are the same file, and
 * a case-sensitive check hands a manifest the launcher's own path.
 *
 * The built-in half is spelled out rather than folded out of the adapter
 * registry because every adapter module imports THIS one: reaching back for the
 * registry closes an import cycle and leaves the map undefined while it
 * evaluates. A built-in whose command drifted from this list would only ever
 * over-refuse, which is the safe direction.
 */
const OWNED_HARNESS_COMMANDS: ReadonlyMap<string, HarnessCommandOwner> = new Map([
  ["volli", "volli-cli"],
  ["volli.cjs", "volli-cli"],
  ["claude", "claude-code"],
  ["codex", "codex"],
  ["cursor-agent", "cursor"],
  ["opencode", "opencode"],
]);

/**
 * Who already owns `<binDir>/<command>`, or `null` when the name is free.
 *
 * Two edges ask, and they have to get the same answer. The manifest parser
 * refuses any owned name outright — a registered harness is never a built-in, so
 * for it "owned" and "forbidden" are the same word. The wrapper writer compares
 * the owner against the adapter it is about to write for, which is what makes
 * `bin/` one-to-one: `claude-code` may claim `claude`, and nobody else may.
 */
export function harnessCommandOwner(command: string): HarnessCommandOwner | null {
  return OWNED_HARNESS_COMMANDS.get(command.toLowerCase()) ?? null;
}

/**
 * Whether `command` is a name Volli will execute and describe honestly: a bare
 * executable, and not the launcher's. Every argument a harness receives comes
 * from a declared argv array instead, which is what makes the trust dialog's
 * claim about the command line literally true.
 *
 * Deliberately silent about the built-ins' own commands — a built-in has to pass
 * this to get its wrapper written at all. Ownership is {@link
 * harnessCommandOwner}'s question, and callers that care ask it separately.
 */
export function isBareHarnessCommand(command: string): boolean {
  return BARE_HARNESS_COMMAND_RE.test(command) && harnessCommandOwner(command) !== "volli-cli";
}

/**
 * Directories whose commands Volli must never shadow. A wrapper is written
 * under the harness's own `command` name into a directory that now genuinely
 * wins `PATH` inside a session — so a manifest declaring `git` would put a
 * Volli script in front of git for every command in every Volli terminal, and
 * the wrapper prepends its injected argv whenever `VOLLI_SESSION` is set, which
 * in a Volli PTY is always.
 *
 * This was inert while the bin dir lost the `PATH` race; making the wrapper win
 * is what turns it into a real hazard, so the guard lands with the fix. It is
 * about a careless manifest, not a hostile one — a hostile manifest is already
 * gated behind a human confirming the exact command line it will run.
 */
const SYSTEM_COMMAND_DIRS: readonly string[] = [
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/usr/libexec",
];

/**
 * Whether writing a wrapper named after this command would shadow a system
 * tool, given where the command resolves on the user's real `PATH`.
 *
 * Asked of the RESOLVED path rather than a denylist of names, so it covers
 * every core tool without anyone having to have thought of it — and so a
 * harness that merely shares a name with something in `/opt/homebrew/bin` is
 * not refused for it.
 */
export function shadowsSystemCommand(resolvedPath: string): boolean {
  return SYSTEM_COMMAND_DIRS.some((dir) => resolvedPath.startsWith(`${dir}/`));
}

export interface HarnessAdapter {
  readonly id: HarnessId;
  readonly label: string;
  /**
   * The bare executable name — no `/`, no whitespace. A registered manifest
   * declares a command line Volli will execute, and the trust dialog's claim
   * about what it runs is only literally true if arguments can come from
   * nowhere but the declared argv arrays.
   */
  readonly command: string;
  readonly promptFlag: string | null;
  readonly detection: { executable: string };
  readonly surfaces: HarnessSurfaces;
  readonly injection: HarnessConfigInjection;
  readonly sessionId: HarnessSessionIdSource;
  readonly resume: HarnessResume;
  readonly events: readonly HarnessEventBinding[];
  /**
   * Harness-native settings Volli forces at launch, as dotted paths into that
   * harness's own config object — silencing its duplicate notifications, and
   * the like. Values keep their JSON type
   * rather than collapsing to strings: these are rendered into a harness's own
   * config, and TOML and JSON both distinguish `false` from `"false"`. A
   * harness handed the wrong one either rejects the key or, worse, ignores it.
   */
  readonly launchSettings: readonly { path: string; value: string | number | boolean }[];
}

/**
 * What Volli can actually expect from a harness. Derived from what it
 * declares, never asserted — and revocable at runtime, since a launch that
 * bypassed the wrapper reports nothing however well it is described here.
 *
 * **Hooked** — an injection path and event bindings: live turn and idle state,
 * automatic board moves, notifications. **Known** — no injection, but a resume
 * path, so activity is inferred from the PTY instead. **Declared** — neither;
 * it still launches with its prompt and the whole `volli` CLI surface still
 * works, because that reaches the app through `VOLLI_SOCKET` and PATH.
 */
export type HarnessTier = "hooked" | "known" | "declared";

/**
 * Whether a resume slot holds argv that would actually resume anything. An
 * EMPTY array is not a resume path, and the distinction is the whole tier: `[]`
 * is truthy, so testing the array itself promotes a resume-less harness to
 * Known, and `buildResumeCommand` then hands back the bare executable — which
 * starts a FRESH session while every surface says "resume".
 */
function hasResumeArgv(argv: readonly string[] | null): boolean {
  return argv !== null && argv.length > 0;
}

export function harnessTier(adapter: HarnessAdapter): HarnessTier {
  if (adapter.injection.kind !== "none" && adapter.events.length > 0) return "hooked";
  return hasResumeArgv(adapter.resume.byId) || hasResumeArgv(adapter.resume.latest)
    ? "known"
    : "declared";
}

/** The canonical events an adapter claims, collapsed from its native bindings. */
export function supportedEvents(adapter: HarnessAdapter): ReadonlySet<HarnessEvent> {
  return new Set(adapter.events.map((binding) => binding.event));
}
