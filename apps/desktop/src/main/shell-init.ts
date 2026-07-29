/**
 * Materializes the zsh startup chain that keeps Volli's `bin/` at the front of
 * a session's `PATH`.
 *
 * The scripts themselves — and the reasoning for why a post-startup hook is the
 * only thing that can work here — live in `@volli/shared`'s `shell-init`. This
 * writes them and reports the environment a PTY needs to pick them up.
 */
import { mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  isZshShell,
  renderZshInitFiles,
  VOLLI_BIN_DIR_ENV,
  VOLLI_USER_ZDOTDIR_ENV,
} from "@volli/shared";

// The chain and the wrappers are the two halves of one generated runtime, and
// they answer a hostile path the same way — borrowed rather than copied, because
// a second copy of this rule is a copy that will one day only be fixed in the
// other file.
import { writeGeneratedFile } from "./harness-runtime";

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
   *
   * Volli's OWN generated directory is a value this can legitimately hold, and
   * the one value it must never be believed about — see {@link isOwnZdotDir}.
   */
  inheritedZdotDir: string | undefined;
  /**
   * `VOLLI_USER_ZDOTDIR` from the launching environment. Only a launch from an
   * already-wrapped shell carries one, and that is exactly the launch whose
   * `ZDOTDIR` has to be discarded — this is where the user's real directory
   * survives it, so their startup files are still found rather than falling
   * back to a `$HOME` they don't keep them in.
   */
  inheritedUserZdotDir: string | undefined;
}

/**
 * Whether an inherited `ZDOTDIR` is the directory Volli just wrote the chain
 * into.
 *
 * It is inherited whenever the app is launched from an environment Volli
 * already wrapped: `pnpm dev` run inside a Volli terminal, an `app.relaunch()`,
 * an `open -a Volli` from a wrapped shell. Passed through, it becomes
 * `VOLLI_USER_ZDOTDIR` — so the generated `.zshenv` sources the generated
 * `.zshenv`, and every PTY's zsh dies at "maximum nested function level
 * reached". Every terminal in the app, from a value that is only ever seen on
 * the dogfooding path.
 *
 * Compared through `realpath` as well as by normalized string, because
 * `userData` on macOS reaches through `/var` → `/private/var`: one spelling of
 * the same directory is the same directory, and a symlinked one still sources
 * itself. An unresolvable path is not equal to anything — the user's own
 * `ZDOTDIR` pointing somewhere that no longer exists is their business, and the
 * chain's existence checks already handle it.
 */
async function isOwnZdotDir(inherited: string, zdotDir: string): Promise<boolean> {
  if (resolve(inherited) === resolve(zdotDir)) return true;
  try {
    return (await realpath(inherited)) === (await realpath(zdotDir));
  } catch {
    return false;
  }
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
  // Every PTY sources this chain, which makes it the most valuable path in the
  // app to redirect: a symlink planted at one of these names would have Volli
  // write the file the user's every shell then executes. The write refuses
  // instead, loudly — see {@link writeGeneratedFile}.
  for (const { name, content } of renderZshInitFiles()) {
    await writeGeneratedFile(join(input.zdotDir, name), content, 0o600);
  }
  // Only when the user actually had one, and only when it is theirs — otherwise
  // the scripts' own `$HOME` default is right, and naming it here would bake
  // main's environment (which under a Dock launch is launchd's, not the user's,
  // and under a wrapped launch is Volli's own) into every session.
  let userZdotDir: string | undefined;
  for (const candidate of [input.inheritedZdotDir, input.inheritedUserZdotDir]) {
    if (candidate === undefined || candidate.length === 0) continue;
    if (await isOwnZdotDir(candidate, input.zdotDir)) continue;
    userZdotDir = candidate;
    break;
  }
  return {
    ZDOTDIR: input.zdotDir,
    [VOLLI_BIN_DIR_ENV]: input.binDir,
    ...(userZdotDir === undefined ? {} : { [VOLLI_USER_ZDOTDIR_ENV]: userZdotDir }),
  };
}
