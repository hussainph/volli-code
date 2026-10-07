/**
 * Starting the standalone Chromium a headless host's Browser Tabs live in
 * (VC-619), over a CDP pipe and never a debugging port.
 *
 * Which Chromium is the host's call, stated as an explicit `executablePath`:
 * host-core never finds or downloads a browser. The recommended build is
 * Playwright's Chrome for Testing, pinned by the lockfile's `playwright-core`
 * and installed with `playwright-core install chromium --no-shell` — the full
 * build, which runs new headless under `--headless`. `chromium-headless-shell`
 * is the old headless and must not be used. See the package README.
 *
 * The sandbox stays on. `noSandbox` exists only for a container that cannot
 * give Chromium the user namespaces its Linux sandbox needs; it is an explicit
 * option with no default, and a launch without the sandbox says so in the log
 * every time. A host that can provide namespaces (a systemd unit allowing
 * them, an AppArmor profile for the binary — `apps/hostd/packaging/`) never
 * sets it.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import { CdpPipeConnection, type CdpPipeLimits } from "./chromium-pipe";
import { hostLogger } from "../log/root";

const log = hostLogger("chromium");

export interface ChromiumLaunchOptions {
  /** The Chromium binary. Policy has no default: the host resolves it. */
  executablePath: string;
  /**
   * Where the browser's private profile directory is made. One directory per
   * launch, created 0700 and removed whenever the browser ends — closed,
   * crashed or cut off — so nothing a page stored outlives the browser
   * process. A host that was killed outright leaves its directory; the next
   * backend on the same root sweeps it ({@link sweepStaleChromiumProfiles}).
   */
  profileRoot: string;
  /**
   * Run without Chromium's sandbox. Only for a container that cannot provide
   * user namespaces; a launch with it logs a warning. No default.
   */
  noSandbox: boolean;
  /**
   * Device pixels per CSS pixel every page is drawn at
   * (`--force-device-scale-factor`). 2 lets a high-DPI viewer's screencast be
   * sharp, at four times the pixels for every tab, viewed or not, and agent
   * screenshots at that scale (as a Retina desktop's are). 1 on a host no
   * high-DPI viewer looks at. No default.
   */
  deviceScaleFactor: number;
}

/** How long a launch may take before the browser is declared unable to start. */
export const CHROMIUM_LAUNCH_TIMEOUT_MS = 30_000;
/** How long a close waits for the browser to exit before it is killed. */
export const CHROMIUM_CLOSE_TIMEOUT_MS = 5_000;
/** The tail of the browser's stderr kept for a launch failure's message. */
const STDERR_TAIL_CHARS = 4_096;

/**
 * The browser's command line. Pure, so a test can hold the security-relevant
 * shape — the pipe, and never a port or an address — without a browser.
 */
export function chromiumLaunchArgs(input: {
  userDataDir: string;
  noSandbox: boolean;
  deviceScaleFactor: number;
}): string[] {
  return [
    // New headless: the full browser without a window, not the old shell.
    "--headless",
    // The CDP wire is fds 3 and 4, private to this process (VC-110).
    "--remote-debugging-pipe",
    `--user-data-dir=${input.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    // Component extensions still start service workers without this.
    "--disable-component-extensions-with-background-pages",
    // Every tab may be driven while nobody watches it (VC-252): never throttled.
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    // No OS keychain or keyring prompt on a host nobody sits at.
    "--password-store=basic",
    "--use-mock-keychain",
    "--mute-audio",
    "--hide-scrollbars",
    "--window-size=1280,720",
    `--force-device-scale-factor=${input.deviceScaleFactor}`,
    ...(input.noSandbox ? ["--no-sandbox"] : []),
    "about:blank",
  ];
}

/**
 * The environment Chromium is started with: these names, copied from the
 * host's environment when set, and nothing else (security review N1). The
 * browser needs to find its libraries and fonts, a home and a temp directory,
 * a locale and a time zone; it never needs a host secret, so an
 * `Environment=` added to the host's unit later cannot ride into it.
 */
export const CHROMIUM_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TZ",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_DATA_DIRS",
  "XDG_CONFIG_DIRS",
  "FONTCONFIG_PATH",
  "FONTCONFIG_FILE",
] as const;

/** The allowlisted slice of `source`. Pure, so a test can hold it. */
export function chromiumEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of CHROMIUM_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** Every profile directory starts with this, then the owning host process's pid. */
export const CHROMIUM_PROFILE_PREFIX = "volli-chromium-";
/** Profiles a browser of this process is using now; a sweep never touches them. */
const liveProfiles = new Set<string>();

/**
 * Makes one launch's private profile, `volli-chromium-<pid>-<random>`, 0700.
 * Registered as live before it exists, so a concurrent sweep cannot take it.
 */
async function makeProfile(profileRoot: string): Promise<string> {
  const dir = join(
    profileRoot,
    `${CHROMIUM_PROFILE_PREFIX}${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  liveProfiles.add(dir);
  try {
    // No `recursive`: an existing directory is an error, as mkdtemp's is.
    await mkdir(dir, { mode: 0o700 });
    await chmod(dir, 0o700);
  } catch (error) {
    liveProfiles.delete(dir);
    throw error;
  }
  return dir;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, and someone else's.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Removes the profiles a host that died without closing its browser left
 * behind (security review N10): every `volli-chromium-<pid>-*` directory under
 * `profileRoot` whose owning process is gone — or is this process, when no
 * browser of ours is using it (a host restarted into the same pid, as in a
 * container). Best-effort and quiet; returns what it removed.
 */
export async function sweepStaleChromiumProfiles(
  profileRoot: string,
  isAlive: (pid: number) => boolean = processIsAlive,
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(profileRoot);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const match = /^volli-chromium-(\d+)-[0-9a-f]+$/.exec(name);
    if (match === null) continue;
    const dir = join(profileRoot, name);
    const owner = Number(match[1]);
    const stale = owner === process.pid ? !liveProfiles.has(dir) : !isAlive(owner);
    if (!stale) continue;
    try {
      await rm(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch (error) {
      log.warn("stale chromium profile was not removed", { profileDir: dir, error });
    }
  }
  return removed;
}

/** One running browser: its CDP connection and how to end it. */
export interface ChromiumProcess {
  readonly connection: CdpPipeConnection;
  readonly pid: number | undefined;
  /** The private profile directory, removed when the browser is gone. */
  readonly profileDir: string;
  /**
   * Called once when the browser is gone, whatever ended it: it exited or
   * crashed, its pipe failed or overflowed, or the host closed it. The
   * shutdown is already under way when it is called.
   */
  onExit(listener: (description: string) => void): void;
  /**
   * Asks the browser to close, ends its whole process group past the bound,
   * reaps it and removes the profile. Idempotent; the same shutdown every
   * other way of ending runs.
   */
  close(): Promise<void>;
}

export class ChromiumLaunchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ChromiumLaunchError";
  }
}

/** A seam for tests: the spawn this module calls. Production passes none. */
export type ChromiumSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/** A seam for tests: how a signal reaches the browser's process group. */
export type ChromiumKillGroup = (child: ChildProcess, signal: NodeJS.Signals) => void;

/** How long the group gets after SIGTERM before SIGKILL. */
export const CHROMIUM_KILL_GRACE_MS = 2_000;

const usesProcessGroups = process.platform !== "win32";

/**
 * Signals the browser's whole process group (it was spawned `detached`, so it
 * leads its own): renderers, the GPU process and the zygote with it, even
 * after the leader itself has exited. A group that is already empty is not
 * an error.
 */
export const killChromiumProcessGroup: ChromiumKillGroup = (child, signal) => {
  const pid = child.pid;
  if (pid === undefined) return;
  if (!usesProcessGroups) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
  }
};

/** A test's spawn owns no real group: signal the child it returned, never a real pgid. */
const killChildOnly: ChromiumKillGroup = (child, signal) => {
  child.kill(signal);
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

/**
 * Launches one browser and resolves once it answers over the pipe. A browser
 * that exits first, or does not answer in {@link CHROMIUM_LAUNCH_TIMEOUT_MS},
 * rejects with what it printed — the line an operator needs, such as
 * Chromium's "No usable sandbox!".
 *
 * Every way the browser can end runs ONE shutdown (`finalize`): the host's
 * close, a launch that failed, the browser exiting or crashing, and its pipe
 * failing or overflowing. It rejects every waiting command, closes the
 * streams, ends the browser's whole process group (SIGTERM, a grace, then
 * SIGKILL, survivors of the leader included), reaps the child and removes the
 * profile. A host that runs browsers needs this itself: nothing assumes a
 * service manager will kill what it leaves.
 */
export async function launchChromium(
  options: ChromiumLaunchOptions,
  spawnImpl: ChromiumSpawn = spawn,
  killGroup: ChromiumKillGroup = spawnImpl === spawn ? killChromiumProcessGroup : killChildOnly,
  limits?: Partial<CdpPipeLimits>,
): Promise<ChromiumProcess> {
  const userDataDir = await makeProfile(options.profileRoot);
  if (options.noSandbox) {
    log.warn(
      "chromium is starting without its sandbox (noSandbox); only for a host without user namespaces, see the host-core README, Browser backend",
    );
  }
  const removeProfile = async (): Promise<void> => {
    await rm(userDataDir, { recursive: true, force: true }).catch((error: unknown) => {
      log.warn("chromium profile was not removed", { profileDir: userDataDir, error });
    });
    liveProfiles.delete(userDataDir);
  };
  let child: ChildProcess;
  try {
    child = spawnImpl(
      options.executablePath,
      chromiumLaunchArgs({
        userDataDir,
        noSandbox: options.noSandbox,
        deviceScaleFactor: options.deviceScaleFactor,
      }),
      {
        // fd 3 is what Chromium reads commands from, fd 4 what it writes to.
        stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
        env: chromiumEnvironment(process.env),
        // Its own process group, so the shutdown can end every process it starts.
        detached: usesProcessGroups,
      },
    );
  } catch (error) {
    await removeProfile();
    throw new ChromiumLaunchError(
      `Chromium could not start: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
  });

  let exited: string | null = null;
  let markExited!: () => void;
  const exitedPromise = new Promise<void>((resolve) => {
    markExited = resolve;
  });
  const write = child.stdio[3] as Writable | null | undefined;
  const read = child.stdio[4] as Readable | null | undefined;

  let gone: string | null = null;
  const goneListeners = new Set<(description: string) => void>();
  let finalizing: Promise<void> | null = null;
  // Assigned below, once the pipe exists; a child without one has no connection.
  let connection: CdpPipeConnection | null = null;

  const exitWithin = async (ms: number): Promise<void> => {
    if (exited === null) await Promise.race([exitedPromise, delay(ms)]);
  };
  const finalize = (description: string, graceful: boolean): Promise<void> => {
    // The latch is set before any of the body runs: the body closes the
    // connection, whose close listener calls back in here.
    if (finalizing !== null) return finalizing;
    let finished!: () => void;
    finalizing = new Promise<void>((resolve) => {
      finished = resolve;
    });
    void (async () => {
      gone = description;
      const listeners = [...goneListeners];
      goneListeners.clear();
      for (const listener of listeners) {
        try {
          listener(description);
        } catch (error) {
          log.error("chromium exit listener failed", { error });
        }
      }
      if (graceful && connection !== null && !connection.closed && exited === null) {
        // Browser.close lets Chromium flush and exit on its own; the signals
        // are for a browser that will not.
        void connection.send("Browser.close").catch(() => undefined);
        await exitWithin(CHROMIUM_CLOSE_TIMEOUT_MS);
      }
      connection?.close(description);
      if (exited === null) {
        killGroup(child, "SIGTERM");
        await exitWithin(CHROMIUM_KILL_GRACE_MS);
      }
      // The leader's exit does not end its group: renderers, the GPU process
      // or the zygote may outlive it. SIGKILL whatever of the group is left.
      killGroup(child, "SIGKILL");
      await exitWithin(CHROMIUM_KILL_GRACE_MS);
      for (const stream of [write, read, child.stderr]) stream?.destroy();
      await removeProfile();
    })()
      .catch((error: unknown) => log.error("chromium shutdown failed", { error }))
      .finally(finished);
    return finalizing;
  };

  child.once("exit", (code, signal) => {
    exited ??= signal === null ? `exited with code ${code}` : `was killed by ${signal}`;
    markExited();
    void finalize(`the browser ${exited}`, false);
  });
  child.once("error", (error) => {
    exited ??= `could not start: ${error.message}`;
    markExited();
    void finalize(`the browser ${exited}`, false);
  });

  if (write == null || read == null) {
    await finalize("Chromium was started without its CDP pipe", false);
    throw new ChromiumLaunchError("Chromium was started without its CDP pipe");
  }
  const live = new CdpPipeConnection(write, read, limits);
  connection = live;
  // A pipe that failed, closed or overflowed is a browser this host can no
  // longer drive: end it, rather than leave it running unreachable.
  live.onClose((reason) => void finalize(reason, false));

  const close = (): Promise<void> => finalize("the browser was closed", true);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      live.send("Browser.getVersion"),
      exitedPromise.then(() => {
        throw new ChromiumLaunchError(`Chromium ${exited}`);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ChromiumLaunchError("Chromium did not answer over its pipe in time")),
          CHROMIUM_LAUNCH_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    await finalize("Chromium could not start", false);
    const printed = stderrTail.trim();
    const why =
      exited !== null && !(error instanceof ChromiumLaunchError)
        ? `Chromium ${exited}`
        : error instanceof Error
          ? error.message
          : String(error);
    throw new ChromiumLaunchError(`${why}${printed === "" ? "" : `: ${printed}`}`, {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }

  return {
    connection: live,
    pid: child.pid,
    profileDir: userDataDir,
    onExit: (listener) => {
      if (gone !== null) listener(gone);
      else goneListeners.add(listener);
    },
    close,
  };
}
