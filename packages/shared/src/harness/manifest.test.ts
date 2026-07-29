import { describe, expect, it } from "vite-plus/test";

import { harnessBaselineActions } from "./core";
import { parseHarnessManifest, type ManifestParse } from "./manifest";
import { harnessTier } from "./types";

/** The smallest manifest that can produce an adapter: a Declared-tier harness. */
function minimal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    slug: "my-harness",
    label: "My Harness",
    command: "my-harness",
    ...overrides,
  };
}

/** Just the paths, in order — the part a human or an agent navigates by. */
function errorPaths(result: ManifestParse): string[] {
  return result.ok ? [] : result.errors.map((error) => error.path);
}

describe("parseHarnessManifest", () => {
  it("turns a minimal manifest into a Declared-tier adapter", () => {
    const result = parseHarnessManifest(minimal());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.adapter.id).toBe("my-harness");
    expect(result.adapter.label).toBe("My Harness");
    expect(result.adapter.command).toBe("my-harness");
    expect(result.adapter.detection.executable).toBe("my-harness");
    expect(result.adapter.injection).toEqual({ kind: "none" });
    expect(result.adapter.events).toEqual([]);
  });

  it("rejects anything that is not a JSON object", () => {
    for (const raw of [null, 42, "harness", ["my-harness"]]) {
      const result = parseHarnessManifest(raw);
      expect(result).toEqual({
        ok: false,
        errors: [{ path: "", message: "must be a JSON object" }],
      });
    }
  });

  it("refuses a manifest version it does not understand", () => {
    expect(errorPaths(parseHarnessManifest(minimal({ manifestVersion: 2 })))).toEqual([
      "manifestVersion",
    ]);
    expect(errorPaths(parseHarnessManifest(minimal({ manifestVersion: "1" })))).toEqual([
      "manifestVersion",
    ]);
  });

  it("reports every bad identity field at once, each with its own path", () => {
    const result = parseHarnessManifest({ manifestVersion: 1, slug: 7, label: "", command: null });
    expect(errorPaths(result)).toEqual(["slug", "label", "command"]);
  });

  it("refuses a slug that could not name a directory or an env-var suffix", () => {
    expect(errorPaths(parseHarnessManifest(minimal({ slug: "My Harness" })))).toEqual(["slug"]);
  });

  it("refuses a slug that would shadow a harness Volli ships", () => {
    expect(errorPaths(parseHarnessManifest(minimal({ slug: "codex" })))).toEqual(["slug"]);
  });

  it("refuses a command that is anything but a bare executable name", () => {
    for (const command of ["/usr/local/bin/harness", "my harness", "harness; rm -rf /", "../ha"]) {
      expect(errorPaths(parseHarnessManifest(minimal({ command })))).toEqual(["command"]);
    }
  });

  it("refuses a command that would shadow Volli's own launcher", () => {
    expect(errorPaths(parseHarnessManifest(minimal({ command: "volli" })))).toEqual(["command"]);
  });

  it("reads the prompt flag, and defaults it to a positional prompt", () => {
    const flagged = parseHarnessManifest(minimal({ promptFlag: "--prompt" }));
    expect(flagged.ok && flagged.adapter.promptFlag).toBe("--prompt");
    const positional = parseHarnessManifest(minimal({ promptFlag: null }));
    expect(positional.ok && positional.adapter.promptFlag).toBeNull();
  });

  it("refuses a prompt flag that is not one argv word", () => {
    expect(errorPaths(parseHarnessManifest(minimal({ promptFlag: "--prompt --now" })))).toEqual([
      "promptFlag",
    ]);
    expect(errorPaths(parseHarnessManifest(minimal({ promptFlag: 3 })))).toEqual(["promptFlag"]);
  });

  it("reads the asset surfaces a harness declares", () => {
    const result = parseHarnessManifest(
      minimal({
        surfaces: {
          skillsDir: "{home}/.my-harness/skills",
          commandsDir: null,
          instructionsFile: "{home}/.my-harness/AGENTS.md",
        },
      }),
    );
    expect(result.ok && result.adapter.surfaces).toEqual({
      skillsDir: "{home}/.my-harness/skills",
      commandsDir: null,
      instructionsFile: "{home}/.my-harness/AGENTS.md",
    });
  });

  it("refuses a surface path that is not rooted at the home token", () => {
    expect(
      errorPaths(parseHarnessManifest(minimal({ surfaces: { skillsDir: "/etc/skills" } }))),
    ).toEqual(["surfaces.skillsDir"]);
  });

  it("refuses a surface path that walks back out of the home directory", () => {
    expect(
      errorPaths(
        parseHarnessManifest(minimal({ surfaces: { commandsDir: "{home}/../../etc/commands" } })),
      ),
    ).toEqual(["surfaces.commandsDir"]);
  });

  it("refuses surfaces that are not an object", () => {
    expect(errorPaths(parseHarnessManifest(minimal({ surfaces: "everything" })))).toEqual([
      "surfaces",
    ]);
  });

  it("reads an argv injection strategy", () => {
    const result = parseHarnessManifest(
      minimal({ injection: { kind: "argv-settings-json", flag: "--settings" } }),
    );
    expect(result.ok && result.adapter.injection).toEqual({
      kind: "argv-settings-json",
      flag: "--settings",
    });
  });

  it("reads an environment injection strategy", () => {
    const result = parseHarnessManifest(
      minimal({
        injection: {
          kind: "plugin-config-env",
          envVar: "MY_HARNESS_CONFIG",
          filename: "volli.json",
        },
      }),
    );
    expect(result.ok && result.adapter.injection).toEqual({
      kind: "plugin-config-env",
      envVar: "MY_HARNESS_CONFIG",
      filename: "volli.json",
    });
  });

  it("reads the config-override and config-directory strategies too", () => {
    const override = parseHarnessManifest(
      minimal({ injection: { kind: "argv-config-override", flag: "-c" } }),
    );
    expect(override.ok && override.adapter.injection).toEqual({
      kind: "argv-config-override",
      flag: "-c",
    });
    const dir = parseHarnessManifest(
      minimal({
        injection: { kind: "config-dir-env", envVar: "MY_CONFIG_DIR", filename: "cli-config.json" },
      }),
    );
    expect(dir.ok && dir.adapter.injection).toEqual({
      kind: "config-dir-env",
      envVar: "MY_CONFIG_DIR",
      filename: "cli-config.json",
    });
  });

  it("takes an explicitly declared absence of injection", () => {
    const result = parseHarnessManifest(minimal({ injection: { kind: "none" } }));
    expect(result.ok && result.adapter.injection).toEqual({ kind: "none" });
  });

  it("refuses a nested block that is not an object", () => {
    for (const key of ["injection", "sessionId", "resume"]) {
      expect(errorPaths(parseHarnessManifest(minimal({ [key]: "hooked" })))).toEqual([key]);
    }
  });

  it("refuses a surface that is not a path string", () => {
    expect(errorPaths(parseHarnessManifest(minimal({ surfaces: { skillsDir: 12 } })))).toEqual([
      "surfaces.skillsDir",
    ]);
  });

  it("refuses an injection kind Volli has no mechanism for", () => {
    expect(
      errorPaths(parseHarnessManifest(minimal({ injection: { kind: "global-merge" } }))),
    ).toEqual(["injection.kind"]);
  });

  it("refuses an argv injection with no flag to carry it", () => {
    expect(
      errorPaths(parseHarnessManifest(minimal({ injection: { kind: "argv-config-override" } }))),
    ).toEqual(["injection.flag"]);
  });

  it("refuses a config filename that would escape Volli's own harness directory", () => {
    for (const filename of ["../../.claude/settings.json", "nested/volli.json", ".."]) {
      expect(
        errorPaths(
          parseHarnessManifest(
            minimal({ injection: { kind: "config-dir-env", envVar: "MY_CONFIG_DIR", filename } }),
          ),
        ),
      ).toEqual(["injection.filename"]);
    }
  });

  it("reads a session id Volli mints at spawn", () => {
    const result = parseHarnessManifest(
      minimal({ sessionId: { kind: "argv", flag: "--session-id", format: "uuid" } }),
    );
    expect(result.ok && result.adapter.sessionId).toEqual({
      kind: "argv",
      flag: "--session-id",
      format: "uuid",
    });
  });

  it("reads a session id the harness reports on its own events", () => {
    const result = parseHarnessManifest(minimal({ sessionId: { kind: "reported" } }));
    expect(result.ok && result.adapter.sessionId).toEqual({ kind: "reported" });
  });

  it("refuses a session-id source Volli cannot read", () => {
    expect(
      errorPaths(parseHarnessManifest(minimal({ sessionId: { kind: "rollout-file" } }))),
    ).toEqual(["sessionId.kind"]);
    expect(errorPaths(parseHarnessManifest(minimal({ sessionId: { kind: "argv" } })))).toEqual([
      "sessionId.flag",
    ]);
  });

  it("reads the resume argv a harness declares", () => {
    const result = parseHarnessManifest(
      minimal({
        resume: {
          byId: ["--resume", "{id}"],
          latest: ["--continue"],
          userResumeTokens: ["--resume", "-r"],
        },
      }),
    );
    expect(result.ok && result.adapter.resume).toEqual({
      byId: ["--resume", "{id}"],
      latest: ["--continue"],
      userResumeTokens: ["--resume", "-r"],
    });
  });

  it("refuses a by-id resume template with no place to put the id", () => {
    expect(errorPaths(parseHarnessManifest(minimal({ resume: { byId: ["--resume"] } })))).toEqual([
      "resume.byId",
    ]);
  });

  it("refuses a by-id resume template that would substitute the id twice", () => {
    expect(
      errorPaths(parseHarnessManifest(minimal({ resume: { byId: ["--resume", "{id}", "{id}"] } }))),
    ).toEqual(["resume.byId"]);
  });

  it("refuses resume argv that is not a list of argv words", () => {
    expect(errorPaths(parseHarnessManifest(minimal({ resume: { latest: "--continue" } })))).toEqual(
      ["resume.latest"],
    );
    expect(
      errorPaths(parseHarnessManifest(minimal({ resume: { userResumeTokens: [7] } }))),
    ).toEqual(["resume.userResumeTokens"]);
  });

  it("refuses an environment variable name a shell would not accept", () => {
    expect(
      errorPaths(
        parseHarnessManifest(
          minimal({
            injection: { kind: "config-dir-env", envVar: "my config", filename: "volli.json" },
          }),
        ),
      ),
    ).toEqual(["injection.envVar"]);
  });

  it("reads the event bindings a harness claims", () => {
    const result = parseHarnessManifest(
      minimal({
        events: [
          { event: "input.needed", native: "Notification", delivery: "async", timeoutMs: 5000 },
          { event: "turn.completed", native: "notify:done", delivery: "sync", timeoutMs: 1000 },
        ],
      }),
    );
    expect(result.ok && result.adapter.events).toEqual([
      { event: "input.needed", native: "Notification", delivery: "async", timeoutMs: 5000 },
      { event: "turn.completed", native: "notify:done", delivery: "sync", timeoutMs: 1000 },
    ]);
  });

  it("names the offending binding by index", () => {
    const result = parseHarnessManifest(
      minimal({
        events: [
          { event: "input.needed", native: "Notification", delivery: "async", timeoutMs: 5000 },
          { event: "agent.vibed", native: "Vibe", delivery: "async", timeoutMs: 5000 },
        ],
      }),
    );
    expect(errorPaths(result)).toEqual(["events[1].event"]);
  });

  it("refuses a binding Volli could not deliver or would wait forever on", () => {
    const bad = (binding: Record<string, unknown>): string[] =>
      errorPaths(parseHarnessManifest(minimal({ events: [binding] })));
    const base = { event: "turn.started", native: "Start", delivery: "async", timeoutMs: 5000 };
    expect(bad({ ...base, native: "" })).toEqual(["events[0].native"]);
    expect(bad({ ...base, delivery: "whenever" })).toEqual(["events[0].delivery"]);
    expect(bad({ ...base, timeoutMs: 0 })).toEqual(["events[0].timeoutMs"]);
    expect(bad({ ...base, timeoutMs: 1000.5 })).toEqual(["events[0].timeoutMs"]);
    expect(bad({ ...base, timeoutMs: 60 * 60 * 1000 })).toEqual(["events[0].timeoutMs"]);
    expect(bad(["turn.started"] as unknown as Record<string, unknown>)).toEqual(["events[0]"]);
  });

  it("refuses events that are not a list", () => {
    expect(errorPaths(parseHarnessManifest(minimal({ events: { stop: "Stop" } })))).toEqual([
      "events",
    ]);
  });

  it("reads the harness-native settings Volli forces at launch, types intact", () => {
    const result = parseHarnessManifest(
      minimal({
        launchSettings: [
          { path: "preferredNotifChannel", value: "notifications_disabled" },
          { path: "hooks.failClosed", value: false },
          { path: "hooks.retries", value: 2 },
        ],
      }),
    );
    expect(result.ok && result.adapter.launchSettings).toEqual([
      { path: "preferredNotifChannel", value: "notifications_disabled" },
      { path: "hooks.failClosed", value: false },
      { path: "hooks.retries", value: 2 },
    ]);
  });

  it("refuses a launch setting that is not a dotted path to a scalar", () => {
    const bad = (setting: unknown): string[] =>
      errorPaths(parseHarnessManifest(minimal({ launchSettings: [setting] })));
    expect(bad({ path: "hooks..failClosed", value: true })).toEqual(["launchSettings[0].path"]);
    expect(bad({ path: "hooks failClosed", value: true })).toEqual(["launchSettings[0].path"]);
    expect(bad({ path: "hooks.timeout", value: { ms: 5 } })).toEqual(["launchSettings[0].value"]);
    expect(bad({ path: "hooks.timeout", value: null })).toEqual(["launchSettings[0].value"]);
    expect(bad("hooks.timeout=5")).toEqual(["launchSettings[0]"]);
    expect(errorPaths(parseHarnessManifest(minimal({ launchSettings: {} })))).toEqual([
      "launchSettings",
    ]);
  });
});

describe("a manifest-derived adapter", () => {
  const registered = parseHarnessManifest(
    minimal({
      injection: { kind: "argv-settings-json", flag: "--settings" },
      surfaces: { skillsDir: "{home}/.my-harness/skills", instructionsFile: "{home}/AGENTS.md" },
      events: [
        { event: "input.needed", native: "Notification", delivery: "async", timeoutMs: 5000 },
      ],
    }),
  );

  it("reaches the Hooked tier on what it declares, with no identity check anywhere", () => {
    expect(registered.ok && harnessTier(registered.adapter)).toBe("hooked");
  });

  it("earns the same baseline assets a built-in with those surfaces earns", () => {
    if (!registered.ok) throw new Error("expected a valid manifest");
    expect(harnessBaselineActions({ home: "/home/dev", adapters: [registered.adapter] })).toEqual(
      harnessBaselineActions({
        home: "/home/dev",
        adapters: [{ ...registered.adapter, id: "codex", label: "Codex", command: "codex" }],
      }),
    );
  });
});
