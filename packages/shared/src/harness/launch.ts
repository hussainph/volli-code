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
import type { HarnessAdapter, HarnessEventBinding } from "./types";

/**
 * Stands in for the Volli-owned per-harness directory
 * (`<userData>/harness/<slug>/`), which main substitutes — this package cannot
 * resolve paths. A manifest may write plugin files nowhere else.
 */
export const HARNESS_DIR_TOKEN = "{harnessDir}";

/**
 * Codex's config key naming an external hooks file. PROVISIONAL alongside the
 * rest of the codex injection path; codex ignores unrecognized keys without
 * `--strict-config`, so a wrong guess here fails silently.
 */
const CODEX_HOOKS_PATH_KEY = "hooks_path";

const HOOKS_MECHANISM = "hooks";
const NOTIFY_MECHANISM = "notify";

export interface HarnessLaunchInput {
  socketPath: string;
  /** The command prefix a hook runs; the canonical event name is appended to it. */
  hookCommand: string;
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
 * The command line a hook fires. The socket travels on the command line rather
 * than only in the environment because not every harness runs its hooks in a
 * shell that inherited ours.
 */
function hookCommandLine(input: HarnessLaunchInput, binding: HarnessEventBinding): string {
  return `${input.hookCommand} ${binding.event} --socket ${shellSingleQuote(input.socketPath)}`;
}

/** The harness's own name for a signal, with any mechanism namespace stripped. */
function nativeName(binding: HarnessEventBinding): string {
  const separator = binding.native.indexOf(":");
  return separator === -1 ? binding.native : binding.native.slice(separator + 1);
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
 * Sets a dotted path on a plain JSON object, creating the objects it passes
 * through and reusing any already there, so two forced settings sharing a
 * prefix land in one object rather than clobbering each other. Leaves are
 * always strings, so nothing on the way down can be `null`.
 */
function setDotted(target: Record<string, unknown>, path: string, value: string): void {
  const segments = path.split(".");
  let cursor = target;
  for (const [index, segment] of segments.entries()) {
    if (index === segments.length - 1) {
      cursor[segment] = value;
      return;
    }
    const next = cursor[segment];
    const child = typeof next === "object" ? (next as Record<string, unknown>) : {};
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
  const hooks: Record<string, unknown[]> = {};
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

/** The flatter `{ native: [{ command }] }` shape cursor and codex both use. */
function commandHooks(
  bindings: readonly HarnessEventBinding[],
  input: HarnessLaunchInput,
): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {};
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
  const settings: Record<string, unknown> = Object.keys(hooks).length > 0 ? { hooks } : {};
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
      // Two mechanisms, one harness: namespaced bindings go to their own file,
      // everything else is a `key=value` override.
      const hooked = adapter.events.filter((binding) => mechanismOf(binding) === HOOKS_MECHANISM);
      const notified = adapter.events.filter(
        (binding) => mechanismOf(binding) === NOTIFY_MECHANISM,
      );
      const overrides: string[] = [];
      const files: { path: string; content: string }[] = [];
      if (hooked.length > 0) {
        const path = `${HARNESS_DIR_TOKEN}/hooks.json`;
        files.push({
          path,
          content: `${JSON.stringify({ hooks: commandHooks(hooked, input) }, null, 2)}\n`,
        });
        overrides.push(`${CODEX_HOOKS_PATH_KEY}=${path}`);
      }
      for (const binding of notified) {
        overrides.push(
          `notify=${JSON.stringify([...input.hookCommand.split(" "), binding.event])}`,
        );
      }
      for (const setting of adapter.launchSettings) {
        overrides.push(`${setting.path}=${setting.value}`);
      }
      return {
        files,
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
      // A plugin, not a command hook: the config only has to name it, and the
      // plugin reaches Volli over VOLLI_SOCKET like everything else does.
      const settings = settingsObject(adapter, {});
      settings["plugin"] = [`${HARNESS_DIR_TOKEN}/volli-plugin.js`];
      const path = `${HARNESS_DIR_TOKEN}/${injection.filename}`;
      return {
        files: [{ path, content: `${JSON.stringify(settings, null, 2)}\n` }],
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
