import { describe, expect, it } from "vite-plus/test";

import { buildSetupSentinelLine, parseSetupSentinel } from "./setup";

describe("buildSetupSentinelLine", () => {
  it("appends an exit-code printf whose format string carries a literal %d", () => {
    const line = buildSetupSentinelLine("pnpm install");
    expect(line).toBe("pnpm install; printf '\\n__VOLLI_SETUP_DONE:%d__\\n' $?");
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
    const echoed = buildSetupSentinelLine("pnpm install");
    expect(parseSetupSentinel(echoed)).toBeNull();
  });

  it("takes the LAST match when the echo and the real marker both appear", () => {
    // A realistic accumulated tail: the typed line (literal %d) then the run's output.
    const tail = `${buildSetupSentinelLine("pnpm install")}\n...output...\n__VOLLI_SETUP_DONE:3__\n`;
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
