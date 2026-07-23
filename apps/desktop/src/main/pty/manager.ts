import type { WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type Database from "better-sqlite3";
import { agentSessionEnv, createSessionRecord, errorMessage, resolveShell } from "@volli/shared";
import type {
  CreateTerminalSessionRequest,
  CreateTerminalSessionResult,
  SessionActivityState,
  SessionLaunchKind,
  TerminalBusyResult,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalIoResult,
  TerminalParkStateEvent,
  VolliIpcEvent,
} from "@volli/shared";
import { broadcastDataChanged } from "../broadcast";
import { createProcessInspector, parkConfigFromEnv } from "../park";
import type { ParkConfig, ProcessInspector } from "../park";
import { isPathWithinRoots } from "../project-roots";
import { ensureProjectArtifactsDir } from "../volli-fs";
import { createSetupRun, ensure } from "../worktree";
import type { EnsureOutcome, SetupRun } from "../worktree";
import { worktreeDeps, worktreesHome } from "../worktree-runtime";
import { isInside } from "../worktree/paths";
import { composeWorktreeLaunchCommand } from "./launch";
import { createOutputPipeline } from "./output";
import type { OutputPipeline, OutputSink } from "./output";
import { ParkController } from "./park-controller";
import { closeOutSession, persistSessionStart } from "./persistence";
import { resolveScope } from "./scope";

// Structural subset of node-pty we depend on — declared here so nothing in
// this module needs a value import of node-pty (whose native binary is built
// for the Electron ABI and must never load under plain-Node vitest).
interface PtyProcess {
  /** The child shell's pid — the root of the tree the warm-park sweep walks. */
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  /** Foreground-process title, read from the kernel (tcgetpgrp) on access —
   *  the shell's own name at an idle prompt, the running command's otherwise.
   *  The same signal iTerm/VS Code use for busy state. */
  readonly process: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /** Stops reading the pty fd — real backpressure, unlike handleFlowControl's
   *  app-level XON/XOFF. The child blocks once the kernel buffer fills. */
  pause(): void;
  resume(): void;
}

interface NodePty {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cwd: string;
      cols: number;
      rows: number;
      env: Record<string, string>;
    },
  ): PtyProcess;
}

interface Session {
  pty: PtyProcess;
  /** The workspace this session is scoped to (future `volli` CLI/notifications consumer). */
  workspaceId: string;
  /**
   * The ticket this session drives, or `null` for a scratch session. Held
   * in-memory so {@link PtyManager.interruptTicketSessions} can find every live
   * session of a ticket without a db round-trip (issue #78 backward-move interrupt).
   */
  ticketId: string | null;
  /**
   * What this PTY's first line launched — an agent harness or a bare shell.
   * Interrupts target only `agent` sessions (an Esc to a plain shell is noise).
   */
  launchKind: SessionLaunchKind;
  /** Basename of the spawned shell (`zsh`) — the foreground title that means "idle at a prompt". */
  shellName: string;
  /** The resolved (canonical, `path.resolve`'d) cwd the PTY runs in — the worktree-delete/remove guards test containment against it. */
  cwd: string;
  /** The window that created the session; where its output events are sent. */
  webContents: WebContents;
  /** The `destroyed` listener we attached, so we can detach it on cleanup. */
  onDestroyed: () => void;
  /**
   * This session's output pipeline: batching, the ack-based flow control, and
   * the bounded observation tail — all the machinery {@link enqueueData} used to
   * spread across seven Session fields, now owned by {@link createOutputPipeline}
   * (issue #99). The manager keeps only the side effects that ride the same
   * onData chunk (activity stamping, setup-run feeding) and adapts a
   * {@link OutputSink} onto this session's webContents + pty.
   */
  output: OutputPipeline;
  /** Last PTY output OR user input, epoch ms — the warm-park idle clock. */
  lastActivityAt: number;
  /** Renderer-reported: the session's pane is currently on screen. */
  visible: boolean;
  /** User pin excluding the session from auto-park. */
  keepAwake: boolean;
  /**
   * `null` while running; when parked, the full stop-order pid list (parent
   * first, then descendants in the order they were SIGSTOP'd). Wake CONTs it
   * in reverse.
   */
  parkedPids: number[] | null;
  /**
   * True when the current park was an explicit user Park Now. A manual freeze
   * is exempt from the breathe duty cycle — it stays frozen until an explicit
   * wake trigger (visibility, input, Keep Awake, Wake).
   */
  parkedManually: boolean;
  /** Consecutive CPU-quiet sweeps observed; parks at `quietSamplesRequired`. */
  quietCpuSamples: number;
  /**
   * Non-null ONLY while a freshly-created worktree session runs its
   * sentinel-gated setup command (worktree-support §6). The whole state machine
   * — tail scanning, phase transitions, the `worktree_failed(setup)` event —
   * lives in the worktree module's {@link createSetupRun} handle; this field is
   * just pty.ts's grip on it: the pty `onData` handler feeds it output chunks and
   * {@link create}'s onExit notifies it of a premature shell death. Cleared the
   * instant the run settles (either outcome) — a non-zero exit leaves the
   * terminal a live shell with the failure visible and never launches the harness.
   */
  setupRun: SetupRun | null;
}

/**
 * Owns every live PTY, keyed by an opaque session id. Sessions are scoped to
 * the window that created them: output events go only to that window, and a
 * window teardown (or app quit) kills its PTYs. node-pty is imported LAZILY
 * inside `create` so the Electron-ABI native binary never loads under
 * plain-Node vitest, which exercises everything except a real spawn.
 */
export class PtyManager {
  private readonly sessions = new Map<string, Session>();
  /**
   * The warm-park duty cycle (park/wake + breathe/sweep), extracted per issue
   * #99. It reads this manager's live `sessions` map (the SAME instance) and
   * mutates each session's park fields in place; the manager keeps only the
   * side effects that touch node-pty/webContents and hands them in as deps.
   */
  private readonly parkController: ParkController;

  /**
   * @param db         the app database, or `null` when it failed to open. Every
   *                   session persists a durable record, so with no db `create`
   *                   fails outright (surfacing {@link dbError}).
   * @param dbError    the open failure to report when `db` is `null`.
   * @param inspector  process-tree inspection seam (real by default; tests
   *                   inject a fake so no `ps`/`pgrep`/`lsof` ever spawn).
   * @param parkConfig warm-park tuning; disabled config makes every park path a
   *                   no-op. Additive with defaults so existing callers/tests
   *                   need not pass it.
   * @param attachmentsRootPath the userData attachment-bytes root (issue #77
   *                   PR 2) a non-worktree ticket's kickoff materializes from
   *                   before spawn — see `resolveScope`. Defaults to `""`
   *                   (never used in production; `registerTerminalIpcHandlers`
   *                   always resolves the real path) so existing tests/callers
   *                   that never seed attachments need not pass it.
   */
  constructor(
    private readonly db: Database.Database | null,
    private readonly dbError: string,
    private readonly inspector: ProcessInspector = createProcessInspector(),
    private readonly parkConfig: ParkConfig = parkConfigFromEnv(process.env, process.platform),
    private readonly agentRuntime: AgentRuntimeEnvironment | null = null,
    private readonly attachmentsRootPath: string = "",
  ) {
    // The controller shares this manager's live session map and mutates each
    // session's park fields in place. `flush` and `pushParkState` stay here —
    // they touch the output pipeline and webContents — and every current
    // pushParkState call site has already verified the session is the map's
    // current entry, so the id→session re-lookup is safe.
    this.parkController = new ParkController({
      config: this.parkConfig,
      inspector: this.inspector,
      sessions: this.sessions,
      flush: (id) => this.sessions.get(id)?.output.flush(),
      pushParkState: (id) => {
        const session = this.sessions.get(id);
        if (session !== undefined) this.pushParkState(session, id);
      },
    });
  }

  /**
   * Lazy dynamic import of node-pty. Isolated in a method so tests can
   * `vi.mock("node-pty")` and so the native module is touched only when a
   * session is actually created.
   */
  private loadNodePty(): Promise<NodePty> {
    return import("node-pty") as unknown as Promise<NodePty>;
  }

  async create(
    webContents: WebContents,
    request: CreateTerminalSessionRequest,
  ): Promise<CreateTerminalSessionResult> {
    const db = this.db;
    if (db === null) return { ok: false, error: this.dbError };

    const resolved = resolveScope(db, request, this.attachmentsRootPath);
    if (!resolved.ok) return resolved;
    const scope = resolved.scope;

    // Worktree ticket sessions materialize (or reuse) their isolated worktree
    // BEFORE anything spawns. `ensure` is single-flight and idempotent; on
    // failure it has already recorded the `worktree_failed` event + `failed`
    // phase, and the session NEVER falls back to the main checkout (#38) — the
    // failure aborts boot outright.
    let worktreeOutcome: EnsureOutcome | null = null;
    if (scope.worktree !== null) {
      const result = await ensure(worktreeDeps(db), scope.worktree.ticketId);
      if (!result.ok) return { ok: false, error: result.error };
      worktreeOutcome = result.value;
      // A fresh `git worktree add` just stamped worktree_path/branch/base_branch
      // on the ticket — tell every window so the Branch/Base fields refresh from
      // their blank-and-editable pre-boot state. Only on `created` (a re-stamp of
      // a cleared path after removal also reconciles to `create`); a reused
      // ready worktree changed nothing, so it never broadcasts. Targeted at the
      // booting ticket, so its own rail refreshes promptly.
      if (worktreeOutcome.created) {
        broadcastDataChanged({
          ticketId: scope.worktree.ticketId,
          projectId: scope.projectId,
          kind: "worktree",
        });
      }
    }

    // cwd resolution + guard. A renderer-supplied cwd (scratch / non-worktree
    // ticket) must live inside a registered project, same defense-in-depth as
    // the filesystem handlers. A worktree cwd is MAIN-derived (ensure returns
    // it), not renderer input, so it's validated against the app-owned worktree
    // home — or `isPathWithinRoots`, which also admits a persisted legacy path
    // that still lives inside a project folder.
    let cwd: string;
    if (worktreeOutcome !== null) {
      const worktreePath = worktreeOutcome.identity.worktreePath;
      if (worktreePath === null) {
        return { ok: false, error: "Worktree path was not resolved" };
      }
      cwd = resolve(worktreePath);
      if (!isInside(worktreesHome(), cwd) && !isPathWithinRoots(cwd)) {
        return { ok: false, error: "Worktree path is outside the worktree home" };
      }
    } else {
      cwd = resolve(scope.cwd);
      if (!isPathWithinRoots(cwd)) {
        return { ok: false, error: "cwd is outside known projects" };
      }
    }

    try {
      const nodePty = await this.loadNodePty();
      // The window can close during the awaited import above — its `destroyed`
      // event has already fired, so a once() attached below would never run
      // and the shell would idle as an orphan until quit. Bail before spawning.
      if (webContents.isDestroyed()) {
        return { ok: false, error: "Window was closed before the terminal could start" };
      }
      // Ensure the project's `.volli/artifacts` dir exists up front so an agent
      // can write artifacts the instant its shell is live (decision #9). A
      // window closing during this await is caught by the post-spawn destroyed
      // check.
      if (scope.artifactsRoot !== null) {
        // Guard against resurrecting a moved/deleted project root: the
        // ensureProjectArtifactsDir call below runs a recursive mkdir that would
        // happily recreate a vanished repo as an empty directory chain, handing
        // the user a plausible-looking shell in a bogus empty "repo". Stat the
        // root first and fail loudly if it isn't an existing directory.
        let rootStat: Awaited<ReturnType<typeof stat>> | null;
        try {
          rootStat = await stat(scope.artifactsRoot);
        } catch {
          rootStat = null;
        }
        if (rootStat === null || !rootStat.isDirectory()) {
          return {
            ok: false,
            error: `Project folder no longer exists at ${scope.artifactsRoot}`,
          };
        }
        await ensureProjectArtifactsDir(scope.artifactsRoot);
      }
      const { file, args } = resolveShell(process.env);
      const sessionId = randomUUID();
      const now = Date.now();
      const sessionEnv = this.agentRuntime
        ? agentSessionEnv(scope.env, {
            sessionId,
            socketPath: this.agentRuntime.socketPath,
            binDir: this.agentRuntime.binDir,
            inheritedPath: process.env["PATH"] ?? "",
          })
        : scope.env;
      const pty = nodePty.spawn(file, args, {
        name: "xterm-256color",
        cwd,
        cols: request.cols,
        rows: request.rows,
        // Inherit the user's environment; force TERM so the terminal emulator
        // negotiates 256-color regardless of the parent's TERM; layer the ticket
        // env (VOLLI_TICKET/VOLLI_ARTIFACTS_DIR) on top for ticket sessions,
        // or just VOLLI_ARTIFACTS_DIR for scratch sessions.
        env: { ...process.env, TERM: "xterm-256color", ...sessionEnv } as Record<string, string>,
      });
      // Same race, other side of the spawn: never register against a window
      // whose `destroyed` event already fired.
      if (webContents.isDestroyed()) {
        pty.kill();
        return { ok: false, error: "Window was closed before the terminal could start" };
      }

      // Persist the durable trace before wiring the session in; a ticket session
      // also records `session_started` in the same transaction. A persist
      // failure (e.g. workspaceId isn't a real project) must not leave an orphan
      // shell — kill it and surface the error.
      const record = createSessionRecord({
        id: sessionId,
        projectId: scope.projectId,
        ticketId: scope.ticketId,
        harnessId: scope.harnessId,
        launchKind: scope.launchKind,
        placement: scope.placement,
        title: scope.title,
        cwd,
        now,
      });
      try {
        persistSessionStart(db, record, scope.resume, now);
      } catch (error) {
        pty.kill();
        return { ok: false, error: errorMessage(error) };
      }

      const onDestroyed = (): void => {
        this.kill(sessionId);
      };
      // A window teardown must not leave an orphaned shell behind.
      webContents.once("destroyed", onDestroyed);
      // The output pipeline's window onto this session: a batch is delivered as
      // one `volli:terminal-data` event (dropped, `send` returning false, once
      // the owning window is destroyed), and backpressure maps onto the pty's
      // real fd pause/resume.
      const sink: OutputSink = {
        send: (data: string): boolean => {
          if (webContents.isDestroyed()) return false;
          const payload: TerminalDataEvent = { sessionId, data };
          webContents.send("volli:terminal-data" satisfies VolliIpcEvent, payload);
          return true;
        },
        pause: () => pty.pause(),
        resume: () => pty.resume(),
      };
      const session: Session = {
        pty,
        workspaceId: request.workspaceId,
        ticketId: scope.ticketId,
        launchKind: scope.launchKind,
        shellName: basename(file),
        cwd,
        webContents,
        onDestroyed,
        output: createOutputPipeline(sink),
        lastActivityAt: now,
        visible: false,
        keepAwake: false,
        parkedPids: null,
        parkedManually: false,
        quietCpuSamples: 0,
        setupRun: null,
      };
      this.sessions.set(sessionId, session);

      pty.onData((data) => {
        const target = this.sessions.get(sessionId);
        // node-pty can deliver a final read after the session was forgotten
        // (kill drops it from the map before pty.kill); that chunk must not
        // buffer, schedule a flush, or send.
        if (target === undefined) return;
        // PTY output is activity: it keeps a busy session out of the idle window.
        target.lastActivityAt = Date.now();
        // Sentinel-gated worktree setup step (§6): while the setup command runs,
        // its output is ALSO fed to the setup run (output still flows to the
        // renderer below — the user watches the install). The run holds the
        // harness command until the sentinel appears; no timeout, since "no
        // sentinel yet" is not an error (installs are slow, prompts happen). On
        // exit 0 it advances the phase to `ready` and returns the harness command
        // to type; on a non-zero exit it records `worktree_failed`(setup) itself
        // and returns nothing to launch — the terminal stays a live shell with
        // the failure on screen.
        const setupRun = target.setupRun;
        if (setupRun !== null) {
          const result = setupRun.feed(data);
          if (result.status !== "pending") {
            target.setupRun = null;
            if (result.status === "ready" && result.launchCommand !== null) {
              target.pty.write(`${result.launchCommand}\r`);
            }
          }
        }
        target.output.enqueue(data);
      });

      // Launch the session's first line now that it is fully registered AND
      // persisted — every rollback path above (persist failure, mid-spawn
      // window destroy) has already returned, so nothing can undo the session
      // here, and a failed persist can never leave an agent running. Written
      // directly to the pty (never through this.write's park/wake logic — the
      // session is brand new and running), exactly once. A CR submits the line,
      // matching how write() feeds the pty.
      //
      // For a worktree session the harness command opens with the orientation
      // preamble (agents must never re-infer their cwd) — buildable only now
      // that ensure resolved the identity. When ensure FRESHLY created the
      // worktree AND the project defines a setup command, that command runs
      // FIRST, sentinel-gated (§6): the worktree module's `createSetupRun` handle
      // owns the whole machine (wrapped line, phase `setting-up`, tail scan,
      // failure event); pty.ts only writes its command line and holds the handle
      // in `setupRun` so enqueueData can feed it. A reused worktree (created
      // false) is already `ready` from ensure and launches immediately.
      const worktree = scope.worktree;
      if (worktree !== null && worktreeOutcome !== null) {
        const identity = worktreeOutcome.identity;
        // Compose the worktree session's first line now that ensure resolved the
        // identity (resume line verbatim, else a preamble-opened kickoff, else
        // nothing). It still flows through the setup gate below.
        const launchCommand = composeWorktreeLaunchCommand(db, worktree, identity, cwd);
        const setupCommand = worktree.setupCommand?.trim() ?? "";
        if (worktreeOutcome.created && setupCommand.length > 0) {
          // `file` is the resolved shell the PTY was spawned with — the sentinel
          // wrapper is shell-aware (fish is not POSIX), so it must match.
          const setupRun = createSetupRun(
            { db, onPhase: worktreeDeps(db).onPhase },
            { ticketId: worktree.ticketId, setupCommand, shellPath: file, launchCommand },
          );
          session.setupRun = setupRun;
          pty.write(`${setupRun.commandLine}\r`);
        } else if (launchCommand !== null) {
          pty.write(`${launchCommand}\r`);
        }
      } else if (scope.launchCommand !== null) {
        pty.write(`${scope.launchCommand}\r`);
      }

      pty.onExit(({ exitCode }) => {
        // Flush buffered output first so the renderer never sees the exit
        // event ahead of the shell's final bytes.
        session.output.flush();
        // A shell dying with the setup run still armed means the sentinel never
        // printed — the subshell wrapper contains a setup's own `exit`, but a
        // crash or an `exec` can still take the shell down. Without this the
        // ticket would sit `setting-up` forever with zero failure signal; hand
        // the exit to the run so it records the setup failure (best-effort).
        const watchedSession = this.sessions.get(sessionId);
        const armedRun = watchedSession?.setupRun ?? null;
        if (watchedSession !== undefined && armedRun !== null) {
          watchedSession.setupRun = null;
          armedRun.handleExit(exitCode);
        }
        // Close out the durable record (and, for a still-linked ticket session,
        // record `session_ended`) — runs whether the shell exited on its own or
        // was killed, so the row never lingers as falsely-live. Never throws.
        closeOutSession(db, sessionId, Date.now(), exitCode);
        if (!webContents.isDestroyed()) {
          const payload: TerminalExitEvent = { sessionId, exitCode };
          webContents.send("volli:terminal-exit" satisfies VolliIpcEvent, payload);
        }
        this.forget(sessionId);
      });

      return { ok: true, sessionId, session: record };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  /**
   * Renderer flow-control ack: `chars` of output were consumed. Only honored
   * from the session's owning webContents — the same window-scoping stance as
   * the output events themselves. The pause/resume accounting lives in the
   * session's output pipeline.
   */
  ack(sender: WebContents, sessionId: string, chars: number): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    if (session.webContents !== sender) return;
    session.output.ack(chars);
  }

  /** The workspace a live session was created for, or undefined if unknown. */
  workspaceIdFor(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.workspaceId;
  }

  /**
   * The resolved cwd of every live session — the worktree remove/orphan-delete
   * guards refuse to touch a directory that still has a session running at or
   * under it. Read-only snapshot; the caller does the containment check.
   */
  liveSessionCwds(): string[] {
    return Array.from(this.sessions.values(), (session) => session.cwd);
  }

  /** Read-only snapshot used by the CLI; it never writes to or controls the observed PTY. */
  peek(
    sessionId: string,
    lines: number,
  ): { status: SessionActivityState; output: string } | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    // The pipeline owns the bounded tail; peekTail joins + slices to the exact
    // cap and normalizes line endings, byte-identical to the old string form.
    const output = session.output.peekTail(lines);
    let status: SessionActivityState = "idle";
    if (session.parkedPids !== null) status = "parked";
    else {
      try {
        if (foregroundProcess(session) !== null) status = "working";
      } catch {
        // A failed foreground-process probe still leaves the session observable.
      }
    }
    return { status, output };
  }

  /** Pushes the session's current park/keep-awake state to its window (skipped if destroyed). */
  private pushParkState(session: Session, sessionId: string): void {
    if (session.webContents.isDestroyed()) return;
    const payload: TerminalParkStateEvent = {
      sessionId,
      parked: session.parkedPids !== null,
      keepAwake: session.keepAwake,
    };
    session.webContents.send("volli:terminal-park-state" satisfies VolliIpcEvent, payload);
  }

  /**
   * Parks a session (SIGSTOP its whole tree — issue #51 warm tier). Delegates to
   * the {@link ParkController}, which owns the guards, mid-park death races, and
   * fork-rescan rounds; the manager keeps this signature because the CLI/IPC and
   * the equivalence benchmark drive park through it.
   */
  park(
    sessionId: string,
    opts: { manual: boolean; activityBaseline?: number },
  ): Promise<TerminalIoResult> {
    return this.parkController.park(sessionId, opts);
  }

  /**
   * Wakes a parked session (SIGCONT its tree in reverse). Synchronous so
   * before-quit teardown and the wake-before-write/kill/interrupt call sites can
   * use it off the stored pid list. Delegates to the {@link ParkController}.
   */
  wake(sessionId: string): TerminalIoResult {
    return this.parkController.wake(sessionId);
  }

  /**
   * Renderer-reported pane visibility. Only honored from the session's owning
   * webContents (same stance as {@link ack}). A pane becoming visible wakes a
   * parked session immediately.
   */
  setVisible(sender: WebContents, sessionId: string, visible: boolean): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    if (session.webContents !== sender) return;
    session.visible = visible;
    if (visible && session.parkedPids !== null) this.parkController.wake(sessionId);
  }

  /** User pin: excludes a session from auto-park, waking it if already parked. */
  setKeepAwake(sessionId: string, keepAwake: boolean): TerminalIoResult {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return { ok: false, error: "Unknown terminal session" };
    session.keepAwake = keepAwake;
    if (keepAwake && session.parkedPids !== null) this.parkController.wake(sessionId);
    this.pushParkState(session, sessionId);
    return { ok: true };
  }

  /**
   * One warm-park sweep (breathe stage 0 + the three staged auto-park gates).
   * Delegates to the {@link ParkController}; kept on the manager because the
   * equivalence benchmark drives the sweep through it.
   */
  sweep(now = Date.now()): Promise<void> {
    return this.parkController.sweep(now);
  }

  /** Starts the recurring sweep (no-op when disabled or already running). */
  startParkSweep(): void {
    this.parkController.start();
  }

  /** Stops the recurring sweep. */
  stopParkSweep(): void {
    this.parkController.stop();
  }

  /**
   * Foreground-process probe for one session, backing the renderer's
   * confirm-before-close gates. An unknown (already exited or forgotten)
   * session reports `busy: false` — there is no PTY left for a close to
   * destroy, so gating it would only add friction.
   */
  busy(sessionId: string): TerminalBusyResult {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return { ok: true, busy: false, process: null };
    try {
      const process = foregroundProcess(session);
      return { ok: true, busy: process !== null, process };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  /**
   * Every live session with a foreground process beyond its shell, optionally
   * scoped to one window's sessions — the quit/window-close gates' input. A
   * probe that throws is skipped: an unreadable pty must never block
   * enumerating the rest.
   */
  busySessions(owner?: WebContents): Array<{ sessionId: string; process: string }> {
    const busy: Array<{ sessionId: string; process: string }> = [];
    for (const [sessionId, session] of this.sessions) {
      if (owner !== undefined && session.webContents !== owner) continue;
      try {
        const process = foregroundProcess(session);
        if (process !== null) busy.push({ sessionId, process });
      } catch {
        // Skipped — see doc comment.
      }
    }
    return busy;
  }

  /**
   * Interrupts every LIVE agent session of a ticket by writing a single Esc
   * byte (`\x1b`) to each — the backward-move interrupt (issue #78, CONCEPT
   * #20): when a ticket leaves the active columns its running agents are told
   * to stop, but the PTYs are NEVER killed or signalled (the transcript stays
   * intact for a later resume). Shell sessions and other tickets' sessions are
   * left untouched. Parked sessions are woken first (a SIGSTOP'd shell can't
   * consume input), mirroring {@link write}'s discipline. Returns the ids of
   * the sessions actually interrupted.
   */
  interruptTicketSessions(ticketId: string): string[] {
    const interrupted: string[] = [];
    for (const [sessionId, session] of this.sessions) {
      if (session.ticketId !== ticketId || session.launchKind !== "agent") continue;
      // User-equivalent input: keep the session out of the idle window and wake
      // it before the write, exactly as write() does.
      session.lastActivityAt = Date.now();
      if (session.parkedPids !== null) this.parkController.wake(sessionId);
      try {
        session.pty.write("\x1b");
        interrupted.push(sessionId);
      } catch (error) {
        // One session's dead pty must never block interrupting the rest; it
        // simply isn't reported as interrupted.
        console.error(`[volli] failed to interrupt session ${sessionId}: ${errorMessage(error)}`);
      }
    }
    return interrupted;
  }

  write(sessionId: string, data: string): TerminalIoResult {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return { ok: false, error: "Unknown terminal session" };
    }
    // User input is activity. A parked session must wake BEFORE the write: a
    // SIGSTOP'd shell can't consume input, but SIGCONT delivery is fast and the
    // kernel has already buffered the bytes, so waking here loses nothing.
    session.lastActivityAt = Date.now();
    if (session.parkedPids !== null) this.parkController.wake(sessionId);
    try {
      session.pty.write(data);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  resize(sessionId: string, cols: number, rows: number): TerminalIoResult {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return { ok: false, error: "Unknown terminal session" };
    }
    try {
      session.pty.resize(cols, rows);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  kill(sessionId: string): TerminalIoResult {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return { ok: false, error: "Unknown terminal session" };
    }
    // INVARIANT: a SIGSTOP'd process ignores SIGTERM/SIGHUP until it is
    // continued, so a parked session must be SIGCONT'd before pty.kill or the
    // shell (and its tree) would never die and would leak as an orphan. wake()
    // is synchronous and needs the session still in the map, so it runs before
    // forget(). killAll() inherits this via kill().
    if (session.parkedPids !== null) this.parkController.wake(sessionId);
    // Forget first so the pty's own onExit (which also calls forget) is a
    // no-op, and so a kill() that throws still drops the session.
    this.forget(sessionId);
    try {
      session.pty.kill();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  /** Kills every live session. Wired to `before-quit`. */
  killAll(): void {
    // Snapshot the ids first: kill() mutates the map as it forgets sessions.
    const sessionIds = Array.from(this.sessions.keys());
    for (const sessionId of sessionIds) {
      this.kill(sessionId);
    }
  }

  /**
   * Drops a session from the registry, detaches its window listener, and
   * disposes its output pipeline (discarding any buffered-but-unflushed output
   * along with its flush timer).
   */
  private forget(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    session.output.dispose();
    if (!session.webContents.isDestroyed()) {
      session.webContents.removeListener("destroyed", session.onDestroyed);
    }
    this.sessions.delete(sessionId);
  }
}

/**
 * The session's foreground process name, or null when the shell itself sits
 * at its prompt. node-pty's `process` getter reads the pty's foreground
 * process group from the kernel; a login shell reports itself as "-zsh", so
 * the leading dash is stripped and paths reduced to a basename before
 * comparing against the spawned shell. Errs busy-side: anything that isn't
 * the shell (including a nested shell of a different flavor) counts.
 */
function foregroundProcess(session: Session): string | null {
  const title = session.pty.process;
  const name = basename(title.startsWith("-") ? title.slice(1) : title);
  if (name.length === 0 || name === session.shellName) return null;
  return name;
}

/**
 * The bundled `volli` CLI's runtime coordinates — layered into a session's env
 * (via `agentSessionEnv`) when present, so an agent process can reach the
 * planner over the socket. Constructed and threaded through the constructor
 * by {@link registerTerminalIpcHandlers} (now in `./ipc`, issue #99).
 */
export interface AgentRuntimeEnvironment {
  socketPath: string;
  binDir: string;
}
