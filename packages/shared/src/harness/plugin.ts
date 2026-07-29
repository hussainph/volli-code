/**
 * The plugin file a `plugin-config-env` harness loads, generated as source.
 *
 * This is the one injection kind whose config cannot carry a command line: it
 * names a JavaScript module, and the module is what reports. So the module has
 * to be *emitted* alongside the config that names it — a config pointing at a
 * file nothing writes loads nothing, and the harness reports forever in
 * silence while the tier still reads "hooked".
 */
import { nativeName, type HarnessEventBinding } from "./types";

/** The export name the harness calls as a plugin factory. */
const PLUGIN_EXPORT = "VolliReporter";

/**
 * What the generated module has to close over. Structurally the part of
 * `HarnessLaunchInput` a plugin needs, declared here rather than imported so
 * the renderer stays a leaf of the launch builder rather than a cycle in it.
 */
export interface EventPluginInput {
  socketPath: string;
  /** `[shimPath, "hook", slug]` — an ARRAY, and it has to stay one. */
  hookArgv: readonly string[];
}

/**
 * Native name to the canonical events it stands for. A list rather than one
 * event because a harness may signal two things at once — opencode's
 * `permission.asked` is both `input.needed` and `permission.requested` — and a
 * map keyed the other way would drop one of them.
 */
function bindingsByNative(bindings: readonly HarnessEventBinding[]): Record<string, string[]> {
  const byNative: Record<string, string[]> = {};
  for (const binding of bindings) {
    const native = nativeName(binding);
    byNative[native] = [...(byNative[native] ?? []), binding.event];
  }
  return byNative;
}

/**
 * The generated module, ready to write beside the config that names it.
 *
 * Everything harness-specific arrives as a JSON literal rather than as
 * interpolated code: the bindings are the adapter's own, so a registered
 * manifest declaring this injection kind gets a working plugin for free.
 */
export function renderEventPlugin(
  bindings: readonly HarnessEventBinding[],
  input: EventPluginInput,
): string {
  return `// Volli event plugin. Generated — edits are overwritten.
//
// Reports through the same \`volli hook\` command every other mechanism fires,
// so nothing downstream can tell a plugin-reported event from a hook-reported
// one. The argv is a literal array and is never joined: the shim's own path
// contains a space on macOS, and re-splitting it would shred it.

import { spawn } from "node:child_process";

const BINDINGS = ${JSON.stringify(bindingsByNative(bindings))};
const HOOK_ARGV = ${JSON.stringify([...input.hookArgv])};
const SOCKET_PATH = ${JSON.stringify(input.socketPath)};

// \`sessionID\` rides on nearly every event — beside the payload on most, inside
// the record on the ones that carry a whole session or message. It is how the
// session correlates at all, since no id is minted at launch for this harness.
const sessionIdOf = (properties) =>
  properties?.sessionID ?? properties?.info?.sessionID ?? properties?.info?.id ?? null;

// Awaited, and it can only resolve: a reporting failure must be invisible to
// the agent that triggered it, exactly as the hook binary's own failures are.
const report = (name, payload) =>
  new Promise((resolve) => {
    try {
      const child = spawn(
        HOOK_ARGV[0],
        [...HOOK_ARGV.slice(1), name, "--socket", SOCKET_PATH, payload],
        { stdio: "ignore" },
      );
      child.once("error", () => resolve());
      child.once("close", () => resolve());
    } catch {
      resolve();
    }
  });

export const ${PLUGIN_EXPORT} = async () => {
  return {
    event: async ({ event }) => {
      // The generic hook, not the documented blocking ones: \`permission.ask\`
      // does not fire, and the published SDK types name events the binary does
      // not send. These names came from a live dump.
      // Own keys only: \`BINDINGS["toString"]\` inherits a function, and handing
      // that to \`for...of\` would throw inside the harness's own dispatch.
      if (!Object.hasOwn(BINDINGS, event?.type)) return;
      const reported = BINDINGS[event.type];
      const sessionID = sessionIdOf(event.properties);
      const payload = JSON.stringify(
        sessionID === null ? { type: event.type } : { type: event.type, sessionID },
      );
      for (const name of reported) await report(name, payload);
    },
  };
};
`;
}
