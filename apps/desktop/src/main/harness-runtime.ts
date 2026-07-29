/**
 * Materializes the harness half of the agent runtime: the PATH wrappers that
 * turn a harness invocation inside a Volli PTY into a configured one, and the
 * launch configuration those wrappers apply.
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  buildLaunchConfig,
  harnessEnvSuffix,
  HARNESS_DIR_TOKEN,
  isBareHarnessCommand,
  renderWrapperScript,
  shellSingleQuote,
} from "@volli/shared";
import type { HarnessAdapter } from "@volli/shared";

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
}

export interface HarnessRuntime {
  /** Absolute paths of the wrappers now on disk. */
  wrappers: string[];
  /**
   * Merged into every Volli PTY's environment alongside `agentSessionEnv`. The
   * wrapper reads its argv out of `VOLLI_HARNESS_ARGV_<SLUG>` here, and a
   * harness configured by environment variable (cursor, opencode) finds its
   * Volli-owned config through it. Session-independent — `buildLaunchConfig`
   * cannot mint a session id, so one environment serves every launch.
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
  const env: Record<string, string> = {};
  for (const adapter of input.adapters) {
    if (!isBareHarnessCommand(adapter.command)) continue;
    const wrapperPath = join(input.binDir, adapter.command);
    await writeExecutable(wrapperPath, renderWrapperScript(adapter, { binDir: input.binDir }));
    wrappers.push(wrapperPath);

    const harnessDir = harnessDirFor(input.harnessRoot, adapter);
    const config = buildLaunchConfig(adapter, {
      socketPath: input.socketPath,
      hookArgv: hookArgvFor(input.shimPath, adapter),
    });
    const resolve = (value: string): string => value.replaceAll(HARNESS_DIR_TOKEN, harnessDir);
    if (config.files.length > 0) await mkdir(harnessDir, { recursive: true });
    for (const file of config.files) {
      await writeFile(resolve(file.path), resolve(file.content), { encoding: "utf8", mode: 0o600 });
    }
    for (const [name, value] of Object.entries(config.env)) env[name] = resolve(value);
    // The wrapper applies this with `eval "set -- $VOLLI_HARNESS_ARGV_<SLUG>"`,
    // so each token is quoted here — an injected `--settings` payload is JSON
    // full of quotes and braces, and must reach the harness as ONE word.
    if (config.argv.length > 0) {
      env[`VOLLI_HARNESS_ARGV_${harnessEnvSuffix(adapter)}`] = config.argv
        .map((token) => shellSingleQuote(resolve(token)))
        .join(" ");
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
    const current = new Set(input.adapters.map((adapter) => adapter.command));
    for (const entry of await readdir(input.binDir)) {
      if (current.has(entry) || !isBareHarnessCommand(entry)) continue;
      await rm(join(input.binDir, entry), { force: true });
    }
  }
  return { wrappers, env };
}
