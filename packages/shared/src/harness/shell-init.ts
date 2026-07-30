/**
 * The zsh startup chain that puts Volli's `bin/` back at the front of `PATH`
 * *after* the user's own shell startup has run.
 *
 * Prepending `PATH` in the spawned process's environment does not survive a
 * macOS login shell, and cannot be made to. `resolveShell` spawns `$SHELL -l`;
 * `/etc/zprofile` then runs `path_helper`, which rebuilds `PATH` with
 * `/etc/paths` first and appends whatever it inherited, and every user prepend
 * in `.zprofile`/`.zshrc` lands on top of that. Measured on a stock host, a
 * directory prepended into `$SHELL -l` finishes at position 20 of 30. Anything
 * that wants to win has to run last, not first.
 *
 * So `ZDOTDIR` points at a Volli-owned directory whose files source the user's
 * own and then re-assert the prepend. This is VS Code's shell-integration
 * mechanism, and it is chosen here for the same reason: it is the only hook
 * that runs after arbitrary user startup without editing a single user file.
 * Nothing is written to the user's dotfiles — these scripts READ them.
 *
 * Two files re-assert, not one. A login shell reads `.zshrc` then `.zlogin`, so
 * `.zlogin` is the last word there; but a nested interactive `zsh` reads
 * `.zshrc` and never reaches `.zlogin`, and the user's `.zshrc` prepends would
 * otherwise bury us again inside the session. Both are idempotent — `typeset -U
 * path` keeps the first occurrence and drops the rest — so running both costs
 * nothing.
 *
 * `ZDOTDIR` is deliberately NOT handed back at the end. A nested shell that
 * reverted to the user's startup would re-run their prepends and lose the race
 * again, inside a session that is supposed to be wrapped throughout;
 * `VOLLI_USER_ZDOTDIR` is exported so the chain keeps finding the user's real
 * files however deep it nests.
 *
 * zsh only. bash and fish reach no equivalent post-startup hook without
 * reimplementing their login semantics, so a session on those shells is
 * launched-wrapped (absolute path) but not typed-wrapped, and reports the tier
 * it can actually deliver rather than the one we wish it had.
 */

/** Names Volli's own env contract for the generated chain. */
export const VOLLI_BIN_DIR_ENV = "VOLLI_BIN_DIR";
export const VOLLI_USER_ZDOTDIR_ENV = "VOLLI_USER_ZDOTDIR";

/** The zsh startup files Volli generates, in the order zsh reads them. */
export const ZSH_INIT_FILENAMES = [".zshenv", ".zprofile", ".zshrc", ".zlogin"] as const;

export type ZshInitFilename = (typeof ZSH_INIT_FILENAMES)[number];

const HEADER = "# Volli shell integration. Generated — edits are overwritten.";

/**
 * Sources the user's own file of the same name, if they have one. Quoted and
 * existence-checked: a missing file is the common case (few people have all
 * four), and an unquoted path breaks on the first user whose home has a space.
 */
function sourceUserFile(name: ZshInitFilename): string[] {
  return [
    `if [ -r "$${VOLLI_USER_ZDOTDIR_ENV}/${name}" ]; then`,
    `  . "$${VOLLI_USER_ZDOTDIR_ENV}/${name}"`,
    "fi",
  ];
}

/**
 * Re-asserts the prepend. `typeset -U path` makes the array
 * duplicate-free keeping the FIRST occurrence, so assigning our directory to
 * the front both promotes it and removes wherever it had sunk to — no pattern
 * matching, so a directory containing glob characters is handled literally.
 * zsh keeps `path` and `PATH` tied, so no explicit export is needed.
 */
function prependBinDir(): string[] {
  return [
    `if [ -n "\${${VOLLI_BIN_DIR_ENV}:-}" ]; then`,
    "  typeset -U path",
    `  path=("$${VOLLI_BIN_DIR_ENV}" $path)`,
    "fi",
  ];
}

/**
 * `.zshenv` runs before zsh looks for any other startup file, and is the one
 * file in which a user can legitimately repoint `ZDOTDIR`. So it remembers
 * where zsh found US, sources the user's `.zshenv`, and then checks whether
 * that moved `ZDOTDIR` — if it did, that new location is where the user's
 * remaining files live, and ours must be restored so zsh keeps reading the rest
 * of this chain.
 */
function zshenv(): string[] {
  return [
    HEADER,
    "",
    "# Where zsh found this file — restored below, so the rest of the chain runs.",
    "volli_own_zdotdir=${ZDOTDIR:-}",
    `: \${${VOLLI_USER_ZDOTDIR_ENV}:=$HOME}`,
    `export ${VOLLI_USER_ZDOTDIR_ENV}`,
    "",
    ...sourceUserFile(".zshenv"),
    "",
    "# The user's .zshenv is the only file that can legitimately repoint ZDOTDIR.",
    "# If it did, that is where the rest of their startup lives.",
    'if [ -n "${ZDOTDIR:-}" ] && [ "$ZDOTDIR" != "$volli_own_zdotdir" ]; then',
    `  ${VOLLI_USER_ZDOTDIR_ENV}=$ZDOTDIR`,
    `  export ${VOLLI_USER_ZDOTDIR_ENV}`,
    "fi",
    "ZDOTDIR=$volli_own_zdotdir",
    "export ZDOTDIR",
    "unset volli_own_zdotdir",
    "",
  ];
}

/** The generated content of one file in the chain. */
export function renderZshInitFile(name: ZshInitFilename): string {
  if (name === ".zshenv") return zshenv().join("\n");
  const lines = [HEADER, "", ...sourceUserFile(name)];
  // `.zshrc` covers a nested interactive shell, which never reaches `.zlogin`;
  // `.zlogin` is the last word in the login shell every Volli PTY spawns.
  if (name === ".zshrc" || name === ".zlogin") {
    lines.push("", "# Volli's bin/ goes back in front, now that the user's startup has run.");
    lines.push(...prependBinDir());
  }
  return `${lines.join("\n")}\n`;
}

/** Every generated file, keyed by name — what main materializes on disk. */
export function renderZshInitFiles(): { name: ZshInitFilename; content: string }[] {
  return ZSH_INIT_FILENAMES.map((name) => ({ name, content: renderZshInitFile(name) }));
}

/**
 * Whether `shellPath` is a zsh, and so whether the chain applies at all. Matched
 * on the basename so `/bin/zsh`, `/opt/homebrew/bin/zsh` and a versioned
 * `zsh-5.9` all count, while `/bin/bash` does not.
 */
export function isZshShell(shellPath: string): boolean {
  const base = shellPath.slice(shellPath.lastIndexOf("/") + 1);
  return base === "zsh" || base.startsWith("zsh-");
}
