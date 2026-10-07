/**
 * Menu-bar mode (VC-577, D-A2 (b)): with the `cloud` flag on, ⌘Q while the
 * host has live work closes the windows, hides the Dock icon and keeps
 * Electron main running as this Mac's host, with a small Tray item. Turns,
 * background shells and the agent socket carry on. Reopening the app — Dock,
 * Spotlight, a second launch, a notification click, the Tray — brings a
 * window back onto the same in-process host.
 *
 * ── WHAT THIS IS NOT ──────────────────────────────────────────────────────
 * - **Not a host stop.** Entering menu-bar mode never calls
 *   `HostLifecycle.stop`, and the lifecycle has no state for it: the host is
 *   simply running with no window, which macOS already allowed before this.
 * - **Not a second source of truth.** Live work is read from the host
 *   (`liveHost.liveWork`), never from a renderer — there is none here.
 * - **Not resident forever.** ⌘Q means "quit when done": once live work has
 *   drained and stayed drained for {@link MENU_BAR_SETTLE_MS}, the app takes
 *   today's quit path on its own. An armed Automation alone does not keep it
 *   resident (the ruling; a later setting can change that).
 *
 * ── THE DECISION ──────────────────────────────────────────────────────────
 * {@link planQuitBranch} is the whole table. It is asked only with the flag
 * on, after the unsaved-drafts and busy-terminal confirms have answered (they
 * are unchanged and run first either way), and only for an attempt they did
 * not refuse. Everything that is not "live work, nothing overriding it" is
 * today's quit.
 *
 * ── THE BARRIER ───────────────────────────────────────────────────────────
 * The settle window is presentation, not safety. Live work is the host's
 * authoritative synchronous count — committed turn facts, accepted starts
 * not yet opened, running shells — and every exit that is not an explicit
 * override (the drain exit, an idle ⌘Q, install-when-idle) takes the host's
 * start latch in the same call that reads it zero. A start after that is
 * refused before it has any effect; a queued follow-up waits for next launch.
 *
 * ── LOGOUT, RESTART, SHUTDOWN ─────────────────────────────────────────────
 * Noted from `powerMonitor` `shutdown`: the quit that follows skips every
 * interactive refusal (the confirms' teardown still runs) so power-off is
 * never blocked. Cleared after {@link SYSTEM_SHUTDOWN_LATCH_MS}, or on a
 * reveal or activation — the logout was cancelled.
 *
 * ── BROWSER TABS ──────────────────────────────────────────────────────────
 * Agent Browser Tabs close with the windows. Entry over tabs a Session is
 * using asks first; after entry, an agent's Browser call is refused with
 * {@link BROWSER_CLOSED_FOR_MENU_BAR} until a window is back.
 *
 * No Electron import: every native effect is a port, so the whole mode is
 * tested under plain Node and `menu-bar-electron.ts` stays a thin adapter.
 */
import { hostLogger } from "@volli/host-core/log";
import { hasLiveWork, NO_LIVE_WORK, type HostLiveWork } from "@volli/host-core/sessions";

/** How long live work must stay drained before a resident host quits on its own. */
export const MENU_BAR_SETTLE_MS = 5_000;

/**
 * How often a resident host re-reads live work on its own clock. The host's
 * feed announces every fold, but a binding that closes without one would
 * otherwise never be re-counted.
 */
export const MENU_BAR_POLL_MS = 15_000;

/**
 * How long a noted logout/restart/shutdown keeps the branch standing down. A
 * process still alive this long after `powerMonitor` `shutdown` was not
 * logged out: someone cancelled it in another app, and the next ⌘Q is an
 * ordinary one again.
 */
export const SYSTEM_SHUTDOWN_LATCH_MS = 60_000;

/** The Browser Tabs confirm's copy, busy-terminal style (VC-577 orchestrator ruling). */
export function closeAgentTabsCopy(count: number): { message: string; detail: string } {
  return {
    message: `${count} browser ${count === 1 ? "tab" : "tabs"} used by running agents will close`,
    detail: "The agents keep running without them.",
  };
}

/** What an agent's Browser call is told once its tabs closed with the windows. */
export const BROWSER_CLOSED_FOR_MENU_BAR =
  "The browser was closed when Volli moved to the menu bar. Browser tools are unavailable until the person reopens the Volli window; continue without the browser.";

/** What one accepted ⌘Q does under the flag. */
export type QuitBranch = "quit" | "menu-bar";

export interface QuitBranchInput {
  /** An accepted update install is driving this quit (`updateInstallQuitInFlight`). */
  readonly updateInstallInFlight: boolean;
  /** macOS is logging out, restarting or shutting down: refusing would block it. */
  readonly systemShuttingDown: boolean;
  /** The person chose "Quit Anyway" from the Tray. */
  readonly quitRequested: boolean;
  readonly liveWork: HostLiveWork;
}

/**
 * The quit decision table, flag on. With the flag off nothing asks it: the
 * quit gate takes today's path without reading anything here.
 */
export function planQuitBranch(input: QuitBranchInput): QuitBranch {
  // Squirrel has already been told to relaunch the new build: staying up
  // would leave it waiting on a process that never exits.
  if (input.updateInstallInFlight) return "quit";
  // Refusing here would cancel the person's logout. The accepted cost of (b):
  // the host ends with the session, and boot recovery marks the turn.
  if (input.systemShuttingDown) return "quit";
  if (input.quitRequested) return "quit";
  return hasLiveWork(input.liveWork) ? "menu-bar" : "quit";
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "2 turns", "1 background shell", "1 turn and 2 background shells". */
export function liveWorkPhrase(work: HostLiveWork): string {
  const parts: string[] = [];
  if (work.turns > 0) parts.push(counted(work.turns, "turn", "turns"));
  if (work.shells > 0) parts.push(counted(work.shells, "background shell", "background shells"));
  return parts.join(" and ");
}

/** The Tray's live-work confirm: what "Quit Volli" would cut short. */
export function quitWithLiveWorkCopy(work: HostLiveWork): { message: string; detail: string } {
  const total = work.turns + work.shells;
  return {
    message: `${liveWorkPhrase(work)} ${total === 1 ? "is" : "are"} running`,
    detail: "Quitting now stops them. Volli quits on its own when they finish.",
  };
}

export type TrayItemId = "status" | "open" | "install-when-idle" | "quit";

export interface TrayItem {
  readonly id: TrayItemId;
  readonly label: string;
  readonly enabled: boolean;
  /** Present only on a checkbox item. */
  readonly checked?: boolean;
  /** Draw a separator above this item. */
  readonly separatorBefore?: boolean;
}

export interface TrayModel {
  /** The menu-bar text beside the (empty) icon: the running count, at a glance. */
  readonly title: string;
  readonly tooltip: string;
  readonly items: readonly TrayItem[];
}

export type TrayUpdateState = "none" | "ready" | "armed";

/** The whole Tray, as data: the Electron adapter only renders it. */
export function trayModel(work: HostLiveWork, update: TrayUpdateState): TrayModel {
  const total = work.turns + work.shells;
  const status = total === 0 ? "Nothing running" : `${liveWorkPhrase(work)} running`;
  const items: TrayItem[] = [
    { id: "status", label: status, enabled: false },
    { id: "open", label: "Open Volli", enabled: true },
  ];
  if (update !== "none") {
    items.push({
      id: "install-when-idle",
      label: "Install Update When Idle",
      enabled: true,
      checked: update === "armed",
      separatorBefore: true,
    });
  }
  items.push({ id: "quit", label: "Quit Volli", enabled: true, separatorBefore: true });
  return {
    title: total === 0 ? "Volli" : `Volli ${total}`,
    tooltip: `Volli — ${status.toLowerCase()}`,
    items,
  };
}

/** The menu-bar Tray, rendered by the adapter. Created on entry, destroyed on exit. */
export interface MenuBarTrayPort {
  show(model: TrayModel): void;
  update(model: TrayModel): void;
  destroy(): void;
}

export interface MenuBarHostPorts {
  /** The host's live work (`liveHost.liveWork`), or a no-work stand-in for a degraded host. */
  liveWork: {
    current(): HostLiveWork;
    subscribe(listener: (work: HostLiveWork) => void): () => void;
    /**
     * The idle-exit barrier: when nothing is live, take the host's start
     * latch (new turn starts are refused) and answer true, in one synchronous
     * call. False, and no latch, when work is live.
     */
    tryBeginIdleExit(): boolean;
    /** Lift that latch: the exit it was taken for did not happen. */
    abandonIdleExit(): void;
  };
  /**
   * Agent Browser Tabs, which close with the windows. Entry asks before
   * closing any a Session is using, then closes them all and refuses agent
   * Browser calls in words until a window is back.
   */
  browserTabs: {
    sessionTabCount(): number;
    closeForMenuBar(): void;
    reopen(): void;
  };
  /** "N browser tabs used by running agents will close" — Close Tabs and Keep Running / Cancel. */
  confirmCloseAgentTabs(count: number): "close" | "cancel";
  windows: {
    count(): number;
    /** Destroys every window without re-asking: the quit confirms already answered. */
    closeAll(): void;
    /** Builds the app window. Called only when none exists. */
    open(): void;
  };
  /** Both quiet-policy aware in the adapter: a quiet smoke never shows a Dock icon. */
  dock: { hide(): void; show(): void };
  tray: MenuBarTrayPort;
  /** `powerSaveBlocker("prevent-app-suspension")`; idempotent in the controller. */
  power: { hold(): void; release(): void };
  update: {
    /** A downloaded update is staged. */
    ready(): boolean;
    /** Whether an accepted install is driving the current shutdown. */
    installInFlight(): boolean;
    /** Raise the latch and `quitAndInstall()`. False when it could not start. */
    install(): boolean;
  };
  /** "N turns are running — Quit Anyway / Wait and Quit". */
  confirmQuit(work: HostLiveWork): "quit" | "wait";
  /** `app.quit()` — through today's whole quit path. */
  quit(): void;
  /** Brings the app forward for an explicit reopen (quiet-policy aware). */
  focusApp(): void;
  timers?: {
    setTimeout(run: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
    setInterval(run: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  };
  settleMs?: number;
  pollMs?: number;
  shutdownLatchMs?: number;
  log?: (line: string) => void;
}

export interface MenuBarHost {
  /**
   * The quit gate's question, flag on, asked only for an attempt the confirms
   * accepted. An idle `quit` verdict takes the host's start latch in the same
   * synchronous call ({@link MenuBarHostPorts.liveWork}'s `tryBeginIdleExit`),
   * so nothing can start between "nothing is live" and the exit.
   */
  branch(): QuitBranch;
  /**
   * Before the terminal confirm: when this attempt would enter menu-bar mode
   * and Sessions are using Browser Tabs, ask whether to close them and keep
   * running. False: the person cancelled, and the quit is refused.
   */
  confirmEnter(): boolean;
  /** A noted logout, restart or shutdown is in effect: the quit must not be refused. */
  systemShuttingDown(): boolean;
  /** Enter menu-bar mode. Idempotent. Never a host stop. */
  enter(): void;
  isResident(): boolean;
  /**
   * Bring a window back: leave menu-bar mode when resident (Dock, Tray, power
   * blocker, drain timer), then open a window if none exists. With the mode
   * never entered this is exactly "open a window if none exists".
   */
  reveal(options?: { focus?: boolean }): void;
  /** Tray → "Quit Volli": asks when work is live, then quits or keeps waiting. */
  quitFromTray(): void;
  /** Tray → "Install Update When Idle": a toggle. */
  toggleInstallWhenIdle(): void;
  /**
   * macOS is ending the session; the next quit must not be refused. Cleared
   * after {@link SYSTEM_SHUTDOWN_LATCH_MS} still alive, or on a reveal or an
   * activation — either means the logout did not happen.
   */
  noteSystemShutdown(): void;
  /** The app was activated (Dock, Spotlight, ⌘Tab): a noted logout is over. */
  noteActivated(): void;
  /** Something the Tray shows changed (the update state). */
  refresh(): void;
}

const realTimers = {
  setTimeout: (run: () => void, ms: number): unknown => setTimeout(run, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (run: () => void, ms: number): unknown => setInterval(run, ms),
  clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export function createMenuBarHost(ports: MenuBarHostPorts): MenuBarHost {
  const timers = ports.timers ?? realTimers;
  const settleMs = ports.settleMs ?? MENU_BAR_SETTLE_MS;
  const pollMs = ports.pollMs ?? MENU_BAR_POLL_MS;
  const shutdownLatchMs = ports.shutdownLatchMs ?? SYSTEM_SHUTDOWN_LATCH_MS;
  const log = ports.log ?? ((line: string) => hostLogger("menu-bar").info(line));

  let resident = false;
  let quitRequested = false;
  let systemShuttingDown = false;
  let shutdownExpiry: unknown = null;
  let installArmed = false;
  let holdingPower = false;
  /**
   * A drain-exit quit was attempted and something refused it (a busy-terminal
   * Cancel). Not retried until work runs again or the Tray asks, so a
   * windowless app does not re-ask the same question every few seconds.
   */
  let exitAttempted = false;
  let unsubscribe: (() => void) | null = null;
  let poll: unknown = null;
  let settle: unknown = null;

  /** Live work, failing toward "none" — and so toward today's quit. */
  function liveWork(): HostLiveWork {
    try {
      return ports.liveWork.current();
    } catch (error) {
      log(`[menu-bar] live work unreadable: ${String(error)}`);
      return NO_LIVE_WORK;
    }
  }

  function updateState(): TrayUpdateState {
    if (!ports.update.ready()) return "none";
    return installArmed ? "armed" : "ready";
  }

  function holdPower(hold: boolean): void {
    if (hold === holdingPower) return;
    holdingPower = hold;
    if (hold) ports.power.hold();
    else ports.power.release();
  }

  function cancelSettle(): void {
    if (settle === null) return;
    timers.clearTimeout(settle);
    settle = null;
  }

  /** The idle-exit barrier, failing toward "no latch, nothing live" — today's quit. */
  function tryBeginIdleExit(): boolean {
    try {
      return ports.liveWork.tryBeginIdleExit();
    } catch (error) {
      log(`[menu-bar] idle exit unreadable: ${String(error)}`);
      return true;
    }
  }

  function finishIdle(): void {
    exitAttempted = true;
    if (installArmed && ports.update.ready()) {
      // The install skips the quit branch (an accepted install always quits),
      // so it takes the same barrier here: a start that landed since the
      // settle check keeps the host resident instead of being installed over.
      if (!tryBeginIdleExit()) {
        exitAttempted = false;
        reevaluate();
        return;
      }
      log("[menu-bar] live work drained; installing the staged update");
      if (ports.update.install()) return;
      ports.liveWork.abandonIdleExit();
    }
    log("[menu-bar] live work drained; quitting");
    // `before-quit` runs synchronously inside: its branch takes the latch.
    ports.quit();
  }

  function clearSystemShutdown(): void {
    systemShuttingDown = false;
    if (shutdownExpiry === null) return;
    timers.clearTimeout(shutdownExpiry);
    shutdownExpiry = null;
  }

  function scheduleSettle(): void {
    if (settle !== null || exitAttempted) return;
    settle = timers.setTimeout(() => {
      settle = null;
      if (!resident) return;
      if (hasLiveWork(liveWork())) {
        reevaluate();
        return;
      }
      finishIdle();
    }, settleMs);
  }

  function reevaluate(work: HostLiveWork = liveWork()): void {
    if (!resident) return;
    ports.tray.update(trayModel(work, updateState()));
    // Never while a window is open (that is today), and only for turns: a
    // dev server in a background shell is not a reason to keep a Mac awake.
    holdPower(work.turns > 0);
    if (hasLiveWork(work)) {
      exitAttempted = false;
      cancelSettle();
    } else {
      scheduleSettle();
    }
  }

  function leave(): void {
    resident = false;
    unsubscribe?.();
    unsubscribe = null;
    // Set on every entry, and leave() runs only while resident.
    timers.clearInterval(poll);
    poll = null;
    cancelSettle();
    holdPower(false);
    installArmed = false;
    exitAttempted = false;
    ports.tray.destroy();
    ports.dock.show();
    ports.browserTabs.reopen();
    log("[menu-bar] left menu-bar mode");
  }

  return {
    branch() {
      const updateInstallInFlight = ports.update.installInFlight();
      const verdict = planQuitBranch({
        updateInstallInFlight,
        systemShuttingDown,
        quitRequested,
        liveWork: liveWork(),
      });
      // Nothing live and nothing overriding: the barrier re-reads and takes
      // the start latch in this same call, or keeps the host resident if a
      // start landed after all. An override quits over live work anyway.
      if (verdict === "quit" && !updateInstallInFlight && !systemShuttingDown && !quitRequested) {
        return tryBeginIdleExit() ? "quit" : "menu-bar";
      }
      return verdict;
    },
    confirmEnter() {
      // A pure read of the branch: no latch, and nothing to ask unless this
      // attempt would enter menu-bar mode with tabs a Session is using.
      if (resident) return true;
      const wouldEnter =
        planQuitBranch({
          updateInstallInFlight: ports.update.installInFlight(),
          systemShuttingDown,
          quitRequested,
          liveWork: liveWork(),
        }) === "menu-bar";
      if (!wouldEnter) return true;
      const tabs = ports.browserTabs.sessionTabCount();
      if (tabs === 0) return true;
      return ports.confirmCloseAgentTabs(tabs) === "close";
    },
    systemShuttingDown: () => systemShuttingDown,
    enter() {
      if (resident) return;
      resident = true;
      const work = liveWork();
      log(`[menu-bar] entered menu-bar mode: ${liveWorkPhrase(work) || "no live work"}`);
      // Before the windows: a turn's next Browser call is refused in words
      // rather than reaching for a tab (or a stage window) that is gone.
      ports.browserTabs.closeForMenuBar();
      ports.windows.closeAll();
      ports.dock.hide();
      ports.tray.show(trayModel(work, updateState()));
      unsubscribe = ports.liveWork.subscribe((next) => reevaluate(next));
      poll = timers.setInterval(() => reevaluate(), pollMs);
      reevaluate(work);
    },
    isResident: () => resident,
    reveal(options) {
      clearSystemShutdown();
      if (resident) leave();
      if (ports.windows.count() === 0) ports.windows.open();
      if (options?.focus === true) ports.focusApp();
    },
    quitFromTray() {
      const work = liveWork();
      if (hasLiveWork(work) && ports.confirmQuit(work) === "wait") {
        // Already the resident default; re-arm the exit a refused one disarmed.
        exitAttempted = false;
        reevaluate();
        return;
      }
      quitRequested = true;
      try {
        ports.quit();
      } finally {
        // `app.quit()` emits before-quit synchronously, so the gate has read
        // this by now; never let it outlive the one attempt it was for.
        quitRequested = false;
      }
    },
    toggleInstallWhenIdle() {
      installArmed = !installArmed;
      exitAttempted = false;
      reevaluate();
    },
    noteSystemShutdown() {
      clearSystemShutdown();
      systemShuttingDown = true;
      // Still alive a minute on: the logout was cancelled elsewhere, and the
      // next ⌘Q must keep its turns again.
      shutdownExpiry = timers.setTimeout(() => {
        shutdownExpiry = null;
        systemShuttingDown = false;
        log("[menu-bar] still running after a system shutdown notice; quitting normally again");
      }, shutdownLatchMs);
    },
    noteActivated() {
      clearSystemShutdown();
    },
    refresh() {
      reevaluate();
    },
  };
}
