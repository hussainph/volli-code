import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ZSH_INIT_FILENAMES } from "@volli/shared";
import { ensureShellInit } from "./shell-init";

const tmpDirs: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "volli-shell-init-")));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("ensureShellInit", () => {
  it("writes every file in the chain and names the directory as ZDOTDIR", async () => {
    const root = await tmpDir();
    const zdotDir = join(root, "shell", "zsh");

    const env = await ensureShellInit({
      zdotDir,
      binDir: "/ud/bin",
      shellPath: "/bin/zsh",
      inheritedZdotDir: undefined,
    });

    expect(env["ZDOTDIR"]).toBe(zdotDir);
    expect(env["VOLLI_BIN_DIR"]).toBe("/ud/bin");
    for (const name of ZSH_INIT_FILENAMES) {
      await expect(fs.readFile(join(zdotDir, name), "utf8")).resolves.toContain("Volli");
    }
  });

  // A shell whose startup has no post-user hook must not be told it has one:
  // the session is still launched-wrapped, and claiming otherwise would let the
  // tier read Hooked for events that can never arrive from a typed command.
  it("contributes nothing for a shell Volli cannot hook", async () => {
    const root = await tmpDir();
    for (const shellPath of ["/bin/bash", "/usr/bin/fish", "/bin/sh"]) {
      expect(
        await ensureShellInit({
          zdotDir: join(root, "shell", "zsh"),
          binDir: "/ud/bin",
          shellPath,
          inheritedZdotDir: undefined,
        }),
      ).toEqual({});
    }
    await expect(fs.stat(join(root, "shell", "zsh"))).rejects.toThrow();
  });

  it("passes an inherited ZDOTDIR through so the chain sources the user's real files", async () => {
    const root = await tmpDir();

    const env = await ensureShellInit({
      zdotDir: join(root, "zsh"),
      binDir: "/ud/bin",
      shellPath: "/bin/zsh",
      inheritedZdotDir: "/Users/x/.config/zsh",
    });

    expect(env["VOLLI_USER_ZDOTDIR"]).toBe("/Users/x/.config/zsh");
  });

  // Main's own environment under a Dock launch is launchd's, not the user's —
  // an empty ZDOTDIR there must not be baked in as if it were a real answer.
  it("leaves the user's ZDOTDIR unnamed when the environment carried none", async () => {
    const root = await tmpDir();
    for (const inherited of [undefined, ""]) {
      const env = await ensureShellInit({
        zdotDir: join(root, "zsh"),
        binDir: "/ud/bin",
        shellPath: "/bin/zsh",
        inheritedZdotDir: inherited,
      });
      expect(env["VOLLI_USER_ZDOTDIR"]).toBeUndefined();
    }
  });

  it("regenerates over a stale chain rather than leaving an older contract in place", async () => {
    const root = await tmpDir();
    const zdotDir = join(root, "zsh");
    await fs.mkdir(zdotDir, { recursive: true });
    await fs.writeFile(join(zdotDir, ".zlogin"), "# stale\n");

    await ensureShellInit({
      zdotDir,
      binDir: "/ud/bin",
      shellPath: "/bin/zsh",
      inheritedZdotDir: undefined,
    });

    const content = await fs.readFile(join(zdotDir, ".zlogin"), "utf8");
    expect(content).not.toContain("stale");
    expect(content).toContain("VOLLI_BIN_DIR");
  });
});
