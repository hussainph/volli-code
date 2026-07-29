import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ZSH_INIT_FILENAMES } from "@volli/shared";
import { ensureShellInit } from "./shell-init";
import type { ShellInitInput } from "./shell-init";

const tmpDirs: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "volli-shell-init-")));
  tmpDirs.push(dir);
  return dir;
}

/** The ordinary launch: a zsh, nothing inherited. Tests name only what they vary. */
function shellInit(
  input: Partial<ShellInitInput> & { zdotDir: string },
): Promise<Record<string, string>> {
  return ensureShellInit({
    binDir: "/ud/bin",
    shellPath: "/bin/zsh",
    inheritedZdotDir: undefined,
    inheritedUserZdotDir: undefined,
    ...input,
  });
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("ensureShellInit", () => {
  it("writes every file in the chain and names the directory as ZDOTDIR", async () => {
    const root = await tmpDir();
    const zdotDir = join(root, "shell", "zsh");

    const env = await shellInit({ zdotDir });

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
      expect(await shellInit({ zdotDir: join(root, "shell", "zsh"), shellPath })).toEqual({});
    }
    await expect(fs.stat(join(root, "shell", "zsh"))).rejects.toThrow();
  });

  it("passes an inherited ZDOTDIR through so the chain sources the user's real files", async () => {
    const root = await tmpDir();

    const env = await shellInit({
      zdotDir: join(root, "zsh"),
      inheritedZdotDir: "/Users/x/.config/zsh",
    });

    expect(env["VOLLI_USER_ZDOTDIR"]).toBe("/Users/x/.config/zsh");
  });

  // Main's own environment under a Dock launch is launchd's, not the user's —
  // an empty ZDOTDIR there must not be baked in as if it were a real answer.
  it("leaves the user's ZDOTDIR unnamed when the environment carried none", async () => {
    const root = await tmpDir();
    for (const inherited of [undefined, ""]) {
      const env = await shellInit({ zdotDir: join(root, "zsh"), inheritedZdotDir: inherited });
      expect(env["VOLLI_USER_ZDOTDIR"]).toBeUndefined();
    }
  });

  // The dogfooding launch: `pnpm dev` from inside a Volli terminal, a relaunch,
  // an `open -a Volli` from a wrapped shell. Chained, the generated .zshenv
  // sources itself and every PTY's zsh dies at "maximum nested function level
  // reached" — so it is refused however it is spelled.
  it("refuses an inherited ZDOTDIR that is Volli's own, so the chain cannot source itself", async () => {
    const root = await tmpDir();
    const zdotDir = join(root, "shell", "zsh");

    for (const spelling of [zdotDir, `${zdotDir}/`, join(zdotDir, "..", "zsh")]) {
      const env = await shellInit({ zdotDir, inheritedZdotDir: spelling });
      expect(env["VOLLI_USER_ZDOTDIR"]).toBeUndefined();
      expect(env["ZDOTDIR"]).toBe(zdotDir);
    }
  });

  // userData on macOS reaches through /var → /private/var, so the same
  // directory arrives under two spellings and only realpath sees it.
  it("refuses an inherited ZDOTDIR that resolves to Volli's own through a symlink", async () => {
    const root = await tmpDir();
    const zdotDir = join(root, "shell", "zsh");
    await fs.mkdir(zdotDir, { recursive: true });
    const link = join(root, "linked-zsh");
    await fs.symlink(zdotDir, link);

    const env = await shellInit({ zdotDir, inheritedZdotDir: link });

    expect(env["VOLLI_USER_ZDOTDIR"]).toBeUndefined();
  });

  // Discarding the inherited ZDOTDIR must not discard the user's real one with
  // it — a wrapped shell carries it in VOLLI_USER_ZDOTDIR, and that is the only
  // place it survives a relaunch.
  it("recovers the user's own ZDOTDIR from the wrapped environment", async () => {
    const root = await tmpDir();
    const zdotDir = join(root, "zsh");

    const env = await shellInit({
      zdotDir,
      inheritedZdotDir: zdotDir,
      inheritedUserZdotDir: "/Users/x/.config/zsh",
    });

    expect(env["VOLLI_USER_ZDOTDIR"]).toBe("/Users/x/.config/zsh");
  });

  it("prefers a real inherited ZDOTDIR over the wrapped environment's record of one", async () => {
    const root = await tmpDir();

    const env = await shellInit({
      zdotDir: join(root, "zsh"),
      inheritedZdotDir: "/Users/x/.config/zsh",
      inheritedUserZdotDir: "/Users/x/stale",
    });

    expect(env["VOLLI_USER_ZDOTDIR"]).toBe("/Users/x/.config/zsh");
  });

  it("regenerates over a stale chain rather than leaving an older contract in place", async () => {
    const root = await tmpDir();
    const zdotDir = join(root, "zsh");
    await fs.mkdir(zdotDir, { recursive: true });
    await fs.writeFile(join(zdotDir, ".zlogin"), "# stale\n");

    await shellInit({ zdotDir });

    const content = await fs.readFile(join(zdotDir, ".zlogin"), "utf8");
    expect(content).not.toContain("stale");
    expect(content).toContain("VOLLI_BIN_DIR");
  });
});
