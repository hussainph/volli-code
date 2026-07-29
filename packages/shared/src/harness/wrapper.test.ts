import { describe, expect, it } from "vite-plus/test";

import { parseHarnessId, type HarnessId } from "../ticket";
import { getHarnessAdapter } from "./core";
import { renderWrapperScript } from "./wrapper";
import type { HarnessAdapter } from "./types";

const BIN_DIR = "/Users/dev/Library/Application Support/Volli/bin";
const BARE = { binDir: BIN_DIR, binaryPath: null, env: {} } as const;

function adapterFor(id: string): HarnessAdapter {
  const found = getHarnessAdapter(id as HarnessId);
  if (!found) throw new Error(`no adapter for ${id}`);
  return found;
}

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

/**
 * These assert the script's TEXT, which cannot tell whether a shell agrees. The
 * execution half lives in `apps/desktop/src/main/harness-runtime.test.ts`, where
 * Node may be imported and the generated wrapper is actually run — including the
 * characters this file can only spell — and in `apps/desktop/e2e/`, which runs
 * one against the environment a live PTY really carries. This package may not
 * import Node.
 */
describe("renderWrapperScript", () => {
  const claude = renderWrapperScript(adapterFor("claude-code"), BARE);

  it("is a POSIX shell script, not a bash or zsh one", () => {
    expect(claude.startsWith("#!/bin/sh\n")).toBe(true);
  });

  it("execs the real binary untouched outside a Volli session", () => {
    expect(claude).toContain('if [ -z "${VOLLI_SESSION:-}" ]; then');
    expect(claude).toContain('exec "$volli_real" "$@"');
  });

  it("skips Volli's own bin dir while walking PATH, so it cannot find itself", () => {
    expect(claude).toContain(
      `if [ "$volli_dir" = '/Users/dev/Library/Application Support/Volli/bin' ]`,
    );
    expect(claude).toContain('if [ -x "$volli_dir/claude" ]');
  });

  it("lets an operator name the real binary outright", () => {
    expect(claude).toContain("VOLLI_HARNESS_BIN_CLAUDE_CODE");
  });

  it("fails loudly rather than silently passing through when the binary is unresolvable", () => {
    expect(claude).toContain("exit 127");
    expect(claude).toContain("volli: cannot find");
  });

  it("injects the launch configuration the session put in the environment", () => {
    expect(claude).toContain("VOLLI_HARNESS_ARGV_CLAUDE_CODE");
  });

  // The argv is applied by field splitting, never by a second shell parse: IFS
  // is one newline for exactly this expansion, and expansion results are not
  // rescanned. `eval` appearing here again would be the regression.
  it("splits the configured argv into words instead of re-parsing it", () => {
    expect(claude).not.toContain("eval");
    expect(claude).toContain("IFS='\n'");
    expect(claude).toContain("set -f");
    expect(claude).toContain(
      'set -- ${VOLLI_HARNESS_ARGV_CLAUDE_CODE:-} \'--session-id\' "$VOLLI_SESSION" "$@"',
    );
    expect(claude).toContain("IFS=$volli_saved_ifs");
  });

  it("suppresses that injection when the user's own argv is already driving resume", () => {
    expect(claude).toContain("'--resume'|'--resume='*");
    expect(claude).toContain("'--continue'|'--continue='*");
    expect(claude).toContain("'-r'|'-r='*");
    expect(claude).toContain('set -- ${VOLLI_HARNESS_ARGV_CLAUDE_CODE:-} "$@"');
  });

  it("has nothing to suppress, and no scan to run, when no id is minted at launch", () => {
    const opencode = renderWrapperScript(adapterFor("opencode"), BARE);
    expect(opencode).not.toContain("VOLLI_SESSION_ARGV");
    expect(opencode).not.toContain("'--session'|");
    expect(opencode).toContain('set -- ${VOLLI_HARNESS_ARGV_OPENCODE:-} "$@"');
    expect(opencode).toContain('exec "$volli_real" "$@"');
  });

  it("quotes a bin dir with a space so the PATH comparison stays one word", () => {
    expect(claude).toContain("'/Users/dev/Library/Application Support/Volli/bin'");
  });

  it("still wraps a harness that has nothing to inject, so PATH stays honest", () => {
    const bare = renderWrapperScript(bareAdapter(), { ...BARE, binDir: "/vol/bin" });
    expect(bare).toContain('if [ -x "$volli_dir/my-harness" ]');
    expect(bare).toContain("VOLLI_HARNESS_BIN_MY_HARNESS");
  });

  // The trust dialog names one binary; the wrapper must run that one. The walk
  // stays for the harness nobody was ever asked about.
  it("runs the binary main resolved rather than walking PATH again", () => {
    const pinned = renderWrapperScript(adapterFor("claude-code"), {
      ...BARE,
      binaryPath: "/opt/homebrew/bin/claude",
    });
    expect(pinned).toContain(`if [ -z "$volli_real" ] && [ -x '/opt/homebrew/bin/claude' ]; then`);
    expect(pinned).toContain("  volli_real='/opt/homebrew/bin/claude'");
    // The override still wins, and the walk still catches an uninstall.
    expect(pinned.indexOf("VOLLI_HARNESS_BIN_CLAUDE_CODE")).toBeLessThan(
      pinned.indexOf("/opt/homebrew/bin/claude"),
    );
    expect(pinned).toContain("for volli_dir in $PATH; do");
  });

  it("walks PATH when main resolved nothing to pin", () => {
    expect(claude).not.toContain("&& [ -x ");
    expect(claude).toContain("for volli_dir in $PATH; do");
  });

  // A harness's own configuration variable belongs to the harness, not to every
  // terminal — and it is exported AFTER the passthrough exec, so a harness run
  // outside a session stays untouched.
  it("exports a harness's own configuration inside its own wrapper", () => {
    const cursor = renderWrapperScript(adapterFor("cursor"), {
      ...BARE,
      env: { CURSOR_CONFIG_DIR: "/Users/dev/Library/Application Support/Volli/harness/cursor" },
    });
    expect(cursor).toContain(
      "export 'CURSOR_CONFIG_DIR=/Users/dev/Library/Application Support/Volli/harness/cursor'",
    );
    expect(cursor.indexOf("export 'CURSOR_CONFIG_DIR")).toBeGreaterThan(
      cursor.indexOf('if [ -z "${VOLLI_SESSION:-}" ]; then'),
    );
  });

  it("says nothing about the environment for a harness that configures none", () => {
    expect(claude).not.toContain("export ");
  });
});
