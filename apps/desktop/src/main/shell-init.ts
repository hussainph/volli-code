/**
 * Materializes the zsh startup chain that keeps Volli's `bin/` at the front of
 * a session's `PATH`.
 *
 * The scripts themselves — and the reasoning for why a post-startup hook is the
 * only thing that can work here — live in `@volli/shared`'s `shell-init`. This
 * writes them and reports the environment a PTY needs to pick them up.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  isZshShell,
  renderZshInitFiles,
  VOLLI_BIN_DIR_ENV,
  VOLLI_USER_ZDOTDIR_ENV,
} from "@volli/shared";

export interface ShellInitInput {
  /** The Volli-owned `ZDOTDIR` the generated files are written into. */
  zdotDir: string;
  /** Volli's own `bin/` — what the chain puts back in front. */
  binDir: string;
  /** The shell a session actually spawns, from `resolveShell`. */
  shellPath: string;
  /**
   * The `ZDOTDIR` the user's environment already carried, if any. Passed
   * through so the chain sources their real startup files rather than assuming
   * `$HOME`; `undefined` is the ordinary case and the scripts default to home.
   */
  inheritedZdotDir: string | undefined;
}

/**
 * Writes the chain and returns the environment that activates it — empty for a
 * shell whose startup Volli cannot hook, which is a real answer and not a
 * failure: that session is still launched-wrapped by absolute path, it just
 * cannot intercept a hand-typed command.
 *
 * Regenerated every boot, exactly as the wrappers and the `volli` shim are, so
 * a script written against an older contract never outlives the build.
 */
export async function ensureShellInit(input: ShellInitInput): Promise<Record<string, string>> {
  if (!isZshShell(input.shellPath)) return {};
  await mkdir(input.zdotDir, { recursive: true });
  for (const { name, content } of renderZshInitFiles()) {
    await writeFile(join(input.zdotDir, name), content, { encoding: "utf8", mode: 0o600 });
  }
  return {
    ZDOTDIR: input.zdotDir,
    [VOLLI_BIN_DIR_ENV]: input.binDir,
    // Only when the user actually had one — otherwise the scripts' own `$HOME`
    // default is right, and naming it here would bake main's environment (which
    // under a Dock launch is launchd's, not the user's) into every session.
    ...(input.inheritedZdotDir !== undefined && input.inheritedZdotDir.length > 0
      ? { [VOLLI_USER_ZDOTDIR_ENV]: input.inheritedZdotDir }
      : {}),
  };
}
