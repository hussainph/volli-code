import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_RULE_PACK_HASH,
  BUILTIN_RULE_PACK_ID,
  type AuthoritySnapshot,
  type CodingToolId,
} from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";
import { authorityRefusal } from "./gate";

function snapshot(overrides: Partial<AuthoritySnapshot> = {}): AuthoritySnapshot {
  return {
    mode: "auto",
    location: "worktree",
    tools: ["read", "edit", "write", "execute"] satisfies CodingToolId[],
    rulePackId: BUILTIN_RULE_PACK_ID,
    rulePackHash: BUILTIN_RULE_PACK_HASH,
    classifierModel: null,
    fallback: { consecutiveDenials: 3, sessionDenials: 20 },
    ...overrides,
  };
}

function workspace(): { raw: string; real: string } {
  const raw = mkdtempSync(join(tmpdir(), "volli-gate-"));
  writeFileSync(join(raw, "MARKER.txt"), "x");
  return { raw, real: realpathSync(raw) };
}

describe("authorityRefusal", () => {
  it("stands aside for work the Session's authority permits", () => {
    const { raw } = workspace();
    expect(
      authorityRefusal({
        tool: "read",
        args: { path: "MARKER.txt" },
        authority: snapshot(),
        workspacePath: raw,
      }),
    ).toBeUndefined();
    expect(
      authorityRefusal({
        tool: "bash",
        args: { command: "printf hi > out.txt" },
        authority: snapshot(),
        workspacePath: raw,
      }),
    ).toBeUndefined();
  });

  it("compares operands against the resolved root, not the symlink the caller passed", () => {
    const { raw, real } = workspace();
    expect(raw).not.toBe(real);
    expect(
      authorityRefusal({
        tool: "read",
        args: { path: join(real, "MARKER.txt") },
        authority: snapshot(),
        workspacePath: raw,
      }),
    ).toBeUndefined();
  });

  it("returns the refusing rule's own words, which the model reads as the tool result", () => {
    const { raw, real } = workspace();
    expect(
      authorityRefusal({
        tool: "read",
        args: { path: "../SECRET.txt" },
        authority: snapshot(),
        workspacePath: raw,
      }),
    ).toBe(
      `${join(real, "../SECRET.txt")} is outside the Session workspace ${real}; every read and write must stay inside it.`,
    );
    expect(
      authorityRefusal({
        tool: "grep",
        args: { pattern: "secret" },
        authority: snapshot(),
        workspacePath: raw,
      }),
    ).toContain('"grep" is not one of this Session\'s tools');
  });

  it("reads the Snapshot's own work location rather than assuming a worktree", () => {
    const { raw } = workspace();
    const call = { tool: "bash", args: { command: "git reset --hard" } } as const;
    expect(
      authorityRefusal({ ...call, authority: snapshot(), workspacePath: raw }),
    ).toBeUndefined();
    expect(
      authorityRefusal({
        ...call,
        authority: snapshot({ location: "main-checkout" }),
        workspacePath: raw,
      }),
    ).toContain("discards uncommitted work");
  });

  it("blocks a call it cannot describe rather than letting it through unchecked", () => {
    const { raw } = workspace();
    expect(
      authorityRefusal({
        tool: "read",
        args: { path: "x".repeat(400) },
        authority: snapshot(),
        workspacePath: raw,
      }),
    ).toContain("could not be checked against the Session's authority");
    expect(
      authorityRefusal({
        tool: "bash",
        args: {},
        authority: snapshot(),
        workspacePath: raw,
      }),
    ).toBe(
      "This call could not be checked against the Session's authority, so it was refused: Pi tool bash was called without a command argument.",
    );
    expect(
      authorityRefusal({
        tool: "read",
        args: { path: "MARKER.txt" },
        authority: snapshot(),
        workspacePath: join(raw, "x".repeat(400)),
      }),
    ).toContain("could not be checked against the Session's authority");
  });
});
