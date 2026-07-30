/**
 * Materializes the harness half of the agent runtime: the PATH wrappers that
 * turn a harness invocation inside a Volli PTY into a configured one, and the
 * launch configuration those wrappers apply.
 */
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  buildLaunchConfig,
  harnessCommandOwner,
  harnessEnvSuffix,
  HARNESS_DIR_TOKEN,
  isBareHarnessCommand,
  renderWrapperScript,
  shadowsSystemCommand,
} from "@volli/shared";
import type { HarnessAdapter, HarnessId, WrapperRefusal } from "@volli/shared";

export interface HarnessRuntimeInput {
  /** Volli's own `bin/` — the same directory the `volli` shim lives in. */
  binDir: string;
  /** `<userData>/harness` — the root of the per-harness Volli-owned directories. */
  harnessRoot: string;
  /** The app's live Unix socket, which a fired hook reports back over. */
  socketPath: string;
  /** The generated `volli` launcher a hook command invokes. */
  shimPath: string;
  /** The harnesses actually installed on this host. */
  adapters: readonly HarnessAdapter[];
  /**
   * Whether {@link adapters} is a complete census of this host, or all the
   * caller could learn. `partial` means detection or the manifest scan could not
   * run, so an absent harness is indistinguishable from an unknown one and no
   * wrapper is removed — see the reconcile below.
   */
  adapterCensus: "complete" | "partial";
  /**
   * Where a command resolves on the user's real `PATH`, Volli's own `bin/`
   * skipped — used to refuse a wrapper that would shadow a system tool. `null`
   * means the command resolves nowhere, which is not a reason to refuse: the
   * wrapper's own "cannot find" is a better error than the shell's.
   */
  resolveCommand: (command: string) => Promise<string | null>;
}

/** A wrapper Volli declined to write, and why — surfaced by `volli doctor`. */
export interface RefusedWrapper {
  harnessId: HarnessId;
  command: string;
  reason: WrapperRefusal;
  /**
   * The path that makes the refusal concrete: what the name resolves to today
   * for a shadowed system tool, and the `bin/` entry that stays unwritten
   * otherwise. Always a real path, never an explanation — `volli doctor` prints
   * it as one.
   */
  resolvedPath: string;
}

export interface HarnessRuntime {
  /** Absolute paths of the wrappers now on disk. */
  wrappers: string[];
  /**
   * Where each harness's wrapper lives, by harness id — what a launch line has
   * to name instead of a bare command.
   *
   * A miss is meaningful and must not be papered over: it says Volli wrote no
   * wrapper for that harness this launch, so a launch resolves the harness
   * through `PATH` and reports nothing. Callers spell that as the Known tier
   * rather than pretending a wrapper exists.
   */
  wrapperPaths: ReadonlyMap<HarnessId, string>;
  /** Wrappers Volli declined to write, each with the rule that declined it. */
  refused: RefusedWrapper[];
  /**
   * Merged into every Volli PTY's environment alongside `agentSessionEnv` —
   * `VOLLI_HARNESS_ARGV_<SLUG>` and nothing else.
   *
   * Session-wide because a wrapper has to READ it, and reading it is the first
   * thing a wrapper does; there is no earlier place to put it. That is the line:
   * what a wrapper reads travels in the session, what a HARNESS reads is
   * exported by its own wrapper one step before its exec. A config variable in
   * the session (`OPENCODE_CONFIG` in a claude terminal) configures nothing and
   * tells every agent about a harness that is not running.
   *
   * Session-independent — `buildLaunchConfig` cannot mint a session id, so one
   * environment serves every launch.
   */
  env: Record<string, string>;
}

/** The Volli-owned directory a harness's generated config files live in. */
export function harnessDirFor(harnessRoot: string, adapter: HarnessAdapter): string {
  return join(harnessRoot, adapter.id);
}

/**
 * The argv prefix a fired hook runs. `buildLaunchConfig` appends the canonical
 * event name and `--socket <path>`, so this only names the launcher and which
 * harness is reporting.
 *
 * Unquoted, deliberately: these are argv words, and whichever form a harness
 * needs them in — a shell command line, or codex's `notify` array — is that
 * harness's business to render. Quoting here would bake a shell assumption into
 * a value that does not always reach one.
 */
function hookArgvFor(shimPath: string, adapter: HarnessAdapter): readonly string[] {
  return [shimPath, "hook", adapter.id];
}

/**
 * The words a launch of `adapter` really prepends to whatever the user typed —
 * what a trust confirmation has to name.
 *
 * Resolved, not templated: `{harnessDir}` is a placeholder the runtime expands
 * on the way to disk, and a confirmation still carrying it would name a file
 * that does not exist. Empty for a harness Volli configures by environment
 * variable instead of on the command line.
 */
export function harnessLaunchArgv(
  adapter: HarnessAdapter,
  input: { harnessRoot: string; socketPath: string; shimPath: string },
): string[] {
  const config = buildLaunchConfig(adapter, {
    socketPath: input.socketPath,
    hookArgv: hookArgvFor(input.shimPath, adapter),
  });
  const harnessDir = harnessDirFor(input.harnessRoot, adapter);
  return config.argv.map((token) => token.replaceAll(HARNESS_DIR_TOKEN, harnessDir));
}

/**
 * Replaces one generated file without ever writing THROUGH whatever is already
 * at its path.
 *
 * {@link writeExecutable} gets this for free: it lands on a fresh temp and
 * renames, and `rename` replaces a symlink rather than following it. A file
 * written in place does not — `writeFile` opens the path, so a symlink someone
 * left there silently redirects Volli's write to wherever it points. Both files
 * that go through here are read by something Volli then runs (a harness's own
 * configuration, and the zsh chain every PTY sources), which makes a redirected
 * write here worth more than any other write the app makes.
 *
 * The refusal is a THROW rather than a skip, and says the same thing
 * `harness-install.ts` says about the same rule: a managed write that could not
 * happen is precisely the silent mutation failure this codebase refuses to
 * carry. It is also a different answer from "nothing was there" — an ENOENT is
 * not a failure at all here, it is the ordinary first write — because the two
 * ask opposite things of the user. Absent means regenerate; occupied means
 * something that is not Volli's owns this path, and regenerating will refuse
 * again forever. `volli doctor --fix`, which is the remedy doctor prints for a
 * missing chain, reports the refusal verbatim instead of hiding it.
 */
export async function writeGeneratedFile(
  path: string,
  content: string,
  mode: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    const entry = await lstat(path);
    if (!entry.isFile()) throw new Error(`Refusing to manage non-regular file ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporaryPath = `${path}.volli-${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

/** Replaces one generated file in place: atomic temp + rename, never a partial script. */
async function writeExecutable(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o700, flag: "wx" });
    await chmod(temporaryPath, 0o755);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

/**
 * Regenerates every wrapper each boot, exactly as the `volli` shim is
 * regenerated, so a wrapper written against an older contract can never outlive
 * the build that wrote it.
 */
export async function ensureHarnessRuntime(input: HarnessRuntimeInput): Promise<HarnessRuntime> {
  await mkdir(input.binDir, { recursive: true });
  const wrappers: string[] = [];
  const wrapperPaths = new Map<HarnessId, string>();
  const refused: RefusedWrapper[] = [];
  const env: Record<string, string> = {};
  for (const adapter of input.adapters) {
    if (!isBareHarnessCommand(adapter.command)) continue;
    const wrapperPath = join(input.binDir, adapter.command);
    // `bin/` is one file per name, and a write is the moment that becomes true
    // or stops being. Two adapters claiming one command used to be two writes to
    // one path, the later one silently inheriting the earlier one's argv
    // injection — and the parser refusing an owned name for a REGISTERED
    // manifest does not cover it, because the manifest that reaches this loop
    // need not have passed today's parser. Compare the owner against the adapter
    // actually being written: `claude-code` may claim `claude`, and nobody else.
    const owner = harnessCommandOwner(adapter.command);
    if (owner !== null && owner !== adapter.id) {
      refused.push({
        harnessId: adapter.id,
        command: adapter.command,
        reason: "name-already-owned",
        resolvedPath: wrapperPath,
      });
      continue;
    }
    // Now that the bin dir genuinely wins PATH inside a session, a wrapper named
    // after a system tool would shadow it for every command in every Volli
    // terminal — and would prepend injected argv to it besides.
    const resolvedCommand = await input.resolveCommand(adapter.command);
    if (resolvedCommand !== null && shadowsSystemCommand(resolvedCommand)) {
      refused.push({
        harnessId: adapter.id,
        command: adapter.command,
        reason: "shadows-system-command",
        resolvedPath: resolvedCommand,
      });
      continue;
    }

    const harnessDir = harnessDirFor(input.harnessRoot, adapter);
    const config = buildLaunchConfig(adapter, {
      socketPath: input.socketPath,
      hookArgv: hookArgvFor(input.shimPath, adapter),
    });
    const resolve = (value: string): string => value.replaceAll(HARNESS_DIR_TOKEN, harnessDir);
    const argv = config.argv.map(resolve);
    // The hand-off below is one word per line, split by the wrapper on newlines
    // alone. A word carrying one would arrive as two, and an empty word would
    // vanish (newline is IFS whitespace, so runs of it collapse) — so refuse the
    // wrapper rather than launch a harness with a command line silently taken
    // apart. Every VALUE is rendered through JSON, which escapes the character;
    // what is left is the injection FLAG an adapter declares, which reaches argv
    // as written, and a Volli path with a newline in it.
    if (argv.some((token) => token.includes("\n") || token.length === 0)) {
      refused.push({
        harnessId: adapter.id,
        command: adapter.command,
        reason: "argv-not-transportable",
        resolvedPath: wrapperPath,
      });
      continue;
    }

    // The harness's own generated configuration, written BEFORE the wrapper
    // that names it. The wrapper exports these paths, so a harness whose
    // configuration Volli could not write must not get a wrapper claiming
    // otherwise — and a refusal here (see {@link writeGeneratedFile}) leaves
    // this harness unwrapped rather than launched against a file somebody else
    // owns.
    for (const file of config.files) {
      await writeGeneratedFile(resolve(file.path), resolve(file.content), 0o600);
    }

    // The wrapper carries everything true of THIS harness: the binary the trust
    // dialog named (the same resolution the shadow guard just performed), and
    // the configuration variables the harness itself reads — which belong to the
    // process the wrapper is about to exec, not to every PTY.
    await writeExecutable(
      wrapperPath,
      renderWrapperScript(adapter, {
        binDir: input.binDir,
        binaryPath: resolvedCommand,
        // The same launcher a fired hook runs, for the same reason: it is the
        // one `volli` this build generated, and the wrapper announces itself
        // through it before handing the terminal to the harness.
        cliPath: input.shimPath,
        env: Object.fromEntries(
          Object.entries(config.env).map(([name, value]) => [name, resolve(value)]),
        ),
      }),
    );
    wrappers.push(wrapperPath);
    wrapperPaths.set(adapter.id, wrapperPath);

    // One word per line, and no quoting: the wrapper applies this by field
    // splitting on newlines rather than by parsing it, so a `--settings` payload
    // full of quotes and braces arrives as the one word it left as.
    if (argv.length > 0) {
      env[`VOLLI_HARNESS_ARGV_${harnessEnvSuffix(adapter)}`] = argv.join("\n");
    }
  }
  // A wrapper for a harness that is no longer on the host is worse than no
  // wrapper: it shadows nothing but its own "cannot find" error, where the
  // shell would have said "command not found". Reconcile rather than accumulate.
  //
  // By reading the directory rather than iterating the built-in adapters,
  // because a registered harness is nowhere in that list: a manifest that was
  // edited, deleted or untrusted simply stops arriving in `input.adapters`, and
  // the only remaining evidence of it is the wrapper it left here. Everything
  // in this directory is either the launcher (a reserved name, so
  // `isBareHarnessCommand` refuses it) or a wrapper Volli generated.
  //
  // Only a COMPLETE census justifies a deletion. An empty list is not proof
  // that every harness was uninstalled — it is also what a PATH that would not
  // resolve or a db that would not open produces, and taking that as proof
  // would let one failed launch destroy the wrappers a working install depends
  // on. Keeping a stale wrapper costs one confusing error; removing a live one
  // costs the whole feature until someone notices.
  if (input.adapterCensus === "complete") {
    // Keyed on what was actually WRITTEN, not on what was offered: a wrapper
    // refused above must also be swept away if an earlier launch wrote it.
    const current = new Set(wrappers.map((path) => basename(path)));
    for (const entry of await readdir(input.binDir)) {
      if (current.has(entry) || !isBareHarnessCommand(entry)) continue;
      await rm(join(input.binDir, entry), { force: true });
    }
  }
  return { wrappers, wrapperPaths, refused, env };
}
