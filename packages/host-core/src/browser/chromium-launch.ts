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
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import { CdpPipeConnection } from "./chromium-pipe";

export interface ChromiumLaunchOptions {
  /** The Chromium binary. Policy has no default: the host resolves it. */
  executablePath: string;
  /**
   * Where the browser's private profile directory is made. One directory per
   * launch, created 0700 and removed when the browser closes: nothing a page
   * stored outlives the browser process.
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

/** One running browser: its CDP connection and how to end it. */
export interface ChromiumProcess {
  readonly connection: CdpPipeConnection;
  readonly pid: number | undefined;
  /** Called once when the process exits, whoever ended it. */
  onExit(listener: (description: string) => void): void;
  /** Asks the browser to close, kills it past the bound, and removes the profile. Idempotent. */
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

/**
 * Launches one browser and resolves once it answers over the pipe. A browser
 * that exits first, or does not answer in {@link CHROMIUM_LAUNCH_TIMEOUT_MS},
 * rejects with what it printed — the line an operator needs, such as
 * Chromium's "No usable sandbox!".
 */
export async function launchChromium(
  options: ChromiumLaunchOptions,
  spawnImpl: ChromiumSpawn = spawn,
): Promise<ChromiumProcess> {
  // mkdtemp makes the directory 0700: the profile is this user's alone.
  const userDataDir = await mkdtemp(join(options.profileRoot, "volli-chromium-"));
  if (options.noSandbox) {
    console.warn(
      "[volli] Chromium is starting WITHOUT its sandbox (noSandbox). Only a host that cannot provide user namespaces should do this; see the host-core README, Browser backend.",
    );
  }
  const child = spawnImpl(
    options.executablePath,
    chromiumLaunchArgs({
      userDataDir,
      noSandbox: options.noSandbox,
      deviceScaleFactor: options.deviceScaleFactor,
    }),
    // fd 3 is what Chromium reads commands from, fd 4 what it writes to.
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
  );
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
  });
  const removeProfile = async (): Promise<void> => {
    await rm(userDataDir, { recursive: true, force: true }).catch((error: unknown) => {
      console.warn(`[volli] Chromium profile ${userDataDir} was not removed:`, error);
    });
  };

  let exited: string | null = null;
  const exitListeners = new Set<(description: string) => void>();
  const exitedPromise = new Promise<void>((resolve) => {
    const finish = (description: string): void => {
      if (exited !== null) return;
      exited = description;
      resolve();
      for (const listener of exitListeners) listener(description);
      exitListeners.clear();
    };
    child.once("exit", (code, signal) =>
      finish(signal === null ? `exited with code ${code}` : `was killed by ${signal}`),
    );
    child.once("error", (error) => finish(`could not start: ${error.message}`));
  });

  const write = child.stdio[3] as Writable | null | undefined;
  const read = child.stdio[4] as Readable | null | undefined;
  if (write == null || read == null) {
    child.kill("SIGKILL");
    await removeProfile();
    throw new ChromiumLaunchError("Chromium was started without its CDP pipe");
  }
  const connection = new CdpPipeConnection(write, read);
  void exitedPromise.then(() => connection.close(`the browser ${exited}`));

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      if (exited === null) {
        // Browser.close lets Chromium flush and exit on its own; the kill is
        // only for a browser that will not.
        void connection.send("Browser.close").catch(() => undefined);
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          exitedPromise,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, CHROMIUM_CLOSE_TIMEOUT_MS);
          }),
        ]);
        clearTimeout(timer);
        if (exited === null) {
          child.kill("SIGKILL");
          await exitedPromise;
        }
      }
      connection.close("the browser was closed");
      await removeProfile();
    })();
    return closing;
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      connection.send("Browser.getVersion"),
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
    await close();
    const printed = stderrTail.trim();
    throw new ChromiumLaunchError(
      `${error instanceof Error ? error.message : String(error)}${printed === "" ? "" : `: ${printed}`}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }

  return {
    connection,
    pid: child.pid,
    onExit: (listener) => {
      if (exited !== null) listener(exited);
      else exitListeners.add(listener);
    },
    close,
  };
}
