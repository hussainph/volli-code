import { describe, expect, it } from "vite-plus/test";

import { parseHarnessId, type HarnessId } from "../ticket";
import { getHarnessAdapter } from "./core";
import { renderWrapperScript } from "./wrapper";
import type { HarnessAdapter } from "./types";

const BIN_DIR = "/Users/dev/Library/Application Support/Volli/bin";

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
 * These assert the script's TEXT, which cannot tell whether its shell quoting
 * actually holds. The rendered wrappers were run against `/bin/sh` by hand for
 * all six paths — passthrough with `VOLLI_SESSION` unset; injection inside a
 * session; suppression when the user's argv drives resume; a missing
 * `VOLLI_HARNESS_ARGV_*`; a `VOLLI_HARNESS_BIN_*` override; and an unresolvable
 * binary exiting 127 — but a standing execution smoke belongs in
 * `apps/desktop/e2e/`, where running a shell is allowed. This package may not
 * import Node.
 */
describe("renderWrapperScript", () => {
  const claude = renderWrapperScript(adapterFor("claude-code"), { binDir: BIN_DIR });

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

  it("mints the session id from the flag the harness declares, using Volli's own", () => {
    expect(claude).toContain(
      'eval "set -- ${VOLLI_HARNESS_ARGV_CLAUDE_CODE:-} \'--session-id\' \\"\\$VOLLI_SESSION\\" \\"\\$@\\""',
    );
  });

  it("suppresses that injection when the user's own argv is already driving resume", () => {
    expect(claude).toContain("'--resume'|'--resume='*");
    expect(claude).toContain("'--continue'|'--continue='*");
    expect(claude).toContain("'-r'|'-r='*");
    expect(claude).toContain('eval "set -- ${VOLLI_HARNESS_ARGV_CLAUDE_CODE:-} \\"\\$@\\""');
  });

  it("has nothing to suppress, and no scan to run, when no id is minted at launch", () => {
    const opencode = renderWrapperScript(adapterFor("opencode"), { binDir: BIN_DIR });
    expect(opencode).not.toContain("VOLLI_SESSION_ARGV");
    expect(opencode).not.toContain("'--session'|");
    expect(opencode).toContain('exec "$volli_real" "$@"');
  });

  it("quotes a bin dir with a space so the PATH comparison stays one word", () => {
    expect(claude).toContain("'/Users/dev/Library/Application Support/Volli/bin'");
  });

  it("still wraps a harness that has nothing to inject, so PATH stays honest", () => {
    const bare = renderWrapperScript(bareAdapter(), { binDir: "/vol/bin" });
    expect(bare).toContain('if [ -x "$volli_dir/my-harness" ]');
    expect(bare).toContain("VOLLI_HARNESS_BIN_MY_HARNESS");
  });
});
