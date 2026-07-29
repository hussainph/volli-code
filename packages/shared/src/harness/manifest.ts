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
import { HOME_TOKEN } from "./core";
import { HARNESS_EVENTS, isBareHarnessCommand, isHarnessEvent } from "./types";
import type {
  HarnessAdapter,
  HarnessConfigInjection,
  HarnessEventBinding,
  HarnessResume,
  HarnessSessionIdSource,
  HarnessSurfaces,
} from "./types";

/** The manifest shape this build understands. A manifest declaring anything else is not guessed at. */
export const SUPPORTED_MANIFEST_VERSION = 1;

export interface ManifestError {
  /** Dotted/indexed path to the offending field (`events[1].timeoutMs`), or `""` for the document itself. */
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
 * A file materialized under `<userData>/harness/<slug>/`, named by its basename
 * alone — trust rule 4. `buildLaunchConfig` joins this onto {@link
 * HARNESS_DIR_TOKEN}, so a separator or a `..` here is the one way a manifest
 * could write outside a Volli-owned directory.
 */
function isVolliOwnedFilename(value: unknown): value is string {
  return isArgvWord(value) && !value.includes("/") && value !== "." && value !== "..";
}

/** The argv-carried strategies, keyed by the flag field each one needs. */
const ARGV_INJECTION_KINDS = new Set(["argv-settings-json", "argv-config-override"]);
const ENV_INJECTION_KINDS = new Set(["config-dir-env", "plugin-config-env"]);

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
    return kind === "argv-settings-json"
      ? { kind: "argv-settings-json", flag }
      : { kind: "argv-config-override", flag };
  }

  if (typeof kind === "string" && ENV_INJECTION_KINDS.has(kind)) {
    const envVar = value["envVar"];
    const filename = value["filename"];
    let bad = false;
    if (typeof envVar !== "string" || !ENV_VAR_RE.test(envVar)) {
      errors.add("injection.envVar", "must be an UPPER_SNAKE environment variable name");
      bad = true;
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
      : { kind: "plugin-config-env", envVar, filename };
  }

  errors.add(
    "injection.kind",
    "must be none, argv-settings-json, argv-config-override, config-dir-env or plugin-config-env",
  );
  return none;
}

/**
 * The longest a binding may make a harness wait. Generous enough for every
 * mechanism observed (Claude Code's own default is 60s) and short enough that a
 * `sync` binding cannot hang a session on a Volli that never answers.
 */
const MAX_EVENT_TIMEOUT_MS = 600_000;

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
  const { event, native, delivery, timeoutMs } = value;
  let ok = true;
  if (!isHarnessEvent(event)) {
    errors.add(`${path}.event`, `must be one of: ${HARNESS_EVENTS.join(", ")}`);
    ok = false;
  }
  if (!isArgvWord(native)) {
    errors.add(`${path}.native`, "must be the harness's own name for the signal");
    ok = false;
  }
  if (delivery !== "async" && delivery !== "sync") {
    errors.add(`${path}.delivery`, "must be async or sync");
    ok = false;
  }
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_EVENT_TIMEOUT_MS
  ) {
    errors.add(`${path}.timeoutMs`, `must be a whole number of ms, 1–${MAX_EVENT_TIMEOUT_MS}`);
    ok = false;
  }
  if (!ok || !isHarnessEvent(event) || !isArgvWord(native)) return null;
  return {
    event,
    native,
    delivery: delivery as "async" | "sync",
    timeoutMs: timeoutMs as number,
  };
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
  const byId = argvList(errors, "resume.byId", value["byId"]);
  if (byId !== null && byId.filter((token) => token.includes(RESUME_ID_TOKEN)).length !== 1) {
    errors.add("resume.byId", `must contain exactly one "${RESUME_ID_TOKEN}" token`);
    return none;
  }
  return {
    byId,
    latest: argvList(errors, "resume.latest", value["latest"]),
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
  if (command !== null && !isBareHarnessCommand(command)) {
    errors.add("command", "must be a bare executable name — no path, whitespace or metacharacters");
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
      detection: { executable: command },
      surfaces,
      injection,
      sessionId,
      resume,
      events,
      launchSettings,
    },
  };
}
