import { describe, expect, it } from "vite-plus/test";

import { PLUGIN_LOAD_NATIVE, renderEventPlugin } from "./plugin";
import type { HarnessEventBinding } from "./types";

const INPUT = {
  socketPath: "/tmp/volli.sock",
  hookArgv: ["/vol/Application Support/Volli Code/bin/volli", "hook", "opencode"],
} as const;

const BINDINGS: readonly HarnessEventBinding[] = [
  { event: "turn.completed", native: "session.idle", delivery: "async" },
  { event: "input.needed", native: "hooks:permission.asked", delivery: "async" },
];

interface PluginModule {
  VolliReporter: () => Promise<{ event: (input: { event: unknown }) => Promise<void> }>;
}

/**
 * Loads the generated source as the module a harness would load it as.
 *
 * A data URL rather than a file on disk, because this package may not import
 * Node — and it buys more than a file would anyway: the module is parsed,
 * linked and evaluated, so a syntax error, an unresolvable import and a
 * throwing top level all surface here. Every other assertion about generated
 * code is a string match, and a template emitting broken JavaScript satisfies
 * all of them while failing in front of a user.
 */
async function load(source: string): Promise<PluginModule> {
  return (await import(
    /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(source)}`
  )) as PluginModule;
}

describe("renderEventPlugin", () => {
  it("emits a module a runtime can parse, link and evaluate", async () => {
    await expect(load(renderEventPlugin(BINDINGS, INPUT))).resolves.toBeDefined();
  });

  it("is checked by something that can fail", async () => {
    // The control for the test above: a check that quietly passed anything
    // would be worth less than no check, because it would read as proof.
    await expect(load("export const Broken = async () => {")).rejects.toThrow();
  });

  it("exports an async factory returning the generic event hook", async () => {
    const module = await load(renderEventPlugin(BINDINGS, INPUT));
    const hooks = await module.VolliReporter();
    // The generic hook, not the documented blocking ones — `permission.ask`
    // never fires, so observing `event` is the only route that works.
    expect(typeof hooks.event).toBe("function");
  });

  it("listens for the native name alone, never the mechanism prefix it carries", () => {
    const source = renderEventPlugin(BINDINGS, INPUT);
    expect(source).toContain('"permission.asked"');
    expect(source).not.toContain("hooks:permission.asked");
  });

  it("reports a bound event and ignores an unbound one", async () => {
    const module = await load(
      renderEventPlugin(BINDINGS, { ...INPUT, hookArgv: ["/usr/bin/true", "hook", "x"] }),
    );
    const hooks = await module.VolliReporter();
    await expect(
      hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } }),
    ).resolves.toBeUndefined();
    await expect(hooks.event({ event: { type: "todo.updated" } })).resolves.toBeUndefined();
  });

  it("ignores an event type that names something every object inherits", async () => {
    const module = await load(renderEventPlugin(BINDINGS, INPUT));
    const hooks = await module.VolliReporter();
    // `BINDINGS["toString"]` is a function on an object literal, and a plain
    // truthiness test would hand it to `for...of` and throw inside the
    // harness's own dispatch — the one thing a reporter may never do.
    await expect(hooks.event({ event: { type: "toString" } })).resolves.toBeUndefined();
  });

  // opencode's stream has no launch-time event, so the factory call is the
  // startup signal. It must not also land in the event map: `plugin:load` would
  // key it under `load`, and any harness event named `load` would report a
  // second, false, session start.
  it("reports a plugin-load binding when the factory runs, and never from the stream", async () => {
    const source = renderEventPlugin(
      [...BINDINGS, { event: "session.started", native: PLUGIN_LOAD_NATIVE, delivery: "async" }],
      { ...INPUT, hookArgv: ["/usr/bin/true", "hook", "x"] },
    );
    expect(source).toContain('const LOAD_EVENTS = ["session.started"]');
    expect(source).not.toContain('"load":');
    const module = await load(source);
    await expect(module.VolliReporter()).resolves.toBeDefined();
  });

  it("has no load report to make when nothing binds one", () => {
    expect(renderEventPlugin(BINDINGS, INPUT)).toContain("const LOAD_EVENTS = []");
  });

  it("survives a hook binary that isn't there, because a report may not break the agent", async () => {
    const module = await load(
      renderEventPlugin(BINDINGS, { ...INPUT, hookArgv: ["/nonexistent/volli", "hook", "x"] }),
    );
    const hooks = await module.VolliReporter();
    // No session id on this one either: the payload has to stay valid JSON
    // whether or not the harness named a session.
    await expect(hooks.event({ event: { type: "session.idle" } })).resolves.toBeUndefined();
  });
});
