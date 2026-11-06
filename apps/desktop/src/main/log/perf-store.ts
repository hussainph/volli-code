/**
 * The desktop's perf store (VC-1092): every stall the log records, kept in
 * the profile's own bounded `perf.db` for `volli perf` and the support
 * report.
 *
 * Opened before the log so its sink sees the first stall; only the instance
 * that owns the profile opens it, as only that one writes the log.
 *
 * **Which build recorded a stall.** A packaged build is its version. A dev
 * build's version does not change between edits, so its runs also carry a
 * build label: `VOLLI_PERF_BUILD` when set at launch (name an experiment:
 * `VOLLI_PERF_BUILD=memo-roster pnpm dev`), else the source checkout's short
 * commit, asked of git once, off the boot path.
 */
import { openPerfStore, perfStallSink, perfStorePath, type PerfStore } from "@volli/host-core/perf";
import { runGitCapturingAsync, type RunGitAsync } from "@volli/host-core/worktree";
import { hostLogger, type LogSink } from "@volli/host-core/log";

export interface DesktopPerfStore {
  readonly store: PerfStore;
  /** The sink the log tees every line through. */
  readonly sink: LogSink;
  /** Resolves once the build label is recorded (or known to be absent). */
  readonly labelled: Promise<void>;
}

export interface DesktopPerfStoreOptions {
  readonly userData: string;
  readonly version: string;
  readonly dev: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The app's source directory: a dev build's checkout. */
  readonly appPath: string;
  readonly git?: RunGitAsync;
  /** Where the store is closed on exit; `process` unless a test drives it. */
  readonly onExit?: (close: () => void) => void;
}

/** `VOLLI_PERF_BUILD` as a label: identifier characters only, or nothing. */
export function perfBuildFromEnv(env: Readonly<Record<string, string | undefined>>): string | null {
  const raw = env["VOLLI_PERF_BUILD"]?.trim();
  return raw !== undefined && /^[\w.+-]{1,64}$/.test(raw) ? raw : null;
}

/** How much of a commit a dev build's label keeps. */
const DEV_LABEL_LENGTH = 9;

/** A dev build's label: the checkout's short commit, or null (logged at debug) when git cannot say. */
export async function devBuildLabel(git: RunGitAsync, appPath: string): Promise<string | null> {
  const log = hostLogger("perf-store");
  try {
    // The host runner admits `rev-parse --verify` (not `--short`): shorten here.
    const sha = (await git(["rev-parse", "--verify", "HEAD"], appPath)).trim();
    if (/^[0-9a-f]{7,64}$/.test(sha)) return sha.slice(0, DEV_LABEL_LENGTH);
    log.debug("dev build has no commit label", { reason: "not-a-commit" });
  } catch (error) {
    log.debug("dev build has no commit label", {
      reason: error instanceof Error ? error.name : "unknown",
    });
  }
  return null;
}

/** Opens the profile's perf store and its log sink, or null when the store cannot open. */
export function startDesktopPerfStore(options: DesktopPerfStoreOptions): DesktopPerfStore | null {
  const fromEnv = perfBuildFromEnv(options.env);
  const store = openPerfStore({
    path: perfStorePath(options.userData),
    version: options.version,
    build: fromEnv,
  });
  if (store === null) return null;
  (options.onExit ?? ((close) => process.once("exit", close)))(() => store.close());
  const labelled =
    fromEnv !== null || !options.dev
      ? Promise.resolve()
      : devBuildLabel(options.git ?? runGitCapturingAsync, options.appPath).then((label) => {
          if (label !== null) store.setBuild(label);
        });
  return { store, sink: perfStallSink(store), labelled };
}
