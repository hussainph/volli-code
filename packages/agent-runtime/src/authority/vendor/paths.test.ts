import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { HOME, resolveInputPath, resolvePathForPolicy, shellPathTokenToPath } from "./paths";

/** A real temporary tree. On macOS its root is itself a symlink, which is the point. */
function workspace(): { raw: string; real: string } {
  const raw = mkdtempSync(join(tmpdir(), "volli-authority-"));
  return { raw, real: realpathSync(raw) };
}

describe("resolveInputPath", () => {
  it("resolves a relative path against the workspace and leaves an absolute one alone", () => {
    expect(resolveInputPath("/work/ticket", "src/index.ts")).toBe("/work/ticket/src/index.ts");
    expect(resolveInputPath("/work/ticket", "  ../sibling/x  ")).toBe("/work/sibling/x");
    expect(resolveInputPath("/work/ticket", "/etc/hosts")).toBe("/etc/hosts");
  });

  // Pi's tools DO strip a leading `@`; replicating that guess here is what let
  // `@.git/hooks/pre-commit` past. `normalizeToolPath` owns it now, and runs
  // before this function, so this one resolves exactly what it is handed.
  it("normalizes nothing of its own, leaving a leading @ to Pi's normalization", () => {
    expect(resolveInputPath("/work", "@types/node/index.d.ts")).toBe(
      "/work/@types/node/index.d.ts",
    );
  });

  it("reports that a blank argument names no path", () => {
    expect(resolveInputPath("/work", "")).toBeUndefined();
    expect(resolveInputPath("/work", "   ")).toBeUndefined();
  });
});

describe("shellPathTokenToPath", () => {
  it.each([
    ["~", HOME],
    ["$HOME", HOME],
    ["${HOME}", HOME],
    ["~/.zshrc", resolve(HOME, ".zshrc")],
    ["$HOME/.ssh", resolve(HOME, ".ssh")],
    ["${HOME}/.ssh", resolve(HOME, ".ssh")],
  ])("expands %j, bare tilde included", (token, path) => {
    expect(shellPathTokenToPath(token, "/work")).toEqual({ kind: "path", path });
  });

  it.each([
    ["build", "/work/build"],
    // Joined, not normalized: `.` and `..` are the walk's to apply, through links.
    ["  ./build  ", "/work/./build"],
    ["s/../x", "/work/s/../x"],
    ["/etc/hosts", "/etc/hosts"],
  ])("joins %j to the workspace", (token, path) => {
    expect(shellPathTokenToPath(token, "/work")).toEqual({ kind: "path", path });
  });

  it.each(["", "   ", "-", "&1"])("reports %j as denoting no location", (token) => {
    expect(shellPathTokenToPath(token, "/work")).toEqual({ kind: "no-location" });
  });

  // Resolving these against the workspace is what made `rm -rf ~someone` read
  // as `<ws>/~someone` — inside the tree, and allowed. Reporting them as
  // unresolvable leaves the caller to decide, which depends on the position.
  it.each([
    ["~hussain", "names another user's home directory"],
    ["~root/.ssh", "names another user's home directory"],
    ["$TMPDIR", "expands through a variable only the shell can read"],
    ["$HOMEBREW/bin", "expands through a variable only the shell can read"],
    ["$(date)", "expands through a variable only the shell can read"],
    ["build$SUFFIX", "expands through a variable only the shell can read"],
    ["out$DIR/y", "expands through a variable only the shell can read"],
    ["pre$HOME/z", "expands through a variable only the shell can read"],
    ["${FOO}bar", "expands through a variable only the shell can read"],
    ["a$_b", "expands through a variable only the shell can read"],
  ])("reports %j as unresolvable rather than guessing", (token, reason) => {
    expect(shellPathTokenToPath(token, "/work")).toEqual({
      kind: "unresolvable",
      reason: expect.stringContaining(reason),
    });
  });

  // A `$` that is not the head of the token is ordinary text — a regex anchor, a
  // sed script, an awk field. Refusing those would refuse most real commands.
  // The discriminator is what follows the `$`, not where it sits. A trailing
  // `$`, or one before punctuation or a digit, names no variable.
  it.each([
    ["^foo$", "/work/^foo$"],
    ["s/$/x/", "/work/s/$/x/"],
    ["s/foo$/bar/", "/work/s/foo$/bar/"],
    ["$", "/work/$"],
    ["cost $5", "/work/cost $5"],
    ["{print $1}", "/work/{print $1}"],
  ])("treats the $ in %j as ordinary text", (token, path) => {
    expect(shellPathTokenToPath(token, "/work")).toEqual({ kind: "path", path });
  });
});

describe("resolvePathForPolicy", () => {
  it("canonicalizes a path that exists", () => {
    const { raw, real } = workspace();
    writeFileSync(join(raw, "MARKER.txt"), "x");
    expect(resolvePathForPolicy(join(raw, "MARKER.txt"))).toBe(join(real, "MARKER.txt"));
  });

  it("resolves a file that does not exist yet through its nearest existing ancestor", () => {
    const { raw, real } = workspace();
    expect(resolvePathForPolicy(join(raw, "new.txt"))).toBe(join(real, "new.txt"));
    expect(resolvePathForPolicy(join(raw, "a", "b", "c.txt"))).toBe(join(real, "a/b/c.txt"));
  });

  it("follows a symlinked directory, including for a target inside it that is missing", () => {
    const { raw, real } = workspace();
    mkdirSync(join(raw, "actual"));
    symlinkSync(join(raw, "actual"), join(raw, "link"));
    expect(resolvePathForPolicy(join(raw, "link"))).toBe(join(real, "actual"));
    expect(resolvePathForPolicy(join(raw, "link", "new.txt"))).toBe(join(real, "actual/new.txt"));
  });

  it("resolves a dangling symlink to the path it points at", () => {
    const { raw, real } = workspace();
    symlinkSync(join(raw, "gone"), join(raw, "dangling"));
    expect(resolvePathForPolicy(join(raw, "dangling"))).toBe(join(real, "gone"));
  });

  it("refuses a symlink cycle rather than looping", () => {
    const { raw } = workspace();
    symlinkSync(join(raw, "b"), join(raw, "a"));
    symlinkSync(join(raw, "a"), join(raw, "b"));
    expect(resolvePathForPolicy(join(raw, "a"))).toBeUndefined();
  });

  it("refuses a path the filesystem cannot name at all", () => {
    const { raw } = workspace();
    expect(resolvePathForPolicy(join(raw, "x".repeat(400)))).toBeUndefined();
  });

  it("follows a link before applying the .. after it, as the kernel does (VC-45 review, B1)", () => {
    const { raw, real } = workspace();
    mkdirSync(join(raw, "out", "Caches"), { recursive: true });
    mkdirSync(join(raw, "ws"));
    symlinkSync(join(raw, "out", "Caches"), join(raw, "ws", "s"));
    symlinkSync("s/../LaunchAgents/x.plist", join(raw, "ws", "x"));
    // Lexically `ws/s/../LaunchAgents` is `ws/LaunchAgents`; through `s` it is `out/LaunchAgents`.
    expect(resolvePathForPolicy(join(raw, "ws", "x"))).toBe(join(real, "out/LaunchAgents/x.plist"));
    // A relative target with `.` components is walked from the link's directory.
    symlinkSync("./s/./new.txt", join(raw, "ws", "dotted"));
    expect(resolvePathForPolicy(join(raw, "ws", "dotted"))).toBe(join(real, "out/Caches/new.txt"));
  });

  // APFS's folding; a case-sensitive Linux volume stores `.SSH` as a different name.
  it.skipIf(process.platform !== "darwin")(
    "spells an existing prefix as the filesystem stores it",
    () => {
      const { raw, real } = workspace();
      mkdirSync(join(raw, ".ssh"));
      // APFS folds case and normalization; these name the same directory, and so does the policy.
      for (const spelling of [".SSH", ".sſh", ".ssh".normalize("NFD")]) {
        expect(resolvePathForPolicy(join(raw, spelling, "id_rsa"))).toBe(join(real, ".ssh/id_rsa"));
      }
    },
  );

  it("spells only the prefix that exists, and appends the rest as named, however long", () => {
    const { raw, real } = workspace();
    const tail = Array.from({ length: 25 }, () => "x".repeat(200));
    expect(resolvePathForPolicy(join(raw, "missing", ...tail))).toBe(
      join(real, "missing", ...tail),
    );
  });

  it("walks again once a .. climbs back above a missing directory", () => {
    const { raw, real } = workspace();
    mkdirSync(join(raw, "elsewhere"));
    symlinkSync(join(raw, "elsewhere"), join(raw, "link"));
    // Unnormalized on purpose, as callers now hand it over: `missing/..` is
    // undone by the walk, and `link` after it is a real link again.
    expect(resolvePathForPolicy(`${raw}/missing/../link/x`)).toBe(join(real, "elsewhere/x"));
    expect(resolvePathForPolicy(`${raw}/missing/deeper/../../link`)).toBe(join(real, "elsewhere"));
    // A link followed before a `..` in the operand itself: kernel order.
    mkdirSync(join(raw, "elsewhere", "inner"));
    symlinkSync(join(raw, "elsewhere", "inner"), join(raw, "deep"));
    expect(resolvePathForPolicy(`${raw}/deep/../sibling.txt`)).toBe(
      join(real, "elsewhere/sibling.txt"),
    );
    // A relative path is taken against the process's directory, unnormalized.
    expect(resolvePathForPolicy("x/../y")).toBe(join(realpathSync(process.cwd()), "y"));
  });

  it("resolves through an ancestor that turns out to be a file", () => {
    const { raw, real } = workspace();
    writeFileSync(join(raw, "not-a-dir"), "x");
    expect(resolvePathForPolicy(join(raw, "not-a-dir", "child"))).toBe(
      join(real, "not-a-dir/child"),
    );
  });
});
