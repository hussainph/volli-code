import { describe, expect, it } from "vite-plus/test";

import { buildSetupSentinelLine, parseSetupSentinel } from "./setup";

describe("buildSetupSentinelLine", () => {
  it("subshells the command and appends an exit-code printf whose format string carries a literal %d (POSIX)", () => {
    const line = buildSetupSentinelLine("pnpm install", "/bin/zsh");
    expect(line).toBe("( pnpm install ); printf '\\n__VOLLI_SETUP_DONE:%d__\\n' $?");
  });

  it("subshell-contains a setup that calls exit, so the parent shell survives to print the sentinel", () => {
    // Without the ( … ) a top-level `exit 7` would kill the interactive shell
    // before printf ran — the e2e-smoke-caught bug this test pins.
    expect(buildSetupSentinelLine("exit 7", "/bin/bash")).toBe(
      "( exit 7 ); printf '\\n__VOLLI_SETUP_DONE:%d__\\n' $?",
    );
  });

  it("emits the fish begin/end + $status form (the POSIX subshell is a fish parse error)", () => {
    expect(buildSetupSentinelLine("pnpm install", "/usr/local/bin/fish")).toBe(
      "begin; pnpm install; end; printf '\\n__VOLLI_SETUP_DONE:%d__\\n' $status",
    );
  });

  it("detects fish even as a login shell (argv0 `-fish`)", () => {
    expect(buildSetupSentinelLine("exit 3", "-fish")).toBe(
      "begin; exit 3; end; printf '\\n__VOLLI_SETUP_DONE:%d__\\n' $status",
    );
  });
});

describe("parseSetupSentinel", () => {
  it("returns null before any sentinel is present (installs are slow, not errors)", () => {
    expect(parseSetupSentinel("pnpm install\nresolving packages...")).toBeNull();
  });

  it("extracts a zero exit code", () => {
    expect(parseSetupSentinel("done\n__VOLLI_SETUP_DONE:0__\n")).toBe(0);
  });

  it("extracts a non-zero exit code", () => {
    expect(parseSetupSentinel("boom\n__VOLLI_SETUP_DONE:127__\n")).toBe(127);
  });

  it("never false-matches the ECHOED command (literal %d, not a digit)", () => {
    // What the shell prints when the wrapped line is typed — %d is literal here.
    const echoed = buildSetupSentinelLine("pnpm install", "/bin/zsh");
    expect(parseSetupSentinel(echoed)).toBeNull();
  });

  it("takes the LAST match when the echo and the real marker both appear", () => {
    // A realistic accumulated tail: the typed line (literal %d) then the run's output.
    const tail = `${buildSetupSentinelLine("pnpm install", "/bin/zsh")}\n...output...\n__VOLLI_SETUP_DONE:3__\n`;
    expect(parseSetupSentinel(tail)).toBe(3);
  });

  it("tolerates the marker split-then-rejoined across accumulated chunks", () => {
    // The caller passes a growing buffer; once whole, the marker parses.
    let buffer = "work\n__VOLLI_SETUP_";
    expect(parseSetupSentinel(buffer)).toBeNull();
    buffer += "DONE:0__\n";
    expect(parseSetupSentinel(buffer)).toBe(0);
  });
});
