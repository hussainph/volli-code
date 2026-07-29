import { describe, expect, it } from "vite-plus/test";

import { parseHarnessId, type HarnessId } from "../ticket";
import { getHarnessAdapter } from "./core";
import { buildLaunchConfig, harnessEnvSuffix, HARNESS_DIR_TOKEN } from "./launch";
import type { HarnessAdapter } from "./types";

const INPUT = {
  socketPath: "/tmp/volli.sock",
  hookCommand: "/vol/bin/volli hook",
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
      "/vol/bin/volli hook turn.completed --socket '/tmp/volli.sock'",
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

  it("points cursor at a Volli-owned config directory, leaving its auth where it is", () => {
    const config = buildLaunchConfig(adapterFor("cursor"), INPUT);
    expect(config.env["CURSOR_CONFIG_DIR"]).toBe(HARNESS_DIR_TOKEN);
    expect(config.files.map((file) => file.path)).toEqual([`${HARNESS_DIR_TOKEN}/cli-config.json`]);

    const written = JSON.parse(config.files[0]?.content ?? "{}") as {
      hooks: Record<string, { command: string }[]>;
    };
    expect(written.hooks["stop"]?.[0]?.command).toBe(
      "/vol/bin/volli hook turn.completed --socket '/tmp/volli.sock'",
    );
    expect(Object.keys(written.hooks)).not.toContain("Notification");
  });

  it("layers opencode's config over the user's and names the plugin that does the reporting", () => {
    const config = buildLaunchConfig(adapterFor("opencode"), INPUT);
    expect(config.env["OPENCODE_CONFIG"]).toBe(`${HARNESS_DIR_TOKEN}/opencode.json`);

    const written = JSON.parse(config.files[0]?.content ?? "{}") as { plugin: string[] };
    expect(written.plugin).toEqual([`${HARNESS_DIR_TOKEN}/volli-plugin.js`]);
  });

  it("splits codex across its two mechanisms: a hooks file and the legacy notify key", () => {
    const config = buildLaunchConfig(adapterFor("codex"), INPUT);
    const overrides = config.argv.filter((token) => token !== "-c");

    expect(config.files.map((file) => file.path)).toEqual([`${HARNESS_DIR_TOKEN}/hooks.json`]);
    const hooks = JSON.parse(config.files[0]?.content ?? "{}") as {
      hooks: Record<string, { command: string }[]>;
    };
    expect(Object.keys(hooks.hooks)).toEqual(["UserPromptSubmit", "PermissionRequest"]);
    expect(hooks.hooks["UserPromptSubmit"]?.[0]?.command).toBe(
      "/vol/bin/volli hook turn.started --socket '/tmp/volli.sock'",
    );

    expect(overrides).toContain(`hooks_path=${HARNESS_DIR_TOKEN}/hooks.json`);
    const notify = overrides.find((token) => token.startsWith("notify="));
    expect(JSON.parse(notify?.slice("notify=".length) ?? "[]")).toEqual([
      "/vol/bin/volli",
      "hook",
      "turn.completed",
    ]);
  });

  it("routes an unnamespaced binding to the hooks file, so a plain manifest still reports", () => {
    const config = buildLaunchConfig(
      bareAdapter({
        injection: { kind: "argv-config-override", flag: "-c" },
        events: [{ event: "turn.started", native: "OnPrompt", delivery: "async", timeoutMs: 1000 }],
      }),
      INPUT,
    );
    const hooks = JSON.parse(config.files[0]?.content ?? "{}") as {
      hooks: Record<string, unknown>;
    };
    expect(Object.keys(hooks.hooks)).toEqual(["OnPrompt"]);
  });

  it("carries a harness's forced settings through whichever mechanism it uses", () => {
    const config = buildLaunchConfig(
      bareAdapter({
        injection: { kind: "argv-config-override", flag: "-c" },
        launchSettings: [{ path: "notifications.enabled", value: "false" }],
      }),
      INPUT,
    );
    expect(config.argv).toEqual(["-c", "notifications.enabled=false"]);
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
      "/vol/bin/volli hook turn.completed --socket '/tmp/it'\\''s here/volli.sock'",
    );
  });
});
