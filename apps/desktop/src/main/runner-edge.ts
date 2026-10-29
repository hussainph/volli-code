/**
 * Desktop's edge of this Mac's runner (VC-671): everything
 * `createRunnerComposition` and `runner.owner` call back into on the desktop —
 * the accepted-quit hold and the quit path it runs, the producer stop, and the
 * Session RPC transport bound from the runner's recovered proof.
 *
 * Built before the runner, whose composition installs the hold synchronously.
 * Everything the hold can reach lives here, live from construction, so a quit
 * at any point of boot reaches only declared state. Boot binds each gate as it
 * builds what the gate guards ({@link DesktopRunnerEdge.bind}); a gate is read
 * when a quit runs, never when the hold was installed, and an unbound gate
 * does nothing — as before its subject existed.
 *
 * No Electron import: `app`, the dialogs and the windows are ports.
 */
import type { HostHandlerMap } from "@volli/host-core/handlers";
import { hostLogger } from "@volli/host-core/log";
import type { RunnerReady } from "@volli/host-core/session-runtime";

import { SHUTDOWN_FLUSH_TIMEOUT_MS } from "./client-state-flush";
import { prepareDesktopQuit } from "./host-runtime";
import type { MenuBarHost } from "./menu-bar-host";
import {
  planUnsavedQuit,
  quitAlreadyRefused,
  refuseQuit,
  registerAcceptedQuitCoordinator,
  unsavedDocumentNames,
  updateInstallQuitInFlight,
  type AcceptedQuitLifecycle,
} from "./quit-gate";

/** Electron main's own composition lines. */
const log = hostLogger("desktop");

type QuitEvent = { preventDefault(): void };

/** The Session RPC as the runner's drain sees it: closed inside the Session drain. */
export interface SessionRpcTransport {
  close(): Promise<void>;
}

/** This launch's terminals, as the quit path touches them. */
export interface QuitTerminals {
  killAll(): void;
  stopParkSweep(): void;
}

export interface DesktopRunnerEdgePorts<T extends QuitTerminals> {
  /** `app`, whose `exit` writes the log's tail first (VC-699): every accepted quit ends in it. */
  lifecycle: AcceptedQuitLifecycle;
  /** The host the runner composes: an accepted quit stops it. */
  host: {
    stop(reason: string): Promise<unknown>;
    warnIfFollowUpCleanCloseSkipped(reason: string): void;
  };
  /** Hosts added over SSH (VC-700): their tunnels and links close with the host. */
  remoteHosts: { close(): Promise<unknown> };
  /** This Mac's Volli Cloud runner (VC-895), in a cloud launch: it reports `stopped` with the host. */
  cloudRunner?: { stop(): Promise<unknown> };
  /** Background work that must not start during teardown (VC-643). */
  stopBackgroundWork(): void;
  /** Cancelled local workers must exit before the profile can be relaunched. */
  settleBackgroundWork?(): Promise<void>;
  /** Whether the `cloud` flag is on now; read at each quit. */
  cloudEnabled(): boolean;
  /** The busy-terminal gate over the bound terminals (`prepareTerminalQuit`). */
  terminalQuit(terminals: T, event: QuitEvent): void;
  /** The Session RPC over the runner's handler map; null when no runtime came up. */
  createSessionRpc(ready: RunnerReady, handlers: HostHandlerMap): SessionRpcTransport | null;
  /** The agent socket's shutdown, drained beside the Session runtime by the host's stop. */
  closeSocket(): Promise<boolean | void>;
  /**
   * The restart into another product store (VC-889): a quit it asked for is
   * never offered menu-bar mode, and it hears whether the gates accepted it.
   */
  relaunch?: {
    pending(): boolean;
    quitAccepted(): void;
    quitRefused(): void;
  };
}

/** What boot binds as it builds each gate's subject. Binding again replaces. */
export interface DesktopQuitBindings<T extends QuitTerminals> {
  /** The runner's Automations: a quit that is not entering menu-bar mode stops them. */
  automations: { stop(): void };
  /** The unsaved-drafts confirm ({@link unsavedDraftsQuitGate}), asked ahead of the terminal one. */
  unsavedQuit(event: QuitEvent): void;
  /**
   * The busy-terminal gate's subject. A flag-on system shutdown kills them
   * unasked, and the runner's producer stop ends their park sweep.
   */
  terminals: T;
  /** Every window, a hidden menu-bar one included: a flag-on system shutdown flushes their drafts. */
  windows: { flushAll(timeoutMs: number): Promise<unknown> };
  /** The legacy transcript repack: every quit that is not entering menu-bar mode aborts it. */
  repack: { abort(): void };
  /** Menu-bar mode (VC-577), built once the window factory and updater exist. */
  menuBar: MenuBarHost;
}

/** Every binding boot owes the quit path, in the order boot makes them. */
const QUIT_BINDINGS = [
  "automations",
  "unsavedQuit",
  "terminals",
  "windows",
  "repack",
  "menuBar",
] as const satisfies readonly (keyof DesktopQuitBindings<QuitTerminals>)[];

/** What the edge needs of the runner `createRunnerComposition` returned. */
export interface AdoptableRunner<Owner> {
  owner(edge: { bind(ready: RunnerReady): void; closeSocket(): Promise<boolean | void> }): Owner;
  handlers(ready: RunnerReady): HostHandlerMap;
}

export interface DesktopRunnerEdge<T extends QuitTerminals> {
  /** The runner's `installQuitHold`: the accepted-quit coordinator over this quit path. */
  readonly installQuitHold: () => void;
  /**
   * The runner's `stopProducers`: from here on a quit is never offered
   * menu-bar mode, and the bound terminals stop their park sweep.
   */
  readonly stopProducers: () => void;
  /** The runner's `transport`: the Session RPC once the host's edge bound it, else null. */
  readonly transport: () => SessionRpcTransport | null;
  /**
   * The owner `hostCore.start` adopts: the runner's own, whose edge builds the
   * Session RPC over the runner's handler map from the recovered proof, and
   * closes the agent socket with the host.
   */
  ownerFor<Owner>(runner: AdoptableRunner<Owner>): Owner;
  readonly bind: (bindings: Partial<DesktopQuitBindings<T>>) => void;
  /**
   * Boot's last word on the quit path: throws naming every binding boot never
   * made, so a dropped `bind` fails the launch (and every smoke) instead of
   * silently skipping a confirm or a stop at quit.
   */
  readonly assertBound: () => void;
  /** Whether the host has begun stopping (the producer stop ran). */
  readonly hostClosing: () => boolean;
  /** Menu-bar mode once bound, else null: read when a notification click or the updater needs it. */
  readonly menuBar: () => MenuBarHost | null;
}

export function createDesktopRunnerEdge<T extends QuitTerminals>(
  ports: DesktopRunnerEdgePorts<T>,
): DesktopRunnerEdge<T> {
  const bound: Partial<DesktopQuitBindings<T>> = {};
  // Set once the host begins stopping: a quit then is never offered menu-bar mode.
  let hostClosing = false;
  let sessionRpc: SessionRpcTransport | null = null;
  /**
   * The flag-on shutdown's draft flush (VC-577), joined into the accepted
   * quit's host shutdown so `app.exit` waits for it — bounded, so power-off is
   * never stalled. Resolved unless a shutdown teardown ran.
   */
  let systemShutdownFlush: Promise<unknown> = Promise.resolve();

  const stopAutomations = (): void => bound.automations?.stop();
  const unsavedQuit = (event: QuitEvent): void => bound.unsavedQuit?.(event);
  const terminalQuit = (event: QuitEvent): void => {
    if (bound.terminals !== undefined) ports.terminalQuit(bound.terminals, event);
  };
  const abortRepack = (): void => bound.repack?.abort();
  /**
   * Flag on, logout/restart/shutdown (VC-577): the terminal confirm's killAll
   * and the windows' draft flush, with nothing that could refuse power-off.
   */
  const systemShutdownTeardown = (): void => {
    bound.terminals?.killAll();
    if (bound.windows !== undefined) {
      systemShutdownFlush = bound.windows.flushAll(SHUTDOWN_FLUSH_TIMEOUT_MS);
    }
  };
  const prepareQuit = (event: QuitEvent): void => {
    // Flag off: the former listener order, including the two unconditional
    // stops on a refused attempt. Flag on: the menu-bar branch decides after
    // the confirms, and a host already stopping is never offered it.
    const menuBar = bound.menuBar;
    // A restart into another product store (VC-889) keeps the flag-on order
    // (every confirm first, so a Cancel stops nothing) but is a quit, never
    // menu-bar mode.
    if (ports.relaunch?.pending() === true) {
      prepareDesktopQuit(event, {
        stopAutomations,
        unsavedQuit,
        terminalQuit,
        abortRepack,
        menuBar: {
          branch: () => "quit",
          confirmEnter: () => true,
          enter: () => {},
          systemShuttingDown: () => menuBar?.systemShuttingDown() ?? false,
        },
        systemShutdownTeardown,
      });
      return;
    }
    prepareDesktopQuit(event, {
      stopAutomations,
      unsavedQuit,
      terminalQuit,
      abortRepack,
      ...(menuBar !== undefined && !hostClosing && ports.cloudEnabled()
        ? { menuBar, systemShutdownTeardown }
        : {}),
    });
  };

  return {
    installQuitHold: () =>
      registerAcceptedQuitCoordinator({
        lifecycle: ports.lifecycle,
        shutdownNativeSessions: async () => {
          await Promise.all([
            ports.host.stop("quit"),
            ports.settleBackgroundWork?.(),
            systemShutdownFlush,
            ports.remoteHosts.close(),
            ports.cloudRunner?.stop(),
          ]);
        },
        // The agent socket closes inside the host's stop (the owner's `closeSocket`).
        shutdownAgentSocket: async () => {},
        prepareQuit,
        stopBackgroundWork: ports.stopBackgroundWork,
        onShutdownDeadline: (deadlineMs) =>
          ports.host.warnIfFollowUpCleanCloseSkipped(
            `quit: shutdown deadline expired after ${deadlineMs}ms`,
          ),
        reportFailure: (error) => log.error("failed to coordinate app shutdown", { error }),
        ...(ports.relaunch === undefined
          ? {}
          : {
              onQuitAccepted: ports.relaunch.quitAccepted,
              onQuitRefused: ports.relaunch.quitRefused,
            }),
      }),
    stopProducers: () => {
      hostClosing = true;
      bound.terminals?.stopParkSweep();
    },
    transport: () => sessionRpc,
    ownerFor(runner) {
      return runner.owner({
        bind: (ready) => {
          sessionRpc = ports.createSessionRpc(ready, runner.handlers(ready));
        },
        closeSocket: ports.closeSocket,
      });
    },
    bind: (bindings) => {
      Object.assign(bound, bindings);
    },
    assertBound: () => {
      const missing = QUIT_BINDINGS.filter((name) => bound[name] === undefined);
      if (missing.length > 0) {
        throw new Error(`The desktop quit path was never bound: ${missing.join(", ")}.`);
      }
    },
    hostClosing: () => hostClosing,
    menuBar: () => bound.menuBar ?? null,
  };
}

/**
 * The unsaved-drafts confirm, asked ahead of the terminal gate: a discarded
 * draft is the only thing on the quit path that cannot be recovered
 * afterwards. It answers from the renderer's last report
 * (`recordUnsavedDocuments`), because `before-quit` needs a synchronous verdict.
 */
export function unsavedDraftsQuitGate(ports: {
  /** The native "Discard and Quit" confirm; true discards the drafts. */
  confirmDiscard(names: readonly string[], verb: "Quit"): boolean;
  /** `VOLLI_SKIP_CLOSE_CONFIRM=1` answers "proceed" without a dialog (the smokes' seam). */
  env: Readonly<Record<string, string | undefined>>;
}): (event: QuitEvent) => void {
  return (event) => {
    if (quitAlreadyRefused(event)) return;
    // An accepted update install already carried the unsaved-drafts warning in
    // its own dialog (VC-59's one-prompt decision) — asking again here would
    // stack a second modal on an answer the user has given.
    if (updateInstallQuitInFlight()) return;
    const names = unsavedDocumentNames();
    const step = planUnsavedQuit({
      names,
      skipConfirm: ports.env["VOLLI_SKIP_CLOSE_CONFIRM"] === "1",
    });
    if (step === "confirm" && !ports.confirmDiscard(names, "Quit")) refuseQuit(event);
  };
}
