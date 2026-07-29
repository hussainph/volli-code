/**
 * What one harness launch needs on disk, on argv, and in the environment.
 *
 * Nothing here touches the user's own harness configuration: every mechanism
 * either passes configuration on the command line or points an environment
 * variable at a Volli-owned directory, which is what makes the whole design
 * free of merges, manifests, uninstall and conflict detection.
 *
 * The switch is on `injection.kind`, never on the harness's identity. A kind
 * names both a mechanism and the native config shape that mechanism expects,
 * so a registered harness declaring `config-dir-env` gets the same treatment a
 * built-in does.
 */
import { shellSingleQuote } from "../harness-command";
import { renderEventPlugin } from "./plugin";
import { nativeName, type HarnessAdapter, type HarnessEventBinding } from "./types";

/**
 * Stands in for the Volli-owned per-harness directory
 * (`<userData>/harness/<slug>/`), which main substitutes — this package cannot
 * resolve paths. A manifest may write plugin files nowhere else.
 */
export const HARNESS_DIR_TOKEN = "{harnessDir}";

/** The generated plugin's name inside the Volli-owned per-harness directory. */
const PLUGIN_FILENAME = "volli-plugin.js";

const HOOKS_MECHANISM = "hooks";
const NOTIFY_MECHANISM = "notify";

export interface HarnessLaunchInput {
  socketPath: string;
  /**
   * The argv a hook runs, before the event name — `[shimPath, "hook", slug]`.
   *
   * Argv rather than a command string, because both forms this becomes are
   * hostile to one. On macOS the shim lives under `Application Support/Volli
   * Code/`, so a joined string would have to be re-split on spaces to reach
   * codex's `notify` key (which takes a real array) and would have to survive a
   * shell unquoted everywhere else. Splitting a path on spaces shreds it; the
   * array never had the problem.
   */
  hookArgv: readonly string[];
}

export interface HarnessLaunchConfig {
  files: readonly { path: string; content: string }[];
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
}

/** A harness slug shouted into the shape an environment-variable name can take. */
export function harnessEnvSuffix(adapter: HarnessAdapter): string {
  return adapter.id.toUpperCase().replaceAll("-", "_");
}

/**
 * The full argv a hook fires. The socket travels here rather than only in the
 * environment because not every harness runs its hooks in a shell that
 * inherited ours.
 */
function hookArgv(input: HarnessLaunchInput, binding: HarnessEventBinding): readonly string[] {
  return [...input.hookArgv, binding.event, "--socket", input.socketPath];
}

/**
 * The same argv as one shell command line. Every word is quoted, not just the
 * socket: the shim's own path contains spaces on macOS, so an unquoted prefix
 * would send the shell looking for a command named `…/Application`.
 */
function hookCommandLine(input: HarnessLaunchInput, binding: HarnessEventBinding): string {
  return hookArgv(input, binding).map(shellSingleQuote).join(" ");
}

/**
 * The mechanism a native name is namespaced to. Only a harness whose signals
 * arrive by more than one route needs the prefix, so a bare name means the
 * ordinary hooks file rather than nothing at all — a manifest that never heard
 * of the namespace still gets its events delivered.
 */
function mechanismOf(binding: HarnessEventBinding): string {
  const separator = binding.native.indexOf(":");
  return separator === -1 ? HOOKS_MECHANISM : binding.native.slice(0, separator);
}

/**
 * A fresh object with NO prototype, for every object a manifest supplies keys
 * to. On a plain `{}`, a manifest's key is not necessarily a key at all:
 * assigning `__proto__` invokes an inherited setter and re-parents the object
 * (one level into a walk, that is a write onto `Object.prototype` itself, for
 * the whole main process), and reading `constructor` back yields a function
 * where the code below expects an array it can push onto. With no prototype
 * there is nothing to inherit and a key is only ever a key.
 *
 * The manifest parser refuses those names outright — this is the layer that
 * means neither refusal is load-bearing alone, and it is also what protects the
 * built-in adapters, which never pass through the parser.
 */
function bareObject<T = unknown>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * Sets a dotted path on a JSON object, creating the objects it passes through
 * and reusing any already there, so two forced settings sharing a prefix land
 * in one object rather than clobbering each other. Leaves are always scalars
 * and never `null`, so the `typeof next === "object"` test on the way down
 * cannot mistake a leaf for a branch to descend into.
 *
 * Own properties only, and prototype-free objects the whole way down: a path
 * segment naming the prototype chain has to land as an ordinary key here rather
 * than reaching anything shared.
 */
function setDotted(
  target: Record<string, unknown>,
  path: string,
  value: string | number | boolean,
): void {
  const segments = path.split(".");
  let cursor = target;
  for (const [index, segment] of segments.entries()) {
    if (index === segments.length - 1) {
      cursor[segment] = value;
      return;
    }
    const next = Object.hasOwn(cursor, segment) ? cursor[segment] : undefined;
    const child = typeof next === "object" ? (next as Record<string, unknown>) : bareObject();
    cursor[segment] = child;
    cursor = child;
  }
}

/**
 * Claude Code's settings shape: every native event holds matcher groups, each
 * holding command hooks, and the timeout is in seconds.
 */
function claudeHooks(
  bindings: readonly HarnessEventBinding[],
  input: HarnessLaunchInput,
): Record<string, unknown> {
  const hooks = bareObject<unknown[]>();
  for (const binding of bindings) {
    const group = hooks[nativeName(binding)] ?? [];
    group.push({
      hooks: [
        {
          type: "command",
          command: hookCommandLine(input, binding),
          timeout: Math.ceil(binding.timeoutMs / 1000),
        },
      ],
    });
    hooks[nativeName(binding)] = group;
  }
  return hooks;
}

/**
 * The subset of TOML a `-c` override value needs. Numbers are absent on
 * purpose: the one numeric field codex's hook handler accepts is `timeout`, a
 * bare `u64` whose unit the binary does not state, and guessing wrong by the
 * factor between seconds and milliseconds either lets a wedged hook hang or
 * kills every hook before it opens the socket. Omitted, codex's own default
 * applies.
 */
type TomlInline = string | boolean | readonly TomlInline[] | { readonly [key: string]: TomlInline };

/**
 * A TOML inline value. Strings go through `JSON.stringify` because a TOML basic
 * string and a JSON string agree on every escape a path or a socket can
 * contain — and `-c` parses TOML, where JSON's `key: value` is a syntax error.
 */
function tomlInline(value: TomlInline): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlInline).join(",")}]`;
  const table = value as { readonly [key: string]: TomlInline };
  return `{${Object.entries(table)
    .map(([key, inner]) => `${key}=${tomlInline(inner)}`)
    .join(",")}}`;
}

/**
 * Codex's hooks, as one `-c hooks.<Event>=…` override each. Hooks are an inline
 * table in codex's own config — there is no key naming an external hooks file,
 * and because codex ignores unknown keys without `--strict-config`, pointing at
 * one reported nothing and said nothing about it.
 *
 * Bindings are grouped by native name before rendering: `-c` is last-write-wins
 * per key, so two events sharing one native name (codex says a human is
 * blocking only by asking permission, which is both `permission.requested` and
 * `input.needed`) have to arrive as two matcher groups of a single override or
 * the first is silently dropped.
 *
 * `matcher` is left off — it is optional, and the events bound here have no
 * tool name to filter on. `command` is a single string, not an argv array,
 * which is why it goes through the shell-quoting `hookCommandLine` does: the
 * shim lives under `Application Support/`, and an unquoted path is shredded on
 * the only OS we ship.
 */
function codexHookOverrides(
  bindings: readonly HarnessEventBinding[],
  input: HarnessLaunchInput,
): string[] {
  const groups = new Map<string, TomlInline[]>();
  for (const binding of bindings) {
    const native = nativeName(binding);
    const group = groups.get(native) ?? [];
    group.push({
      hooks: [
        {
          type: "command",
          command: hookCommandLine(input, binding),
          // Codex is the one mechanism that can express what `delivery` means.
          async: binding.delivery === "async",
        },
      ],
    });
    groups.set(native, group);
  }
  return [...groups].map(([native, value]) => `hooks.${native}=${tomlInline(value)}`);
}

/** The flatter `{ native: [{ command }] }` shape cursor uses. */
function commandHooks(
  bindings: readonly HarnessEventBinding[],
  input: HarnessLaunchInput,
): Record<string, unknown> {
  const hooks = bareObject<unknown[]>();
  for (const binding of bindings) {
    const group = hooks[nativeName(binding)] ?? [];
    group.push({ command: hookCommandLine(input, binding) });
    hooks[nativeName(binding)] = group;
  }
  return hooks;
}

function settingsObject(
  adapter: HarnessAdapter,
  hooks: Record<string, unknown>,
): Record<string, unknown> {
  const settings = bareObject();
  if (Object.keys(hooks).length > 0) settings["hooks"] = hooks;
  for (const setting of adapter.launchSettings) setDotted(settings, setting.path, setting.value);
  return settings;
}

function injected(adapter: HarnessAdapter, input: HarnessLaunchInput): HarnessLaunchConfig {
  const { injection } = adapter;
  switch (injection.kind) {
    case "none": {
      return { files: [], argv: [], env: {} };
    }
    case "argv-settings-json": {
      const settings = settingsObject(adapter, claudeHooks(adapter.events, input));
      return { files: [], argv: [injection.flag, JSON.stringify(settings)], env: {} };
    }
    case "argv-config-override": {
      // Two mechanisms, one harness, and nothing written to disk: hook bindings
      // become an inline `hooks` table, notify bindings the legacy argv key.
      const hooked = adapter.events.filter((binding) => mechanismOf(binding) === HOOKS_MECHANISM);
      const notified = adapter.events.filter(
        (binding) => mechanismOf(binding) === NOTIFY_MECHANISM,
      );
      const overrides = codexHookOverrides(hooked, input);
      for (const binding of notified) {
        overrides.push(`notify=${JSON.stringify(hookArgv(input, binding))}`);
      }
      for (const setting of adapter.launchSettings) {
        overrides.push(`${setting.path}=${JSON.stringify(setting.value)}`);
      }
      return {
        files: [],
        argv: overrides.flatMap((override) => [injection.flag, override]),
        env: {},
      };
    }
    case "config-dir-env": {
      const settings = settingsObject(adapter, commandHooks(adapter.events, input));
      return {
        files: [
          {
            path: `${HARNESS_DIR_TOKEN}/${injection.filename}`,
            content: `${JSON.stringify(settings, null, 2)}\n`,
          },
        ],
        argv: [],
        // The variable names a DIRECTORY; the harness finds the file inside it.
        env: { [injection.envVar]: HARNESS_DIR_TOKEN },
      };
    }
    case "plugin-config-env": {
      // A plugin, not a command hook: the config can only NAME a module, so the
      // module is emitted here too. Naming one nothing writes would leave the
      // harness loading a file that does not exist — reporting nothing, while
      // still declaring bindings and so still reading as Hooked.
      const settings = settingsObject(adapter, {});
      const pluginPath = `${HARNESS_DIR_TOKEN}/${PLUGIN_FILENAME}`;
      settings["plugin"] = [pluginPath];
      const path = `${HARNESS_DIR_TOKEN}/${injection.filename}`;
      return {
        files: [
          { path, content: `${JSON.stringify(settings, null, 2)}\n` },
          { path: pluginPath, content: renderEventPlugin(adapter.events, input) },
        ],
        argv: [],
        // The variable names the FILE itself, layered over the user's config.
        env: { [injection.envVar]: path },
      };
    }
  }
}

/**
 * Everything a launch of `adapter` needs: files to materialize under the
 * Volli-owned harness directory, argv to prepend to the user's own, and
 * environment to merge into the session's.
 *
 * Session-independent by construction, and deliberately so — the harness
 * session id is `VOLLI_SESSION`, injected by the wrapper at run time, so this
 * config can be built once and reused for every launch of the same harness.
 */
export function buildLaunchConfig(
  adapter: HarnessAdapter,
  input: HarnessLaunchInput,
): HarnessLaunchConfig {
  return injected(adapter, input);
}
