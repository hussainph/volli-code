import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { readRepoInstructions } from "./repo-instructions";

const warn = vi.hoisted(() => vi.fn());
vi.mock("./log/root", () => ({ hostLogger: () => ({ warn }) }));

let dir: string;
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  warn.mockReset();
});
function workspace(files: Record<string, string> = {}): string {
  dir = mkdtempSync(join(tmpdir(), "volli-repo-instructions-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

describe("readRepoInstructions", () => {
  it("reads AGENTS.md at the workspace root", async () => {
    const resource = await readRepoInstructions(
      workspace({ "AGENTS.md": "agents", "CLAUDE.md": "claude" }),
    );
    expect(resource).toEqual({
      name: "repository instructions",
      text: "From AGENTS.md at the workspace root, as it read when this Session started.\n\nagents",
    });
  });

  it("falls back to CLAUDE.md, including when AGENTS.md is a symlink to it", async () => {
    expect((await readRepoInstructions(workspace({ "CLAUDE.md": "claude" })))?.text).toContain(
      "From CLAUDE.md",
    );
    rmSync(dir, { recursive: true, force: true });
    const linked = workspace({ "CLAUDE.md": "shared rules" });
    symlinkSync(join(linked, "CLAUDE.md"), join(linked, "AGENTS.md"));
    const text = (await readRepoInstructions(linked))?.text ?? "";
    expect(text.match(/shared rules/g)).toHaveLength(1);
  });

  it("is null, silently, when there is no instruction file or no workspace", async () => {
    expect(await readRepoInstructions(workspace())).toBeNull();
    expect(await readRepoInstructions(join(dir, "missing"))).toBeNull();
    expect(await readRepoInstructions(join(dir, "file-not-dir"))).toBeNull();
    writeFileSync(join(dir, "file-not-dir"), "");
    expect(await readRepoInstructions(join(dir, "file-not-dir"))).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs an unreadable file and moves on to the next one", async () => {
    const root = workspace({ "CLAUDE.md": "claude" });
    mkdirSync(join(root, "AGENTS.md"));
    expect((await readRepoInstructions(root))?.text).toContain("From CLAUDE.md");
    expect(warn).toHaveBeenCalledWith(
      "repository instructions unreadable",
      expect.objectContaining({ path: join(root, "AGENTS.md") }),
    );
  });
});
