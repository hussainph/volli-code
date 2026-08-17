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

/**
 * How a fenced managed block comments its markers. `html` is the default and
 * what every instructions file (Markdown) uses; `hash` exists because a fenced
 * block can now land in a shell profile, where `<!-- volli:begin v=1 -->` is a
 * syntax error the user's login shell would print on every boot.
 */
export type FenceComment = "html" | "hash";

export type InstallAction =
  | { kind: "write"; path: string; content: string; managed: true }
  | { kind: "symlink"; path: string; target: string; managed: true }
  | {
      kind: "fenced";
      path: string;
      content: string;
      version: number;
      managed: true;
      /** Marker comment syntax; absent means `html` (the Markdown-file default). */
      comment?: FenceComment;
    };

/**
 * The involuntary signals Volli understands. Harness-native event names never
 * leave the adapter — the rest of the app consumes this union alone.
 *
 * `input.needed` is the one that earns the feature: it means a human is
 * blocking the agent's progress, and it drives the attention row at the top of
 * the sidebar's Active band and the native notification.
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
 * own config. The launch builder switches on the kind and never on the
 * harness's identity, which is what lets a registered manifest be configured
 * the way a built-in is.
 *
 * Each kind is NAMED AFTER THE BINARY it was written against, because that is
 * all a kind ever was. A name like `argv-settings-json` reads as a claim about a
 * mechanism class — "this harness takes settings JSON on a flag" — while the arm
 * behind it also fixes one binary's hook schema, one filename and one search
 * order. `config-dir-env` is what that costs when nobody re-checks it: it was
 * written for cursor from a mechanism it does not use, and every hook it wrote
 * was unreachable for a whole branch. A kind named after a binary is a
 * falsifiable statement about that binary and one version of it, and a manifest
 * declaring it is declaring "my harness reads exactly what THAT one reads".
 */
export type HarnessConfigInjection =
  | { kind: "none" }
  /** claude-code: `--settings` takes a settings JSON string, merged additively over the user's scopes. */
  | { kind: "claude-settings-json"; flag: string }
  /** codex: `-c key=value`, repeated once per override. */
  | { kind: "codex-config-override"; flag: string }
  /**
   * A directory named by an environment variable holds `filename`, in the flat
   * `{ "<Native>": [{ command }] }` hook shape.
   *
   * The one kind still named after a mechanism, and the reason is worth
   * keeping: it was written FOR cursor, on the strength of `CURSOR_CONFIG_DIR`
   * redirecting `cli-config.json`. That variable really does redirect that file
   * — and `cursor-agent` reads hooks from somewhere else entirely, so every hook
   * Volli wrote through this kind was unreachable. The generic name is what let
   * the mistake survive unexamined. No built-in declares it any more;
   * `docs/plans/harness-architecture-v2.md` §1 replaces it with one BYO
   * mechanism (`hook-file`), and until that lands this stays, because a
   * registered manifest may already declare it.
   */
  | { kind: "config-dir-env"; envVar: string; filename: string }
  /**
   * cursor: hooks come from a fixed `hooks.json` ladder that NO environment
   * variable reaches — enterprise, `~/.cursor`, `<cwd>/.cursor`, a team file
   * under `~/.cursor/managed`, and the Claude-compatibility files. The only
   * rung Volli can own per ticket is the project one, `.cursor/hooks.json`
   * relative to the working directory, which is a Volli-created worktree.
   *
   * It fixes cursor's schema, cursor's filename and cursor's search order all at
   * once — which is what every one of these kinds does, and why they are all
   * named this way now.
   */
  | { kind: "cursor-hooks-file" }
  /** opencode: `OPENCODE_CONFIG` points at `filename` itself, layered over the user's config. */
  | { kind: "opencode-plugin"; envVar: string; filename: string };

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
   *
   * It is also the name detection resolves on the user's PATH. There was a
   * separate `detection: { executable }` for that and it held this same string
   * in all four built-ins and in the manifest parser, which assigned it FROM
   * here — two fields that could only ever agree, one of which could be edited
   * without the other.
   */
  readonly command: string;
  readonly promptFlag: string | null;
  readonly surfaces: HarnessSurfaces;
  readonly injection: HarnessConfigInjection;
  readonly sessionId: HarnessSessionIdSource;
  readonly resume: HarnessResume;
  readonly events: readonly HarnessEventBinding[];
  /**
   * The bound event that fires on harness boot, before the user does anything.
   * `null` means the channel cannot prove itself alive until the agent acts.
   *
   * This is the field that makes SILENCE mean something. Without it, "no event
   * yet" is ambiguous between a channel that never worked and an agent nobody
   * has typed into — and the app resolves that ambiguity against the harness,
   * so a perfectly healthy session reads as not reporting for as long as its
   * user is still reading the ticket. With it, and with the wrapper's launch
   * announce proving Volli's configuration was in the loop, a window of silence
   * after boot means one thing only: what we injected did not take.
   *
   * It must be `null` or an event the adapter actually binds — see
   * {@link bindsStartupEvent}. An adapter claiming a startup signal it never
   * bound is the exact class of lie this field exists to remove.
   */
  readonly startupEvent: HarnessEvent | null;
  /**
   * Harness-native settings Volli forces at launch, as dotted paths into that
   * harness's own config object — silencing its duplicate notifications, and
   * the like. Values keep their JSON type
   * rather than collapsing to strings: these are rendered into a harness's own
   * config, and TOML and JSON both distinguish `false` from `"false"`. A
   * harness handed the wrong one either rejects the key or, worse, ignores it.
   */
  readonly launchSettings: readonly { path: string; value: string | number | boolean }[];
  /**
   * The variables this harness stamps to say "one of MY sessions is already
   * running here". Volli clears them out of the INHERITED environment before it
   * spawns a session shell, so a Volli terminal is a fresh top-level session
   * rather than a child of whatever happened to launch the app — Volli launched
   * from a terminal that is itself inside an agent session otherwise passes that
   * session's markers to every terminal it opens. Observed: `claude` reads its
   * own child-session marker and turns transcript saving off for the whole run.
   *
   * Not the manifest's reserved names, which answer the opposite question.
   * Reserved names are what a manifest may not SET, so they are stated as whole
   * namespaces (`ANTHROPIC_*`, `CLAUDE_*`) — deliberately over-broad, because
   * over-refusing a manifest costs a manifest author one error message. These
   * are DELETED from the user's own environment, where the same breadth is a
   * bug: `ANTHROPIC_API_KEY` is their credential and `CLAUDE_CONFIG_DIR` their
   * configuration, and a terminal that starts without either is broken, not
   * clean.
   *
   * So list names, conservatively, and only ones seen set on a real session: a
   * marker named here that a harness never sets costs nothing at all, and one
   * name too many costs the user a terminal that cannot authenticate.
   */
  readonly sessionMarkers: readonly string[];
}

/**
 * Whether Volli may hold this harness to a reporting promise — the one question
 * everything that judges silence asks, written once and asked in both places
 * that judge it (the per-session grace window, `session.ts`, and the durable
 * channel state, `channel.ts`).
 *
 * Both halves of the conjunction are load-bearing, and the second is the one
 * that was learned the expensive way. An injection path means Volli got to
 * configure the harness at all. A `startupEvent` means the channel says
 * something at BOOT, before the user has done anything — and without that,
 * silence is indistinguishable from a terminal nobody has typed into. Codex is
 * exactly that harness: it has no session until there is a turn, so it fires
 * nothing at launch however well its hooks work, and accusing it of not
 * reporting is a lie about a healthy session.
 *
 * `undefined` — an id nothing here can describe — is `false`, and that is the
 * quiet failure on purpose: a harness whose promise nobody read has made none,
 * and the direction that costs nothing is declining to accuse it. Note that
 * {@link declaresInputNeeded} fails the OTHER way for the same input, because
 * it gates BELIEVING a delivery rather than making an accusation.
 */
export function expectsHarnessEvents(
  adapter: Pick<HarnessAdapter, "injection" | "startupEvent"> | undefined,
): boolean {
  if (adapter === undefined) return false;
  return adapter.injection.kind !== "none" && adapter.startupEvent !== null;
}

/** The canonical events an adapter claims, collapsed from its native bindings. */
export function supportedEvents(
  adapter: Pick<HarnessAdapter, "events">,
): ReadonlySet<HarnessEvent> {
  return new Set(adapter.events.map((binding) => binding.event));
}

/**
 * Whether a harness can say a human is blocking its agent. Gates the needs-you
 * notification in main and the `waiting` fold in the renderer, which is why it
 * lives here rather than beside either of them: the two ends have to agree, and
 * the way they agree is by asking the same function.
 *
 * `undefined` believes. An id nothing here can describe is a manifest trusted
 * since the catalog was last read, and its delivery is the only evidence there
 * is — disbelieving it would hide a harness that IS reporting.
 */
export function declaresInputNeeded(adapter: Pick<HarnessAdapter, "events"> | undefined): boolean {
  return adapter === undefined || supportedEvents(adapter).has("input.needed");
}

/**
 * Whether {@link HarnessAdapter.startupEvent} names something the adapter
 * actually bound — the one invariant that field has.
 *
 * A startup event nothing renders is worse than no startup event at all: it
 * promises the channel will speak at boot, so the silence that follows is read
 * as a broken injection and reported to the user as such. Declaring `null` costs
 * a harness nothing except the ability to be caught lying.
 *
 * Asserted against the built-ins in their own test, and enforced at parse time
 * for a manifest, where it is untrusted input rather than a typo.
 */
export function bindsStartupEvent(
  adapter: Pick<HarnessAdapter, "startupEvent" | "events">,
): boolean {
  const { startupEvent } = adapter;
  return startupEvent === null || adapter.events.some((binding) => binding.event === startupEvent);
}
