import { describe, expect, it } from "vite-plus/test";

import { parseHarnessId, type HarnessId } from "../ticket";
import { claudeCodeAdapter } from "./claude-code";
import { scrubInheritedSessionEnv } from "./inherited-env";
import type { HarnessAdapter } from "./types";

/** A registered harness that stamps a marker of its own. */
function registered(sessionMarkers: readonly string[]): HarnessAdapter {
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
    sessionMarkers,
  };
}

describe("scrubInheritedSessionEnv", () => {
  it("clears the markers of an outer claude-code session", () => {
    const scrubbed = scrubInheritedSessionEnv(
      {
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "6f1c",
        CLAUDE_CODE_CHILD_SESSION: "1",
        CLAUDE_CODE_ENTRYPOINT: "cli",
        CLAUDE_CODE_BRIDGE_SESSION_ID: "9a2b",
        CLAUDE_CODE_EXECPATH: "/opt/homebrew/bin/claude",
        CLAUDE_PID: "4711",
      },
      [claudeCodeAdapter],
    );
    expect(scrubbed).toEqual({});
  });

  it("keeps credentials, user configuration and the shell's own world", () => {
    const env = {
      ANTHROPIC_API_KEY: "sk-test",
      CLAUDE_CONFIG_DIR: "/Users/x/.claude",
      HOME: "/Users/x",
      PATH: "/usr/bin:/bin",
      SHELL: "/bin/zsh",
      TMPDIR: "/var/folders/tmp/",
      LANG: "en_US.UTF-8",
      XDG_CONFIG_HOME: "/Users/x/.config",
    };
    expect(scrubInheritedSessionEnv(env, [claudeCodeAdapter])).toEqual(env);
  });

  it("clears Volli's own session contract inherited from an outer Volli", () => {
    const scrubbed = scrubInheritedSessionEnv(
      {
        VOLLI_SESSION: "outer-session",
        VOLLI_SOCKET: "/outer/volli.sock",
        VOLLI_TICKET: "VC-99",
        VOLLI_ARTIFACTS_DIR: "/outer/.volli/artifacts",
        VOLLI_PROJECT_DIR: "/outer",
        VOLLI_BIN_DIR: "/outer/bin",
        VOLLI_HARNESS_ARGV_CLAUDE_CODE: '["--settings","/outer/settings.json"]',
        VOLLI_HARNESS_BIN_CLAUDE_CODE: "/outer/bin/claude",
        HOME: "/Users/x",
      },
      [],
    );
    expect(scrubbed).toEqual({ HOME: "/Users/x" });
  });

  it("clears another agent manager's surface markers", () => {
    expect(
      scrubInheritedSessionEnv({ CMUX_SURFACE_ID: "abc", CMUX_TASK_RUN_ID: "def", USER: "x" }, []),
    ).toEqual({ USER: "x" });
  });

  it("drops keys whose value is undefined", () => {
    expect(scrubInheritedSessionEnv({ HOME: "/Users/x", EDITOR: undefined }, [])).toEqual({
      HOME: "/Users/x",
    });
  });

  it("honours the markers a registered adapter declares", () => {
    const env = { MY_HARNESS_SESSION: "1", MY_HARNESS_TOKEN: "keep-me" };
    expect(scrubInheritedSessionEnv(env, [registered(["MY_HARNESS_SESSION"])])).toEqual({
      MY_HARNESS_TOKEN: "keep-me",
    });
    // The same variable survives when no adapter present claims it — the set
    // cleared is the set of harnesses this launch actually knows about.
    expect(scrubInheritedSessionEnv(env, [registered([])])).toEqual(env);
  });

  it("returns an empty environment unchanged", () => {
    expect(scrubInheritedSessionEnv({}, [claudeCodeAdapter])).toEqual({});
  });
});
