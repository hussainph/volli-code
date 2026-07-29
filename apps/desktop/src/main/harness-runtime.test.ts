import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
      adapters: [adapterFor("cursor")],
      adapterCensus: "complete",
      resolveCommand: () => Promise.resolve(null),
    });

    const harnessDir = join(paths.harnessRoot, "cursor");
    const config = JSON.parse(await readFile(join(harnessDir, "cli-config.json"), "utf8")) as {
      hooks: Record<string, { command: string }[]>;
    };
    expect(config.hooks["stop"]?.[0]?.command).toContain("'hook' 'cursor' 'turn.completed'");
    // The variable names the directory the harness reads its config out of, and
    // it is exported by cursor's own wrapper — a claude session has no business
    // carrying it, and a leftover `{harnessDir}` would point cursor at a
    // literal path either way.
    expect(runtime.env["CURSOR_CONFIG_DIR"]).toBeUndefined();
    expect(await readFile(join(paths.binDir, "cursor-agent"), "utf8")).toContain(
      `export 'CURSOR_CONFIG_DIR=${harnessDir}'`,
    );
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
describe("the generated wrapper, run", () => {
  /** A harness whose injected settings carry every character a shell reacts to. */
  const HOSTILE_SETTING = '$(touch pwned) `touch pwned2` it\'s \\ * "quoted"';

  async function hostileRuntime(): Promise<{ wrapperPath: string; env: Record<string, string> }> {
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
    return { wrapperPath, env: { ...runtime.env, PATH: "/nonexistent" } };
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
    expect(run.args.slice(2)).toEqual([
      "--session-id",
      "5f0d0f7a-0000-4000-8000-000000000000",
      "--print",
      "hello world",
    ]);
    expect(await exists(join(scratchRoot, "pwned"))).toBe(false);
    expect(await exists(join(scratchRoot, "pwned2"))).toBe(false);
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

    expect(run.args).toEqual(["--session-id", "5f0d0f7a-0000-4000-8000-000000000000", "hello"]);
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
