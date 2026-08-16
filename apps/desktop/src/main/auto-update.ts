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

import type { UpdateUiState } from "../ipc/contract";
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

/** The slice of electron-updater's `ProgressInfo` the state machine reads. */
interface UpdateDownloadProgress {
  /** 0–100. */
  percent: number;
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
  on(event: "download-progress", listener: (progress: UpdateDownloadProgress) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  /** Hands the staged update to Squirrel and quits through the normal app lifecycle. */
  quitAndInstall(): void;
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
  /** The running build's version (`app.getVersion()`) — the "from" of any update. */
  currentVersion: string;
  /** The app's notification seam: a native `Notification`, never a dialog. */
  notify(title: string, body: string): void;
  /** The main-process log seam (`console.info` in production). */
  log(line: string): void;
  /**
   * Announces every state transition — `index.ts` fans it out to every window
   * (`broadcastUpdateState`), the way the retention watch announces its
   * changes. Called only on an actual change, never with an identical state.
   */
  onStateChange(state: UpdateUiState): void;
  /**
   * Whether a window exists to render the badge/dialog for a downloaded
   * update. When one does, the sidebar surface owns the announcement and the
   * native "Update ready" notification stays quiet (VC-59's double-notify
   * guard); with no window — macOS keeps the app alive after the last window
   * closes — the notification is the only voice left and still fires.
   */
  hasUpdateSurface(): boolean;
}

export interface AutoUpdateHandle {
  /** Cancels the pending and periodic checks (listeners stay, but nothing fires them). */
  stop(): void;
  /** The current user-facing snapshot — what a freshly-opened renderer reads. */
  state(): UpdateUiState;
  /**
   * A user-initiated check (the sidebar icon's click). Resolves when the check
   * settles; `checking` can never hang — a check that produces no event (an
   * inactive updater returns null, concurrent calls coalesce) falls back to
   * `idle`, and a rejection lands in `error`.
   */
  checkNow(): Promise<void>;
  /** Hands the staged update to Squirrel — callers gate on `phase === "downloaded"` first. */
  quitAndInstall(): void;
}

/**
 * Configures the updater and starts the check schedule. Every failure path
 * is a log line — an update check must never interrupt whatever the user is
 * doing.
 */
export function startAutoUpdate(deps: AutoUpdateDeps): AutoUpdateHandle {
  /**
   * The one mutable snapshot. Transitions REPLACE it (never mutate) so every
   * `onStateChange` payload is a stable value a renderer can hold.
   */
  let current: UpdateUiState = {
    supported: deps.isPackaged,
    phase: "idle",
    currentVersion: deps.currentVersion,
    targetVersion: null,
    percent: null,
    error: null,
  };

  if (!deps.isPackaged) {
    deps.log("[updater] dev run — auto-update disabled");
    // Inert but truthful: the renderer reads `supported: false` and hides the
    // whole surface; the commands are no-ops rather than errors so a stray
    // call in dev can never throw.
    return {
      stop: () => {},
      state: () => current,
      checkNow: () => Promise.resolve(),
      quitAndInstall: () => {},
    };
  }

  const setState = (next: Partial<Omit<UpdateUiState, "supported" | "currentVersion">>): void => {
    const merged: UpdateUiState = { ...current, ...next };
    if (
      merged.phase === current.phase &&
      merged.targetVersion === current.targetVersion &&
      merged.percent === current.percent &&
      merged.error === current.error
    ) {
      return; // no actual change — never re-broadcast an identical state
    }
    current = merged;
    deps.onStateChange(merged);
  };

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

  updater.on("checking-for-update", () => {
    deps.log("[updater] checking for updates");
    // A staged download stays visible through a re-check: the 4h schedule
    // keeps running after a download, and `volli:update-install` gates on
    // phase === "downloaded" — demoting it here would hide (and refuse) a
    // perfectly valid staged install for the length of every check.
    if (current.phase === "downloaded") return;
    setState({ phase: "checking", error: null });
  });
  updater.on("update-available", (info) => {
    deps.log(`[updater] update available: ${info.version} — downloading`);
    // `autoDownload` is on, so "available" means the download is beginning —
    // 0% until the first progress event lands.
    setState({ phase: "downloading", targetVersion: info.version, percent: 0, error: null });
  });
  // NOT logged: progress fires steadily through a download and would drown the
  // `[updater]` log; the state broadcast is its surface.
  updater.on("download-progress", (progress) => {
    setState({ phase: "downloading", percent: progress.percent });
  });
  updater.on("update-not-available", (info) => {
    deps.log(`[updater] up to date (latest: ${info.version})`);
    setState({ phase: "idle", targetVersion: null, percent: null, error: null });
  });
  updater.on("error", (error) => {
    deps.log(`[updater] error: ${errorMessage(error)}`);
    // Same guarantee: a failed RE-check (offline, feed briefly gone) must not
    // hide a staged, installable update behind an error tint — `downloaded`
    // is only left by a real outcome (a newer download starting, the feed
    // answering up-to-date), never by a check that told us nothing new.
    if (current.phase === "downloaded") return;
    setState({ phase: "error", percent: null, error: errorMessage(error) });
  });

  // One notification per downloaded version. Long-lived instances can see
  // several downloads (a newer release lands before the app quits) — each
  // NEW version notifies once, a re-download of the same version is silent.
  // A version is only MARKED notified when the notification actually fires:
  // while a window is open the badge/dialog owns the announcement and the
  // notification stands down without burning the version, so an install whose
  // windows have all closed since still gets the one native voice left.
  const notifiedVersions = new Set<string>();
  updater.on("update-downloaded", (info) => {
    deps.log(`[updater] downloaded ${info.version} — installs on quit`);
    setState({ phase: "downloaded", targetVersion: info.version, percent: null, error: null });
    if (notifiedVersions.has(info.version)) return;
    if (deps.hasUpdateSurface()) return;
    notifiedVersions.add(info.version);
    deps.notify(
      "Update ready",
      `Volli Code ${info.version} has been downloaded and will install when you quit.`,
    );
  });

  // The returned promise is also where a failed feed read/download kickoff
  // surfaces (alongside the 'error' event) — observe it so a check can never
  // become an unhandled rejection. Shared by the schedule and the sidebar's
  // explicit check.
  const checkNow = async (): Promise<void> => {
    // Eager, ahead of the `checking-for-update` event: the click must respond
    // even while electron-updater is still deciding whether to check at all.
    // Unless a download is already staged — the badge outranks the spinner
    // (the sidebar never offers a check in that phase anyway).
    if (current.phase !== "downloaded") {
      setState({ phase: "checking", error: null });
    }
    try {
      await updater.checkForUpdates();
      // `checkForUpdates()` resolves null without any event when the updater
      // is inactive, and a coalesced concurrent call settles with the primary
      // — either way a check that settled while still `checking` produced
      // nothing, and the state must say so rather than hang.
      if (current.phase === "checking") {
        setState({ phase: "idle" });
      }
    } catch (error) {
      deps.log(`[updater] check failed: ${errorMessage(error)}`);
      if (current.phase === "downloaded") return;
      setState({ phase: "error", percent: null, error: errorMessage(error) });
    }
  };
  const check = () => {
    void checkNow();
  };
  const initial = setTimeout(check, INITIAL_CHECK_DELAY_MS);
  const interval = setInterval(check, CHECK_INTERVAL_MS);
  return {
    stop: () => {
      clearTimeout(initial);
      clearInterval(interval);
    },
    state: () => current,
    checkNow,
    quitAndInstall: () => updater.quitAndInstall(),
  };
}
