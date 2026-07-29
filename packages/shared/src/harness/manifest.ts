/**
 * `~/.agents/harnesses/<slug>/harness.json` → a {@link HarnessAdapter}.
 *
 * An adapter is 100% serializable data, so a manifest can declare everything a
 * built-in declares and the engine reads capabilities without ever learning
 * which arm it is holding. This module is the boundary that earns that: anything
 * at all in, an adapter the rest of the package may assume well-formed, or a
 * list of errors each naming the field that produced it.
 *
 * Hand-written narrowing, no schema library — the repo has none, and a manifest
 * is read by a human or an agent who then has to fix it, so the paths in the
 * errors are the product.
 */
import { RESUME_ID_TOKEN } from "../harness-command";
import { isFirstClassHarnessId, parseHarnessId, HARNESS_SLUG_RE } from "../ticket";
import { harnessAdapters, HOME_TOKEN } from "./core";
import {
  HARNESS_EVENTS,
  harnessCommandOwner,
  isBareHarnessCommand,
  isHarnessEvent,
  nativeName,
} from "./types";
import type {
  HarnessAdapter,
  HarnessCommandOwner,
  HarnessConfigInjection,
  HarnessEventBinding,
  HarnessResume,
  HarnessSessionIdSource,
  HarnessSurfaces,
} from "./types";

/** The manifest shape this build understands. A manifest declaring anything else is not guessed at. */
export const SUPPORTED_MANIFEST_VERSION = 1;

export interface ManifestError {
  /** Dotted/indexed path to the offending field (`events[1].delivery`), or `""` for the document itself. */
  path: string;
  message: string;
}

export type ManifestParse =
  | { ok: true; adapter: HarnessAdapter }
  | { ok: false; errors: readonly ManifestError[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collects every field error so one round trip fixes the whole file. */
class Errors {
  readonly list: ManifestError[] = [];

  add(path: string, message: string): void {
    this.list.push({ path, message });
  }

  /** A required non-empty string, or `null` (with the error recorded). */
  text(source: Record<string, unknown>, key: string): string | null {
    const value = source[key];
    if (typeof value !== "string" || value.length === 0) {
      this.add(key, "must be a non-empty string");
      return null;
    }
    return value;
  }

  /** An optional field: absent and `null` both mean "not declared", with no error. */
  optional(source: Record<string, unknown>, key: string): unknown {
    const value = source[key];
    return value === undefined ? null : value;
  }
}

/** One argv word: no whitespace to re-split on, no quoting for a shell to undo. */
function isArgvWord(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/\s/.test(value);
}

/**
 * Names that do not address a config key but a rung of the prototype chain.
 * Every one of them arrives from a manifest and is then used as an object key —
 * a forced setting's dotted path, an event's native name — so `__proto__` writes
 * onto `Object.prototype` for the whole process and `constructor` yields a
 * function where the code that reads it back expects an array.
 *
 * This matters more than the usual because of WHERE it runs: main compiles a
 * PENDING manifest — one nobody has trusted yet — because compiling it is how
 * the trust dialog learns which command line it is asking about. A refusal here
 * is the only thing between "a file appeared in `~/.agents/harnesses`" and
 * arbitrary keys on `Object.prototype` in the Electron main process.
 *
 * The traversals are separately hardened (null-prototype objects, own-property
 * reads — see `setDotted`), so neither layer is load-bearing alone.
 */
const PROTOTYPE_SEGMENTS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

const PROTOTYPE_SEGMENT_MESSAGE = `must not name a prototype-chain segment (${[...PROTOTYPE_SEGMENTS].join(", ")})`;

/**
 * An asset path a manifest may claim. These resolve into the USER's dotfiles —
 * `harnessBaselineActions` writes a symlink or a fenced block at whatever a
 * surface names — so a manifest may only name a place under the home directory,
 * and may not walk back out of it.
 */
function surfacePath(errors: Errors, path: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) {
    errors.add(path, "must be a path string or null");
    return null;
  }
  if (!value.startsWith(`${HOME_TOKEN}/`)) {
    errors.add(
      path,
      `must start with "${HOME_TOKEN}/" — a manifest may only claim paths under home`,
    );
    return null;
  }
  if (value.split("/").includes("..")) {
    errors.add(path, 'must not contain a ".." segment');
    return null;
  }
  return value;
}

/** A name a shell can carry: uppercase, digits, underscores, leading letter. */
const ENV_VAR_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Variables a manifest may not claim, because the variable it declares is not
 * scoped to it: `harness-runtime` merges every injection's `envVar` into the
 * environment of EVERY pty in the session, so whatever a manifest names, it
 * names for the user's shell and for every other agent running beside it.
 *
 * Three families, each a different kind of takeover. The ones that say where
 * things are (`HOME`, `PATH`, `SHELL`, `TMPDIR`, the `XDG_*` roots) point the
 * whole session at a Volli-owned directory. The ones that say what to run
 * before the program does (`NODE_OPTIONS`, `BASH_ENV`, `LD_PRELOAD`,
 * `DYLD_INSERT_LIBRARIES`) execute a manifest's choice of code inside every
 * command an agent runs. And the ones that redirect git (`GIT_CONFIG_GLOBAL`,
 * `GIT_SSH_COMMAND`, `GIT_DIR`) reach the worktrees the whole product is built
 * on.
 */
const RESERVED_ENV_VARS: ReadonlySet<string> = new Set([
  "HOME",
  "PATH",
  "SHELL",
  "USER",
  "LOGNAME",
  "PWD",
  "OLDPWD",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "IFS",
  "ENV",
  "BASH_ENV",
  "ZDOTDIR",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_SSH_COMMAND",
]);

/**
 * Volli's own namespace, refused wholesale. It is how the app talks to the code
 * it injects: `VOLLI_SOCKET` and `VOLLI_SESSION` are the only reason a fired
 * hook can reach the planner, and `VOLLI_HARNESS_ARGV_<SLUG>` holds the argv a
 * wrapper prepends — so claiming one of those is claiming another harness's
 * command line, from a file that only had to appear on disk.
 */
const RESERVED_ENV_PREFIX = "VOLLI_";

/**
 * The injection variables the harnesses Volli ships already own — the ones VOLLI
 * SETS on their behalf. Folded out of the registry rather than restated, so a
 * built-in that changes its variable carries this with it, and no cycle, because
 * `core` knows nothing about manifests.
 */
function builtInInjectionEnvVars(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const adapter of harnessAdapters) {
    if ("envVar" in adapter.injection) names.add(adapter.injection.envVar);
  }
  return names;
}

/**
 * The namespaces the harnesses Volli ships READ THEMSELVES.
 *
 * Written down rather than derived, and that is not redundancy with
 * {@link builtInInjectionEnvVars} — the two answer different questions and go
 * stale for different reasons. What Volli injects is a fact about our own
 * adapters, so the registry always knows it. What a harness reads is a fact
 * about someone else's binary, and the registry cannot see it at all:
 * claude-code is configured entirely through argv, so it contributes no `envVar`
 * to derive, and yet the binary reads `CLAUDE_CONFIG_DIR`. A manifest naming
 * that one points the REAL Claude Code at a directory whose contents the same
 * manifest controls, which is precisely the hijack this guard exists to stop.
 * codex reads `CODEX_HOME` the same way, and neither would ever be derived.
 *
 * Namespaces rather than names because a name list here cannot be kept
 * complete: claude-code reads 105 distinct `CLAUDE_*`/`ANTHROPIC_*` variables,
 * opencode some thirty `OPENCODE_DISABLE_*` switches — one of which,
 * `OPENCODE_DISABLE_DEFAULT_PLUGINS`, silently turns off the plugin every
 * opencode event Volli reports arrives through. Nobody is going to keep a
 * hundred-and-fifty-name list current across four upstreams that ship weekly.
 *
 * **Add a namespace whenever a harness is added.** This half tracks other
 * people's binaries, so it does not maintain itself the way the derived half
 * does. Extend it in the safe direction: a namespace reserved too eagerly
 * refuses a manifest that meant no harm and tells it exactly which variable to
 * take up with us, while a namespace left out is a live hijack of a harness the
 * user already trusts.
 */
const BUILT_IN_HARNESS_ENV_PREFIXES: readonly string[] = [
  "ANTHROPIC_",
  "CLAUDE_",
  "CODEX_",
  "OPENAI_",
  "CURSOR_",
  "OPENCODE_",
];

/**
 * Why a manifest may not have this variable, or `null` when it may. Most
 * specific reason first — a variable Volli itself injects deserves to be told
 * so, rather than being lumped in with its harness's whole namespace.
 */
function reservedEnvVarReason(name: string): string | null {
  if (name.startsWith(RESERVED_ENV_PREFIX)) return "Volli's own namespace";
  if (builtInInjectionEnvVars().has(name)) return "how Volli configures a harness it ships";
  if (RESERVED_ENV_VARS.has(name)) return "part of the environment every session runs in";
  const namespace = BUILT_IN_HARNESS_ENV_PREFIXES.find((prefix) => name.startsWith(prefix));
  if (namespace !== undefined) {
    return `in ${namespace}*, which a harness Volli ships reads its own configuration from`;
  }
  return null;
}

/**
 * A file materialized under `<userData>/harness/<slug>/`, named by its basename
 * alone — trust rule 4. `buildLaunchConfig` joins this onto {@link
 * HARNESS_DIR_TOKEN}, so a separator or a `..` here is the one way a manifest
 * could write outside a Volli-owned directory.
 */
function isVolliOwnedFilename(value: unknown): value is string {
  return isArgvWord(value) && !value.includes("/") && value !== "." && value !== "..";
}

/** The argv-carried strategies, keyed by the flag field each one needs. */
const ARGV_INJECTION_KINDS = new Set(["claude-settings-json", "codex-config-override"]);
const ENV_INJECTION_KINDS = new Set(["config-dir-env", "opencode-plugin"]);

/**
 * The mechanism Volli configures this harness through at launch. Every arm
 * either passes configuration on the command line or points an environment
 * variable at a Volli-owned file — there is deliberately no arm that merges into
 * the user's own configuration, so a manifest cannot ask for one.
 */
function parseInjection(errors: Errors, value: unknown): HarnessConfigInjection {
  const none: HarnessConfigInjection = { kind: "none" };
  if (value === null) return none;
  if (!isRecord(value)) {
    errors.add("injection", "must be an object");
    return none;
  }
  const kind = value["kind"];
  if (kind === "none") return none;

  if (typeof kind === "string" && ARGV_INJECTION_KINDS.has(kind)) {
    const flag = value["flag"];
    if (!isArgvWord(flag)) {
      errors.add("injection.flag", "must be a single argv word");
      return none;
    }
    return kind === "claude-settings-json"
      ? { kind: "claude-settings-json", flag }
      : { kind: "codex-config-override", flag };
  }

  if (typeof kind === "string" && ENV_INJECTION_KINDS.has(kind)) {
    const envVar = value["envVar"];
    const filename = value["filename"];
    let bad = false;
    if (typeof envVar !== "string" || !ENV_VAR_RE.test(envVar)) {
      errors.add("injection.envVar", "must be an UPPER_SNAKE environment variable name");
      bad = true;
    } else {
      const reason = reservedEnvVarReason(envVar);
      if (reason !== null) {
        errors.add("injection.envVar", `must not be ${envVar} — that name is ${reason}`);
        bad = true;
      }
    }
    if (!isVolliOwnedFilename(filename)) {
      errors.add(
        "injection.filename",
        "must be a bare filename — Volli writes it under its own harness directory",
      );
      bad = true;
    }
    if (bad || typeof envVar !== "string" || !isVolliOwnedFilename(filename)) return none;
    return kind === "config-dir-env"
      ? { kind: "config-dir-env", envVar, filename }
      : { kind: "opencode-plugin", envVar, filename };
  }

  errors.add(
    "injection.kind",
    "must be none, claude-settings-json, codex-config-override, config-dir-env or opencode-plugin",
  );
  return none;
}

function parseEventBinding(
  errors: Errors,
  index: number,
  value: unknown,
): HarnessEventBinding | null {
  const path = `events[${index}]`;
  if (!isRecord(value)) {
    errors.add(path, "must be an object");
    return null;
  }
  const { event, native, delivery } = value;
  let ok = true;
  if (!isHarnessEvent(event)) {
    errors.add(`${path}.event`, `must be one of: ${HARNESS_EVENTS.join(", ")}`);
    ok = false;
  }
  if (!isArgvWord(native)) {
    errors.add(`${path}.native`, "must be the harness's own name for the signal");
    ok = false;
  } else if (PROTOTYPE_SEGMENTS.has(nativeName({ native }))) {
    // Judged after the mechanism namespace is stripped, because the stripped
    // name is what keys the hooks object — `hooks:__proto__` is the same attack
    // wearing a prefix.
    errors.add(`${path}.native`, PROTOTYPE_SEGMENT_MESSAGE);
    ok = false;
  }
  if (delivery !== "async" && delivery !== "sync") {
    errors.add(`${path}.delivery`, "must be async or sync");
    ok = false;
  }
  if (!ok || !isHarnessEvent(event) || !isArgvWord(native)) return null;
  return { event, native, delivery: delivery as "async" | "sync" };
}

function parseEvents(errors: Errors, value: unknown): readonly HarnessEventBinding[] {
  if (value === null) return [];
  if (!Array.isArray(value)) {
    errors.add("events", "must be a list of event bindings");
    return [];
  }
  const bindings: HarnessEventBinding[] = [];
  for (const [index, raw] of value.entries()) {
    const binding = parseEventBinding(errors, index, raw);
    if (binding !== null) bindings.push(binding);
  }
  return bindings;
}

/** A dotted path into the harness's own config object: non-empty word segments. */
const SETTING_PATH_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

function parseLaunchSettings(
  errors: Errors,
  value: unknown,
): readonly { path: string; value: string | number | boolean }[] {
  if (value === null) return [];
  if (!Array.isArray(value)) {
    errors.add("launchSettings", "must be a list of settings");
    return [];
  }
  const settings: { path: string; value: string | number | boolean }[] = [];
  for (const [index, raw] of value.entries()) {
    const at = `launchSettings[${index}]`;
    if (!isRecord(raw)) {
      errors.add(at, "must be an object");
      continue;
    }
    const settingPath = raw["path"];
    const settingValue = raw["value"];
    if (typeof settingPath !== "string" || !SETTING_PATH_RE.test(settingPath)) {
      errors.add(`${at}.path`, "must be a dotted path into the harness's own config");
      continue;
    }
    if (settingPath.split(".").some((segment) => PROTOTYPE_SEGMENTS.has(segment))) {
      errors.add(`${at}.path`, PROTOTYPE_SEGMENT_MESSAGE);
      continue;
    }
    // Scalars only: these render into JSON and TOML alike, and a nested object
    // would collide with the dotted path that is already how depth is expressed.
    if (
      typeof settingValue !== "string" &&
      typeof settingValue !== "number" &&
      typeof settingValue !== "boolean"
    ) {
      errors.add(`${at}.value`, "must be a string, number or boolean");
      continue;
    }
    settings.push({ path: settingPath, value: settingValue });
  }
  return settings;
}

function parseSessionId(errors: Errors, value: unknown): HarnessSessionIdSource {
  const none: HarnessSessionIdSource = { kind: "none" };
  if (value === null) return none;
  if (!isRecord(value)) {
    errors.add("sessionId", "must be an object");
    return none;
  }
  const kind = value["kind"];
  if (kind === "none" || kind === "reported") return { kind };
  if (kind === "argv") {
    const flag = value["flag"];
    if (!isArgvWord(flag)) {
      errors.add("sessionId.flag", "must be a single argv word");
      return none;
    }
    return { kind: "argv", flag, format: "uuid" };
  }
  errors.add("sessionId.kind", "must be argv, reported or none");
  return none;
}

/** An argv template or fragment: a list of whitespace-free words, or `null`. */
function argvList(errors: Errors, path: string, value: unknown): readonly string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || !value.every((token) => isArgvWord(token))) {
    errors.add(path, "must be a list of argv words");
    return null;
  }
  return value as readonly string[];
}

/**
 * A resume path: argv that resumes something, or `null` for a harness that has
 * no such path. An EMPTY list is neither, and is refused rather than kept —
 * `[]` reads as "resume with no arguments", which describes no harness that has
 * ever existed, and every consumer treats the array itself as the evidence. A
 * kept `[]` promotes the adapter to the Known tier and then resumes by running
 * the bare executable, which starts a FRESH session under the word "resume".
 *
 * Refused here rather than only where it is read, because the parser is the
 * only place that can say so out loud: a manifest gets an error naming the
 * field, instead of a harness that silently loses its sessions.
 */
function resumeArgv(errors: Errors, path: string, value: unknown): readonly string[] | null {
  const argv = argvList(errors, path, value);
  if (argv === null) return null;
  if (argv.length === 0) {
    errors.add(path, "must not be empty — a harness with no resume path declares null");
    return null;
  }
  return argv;
}

/**
 * Resume argv. `byId` is a TEMPLATE, so it must carry exactly one `{id}` — none
 * leaves the id nowhere to go, and two would substitute the same session id into
 * two positions the harness never meant to receive it.
 */
function parseResume(errors: Errors, value: unknown): HarnessResume {
  const none: HarnessResume = { byId: null, latest: null, userResumeTokens: [] };
  if (value === null) return none;
  if (!isRecord(value)) {
    errors.add("resume", "must be an object");
    return none;
  }
  const byId = resumeArgv(errors, "resume.byId", value["byId"]);
  if (byId !== null && byId.filter((token) => token.includes(RESUME_ID_TOKEN)).length !== 1) {
    errors.add("resume.byId", `must contain exactly one "${RESUME_ID_TOKEN}" token`);
    return none;
  }
  return {
    byId,
    latest: resumeArgv(errors, "resume.latest", value["latest"]),
    // Empty is meaningful here and only here: it is the ordinary case, a harness
    // whose users have no way of driving resume themselves.
    userResumeTokens: argvList(errors, "resume.userResumeTokens", value["userResumeTokens"]) ?? [],
  };
}

function parseSurfaces(errors: Errors, value: unknown): HarnessSurfaces {
  const none: HarnessSurfaces = { skillsDir: null, commandsDir: null, instructionsFile: null };
  if (value === null) return none;
  if (!isRecord(value)) {
    errors.add("surfaces", "must be an object");
    return none;
  }
  return {
    skillsDir: surfacePath(errors, "surfaces.skillsDir", value["skillsDir"]),
    commandsDir: surfacePath(errors, "surfaces.commandsDir", value["commandsDir"]),
    instructionsFile: surfacePath(errors, "surfaces.instructionsFile", value["instructionsFile"]),
  };
}

/** The owner of a claimed command, as the error message names it. */
function ownerDescription(owner: HarnessCommandOwner): string {
  return owner === "volli-cli"
    ? "the command Volli's own CLI launcher answers to"
    : `the command the built-in ${owner} harness launches`;
}

export function parseHarnessManifest(raw: unknown): ManifestParse {
  const errors = new Errors();
  if (!isRecord(raw))
    return { ok: false, errors: [{ path: "", message: "must be a JSON object" }] };

  if (raw["manifestVersion"] !== SUPPORTED_MANIFEST_VERSION) {
    errors.add("manifestVersion", `must be ${SUPPORTED_MANIFEST_VERSION}`);
  }

  const slug = errors.text(raw, "slug");
  if (slug !== null && !HARNESS_SLUG_RE.test(slug)) {
    errors.add("slug", "must be lowercase letters, digits and dashes, starting with a letter");
  } else if (slug !== null && isFirstClassHarnessId(slug)) {
    errors.add("slug", "is a harness Volli ships — a manifest cannot replace it");
  }

  const label = errors.text(raw, "label");

  const command = errors.text(raw, "command");
  if (command !== null) {
    // Ownership first: `volli` and `claude` are both perfectly well-formed
    // executable names, so the shape error would be a lie about why they are
    // refused — and the person fixing the file only ever reads the message.
    const owner = harnessCommandOwner(command);
    if (owner !== null) {
      errors.add(
        "command",
        `is already ${ownerDescription(owner)} — a wrapper name belongs to one`,
      );
    } else if (!isBareHarnessCommand(command)) {
      errors.add(
        "command",
        "must be a bare executable name — no path, whitespace or metacharacters",
      );
    }
  }

  const promptFlagValue = errors.optional(raw, "promptFlag");
  const promptFlag = promptFlagValue === null ? null : promptFlagValue;
  if (promptFlag !== null && !isArgvWord(promptFlag)) {
    errors.add("promptFlag", "must be a single argv word, or null for a positional prompt");
  }

  const surfaces = parseSurfaces(errors, errors.optional(raw, "surfaces"));
  const injection = parseInjection(errors, errors.optional(raw, "injection"));
  const sessionId = parseSessionId(errors, errors.optional(raw, "sessionId"));
  const resume = parseResume(errors, errors.optional(raw, "resume"));
  const events = parseEvents(errors, errors.optional(raw, "events"));
  const launchSettings = parseLaunchSettings(errors, errors.optional(raw, "launchSettings"));

  if (errors.list.length > 0 || slug === null || label === null || command === null) {
    return { ok: false, errors: errors.list };
  }
  const id = parseHarnessId(slug);
  /* v8 ignore next -- HARNESS_SLUG_RE passed above, so parseHarnessId cannot miss. */
  if (id === null) return { ok: false, errors: [{ path: "slug", message: "is not a harness id" }] };

  return {
    ok: true,
    adapter: {
      id,
      label,
      command,
      promptFlag: isArgvWord(promptFlag) ? promptFlag : null,
      surfaces,
      injection,
      sessionId,
      resume,
      events,
      launchSettings,
      // Not a manifest field, and not an oversight. Every other field says what
      // Volli should DO for this harness; this one names variables Volli deletes
      // from the user's own environment before any shell starts, so a manifest
      // declaring `SSH_AUTH_SOCK` or `AWS_PROFILE` would quietly break every
      // terminal in the app — including ones that never run this harness — from
      // a file that only had to appear on disk. A registered harness whose
      // markers really do need clearing gets them here, in code, once they have
      // been observed.
      sessionMarkers: [],
    },
  };
}
