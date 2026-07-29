import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { getHarnessAdapter } from "@volli/shared";
import type { HarnessAdapter, HarnessId } from "@volli/shared";

import { ensureHarnessRuntime, harnessLaunchArgv } from "./harness-runtime";

const execFileAsync = promisify(execFile);

/** Every scratch root this test made, so a test that needs two still cleans up both. */
let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

function adapterFor(id: string): HarnessAdapter {
  const found = getHarnessAdapter(id as HarnessId);
  if (!found) throw new Error(`no adapter for ${id}`);
  return found;
}

let scratchRoot = "";

async function scratch(): Promise<{ binDir: string; harnessRoot: string; shimPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "volli-harness-runtime-"));
  scratchRoot = root;
  roots.push(root);
  return {
    binDir: join(root, "bin"),
    harnessRoot: join(root, "harness"),
    shimPath: join(root, "bin", "volli"),
  };
}

/**
 * A stand-in for a harness binary: it records `$0`, every argument it was given
 * and the configuration variable opencode reads, one per line, into
 * `$VOLLI_PROBE`. Argv and environment are the whole of what a wrapper does, so
 * recording them verbatim is the whole assertion surface.
 */
const FAKE_BINARY = [
  "#!/bin/sh",
  ': > "$VOLLI_PROBE"',
  'printf "argv0=%s\\n" "$0" >> "$VOLLI_PROBE"',
  'for volli_arg in "$@"; do printf "arg=%s\\n" "$volli_arg" >> "$VOLLI_PROBE"; done',
  'printf "config=%s\\n" "${OPENCODE_CONFIG:-unset}" >> "$VOLLI_PROBE"',
  "exit 0",
  "",
].join("\n");

async function fakeBinary(name: string, dirName = name): Promise<string> {
  const dir = join(scratchRoot, `realbin-${dirName}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, FAKE_BINARY, { mode: 0o755 });
  return path;
}

interface WrapperRun {
  code: number;
  stderr: string;
  argv0: string | null;
  args: string[];
  /** What `OPENCODE_CONFIG` was, seen from inside the harness process. */
  config: string | null;
}

/**
 * Runs a generated wrapper the way a shell in a Volli PTY does — shebang, mode
 * bit and all — and reads back what the binary underneath was actually handed.
 * The unit tests in `@volli/shared` can only assert this script's text; a shell
 * is the only thing that can say whether it means what it reads like.
 */
async function runWrapper(
  wrapperPath: string,
  args: string[],
  env: Record<string, string>,
): Promise<WrapperRun> {
  const probe = join(scratchRoot, `probe-${Math.random().toString(36).slice(2)}`);
  let code = 0;
  let stderr = "";
  try {
    const result = await execFileAsync(wrapperPath, args, { env: { ...env, VOLLI_PROBE: probe } });
    stderr = result.stderr;
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    code = failure.code ?? 1;
    stderr = failure.stderr ?? "";
  }
  let recorded: string | null = null;
  try {
    recorded = await readFile(probe, "utf8");
  } catch {
    recorded = null;
  }
  const lines = recorded === null ? [] : recorded.split("\n").filter(Boolean);
  const valueOf = (prefix: string): string | null =>
    lines.find((line) => line.startsWith(prefix))?.slice(prefix.length) ?? null;
  return {
    code,
    stderr,
    argv0: valueOf("argv0="),
    args: lines.filter((line) => line.startsWith("arg=")).map((line) => line.slice("arg=".length)),
    config: valueOf("config="),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("ensureHarnessRuntime", () => {
  it("puts an executable wrapper on the session PATH for each installed harness", async () => {
    const paths = await scratch();

    await ensureHarnessRuntime({
      ...paths,
      socketPath: join(paths.binDir, "..", "volli.sock"),
      adapters: [adapterFor("claude-code")],
      adapterCensus: "complete",
      resolveCommand: () => Promise.resolve(null),
    });

    const wrapperPath = join(paths.binDir, "claude");
    expect(await readFile(wrapperPath, "utf8")).toContain("#!/bin/sh");
    expect((await stat(wrapperPath)).mode & 0o777).toBe(0o755);
  });

  it("replaces a wrapper an older build left behind", async () => {
    const paths = await scratch();
    const input = {
      ...paths,
      socketPath: join(paths.binDir, "..", "volli.sock"),
      adapters: [adapterFor("claude-code")],
      adapterCensus: "complete",
      resolveCommand: () => Promise.resolve(null),
    } as const;
    await mkdir(paths.binDir, { recursive: true });
    await writeFile(join(paths.binDir, "claude"), "#!/bin/sh\n# stale\n", { mode: 0o755 });

    await ensureHarnessRuntime(input);

    expect(await readFile(join(paths.binDir, "claude"), "utf8")).not.toContain("# stale");
  });

  it("leaves the volli launcher alone when a harness claims its name", async () => {
    const paths = await scratch();
    await mkdir(paths.binDir, { recursive: true });
    await writeFile(paths.shimPath, "#!/bin/sh\n# the real launcher\n", { mode: 0o755 });

    const runtime = await ensureHarnessRuntime({
      ...paths,
      socketPath: join(paths.binDir, "..", "volli.sock"),
      adapters: [{ ...adapterFor("claude-code"), command: "volli" }],
      adapterCensus: "complete",
      resolveCommand: () => Promise.resolve(null),
    });

    expect(runtime.wrappers).toEqual([]);
    expect(await readFile(paths.shimPath, "utf8")).toContain("# the real launcher");
  });

  it("refuses a command that is a path rather than a bare executable name", async () => {
    const paths = await scratch();

    const runtime = await ensureHarnessRuntime({
      ...paths,
      socketPath: join(paths.binDir, "..", "volli.sock"),
      adapters: [{ ...adapterFor("claude-code"), command: "../../usr/bin/env" }],
      adapterCensus: "complete",
      resolveCommand: () => Promise.resolve(null),
    });

    expect(runtime.wrappers).toEqual([]);
  });

  it("drops the wrapper of a harness the user has since uninstalled", async () => {
    const paths = await scratch();
    const socketPath = join(paths.binDir, "..", "volli.sock");
    await ensureHarnessRuntime({
      ...paths,
      socketPath,
      adapters: [adapterFor("claude-code"), adapterFor("codex")],
      adapterCensus: "complete",
      resolveCommand: () => Promise.resolve(null),
    });

    await ensureHarnessRuntime({
      ...paths,
      socketPath,
      adapters: [adapterFor("claude-code")],
      adapterCensus: "complete",
      resolveCommand: () => Promise.resolve(null),
    });

    await expect(readFile(join(paths.binDir, "codex"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(paths.binDir, "claude"), "utf8")).toContain("#!/bin/sh");
  });

  it("drops the wrapper of a registered harness that is no longer trusted", async () => {
    const paths = await scratch();
    const socketPath = join(paths.binDir, "..", "volli.sock");
    const registered: HarnessAdapter = {
      ...adapterFor("claude-code"),
      id: "my-harness" as HarnessId,
      command: "my-harness",
    };
    await ensureHarnessRuntime({
      ...paths,
      socketPath,
      adapters: [registered],
      adapterCensus: "complete",
      resolveCommand: () => Promise.resolve(null),
    });

    // A manifest that was edited, deleted or untrusted simply stops being
    // handed in — no table anywhere names its slug, so the reconcile has to
    // read the directory to find the wrapper it left behind.
    await ensureHarnessRuntime({
      ...paths,
      socketPath,
      adapters: [],
      adapterCensus: "complete",
      resolveCommand: () => Promise.resolve(null),
    });

    await expect(readFile(join(paths.binDir, "my-harness"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  // Inert while the bin dir lost the PATH race; a live hazard now that it wins.
  // A wrapper named `git` would sit in front of git for every command in every
  // Volli terminal, with injected argv prepended besides.
  it("refuses a wrapper whose name would shadow a system tool", async () => {
    const paths = await scratch();
    const shadowing: HarnessAdapter = {
      ...adapterFor("claude-code"),
      id: "sneaky" as HarnessId,
      command: "git",
    };

    const runtime = await ensureHarnessRuntime({
      ...paths,
      socketPath: join(paths.binDir, "..", "volli.sock"),
      adapters: [shadowing],
      adapterCensus: "complete",
      resolveCommand: () => Promise.resolve("/usr/bin/git"),
    });

    await expect(readFile(join(paths.binDir, "git"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(runtime.refused).toEqual([
      {
        harnessId: "sneaky",
        command: "git",
        reason: "shadows-system-command",
        resolvedPath: "/usr/bin/git",
      },
    ]);
    expect(runtime.wrapperPaths.has("sneaky" as HarnessId)).toBe(false);
  });

  it("sweeps away a shadowing wrapper an earlier launch had written", async () => {
    const paths = await scratch();
    const socketPath = join(paths.binDir, "..", "volli.sock");
    const shadowing: HarnessAdapter = {
      ...adapterFor("claude-code"),
      id: "sneaky" as HarnessId,
      command: "git",
    };
    // An earlier launch, before the guard could resolve the command.
    await ensureHarnessRuntime({
      ...paths,
      socketPath,
      adapters: [shadowing],
      adapterCensus: "complete",
      resolveCommand: () => Promise.resolve(null),
    });
    expect(await readFile(join(paths.binDir, "git"), "utf8")).toContain("#!/bin/sh");

    await ensureHarnessRuntime({
      ...paths,
      socketPath,
      adapters: [shadowing],
      adapterCensus: "complete",
      resolveCommand: () => Promise.resolve("/usr/bin/git"),
    });

    await expect(readFile(join(paths.binDir, "git"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  // A harness that merely shares a name with something in /opt/homebrew/bin is
  // the ordinary case — refusing it would break real installs.
  it("writes the wrapper when the command resolves outside the system directories", async () => {
    const paths = await scratch();

    const runtime = await ensureHarnessRuntime({
      ...paths,
      socketPath: join(paths.binDir, "..", "volli.sock"),
      adapters: [adapterFor("claude-code")],
      adapterCensus: "complete",
      resolveCommand: () => Promise.resolve("/opt/homebrew/bin/claude"),
    });

    expect(await readFile(join(paths.binDir, "claude"), "utf8")).toContain("#!/bin/sh");
    expect(runtime.refused).toEqual([]);
  });

  it("keeps every wrapper when the adapter list is not a census of the host", async () => {
    const paths = await scratch();
    const socketPath = join(paths.binDir, "..", "volli.sock");
    await ensureHarnessRuntime({
      ...paths,
      socketPath,
      adapters: [adapterFor("claude-code"), adapterFor("codex")],
      adapterCensus: "complete",
      resolveCommand: () => Promise.resolve(null),
    });

    // Detection failed this launch, so nothing here is known to be gone —
    // deleting on that would let one unresolvable PATH destroy a working
    // install, and the next launch that does resolve it rewrites these anyway.
    await ensureHarnessRuntime({
      ...paths,
      socketPath,
      adapters: [],
      adapterCensus: "partial",
      resolveCommand: () => Promise.resolve(null),
    });

    expect(await readFile(join(paths.binDir, "codex"), "utf8")).toContain("#!/bin/sh");
    expect(await readFile(join(paths.binDir, "claude"), "utf8")).toContain("#!/bin/sh");
  });

  it("leaves the launcher and its bundle in place while reconciling wrappers", async () => {
    const paths = await scratch();
    await mkdir(paths.binDir, { recursive: true });
    await writeFile(join(paths.binDir, "volli"), "#!/bin/sh\n# launcher\n", { mode: 0o755 });
    await writeFile(join(paths.binDir, "volli.cjs"), "// bundle\n", { mode: 0o644 });

    await ensureHarnessRuntime({
      ...paths,
      socketPath: join(paths.binDir, "..", "volli.sock"),
      adapters: [],
      adapterCensus: "complete",
      resolveCommand: () => Promise.resolve(null),
    });

    expect(await readFile(join(paths.binDir, "volli"), "utf8")).toContain("launcher");
    expect(await readFile(join(paths.binDir, "volli.cjs"), "utf8")).toContain("bundle");
  });

  // `bin/` is one file per name. Two adapters claiming one command used to be
  // two writes to one path — the second silently inheriting the first's argv
  // injection — and the parser cannot be the only thing standing in the way,
  // since a manifest decided by an older build never passes through today's.
  it("refuses a wrapper for a command another harness already owns", async () => {
    const paths = await scratch();
    const impostor: HarnessAdapter = {
      ...adapterFor("claude-code"),
      id: "my-harness" as HarnessId,
      label: "My Harness",
      command: "claude",
    };

    const runtime = await ensureHarnessRuntime({
      ...paths,
      socketPath: join(paths.binDir, "..", "volli.sock"),
      adapters: [adapterFor("claude-code"), impostor],
      adapterCensus: "complete",
      resolveCommand: () => Promise.resolve(null),
    });

    expect(runtime.refused).toEqual([
      {
        harnessId: "my-harness",
        command: "claude",
        reason: "name-already-owned",
        resolvedPath: join(paths.binDir, "claude"),
      },
    ]);
    // The owner's wrapper is intact — the refusal is of the write, not of the
    // name — and the impostor has no wrapper to be launched through.
    expect(await readFile(join(paths.binDir, "claude"), "utf8")).toContain(
      "VOLLI_HARNESS_ARGV_CLAUDE_CODE",
    );
    expect(runtime.wrapperPaths.get("my-harness" as HarnessId)).toBeUndefined();
  });

  // Order must not decide it: the owner is the adapter whose id matches, not
  // whichever one the loop happens to reach last.
  it("refuses the impostor even when it is written first", async () => {
    const paths = await scratch();
    const impostor: HarnessAdapter = {
      ...adapterFor("claude-code"),
      id: "my-harness" as HarnessId,
      command: "claude",
    };

    const runtime = await ensureHarnessRuntime({
      ...paths,
      socketPath: join(paths.binDir, "..", "volli.sock"),
      adapters: [impostor, adapterFor("claude-code")],
      adapterCensus: "complete",
      resolveCommand: () => Promise.resolve(null),
    });

    expect(runtime.refused.map((entry) => entry.harnessId)).toEqual(["my-harness"]);
    expect(runtime.wrapperPaths.get("claude-code" as HarnessId)).toBe(join(paths.binDir, "claude"));
  });

  it("hands the wrapper its argv through the environment, one word per line", async () => {
    const paths = await scratch();

    const runtime = await ensureHarnessRuntime({
      ...paths,
      socketPath: "/tmp/volli.sock",
      adapters: [adapterFor("claude-code")],
      adapterCensus: "complete",
      resolveCommand: () => Promise.resolve(null),
    });

    const argv = (runtime.env["VOLLI_HARNESS_ARGV_CLAUDE_CODE"] ?? "").split("\n");
    // Two words, unquoted: the flag, and the whole settings payload. The wrapper
    // splits this on newlines rather than parsing it, so quoting it here would
    // hand the harness a word with quotes IN it.
    expect(argv[0]).toBe("--settings");
    expect(argv).toHaveLength(2);
    // Every word of the hook line is quoted, the shim path included — it lives
    // under `Application Support/` in a real install. That quoting is the hook
    // command line's own, inside the JSON, and survives the hand-off untouched.
    expect(argv[1]).toContain("'hook' 'claude-code' 'input.needed' '--socket' '/tmp/volli.sock'");
    expect(argv[1]).toContain("preferredNotifChannel");
  });

  // A word carrying a newline would arrive as two, so the launch is refused
  // rather than silently taken apart. Every VALUE is JSON-escaped on the way
  // here, which leaves the injection flag an adapter declares — reaching argv
  // exactly as written, and never passing through today's manifest parser when
  // an older build decided the manifest.
  it("refuses a wrapper whose argv could not survive the hand-off", async () => {
    const paths = await scratch();
    const split: HarnessAdapter = {
      ...adapterFor("claude-code"),
      injection: { kind: "argv-settings-json", flag: "--settings\n--dangerously-skip" },
    };

    const runtime = await ensureHarnessRuntime({
      ...paths,
      socketPath: "/tmp/volli.sock",
      adapters: [split],
      adapterCensus: "complete",
      resolveCommand: () => Promise.resolve(null),
    });

    expect(runtime.refused).toEqual([
      {
        harnessId: "claude-code",
        command: "claude",
        reason: "argv-not-transportable",
        resolvedPath: join(paths.binDir, "claude"),
      },
    ]);
    expect(runtime.env["VOLLI_HARNESS_ARGV_CLAUDE_CODE"]).toBeUndefined();
    await expect(readFile(join(paths.binDir, "claude"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("materializes a harness's launch files inside its own Volli-owned directory", async () => {
    const paths = await scratch();

    const runtime = await ensureHarnessRuntime({
      ...paths,
      socketPath: "/tmp/volli.sock",
      adapters: [adapterFor("opencode")],
      adapterCensus: "complete",
      resolveCommand: () => Promise.resolve(null),
    });

    const harnessDir = join(paths.harnessRoot, "opencode");
    const config = JSON.parse(await readFile(join(harnessDir, "opencode.json"), "utf8")) as {
      plugin: string[];
    };
    expect(config.plugin).toEqual([join(harnessDir, "volli-plugin.js")]);
    // The variable names the file the harness reads its config out of, and it
    // is exported by opencode's own wrapper — a claude session has no business
    // carrying it, and a leftover `{harnessDir}` would point opencode at a
    // literal path either way.
    expect(runtime.env["OPENCODE_CONFIG"]).toBeUndefined();
    expect(await readFile(join(paths.binDir, "opencode"), "utf8")).toContain(
      `export 'OPENCODE_CONFIG=${join(harnessDir, "opencode.json")}'`,
    );
  });

  // Cursor writes NOTHING here, and that is the fix rather than an omission:
  // its hooks reach a path relative to the session's working directory, so a
  // file under `<userData>` would be one more file cursor never reads.
  it("writes no Volli-owned config for a harness whose config lives in the workspace", async () => {
    const paths = await scratch();

    const runtime = await ensureHarnessRuntime({
      ...paths,
      socketPath: "/tmp/volli.sock",
      adapters: [adapterFor("cursor")],
      adapterCensus: "complete",
      resolveCommand: () => Promise.resolve(null),
    });

    await expect(access(join(paths.harnessRoot, "cursor"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(runtime.wrapperPaths.get("cursor" as HarnessId)).toBe(
      join(paths.binDir, "cursor-agent"),
    );
    expect(await readFile(join(paths.binDir, "cursor-agent"), "utf8")).not.toContain(
      "CURSOR_CONFIG_DIR",
    );
  });

  // A config file is written in place, so a symlink left at its name would have
  // Volli write the hook config through to wherever it points — and the harness
  // would then run whatever came back. The write refuses instead, and refuses
  // loudly: a wrapper naming a config Volli never wrote is worse than no wrapper.
  it("refuses to write a harness config through a symlink, and writes no wrapper for it", async () => {
    const paths = await scratch();
    const harnessDir = join(paths.harnessRoot, "opencode");
    const elsewhere = join(scratchRoot, "somebody-elses.json");
    await writeFile(elsewhere, "untouched", "utf8");
    await mkdir(harnessDir, { recursive: true });
    await symlink(elsewhere, join(harnessDir, "opencode.json"));

    await expect(
      ensureHarnessRuntime({
        ...paths,
        socketPath: "/tmp/volli.sock",
        adapters: [adapterFor("opencode")],
        adapterCensus: "complete",
        resolveCommand: () => Promise.resolve(null),
      }),
    ).rejects.toThrow(/Refusing to manage non-regular file .*opencode\.json/);

    expect(await readFile(elsewhere, "utf8")).toBe("untouched");
    await expect(access(join(paths.binDir, "opencode"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("writes a harness config that no link is sitting on", async () => {
    const paths = await scratch();

    await ensureHarnessRuntime({
      ...paths,
      socketPath: "/tmp/volli.sock",
      adapters: [adapterFor("opencode")],
      adapterCensus: "complete",
      resolveCommand: () => Promise.resolve(null),
    });

    const configPath = join(paths.harnessRoot, "opencode", "opencode.json");
    expect((await stat(configPath)).isFile()).toBe(true);
    // And it is still a plain replace on the next pass — the guard refuses a
    // foreign path, not Volli's own previous write.
    await ensureHarnessRuntime({
      ...paths,
      socketPath: "/tmp/volli.sock",
      adapters: [adapterFor("opencode")],
      adapterCensus: "complete",
      resolveCommand: () => Promise.resolve(null),
    });
    expect((await stat(configPath)).isFile()).toBe(true);
  });
});

/**
 * The wrapper, executed. Everything above asserts what was written; a shell is
 * the only thing that can say what it means — and the two hazards this covers
 * (a second parse of the injected argv, and a configuration variable leaking
 * into a session that never ran the harness) are invisible to a text assertion.
 * `apps/desktop/e2e/harness-wrapper-smoke.mjs` runs the same script against a
 * live PTY's real environment; this runs it in milliseconds, in CI.
 */
/** Drops a stand-in `volli` shim where the wrapper will look for the real one. */
async function installFakeVolli(shimPath: string, script: string): Promise<void> {
  await mkdir(join(shimPath, ".."), { recursive: true });
  await writeFile(shimPath, script, { mode: 0o755 });
}

describe("the generated wrapper, run", () => {
  /** A harness whose injected settings carry every character a shell reacts to. */
  const HOSTILE_SETTING = '$(touch pwned) `touch pwned2` it\'s \\ * "quoted"';

  /**
   * A stand-in for the generated `volli`, written where the wrapper's pinned
   * `cliPath` points. It logs the argv it was called with and answers a mint
   * with a DIFFERENT id every time, which is the property under test: the
   * wrapper must launch with the id it was just handed, not with one it read
   * out of an environment that never changes.
   */
  // Shell builtins only: the session PATH under test resolves nowhere, so a
  // `cat` here would silently fail and hand every launch the same id — the very
  // bug these tests exist to catch.
  const FAKE_VOLLI = [
    "#!/bin/sh",
    'printf "%s\\n" "$*" >> "$VOLLI_MINT_LOG"',
    "volli_n=0",
    'if [ -f "$VOLLI_MINT_COUNT" ]; then read volli_n < "$VOLLI_MINT_COUNT"; fi',
    "volli_n=$((volli_n + 1))",
    'printf "%s\\n" "$volli_n" > "$VOLLI_MINT_COUNT"',
    'printf "00000000-0000-4000-8000-00000000000%s\\n" "$volli_n"',
    "",
  ].join("\n");

  /** The same shim, unable to answer — a dead app, a broken install, a bad socket. */
  const FAILING_VOLLI = [
    "#!/bin/sh",
    'printf "error[APP_UNREACHABLE] nope\\n" >&2',
    "exit 3",
    "",
  ].join("\n");

  async function hostileRuntime(): Promise<{
    wrapperPath: string;
    shimPath: string;
    env: Record<string, string>;
  }> {
    const paths = await scratch();
    const binaryPath = await fakeBinary("hostile");
    const runtime = await ensureHarnessRuntime({
      ...paths,
      socketPath: "/tmp/volli.sock",
      adapters: [
        {
          ...adapterFor("claude-code"),
          id: "hostile" as HarnessId,
          label: "Hostile",
          command: "hostile",
          launchSettings: [{ path: "volliProbe", value: HOSTILE_SETTING }],
        },
      ],
      adapterCensus: "complete",
      resolveCommand: () => Promise.resolve(binaryPath),
    });
    const wrapperPath = runtime.wrapperPaths.get("hostile" as HarnessId);
    if (wrapperPath === undefined) throw new Error("no wrapper was written");
    return {
      wrapperPath,
      shimPath: paths.shimPath,
      env: { ...runtime.env, PATH: "/nonexistent" },
    };
  }

  /** A session environment that can reach an app, with the mint's bookkeeping. */
  function mintingSession(env: Record<string, string>): Record<string, string> {
    return {
      ...env,
      VOLLI_SESSION: "5f0d0f7a-0000-4000-8000-000000000000",
      VOLLI_SOCKET: join(scratchRoot, "volli.sock"),
      VOLLI_MINT_LOG: join(scratchRoot, "mint-log"),
      VOLLI_MINT_COUNT: join(scratchRoot, "mint-count"),
    };
  }

  // The one that matters: the injected argv reaches the harness as the
  // characters it left as, and nothing in it is executed on the way. A command
  // substitution here would create the file it names.
  it("carries a settings payload the shell would otherwise read, verbatim", async () => {
    const { wrapperPath, env } = await hostileRuntime();

    const run = await runWrapper(wrapperPath, ["--print", "hello world"], {
      ...env,
      VOLLI_SESSION: "5f0d0f7a-0000-4000-8000-000000000000",
    });

    expect(run.code).toBe(0);
    expect(run.args[0]).toBe("--settings");
    const settings = JSON.parse(run.args[1] ?? "{}") as { volliProbe?: string };
    expect(settings.volliProbe).toBe(HOSTILE_SETTING);
    // No socket in this environment, so no id was minted and none is passed —
    // see the minting tests below for the launch that has one.
    expect(run.args.slice(2)).toEqual(["--print", "hello world"]);
    expect(await exists(join(scratchRoot, "pwned"))).toBe(false);
    expect(await exists(join(scratchRoot, "pwned2"))).toBe(false);
  });

  // THE RELAUNCH BUG, in a shell. `VOLLI_SESSION` is stamped once per PTY, so a
  // wrapper that read the session id out of it handed the second launch in one
  // terminal the id the first had already consumed — which a harness that
  // treats the id as single-use per workspace (cursor) refuses outright.
  it("launches with an id it asked the app for, freshly, every time", async () => {
    const { wrapperPath, shimPath, env } = await hostileRuntime();
    await installFakeVolli(shimPath, FAKE_VOLLI);
    const session = mintingSession(env);

    const first = await runWrapper(wrapperPath, ["hello"], session);
    const second = await runWrapper(wrapperPath, ["hello"], session);

    expect(first.args.slice(-3)).toEqual([
      "--session-id",
      "00000000-0000-4000-8000-000000000001",
      "hello",
    ]);
    expect(second.args.slice(-3)).toEqual([
      "--session-id",
      "00000000-0000-4000-8000-000000000002",
      "hello",
    ]);
    expect(second.args).not.toContain(session["VOLLI_SESSION"]);
    // One call, doing both jobs: the announce and the mint.
    const log = await readFile(join(scratchRoot, "mint-log"), "utf8");
    expect(log.trim().split("\n")).toEqual([
      "session harness hostile --mint",
      "session harness hostile --mint",
    ]);
  });

  // Degrading to an unpinned launch is correct; launching under an id that may
  // already exist is the failure this removed. Either way the agent starts.
  it("launches with no session id at all when the app cannot answer", async () => {
    const { wrapperPath, shimPath, env } = await hostileRuntime();
    await installFakeVolli(shimPath, FAILING_VOLLI);

    const run = await runWrapper(wrapperPath, ["hello"], mintingSession(env));

    expect(run.code).toBe(0);
    expect(run.args).not.toContain("--session-id");
    expect(run.args.slice(-1)).toEqual(["hello"]);
    // The harness owns this terminal a moment from now; the failure may not
    // print into its first frame.
    expect(run.stderr).toBe("");
  });

  // The user asked for a specific session. They are not handed another one —
  // but Volli is still told what is running, on the detached announce.
  it("asks for no id, and still announces, when the user drives resume", async () => {
    const { wrapperPath, shimPath, env } = await hostileRuntime();
    await installFakeVolli(shimPath, FAKE_VOLLI);
    const session = mintingSession(env);

    const run = await runWrapper(wrapperPath, ["--resume", "abc123"], session);

    expect(run.args).not.toContain("--session-id");
    // Backgrounded, so it may not have landed yet — the id it would have minted
    // is what matters, and it is not on the command line either way.
    expect(run.args.slice(-2)).toEqual(["--resume", "abc123"]);
  });

  it("leaves an invocation outside a Volli session completely alone", async () => {
    const { wrapperPath, env } = await hostileRuntime();

    const run = await runWrapper(wrapperPath, ["--print", "hello"], env);

    expect(run.code).toBe(0);
    expect(run.args).toEqual(["--print", "hello"]);
  });

  it("keeps its session id out when the user's own argv drives resume", async () => {
    const { wrapperPath, env } = await hostileRuntime();

    const run = await runWrapper(wrapperPath, ["--resume", "abc123"], {
      ...env,
      VOLLI_SESSION: "5f0d0f7a-0000-4000-8000-000000000000",
    });

    expect(run.code).toBe(0);
    expect(run.args).not.toContain("--session-id");
    expect(run.args.slice(-2)).toEqual(["--resume", "abc123"]);
  });

  // An unset variable must expand to NOTHING — not to an empty argument the
  // harness would then have to interpret.
  it("adds no empty word when no argv was configured for it", async () => {
    const { wrapperPath, env } = await hostileRuntime();

    const run = await runWrapper(wrapperPath, ["hello"], {
      PATH: env["PATH"] ?? "",
      VOLLI_SESSION: "5f0d0f7a-0000-4000-8000-000000000000",
    });

    expect(run.args).toEqual(["hello"]);
  });

  // The binary a human approved is the one that runs: PATH here resolves
  // nowhere, and the wrapper still finds the file main pinned into it.
  it("runs the binary main resolved rather than whatever PATH now says", async () => {
    const { wrapperPath, env } = await hostileRuntime();

    const run = await runWrapper(wrapperPath, ["hello"], {
      ...env,
      VOLLI_SESSION: "5f0d0f7a-0000-4000-8000-000000000000",
    });

    expect(run.argv0).toBe(join(scratchRoot, "realbin-hostile", "hostile"));
  });

  // A pinned path that no longer exists means the harness was uninstalled or
  // moved, so the walk still has to run — and still has to fail loudly rather
  // than pass an empty command to exec.
  it("falls back to PATH when the pinned binary is gone", async () => {
    const { wrapperPath, env } = await hostileRuntime();
    await rm(join(scratchRoot, "realbin-hostile", "hostile"), { force: true });
    const elsewhere = await fakeBinary("hostile", "moved");
    const session = { ...env, VOLLI_SESSION: "5f0d0f7a-0000-4000-8000-000000000000" };

    const found = await runWrapper(wrapperPath, ["hello"], {
      ...session,
      PATH: join(scratchRoot, "realbin-moved"),
    });
    const missing = await runWrapper(wrapperPath, ["hello"], session);

    expect(found.code).toBe(0);
    expect(found.argv0).toBe(elsewhere);
    expect(missing.code).toBe(127);
    expect(missing.stderr).toContain("volli: cannot find");
  });

  it("still lets an explicit override name the binary outright", async () => {
    const { wrapperPath, env } = await hostileRuntime();
    const override = await fakeBinary("override");

    const run = await runWrapper(wrapperPath, ["hello"], {
      ...env,
      VOLLI_SESSION: "5f0d0f7a-0000-4000-8000-000000000000",
      VOLLI_HARNESS_BIN_HOSTILE: override,
    });

    expect(run.argv0).toBe(override);
  });

  // A harness's own configuration is in scope for the process the wrapper
  // execs, and for nothing else in the terminal.
  it("exports a harness's configuration variable to that harness alone", async () => {
    const paths = await scratch();
    const binaryPath = await fakeBinary("opencode");
    const runtime = await ensureHarnessRuntime({
      ...paths,
      socketPath: "/tmp/volli.sock",
      adapters: [adapterFor("opencode")],
      adapterCensus: "complete",
      resolveCommand: () => Promise.resolve(binaryPath),
    });
    const wrapperPath = runtime.wrapperPaths.get("opencode" as HarnessId) ?? "";
    const session = { ...runtime.env, PATH: "/nonexistent" };

    const run = await runWrapper(wrapperPath, ["hello"], {
      ...session,
      VOLLI_SESSION: "5f0d0f7a-0000-4000-8000-000000000000",
    });

    // Nothing in the session sets it…
    expect(runtime.env["OPENCODE_CONFIG"]).toBeUndefined();
    // …and the harness it belongs to gets it anyway, from its own wrapper.
    expect(run.code).toBe(0);
    expect(run.config).toBe(join(paths.harnessRoot, "opencode", "opencode.json"));

    // Another harness's wrapper, in the same session, does not carry it — which
    // is the whole point of moving it off the session's environment.
    const { wrapperPath: other } = await hostileRuntime();
    const elsewhere = await runWrapper(other, ["hello"], {
      ...session,
      VOLLI_SESSION: "5f0d0f7a-0000-4000-8000-000000000000",
    });
    expect(elsewhere.config).toBe("unset");
  });
});

describe("harnessLaunchArgv", () => {
  it("names the words a launch really prepends, with no token left to resolve", async () => {
    const paths = await scratch();

    const argv = harnessLaunchArgv(adapterFor("codex"), {
      harnessRoot: paths.harnessRoot,
      socketPath: join(paths.binDir, "..", "volli.sock"),
      shimPath: paths.shimPath,
    });

    // codex injects its hooks inline, so what has to be resolved here is the
    // shim every hook command line names — a token still standing would be a
    // confirmation naming a binary that does not exist.
    expect(argv.length).toBeGreaterThan(0);
    expect(argv.join(" ")).not.toContain("{harnessDir}");
    expect(argv.join(" ")).toContain(paths.shimPath);
  });

  it("is empty for a harness Volli configures by environment rather than argv", async () => {
    const paths = await scratch();

    expect(
      harnessLaunchArgv(adapterFor("cursor"), {
        harnessRoot: paths.harnessRoot,
        socketPath: join(paths.binDir, "..", "volli.sock"),
        shimPath: paths.shimPath,
      }),
    ).toEqual([]);
  });
});
