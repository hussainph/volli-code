import { describe, expect, it } from "vite-plus/test";

import { resolveShell } from "./terminal";

describe("resolveShell", () => {
  it("uses $SHELL when it is a non-empty string", () => {
    expect(resolveShell({ SHELL: "/opt/homebrew/bin/fish" })).toEqual({
      file: "/opt/homebrew/bin/fish",
      args: ["-l"],
    });
  });

  it("falls back to /bin/zsh when $SHELL is undefined", () => {
    expect(resolveShell({})).toEqual({ file: "/bin/zsh", args: ["-l"] });
  });

  it("falls back to /bin/zsh when $SHELL is an empty string", () => {
    expect(resolveShell({ SHELL: "" })).toEqual({ file: "/bin/zsh", args: ["-l"] });
  });

  it("always requests a login shell", () => {
    expect(resolveShell({ SHELL: "/bin/bash" }).args).toEqual(["-l"]);
    expect(resolveShell({}).args).toEqual(["-l"]);
  });
});
