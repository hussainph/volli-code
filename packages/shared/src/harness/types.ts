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
import type { HarnessId } from "../ticket";

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

/**
 * Names inside Volli's `bin/` that belong to the CLI launcher. A wrapper is
 * written under a harness's `command`, so the one thing standing between a
 * hostile (or merely careless) manifest and the launcher every agent reaches
 * Volli through is refusing these outright.
 */
const RESERVED_HARNESS_COMMANDS: ReadonlySet<string> = new Set(["volli", "volli.cjs"]);

/**
 * Whether `command` is a name Volli will execute and describe honestly: a bare
 * executable, and not one of Volli's own. Every argument a harness receives
 * comes from a declared argv array instead, which is what makes the trust
 * dialog's claim about the command line literally true.
 */
export function isBareHarnessCommand(command: string): boolean {
  return BARE_HARNESS_COMMAND_RE.test(command) && !RESERVED_HARNESS_COMMANDS.has(command);
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

export function harnessTier(adapter: HarnessAdapter): HarnessTier {
  if (adapter.injection.kind !== "none" && adapter.events.length > 0) return "hooked";
  return adapter.resume.byId || adapter.resume.latest ? "known" : "declared";
}

/** The canonical events an adapter claims, collapsed from its native bindings. */
export function supportedEvents(adapter: HarnessAdapter): ReadonlySet<HarnessEvent> {
  return new Set(adapter.events.map((binding) => binding.event));
}
