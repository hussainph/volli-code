import { describe, expect, it } from "vite-plus/test";

import { parseHarnessId, type HarnessId } from "../ticket";
import { getHarnessAdapter } from "./core";
import { renderWrapperScript } from "./wrapper";
import type { HarnessAdapter } from "./types";

const BIN_DIR = "/Users/dev/Library/Application Support/Volli/bin";
const CLI_PATH = "/Users/dev/Library/Application Support/Volli/bin/volli";
const BARE = { binDir: BIN_DIR, binaryPath: null, cliPath: CLI_PATH, env: {} } as const;

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
    sessionMarkers: [],
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
      'set -- ${VOLLI_HARNESS_ARGV_CLAUDE_CODE:-} \'--session-id\' "$volli_harness_session" "$@"',
    );
    expect(claude).toContain("IFS=$volli_saved_ifs");
  });

  it("suppresses that injection when the user's own argv is already driving resume", () => {
    expect(claude).toContain("'--resume'|'--resume='*");
    expect(claude).toContain("'--continue'|'--continue='*");
    expect(claude).toContain("'-r'|'-r='*");
    expect(claude).toContain('set -- ${VOLLI_HARNESS_ARGV_CLAUDE_CODE:-} "$@"');
    // The scan decides which call is made, and a resuming launch asks for no id
    // — so the injection is suppressed by there being nothing to inject.
    expect(claude).toContain('if [ "$volli_user_resume" = 1 ]; then\n    ( ');
  });

  // THE BUG THIS REMOVES: `VOLLI_SESSION` is stamped once per PTY, so quitting
  // an agent and running it again in the same terminal used to hand the second
  // launch the first one's id — which a harness that mkdirs a directory named
  // after it (cursor) rejects outright.
  it("launches with an id minted for this launch, never with VOLLI_SESSION", () => {
    expect(claude).toContain(
      `volli_harness_session=$('${CLI_PATH}' session harness 'claude-code' --mint </dev/null 2>/dev/null) || volli_harness_session=''`,
    );
    expect(claude).not.toContain('"$VOLLI_SESSION"');
  });

  // Degrading to an unpinned launch is correct; reusing an id is not. Every way
  // the mint can come back empty — no socket, no app, a wedged one, a user
  // driving resume — lands on the same branch.
  it("omits the session flag entirely when nothing was minted", () => {
    expect(claude).toContain("volli_harness_session=''");
    expect(claude).toContain(
      'if [ -n "$volli_harness_session" ]; then\n  set -- ${VOLLI_HARNESS_ARGV_CLAUDE_CODE:-} \'--session-id\' "$volli_harness_session" "$@"\nelse\n  set -- ${VOLLI_HARNESS_ARGV_CLAUDE_CODE:-} "$@"\nfi',
    );
  });

  it("asks for an id unconditionally when the harness has no resume tokens to respect", () => {
    const script = renderWrapperScript(
      bareAdapter({ sessionId: { kind: "argv", flag: "--sid", format: "uuid" } }),
      BARE,
    );
    expect(script).not.toContain("volli_user_resume");
    expect(script).toContain("session harness 'my-harness' --mint");
    expect(script).toContain(
      'set -- ${VOLLI_HARNESS_ARGV_MY_HARNESS:-} \'--sid\' "$volli_harness_session" "$@"',
    );
  });

  // A `reported` or `none` harness names its own session. Minting one for it
  // would overwrite the resume seed its own events are about to write.
  it("asks for no id for a harness that does not take one on argv", () => {
    const opencode = renderWrapperScript(adapterFor("opencode"), BARE);
    expect(opencode).not.toContain("--mint");
    expect(opencode).not.toContain("volli_harness_session");
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

  // The announce is what keeps `sessions.active_harness_id` true: the wrapper is
  // the only thing that runs on every invocation of every tier, including a
  // Declared harness that fires no hooks at all. It survives on the paths that
  // want no id back, so a resuming user still moves the session's harness.
  it("announces which harness is now running, by absolute path", () => {
    expect(claude).toContain(
      `( '${CLI_PATH}' session harness 'claude-code' </dev/null >/dev/null 2>&1 & ) || true`,
    );
  });

  it("gates both calls on there being an app to ask", () => {
    expect(claude).toContain('if [ -n "${VOLLI_SOCKET:-}" ]; then');
  });

  // A harness TUI is about to own this terminal: neither call may print into
  // it, read from it, or be able to fail the launch.
  it("keeps the announce silent, detached and unable to fail the launch", () => {
    const announce = claude.slice(claude.indexOf("( '"));
    const line = announce.slice(0, announce.indexOf("\n"));
    expect(line).toContain("</dev/null");
    expect(line).toContain(">/dev/null");
    expect(line).toContain("2>&1");
    expect(line).toContain("& )");
    expect(line).toContain("|| true");
  });

  it("keeps the mint silent on stderr and unable to fail the launch", () => {
    const mint = claude.slice(claude.indexOf("volli_harness_session=$("));
    const line = mint.slice(0, mint.indexOf("\n"));
    expect(line).toContain("</dev/null");
    expect(line).toContain("2>/dev/null");
    // stdout is the one stream that is NOT discarded — it is the id.
    expect(line.trimStart().startsWith("volli_harness_session=$(")).toBe(true);
    expect(line).toContain("|| volli_harness_session=''");
  });

  // A harness run from a normal terminal is untouched, announce included —
  // there is no session for it to be announcing against.
  it("never announces on the passthrough path", () => {
    const lines = claude.split("\n");
    const gate = lines.indexOf('if [ -z "${VOLLI_SESSION:-}" ]; then');
    const passthrough = lines.slice(gate, lines.indexOf("fi", gate) + 1);
    expect(passthrough).toEqual([
      'if [ -z "${VOLLI_SESSION:-}" ]; then',
      '  exec "$volli_real" "$@"',
      "fi",
    ]);
    expect(lines.findIndex((line) => line.includes("session harness"))).toBeGreaterThan(
      lines.indexOf("fi", gate),
    );
  });

  it("quotes a slug and a cli path so neither can become shell", () => {
    const odd = renderWrapperScript(bareAdapter(), {
      ...BARE,
      cliPath: "/opt/my volli/bin/volli",
    });
    expect(odd).toContain("'/opt/my volli/bin/volli' session harness 'my-harness'");
  });
});
