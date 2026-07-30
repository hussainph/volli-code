import { describe, expect, it } from "vite-plus/test";
import {
  isZshShell,
  renderZshInitFile,
  renderZshInitFiles,
  ZSH_INIT_FILENAMES,
} from "./shell-init";

describe("renderZshInitFile", () => {
  it("sources the user's own file of the same name, from their real ZDOTDIR", () => {
    for (const name of ZSH_INIT_FILENAMES) {
      expect(renderZshInitFile(name)).toContain(`. "$VOLLI_USER_ZDOTDIR/${name}"`);
    }
  });

  it("existence-checks before sourcing, since few people have all four files", () => {
    for (const name of ZSH_INIT_FILENAMES) {
      expect(renderZshInitFile(name)).toContain(`if [ -r "$VOLLI_USER_ZDOTDIR/${name}" ]; then`);
    }
  });

  it("quotes every path it sources, for a home directory containing a space", () => {
    for (const name of ZSH_INIT_FILENAMES) {
      expect(renderZshInitFile(name)).not.toMatch(/\.\s+\$VOLLI_USER_ZDOTDIR\/[^"]/);
    }
  });

  // The whole point: the prepend has to happen after the user's startup, in the
  // last file that startup reaches.
  it("re-prepends the bin dir in .zlogin, the last file a login shell reads", () => {
    const content = renderZshInitFile(".zlogin");
    expect(content).toContain('path=("$VOLLI_BIN_DIR" $path)');
    // After the user's own .zlogin, never before it.
    expect(content.indexOf('. "$VOLLI_USER_ZDOTDIR/.zlogin"')).toBeLessThan(
      content.indexOf('path=("$VOLLI_BIN_DIR" $path)'),
    );
  });

  // A nested interactive zsh never reaches .zlogin, and the user's .zshrc
  // prepends would otherwise bury us again inside the session.
  it("re-prepends in .zshrc too, after the user's own .zshrc", () => {
    const content = renderZshInitFile(".zshrc");
    expect(content).toContain('path=("$VOLLI_BIN_DIR" $path)');
    expect(content.indexOf('. "$VOLLI_USER_ZDOTDIR/.zshrc"')).toBeLessThan(
      content.indexOf('path=("$VOLLI_BIN_DIR" $path)'),
    );
  });

  it("dedupes rather than pattern-matching, so a glob character in the path stays literal", () => {
    expect(renderZshInitFile(".zlogin")).toContain("typeset -U path");
    expect(renderZshInitFile(".zlogin")).not.toContain("${path:#");
  });

  it("does nothing when the bin dir is not in the environment", () => {
    expect(renderZshInitFile(".zlogin")).toContain('if [ -n "${VOLLI_BIN_DIR:-}" ]; then');
  });

  it("leaves .zprofile as a pure passthrough — path_helper has not finished with PATH yet", () => {
    expect(renderZshInitFile(".zprofile")).not.toContain("VOLLI_BIN_DIR");
  });

  it("defaults the user's ZDOTDIR to their home when the environment names none", () => {
    expect(renderZshInitFile(".zshenv")).toContain(": ${VOLLI_USER_ZDOTDIR:=$HOME}");
  });

  // .zshenv is the one file in which a user may legitimately repoint ZDOTDIR;
  // if we did not restore ours, zsh would read the rest of their chain and none
  // of ours, and the prepend would never run.
  it("restores its own ZDOTDIR after the user's .zshenv, and adopts theirs if they moved it", () => {
    const content = renderZshInitFile(".zshenv");
    expect(content).toContain("volli_own_zdotdir=${ZDOTDIR:-}");
    expect(content).toContain("VOLLI_USER_ZDOTDIR=$ZDOTDIR");
    expect(content).toContain("ZDOTDIR=$volli_own_zdotdir");
    expect(content.indexOf('. "$VOLLI_USER_ZDOTDIR/.zshenv"')).toBeLessThan(
      content.indexOf("ZDOTDIR=$volli_own_zdotdir"),
    );
  });

  it("exports the user's ZDOTDIR so a nested shell still finds their real files", () => {
    expect(renderZshInitFile(".zshenv")).toContain("export VOLLI_USER_ZDOTDIR");
  });

  it("marks every file as generated", () => {
    for (const { content } of renderZshInitFiles()) {
      expect(content).toContain("Generated — edits are overwritten");
    }
  });

  it("renders every file in the chain", () => {
    expect(renderZshInitFiles().map(({ name }) => name)).toEqual([...ZSH_INIT_FILENAMES]);
  });
});

describe("isZshShell", () => {
  it("recognizes zsh wherever it is installed", () => {
    expect(isZshShell("/bin/zsh")).toBe(true);
    expect(isZshShell("/opt/homebrew/bin/zsh")).toBe(true);
    expect(isZshShell("/usr/local/bin/zsh-5.9")).toBe(true);
  });

  it("does not claim shells whose startup Volli cannot hook", () => {
    expect(isZshShell("/bin/bash")).toBe(false);
    expect(isZshShell("/usr/bin/fish")).toBe(false);
    expect(isZshShell("/bin/sh")).toBe(false);
  });

  it("is not fooled by a directory that merely mentions zsh", () => {
    expect(isZshShell("/opt/zsh/bin/bash")).toBe(false);
  });
});
