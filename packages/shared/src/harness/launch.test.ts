import { describe, expect, it } from "vite-plus/test";

import { parseHarnessId, type HarnessId } from "../ticket";
import { getHarnessAdapter } from "./core";
import {
  buildLaunchConfig,
  harnessEnvSuffix,
  mergeWorkspaceFile,
  CURSOR_HOOKS_PATH,
  HARNESS_DIR_TOKEN,
} from "./launch";
import type { HarnessAdapter } from "./types";

/**
 * The shim path carries a space on purpose. Electron's `userData` on macOS is
 * `~/Library/Application Support/Volli Code`, so every launch config is built
 * from a path with one — and a fixture without it lets a path-shredding bug
 * pass every assertion here while breaking on the only OS we ship.
 */
const INPUT = {
  socketPath: "/tmp/volli.sock",
  hookArgv: ["/vol/Application Support/Volli Code/bin/volli", "hook", "codex"],
} as const;

function adapterFor(id: string): HarnessAdapter {
  const found = getHarnessAdapter(id as HarnessId);
  if (!found) throw new Error(`no adapter for ${id}`);
  return found;
}

/** A Declared-tier adapter: nothing to inject, nothing to report. */
function bareAdapter(overrides: Partial<HarnessAdapter> = {}): HarnessAdapter {
  return {
    id: parseHarnessId("my-harness") as HarnessId,
    label: "My Harness",
    command: "my-harness",
    promptFlag: null,
    detection: { executable: "my-harness" },
    surfaces: { skillsDir: null, commandsDir: null, instructionsFile: null },
    injection: { kind: "none" },
    sessionId: { kind: "none" },
    resume: { byId: null, latest: null, userResumeTokens: [] },
    events: [],
    launchSettings: [],
    sessionMarkers: [],
    ...overrides,
  };
}

describe("harnessEnvSuffix", () => {
  it("shouts a slug into the shape an environment variable name can take", () => {
    expect(harnessEnvSuffix(adapterFor("claude-code"))).toBe("CLAUDE_CODE");
    expect(harnessEnvSuffix(bareAdapter())).toBe("MY_HARNESS");
  });
});

describe("buildLaunchConfig", () => {
  it("asks nothing of a harness that accepts no configuration", () => {
    const config = buildLaunchConfig(bareAdapter(), INPUT);
    expect(config.files).toEqual([]);
    expect(config.argv).toEqual([]);
    expect(Object.keys(config.env)).toEqual([]);
  });

  it("passes claude-code its hooks inline on argv, writing no file at all", () => {
    const config = buildLaunchConfig(adapterFor("claude-code"), INPUT);
    expect(config.files).toEqual([]);
    expect(config.argv[0]).toBe("--settings");

    const settings = JSON.parse(config.argv[1] ?? "{}") as {
      hooks: Record<string, { hooks: { type: string; command: string; timeout: number }[] }[]>;
      preferredNotifChannel: string;
    };
    expect(settings.hooks["Stop"]?.[0]?.hooks[0]?.command).toBe(
      "'/vol/Application Support/Volli Code/bin/volli' 'hook' 'codex' 'turn.completed' '--socket' '/tmp/volli.sock'",
    );
    expect(settings.hooks["Stop"]?.[0]?.hooks[0]?.timeout).toBe(5);
    expect(settings.preferredNotifChannel).toBe("notifications_disabled");
  });

  it("mints no session id itself — that is the wrapper's, from VOLLI_SESSION", () => {
    const claude = buildLaunchConfig(adapterFor("claude-code"), INPUT);
    expect(claude.argv).not.toContain("--session-id");
    expect(claude.argv).toHaveLength(2);
    expect(buildLaunchConfig(adapterFor("opencode"), INPUT).argv).toEqual([]);
  });

  // The whole point of the kind: cursor's hooks reach a path relative to the
  // WORKING directory, and no environment variable and no argv flag can move
  // them. A regression here is silent — the harness launches perfectly and
  // reports nothing — so the assertions are about where the file is NOT.
  it("gives cursor a workspace hooks file and nothing else at all", () => {
    const config = buildLaunchConfig(adapterFor("cursor"), INPUT);
    expect(config.files).toEqual([]);
    expect(config.argv).toEqual([]);
    expect(config.env).toEqual({});
    expect(config.workspaceFiles.map((file) => file.path)).toEqual([CURSOR_HOOKS_PATH]);
    expect(config.workspaceFiles[0]?.path.startsWith(HARNESS_DIR_TOKEN)).toBe(false);
    expect(config.workspaceFiles[0]?.merge).toBe("cursor-hooks");

    const written = JSON.parse(config.workspaceFiles[0]?.content ?? "{}") as {
      version: number;
      hooks: Record<string, { command: string; timeout: number }[]>;
    };
    expect(written.version).toBe(1);
    expect(written.hooks["stop"]?.[0]?.command).toBe(
      "'/vol/Application Support/Volli Code/bin/volli' 'hook' 'codex' 'turn.completed' '--socket' '/tmp/volli.sock'",
    );
    // Seconds, because cursor multiplies this by 1000 before it arms the
    // timer — a millisecond value here is a hook with an 83-minute leash.
    expect(written.hooks["stop"]?.[0]?.timeout).toBe(5);
    expect(Object.keys(written.hooks)).not.toContain("Notification");
  });

  it("leaves every other harness with no workspace file to write into a repo", () => {
    for (const id of ["claude-code", "codex", "opencode"]) {
      expect(buildLaunchConfig(adapterFor(id), INPUT).workspaceFiles).toEqual([]);
    }
    expect(buildLaunchConfig(bareAdapter(), INPUT).workspaceFiles).toEqual([]);
  });

  it("still writes a config-dir-env harness into the Volli-owned directory", () => {
    const config = buildLaunchConfig(
      bareAdapter({
        injection: { kind: "config-dir-env", envVar: "MY_CONFIG_DIR", filename: "cli-config.json" },
        events: [{ event: "turn.completed", native: "stop", delivery: "async", timeoutMs: 5000 }],
      }),
      INPUT,
    );
    expect(config.env["MY_CONFIG_DIR"]).toBe(HARNESS_DIR_TOKEN);
    expect(config.files.map((file) => file.path)).toEqual([`${HARNESS_DIR_TOKEN}/cli-config.json`]);
    expect(config.workspaceFiles).toEqual([]);
  });

  it("layers opencode's config over the user's and emits the plugin it names", () => {
    const config = buildLaunchConfig(adapterFor("opencode"), INPUT);
    expect(config.env["OPENCODE_CONFIG"]).toBe(`${HARNESS_DIR_TOKEN}/opencode.json`);

    const settings = config.files.find((file) => file.path.endsWith("/opencode.json"));
    const { plugin } = JSON.parse(settings?.content ?? "{}") as { plugin: string[] };

    // The referent, not the reference: a config naming a file nothing writes
    // loads a plugin that does not exist, and the harness reports forever in
    // silence. This is the assertion the original test was missing.
    expect(config.files.map((file) => file.path)).toContain(plugin[0]);
  });

  it("carries opencode's bindings into the plugin, both events sharing one native name", () => {
    const config = buildLaunchConfig(adapterFor("opencode"), INPUT);
    const source = config.files.find((file) => file.path.endsWith(".js"))?.content ?? "";

    // The native names come from a live event dump, not the stale SDK types —
    // a plugin listening for `permission.updated` would never hear a thing.
    expect(source).toContain("session.idle");
    expect(source).toContain("permission.asked");
    expect(source).toContain("message.updated");
    expect(source).not.toContain("permission.updated");

    // One native signal, two canonical events: the plugin has to report both.
    const bindings = JSON.parse(source.match(/^const BINDINGS = (.+);$/m)?.[1] ?? "{}") as Record<
      string,
      string[]
    >;
    expect(bindings["permission.asked"]).toEqual(["input.needed", "permission.requested"]);
    expect(bindings["session.idle"]).toEqual(["turn.completed"]);
  });

  it("hands the plugin the hook argv as an array, so the spaced shim path stays one word", () => {
    const config = buildLaunchConfig(adapterFor("opencode"), INPUT);
    const source = config.files.find((file) => file.path.endsWith(".js"))?.content ?? "";

    // A JSON array literal in the source, not a joined command line: the shim
    // lives under `Application Support/`, and any form the plugin would have to
    // re-split on spaces shreds that path.
    const argv = JSON.parse(source.match(/^const HOOK_ARGV = (.+);$/m)?.[1] ?? "[]") as string[];
    expect(argv).toEqual([...INPUT.hookArgv]);
    expect(source).toContain(JSON.stringify(INPUT.socketPath));
    expect(source).not.toContain(".split(");
  });

  it("emits a registered manifest its own plugin, from the bindings it declared", () => {
    const config = buildLaunchConfig(
      bareAdapter({
        injection: { kind: "plugin-config-env", envVar: "X_CONFIG", filename: "x.json" },
        events: [
          { event: "input.needed", native: "asked-a-question", delivery: "async", timeoutMs: 1000 },
        ],
      }),
      INPUT,
    );
    const settings = config.files.find((file) => file.path.endsWith("/x.json"));
    const { plugin } = JSON.parse(settings?.content ?? "{}") as { plugin: string[] };
    const source = config.files.find((file) => file.path === plugin[0])?.content ?? "";

    // Nothing here is opencode's: a kind names a mechanism, not a harness, or
    // the manifest schema advertises an injection path that only Volli can use.
    expect(source).toContain("asked-a-question");
    expect(source).toContain("input.needed");
  });

  it("splits codex across its two mechanisms: the inline hooks table and the legacy notify key", () => {
    const config = buildLaunchConfig(adapterFor("codex"), INPUT);
    const overrides = config.argv.filter((token) => token !== "-c");

    // Codex has no key naming an external hooks file. Writing one and pointing
    // at it is what silently reported nothing for the length of this branch.
    expect(config.files).toEqual([]);

    // One override per native event, the value a TOML array of matcher groups —
    // this exact string is accepted by codex 0.144.6's own deserializer.
    expect(overrides).toContain(
      'hooks.UserPromptSubmit=[{hooks=[{type="command",' +
        "command=\"'/vol/Application Support/Volli Code/bin/volli' 'hook' 'codex' " +
        "'turn.started' '--socket' '/tmp/volli.sock'\",async=true}]}]",
    );

    // notify takes a real argv array, so the spaced shim path stays one word —
    // this is the whole reason the hook prefix travels as argv, not a string.
    const notify = overrides.find((token) => token.startsWith("notify="));
    expect(JSON.parse(notify?.slice("notify=".length) ?? "[]")).toEqual([
      "/vol/Application Support/Volli Code/bin/volli",
      "hook",
      "codex",
      "turn.completed",
      "--socket",
      "/tmp/volli.sock",
    ]);
  });

  it("gathers two events sharing one native name into a single override, not two", () => {
    // `-c` is last-write-wins per key, so emitting `hooks.PermissionRequest`
    // twice would silently drop `permission.requested` and report only the
    // second binding. Both have to arrive as matcher groups of one override.
    const overrides = buildLaunchConfig(adapterFor("codex"), INPUT).argv;
    const permission = overrides.filter((token) => token.startsWith("hooks.PermissionRequest="));
    expect(permission).toHaveLength(1);

    const groups = permission[0]?.match(/{hooks=/g) ?? [];
    expect(groups).toHaveLength(2);
    expect(permission[0]).toContain("'permission.requested'");
    expect(permission[0]).toContain("'input.needed'");
  });

  it("routes an unnamespaced binding to the inline hooks table, so a plain manifest reports", () => {
    const config = buildLaunchConfig(
      bareAdapter({
        injection: { kind: "argv-config-override", flag: "-c" },
        events: [{ event: "turn.started", native: "OnPrompt", delivery: "async", timeoutMs: 1000 }],
      }),
      INPUT,
    );
    expect(config.files).toEqual([]);
    expect(config.argv[0]).toBe("-c");
    expect(config.argv[1]?.startsWith("hooks.OnPrompt=[")).toBe(true);
  });

  it("builds codex the same bytes every time, so its hook trust gate asks once", () => {
    // Codex hashes the hook config it is trusted for. Anything varying between
    // launches re-raises an interactive review, and one wrong keypress there
    // silently disables our events for that session — so the session id reaches
    // the harness through VOLLI_SESSION, never through here.
    const first = buildLaunchConfig(adapterFor("codex"), INPUT);
    const second = buildLaunchConfig(adapterFor("codex"), INPUT);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    const hooks = first.argv.filter((token) => token.startsWith("hooks."));
    expect(hooks.length).toBeGreaterThan(0);
    expect(hooks.join(" ")).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
  });

  it("marks a blocking binding as one, since codex can say so and the rest cannot", () => {
    const config = buildLaunchConfig(
      bareAdapter({
        injection: { kind: "argv-config-override", flag: "-c" },
        events: [{ event: "input.needed", native: "Ask", delivery: "sync", timeoutMs: 1000 }],
      }),
      INPUT,
    );
    expect(config.argv[1]).toContain("async=false");
  });

  it("carries a harness's forced settings through whichever mechanism it uses", () => {
    const config = buildLaunchConfig(
      bareAdapter({
        injection: { kind: "argv-config-override", flag: "-c" },
        launchSettings: [{ path: "notifications.enabled", value: false }],
      }),
      INPUT,
    );
    // `false`, not `"false"` — `-c` parses TOML, which distinguishes the two.
    expect(config.argv).toEqual(["-c", "notifications.enabled=false"]);
  });

  it("keeps a forced string setting quoted, so TOML reads it as a string", () => {
    const config = buildLaunchConfig(
      bareAdapter({
        injection: { kind: "argv-config-override", flag: "-c" },
        launchSettings: [{ path: "notify.channel", value: "disabled" }],
      }),
      INPUT,
    );
    expect(config.argv).toEqual(["-c", 'notify.channel="disabled"']);
  });

  it("nests forced settings written as dotted paths, merging ones that share a prefix", () => {
    const config = buildLaunchConfig(
      bareAdapter({
        injection: { kind: "config-dir-env", envVar: "X_CONFIG_DIR", filename: "x.json" },
        launchSettings: [
          { path: "notifications.desktop.enabled", value: "false" },
          { path: "notifications.sound", value: "off" },
          { path: "theme", value: "dark" },
        ],
      }),
      INPUT,
    );
    expect(JSON.parse(config.files[0]?.content ?? "{}")).toEqual({
      notifications: { desktop: { enabled: "false" }, sound: "off" },
      theme: "dark",
    });
  });

  /**
   * The manifest parser refuses every name used here, so this is the OTHER
   * layer on its own: a built-in never passes through that parser, and two
   * refusals neither of which is load-bearing alone is the whole point.
   */
  describe("given prototype-chain names the parser would have refused", () => {
    const hostile = (injection: HarnessAdapter["injection"]): HarnessAdapter =>
      bareAdapter({
        injection,
        events: [
          { event: "turn.completed", native: "__proto__", delivery: "async", timeoutMs: 1000 },
          { event: "turn.started", native: "constructor", delivery: "async", timeoutMs: 1000 },
        ],
        launchSettings: [
          { path: "__proto__.polluted", value: "yes" },
          { path: "constructor.prototype.polluted", value: "yes" },
        ],
      });

    // `plugin-config-env` is absent on purpose: it renders through `plugin.ts`,
    // which still keys a plain object by native name and throws on
    // `constructor` before it can pollute anything. The parser refusal covers
    // it today; hardening that module is a separate change to a separate file.
    it("builds every mechanism it renders itself without touching Object.prototype", () => {
      const injections = [
        { kind: "argv-settings-json", flag: "--settings" },
        { kind: "argv-config-override", flag: "-c" },
        { kind: "config-dir-env", envVar: "X_CONFIG_DIR", filename: "x.json" },
      ] as const;
      for (const injection of injections) {
        // `constructor` is the half that throws rather than pollutes: on a plain
        // object it reads back a function, and `group.push` on that is a
        // TypeError inside the launch builder.
        expect(() => buildLaunchConfig(hostile(injection), INPUT)).not.toThrow();
      }
      const witness: Record<string, unknown> = {};
      expect(witness["polluted"]).toBeUndefined();
      expect("polluted" in witness).toBe(false);
    });

    it("carries the name through as data, so nothing is silently dropped either", () => {
      const config = buildLaunchConfig(
        hostile({ kind: "argv-settings-json", flag: "--settings" }),
        INPUT,
      );
      const settings = JSON.parse(config.argv[1] ?? "{}") as Record<string, unknown>;
      expect(Object.hasOwn(settings, "__proto__")).toBe(true);
      const hooks = JSON.parse(JSON.stringify(settings["hooks"] ?? {})) as Record<string, unknown>;
      expect(Object.hasOwn(hooks, "__proto__")).toBe(true);
      expect(Object.hasOwn(hooks, "constructor")).toBe(true);
    });
  });

  it("quotes a socket path that would otherwise break the hook command line", () => {
    const config = buildLaunchConfig(
      bareAdapter({
        injection: { kind: "config-dir-env", envVar: "X_CONFIG_DIR", filename: "x.json" },
        events: [{ event: "turn.completed", native: "stop", delivery: "async", timeoutMs: 1000 }],
      }),
      { ...INPUT, socketPath: "/tmp/it's here/volli.sock" },
    );
    const written = JSON.parse(config.files[0]?.content ?? "{}") as {
      hooks: Record<string, { command: string }[]>;
    };
    expect(written.hooks["stop"]?.[0]?.command).toBe(
      "'/vol/Application Support/Volli Code/bin/volli' 'hook' 'codex' 'turn.completed' '--socket' '/tmp/it'\\''s here/volli.sock'",
    );
  });
});

describe("mergeWorkspaceFile", () => {
  it("replaces outright when the file is nobody else's to share", () => {
    const file = { path: "a.json", content: "ours\n", merge: "replace" as const };
    expect(mergeWorkspaceFile(file, "theirs\n")).toEqual({ ok: true, content: "ours\n" });
  });

  it("routes cursor's file through the merge that knows its schema", () => {
    const config = buildLaunchConfig(adapterFor("cursor"), INPUT);
    const file = config.workspaceFiles[0]!;
    const merged = mergeWorkspaceFile(file, '{"version":1,"hooks":{"stop":[{"command":"mine"}]}}');
    expect(merged.ok).toBe(true);
    const hooks = (
      JSON.parse((merged as { content: string }).content) as {
        hooks: Record<string, { command: string }[]>;
      }
    ).hooks;
    expect(hooks["stop"]?.[0]?.command).toBe("mine");
    expect(hooks["stop"]).toHaveLength(2);
  });
});
