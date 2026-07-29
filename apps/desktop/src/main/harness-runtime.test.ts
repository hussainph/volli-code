import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { getHarnessAdapter } from "@volli/shared";
import type { HarnessAdapter, HarnessId } from "@volli/shared";

import { ensureHarnessRuntime, harnessLaunchArgv } from "./harness-runtime";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

function adapterFor(id: string): HarnessAdapter {
  const found = getHarnessAdapter(id as HarnessId);
  if (!found) throw new Error(`no adapter for ${id}`);
  return found;
}

async function scratch(): Promise<{ binDir: string; harnessRoot: string; shimPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "volli-harness-runtime-"));
  cleanup = () => rm(root, { recursive: true, force: true });
  return {
    binDir: join(root, "bin"),
    harnessRoot: join(root, "harness"),
    shimPath: join(root, "bin", "volli"),
  };
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
      { harnessId: "sneaky", command: "git", resolvedPath: "/usr/bin/git" },
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

  it("hands the wrapper its argv through the environment, shell-quoted", async () => {
    const paths = await scratch();

    const runtime = await ensureHarnessRuntime({
      ...paths,
      socketPath: "/tmp/volli.sock",
      adapters: [adapterFor("claude-code")],
      adapterCensus: "complete",
      resolveCommand: () => Promise.resolve(null),
    });

    const argv = runtime.env["VOLLI_HARNESS_ARGV_CLAUDE_CODE"] ?? "";
    // Two shell words: the flag, and the whole settings payload as ONE word —
    // its own quotes escaped, since the wrapper applies this through `eval`.
    expect(argv).toMatch(/^'--settings' '\{/);
    // Every word of the hook line is quoted, the shim path included — it lives
    // under `Application Support/` in a real install.
    expect(argv).toContain(
      "'\\''hook'\\'' '\\''claude-code'\\'' '\\''input.needed'\\'' '\\''--socket'\\'' '\\''/tmp/volli.sock'\\''",
    );
    expect(argv).toContain("preferredNotifChannel");
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
    // The variable names the directory the harness reads its config out of, so
    // a leftover `{harnessDir}` would point cursor at a literal path.
    expect(runtime.env["CURSOR_CONFIG_DIR"]).toBe(harnessDir);
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
