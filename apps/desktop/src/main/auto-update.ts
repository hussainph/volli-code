/**
 * Auto-update runtime (VC-24): the schedule/notification/logging policy that
 * keeps a packaged install current from GitHub Releases. electron-updater
 * does the heavy lifting — it reads the feed named by the app-update.yml
 * electron-builder bakes into Resources (the `publish` block in
 * electron-builder.yml), downloads the zip target and hands it to
 * Squirrel.Mac. This module owns everything around that and, like the
 * retention watch (`retention-runtime.ts`), takes its Electron seams
 * injected so the policy is testable under plain Node: `index.ts` passes the
 * real `autoUpdater`, a native `Notification` and `console`.
 *
 * The policy:
 * - never checks in dev (`isPackaged` guard) — `pnpm start` has no
 *   app-update.yml and nothing meaningful to update, so a dev check could
 *   only ever produce a noisy error;
 * - first check ~30s after launch so it never competes with boot, then every
 *   ~4h for long-lived instances;
 * - downloads ride in the background (`autoDownload`) and install on quit
 *   (`autoInstallOnAppQuit`; Squirrel.Mac applies the staged update when the
 *   app next launches), surfaced as ONE native notification per version —
 *   "restarts on quit", never a modal;
 * - every updater event lands in the main-process log with an `[updater]`
 *   prefix so a failed check is diagnosable after the fact.
 */
import type Database from "better-sqlite3";
import { errorMessage } from "@volli/shared";

import { prepared } from "./db/prepared";

/**
 * The `app_state` key behind the prerelease toggle (default OFF). Canary
 * releases are prerelease-suffixed tags (`v0.2.0-canary.3`) that
 * electron-builder auto-marks as GitHub pre-releases, so with the toggle off
 * a public install only ever sees full releases; the dogfood install flips
 * this on once to absorb canaries too. No Settings UI yet (that is its own
 * slice) — until then the row is set by hand:
 *
 *   sqlite3 "~/Library/Application Support/Volli Code/volli.db" \
 *     "INSERT INTO app_state (key, value, updated_at)
 *      VALUES ('volli:update-allow-prerelease', 'true', 0)
 *      ON CONFLICT(key) DO UPDATE SET value = excluded.value;"
 *
 * The toggle only ever WIDENS the update surface, so it is applied one-way:
 * `true` forces prereleases on, `false`/absent leaves electron-updater's own
 * default in place. That default is already the right policy per install
 * kind — `true` when the RUNNING build's version carries a prerelease
 * component (a canary install exists only because someone opted into
 * canaries) and `false` for stable versions. Forcing `false` onto a canary
 * install would strand it: its checks would read the stable-only feed
 * (`releases/latest`), which 404s while only prereleases exist, and it
 * would never follow the canary line it came from.
 */
export const UPDATE_ALLOW_PRERELEASE_APP_STATE_KEY = "volli:update-allow-prerelease";

/**
 * Reads the prerelease toggle. Anything other than a present, well-formed
 * JSON `true` — absent row, `false`, malformed JSON — means OFF: the toggle
 * widens what an install will update to, so it must fail closed.
 */
export function readAllowPrerelease(db: Database.Database): boolean {
  const row = prepared<[string], { value: string }>(
    db,
    "SELECT value FROM app_state WHERE key = ?",
  ).get(UPDATE_ALLOW_PRERELEASE_APP_STATE_KEY);
  if (row === undefined) return false;
  try {
    return (JSON.parse(row.value) as unknown) === true;
  } catch {
    return false;
  }
}

const INITIAL_CHECK_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** Version metadata shared by every informative updater event. */
interface UpdateVersionInfo {
  version: string;
}

/**
 * The slice of electron-updater's `AppUpdater` this module drives. Narrow on
 * purpose: tests implement it with a plain fake, and `index.ts` hands in the
 * real `autoUpdater` (which satisfies it structurally).
 */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  on(event: "checking-for-update", listener: () => void): unknown;
  on(
    event: "update-available" | "update-not-available" | "update-downloaded",
    listener: (info: UpdateVersionInfo) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
}

export interface AutoUpdateDeps {
  /** `app.isPackaged` — dev runs must never check. */
  isPackaged: boolean;
  updater: AutoUpdaterLike;
  /**
   * The one persisted policy input — see {@link readAllowPrerelease}. Applied
   * one-way: `true` widens to prereleases, `false` defers to the updater's
   * version-derived default (see the note on the app_state key above).
   */
  allowPrerelease: boolean;
  /** The app's notification seam: a native `Notification`, never a dialog. */
  notify(title: string, body: string): void;
  /** The main-process log seam (`console.info` in production). */
  log(line: string): void;
}

export interface AutoUpdateHandle {
  /** Cancels the pending and periodic checks (listeners stay, but nothing fires them). */
  stop(): void;
}

/**
 * Configures the updater and starts the check schedule. Every failure path
 * is a log line — an update check must never interrupt whatever the user is
 * doing.
 */
export function startAutoUpdate(deps: AutoUpdateDeps): AutoUpdateHandle {
  if (!deps.isPackaged) {
    deps.log("[updater] dev run — auto-update disabled");
    return { stop: () => {} };
  }

  const { updater } = deps;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  // One-way widen — never assign `false` over the updater's version-derived
  // default (see UPDATE_ALLOW_PRERELEASE_APP_STATE_KEY's doc for why).
  if (deps.allowPrerelease) updater.allowPrerelease = true;
  // The effective policy, logged up front: "why did/didn't this install see
  // the canary?" must be answerable from the log alone.
  deps.log(
    `[updater] allowPrerelease=${String(updater.allowPrerelease)} (toggle=${String(deps.allowPrerelease)})`,
  );

  updater.on("checking-for-update", () => deps.log("[updater] checking for updates"));
  updater.on("update-available", (info) =>
    deps.log(`[updater] update available: ${info.version} — downloading`),
  );
  updater.on("update-not-available", (info) =>
    deps.log(`[updater] up to date (latest: ${info.version})`),
  );
  updater.on("error", (error) => deps.log(`[updater] error: ${errorMessage(error)}`));

  // One notification per downloaded version. Long-lived instances can see
  // several downloads (a newer release lands before the app quits) — each
  // NEW version notifies once, a re-download of the same version is silent.
  const notifiedVersions = new Set<string>();
  updater.on("update-downloaded", (info) => {
    deps.log(`[updater] downloaded ${info.version} — installs on quit`);
    if (notifiedVersions.has(info.version)) return;
    notifiedVersions.add(info.version);
    deps.notify(
      "Update ready",
      `Volli Code ${info.version} has been downloaded and will install when you quit.`,
    );
  });

  // The returned promise is also where a failed feed read/download kickoff
  // surfaces (alongside the 'error' event) — observe it so a check can never
  // become an unhandled rejection.
  const check = () => {
    updater.checkForUpdates().catch((error: unknown) => {
      deps.log(`[updater] check failed: ${errorMessage(error)}`);
    });
  };
  const initial = setTimeout(check, INITIAL_CHECK_DELAY_MS);
  const interval = setInterval(check, CHECK_INTERVAL_MS);
  return {
    stop: () => {
      clearTimeout(initial);
      clearInterval(interval);
    },
  };
}
