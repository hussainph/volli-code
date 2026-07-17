import { app, dialog, ipcMain } from "electron";
import type { BrowserWindow, WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type Database from "better-sqlite3";
import {
  breatheShouldWake,
  createSessionRecord,
  DEFAULT_HARNESS_ID,
  displayTicketId,
  errorMessage,
  isParkCandidate,
  projectSessionEnv,
  resolveShell,
  ticketSessionEnv,
  treeIsCpuQuiet,
} from "@volli/shared";
import type {
  CreateTerminalSessionRequest,
  CreateTerminalSessionResult,
  HarnessId,
  TerminalBusyResult,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalIoResult,
  TerminalParkStateEvent,
  VolliIpcChannel,
  VolliIpcEvent,
} from "@volli/shared";
import type { DbHandle } from "./data-ipc";
import { createProcessInspector, parkConfigFromEnv } from "./park";
import type { ParkConfig, ProcessInspector } from "./park";
import { recordTicketEvent } from "./db/events-repo";
import {
  countProjectScratchSessions,
  countTicketSessions,
  endSession,
  getSessionTicketId,
  getTicketSessionContext,
  insertSession,
} from "./db/sessions-repo";
import { getProjectById } from "./db/projects-repo";
import { isPathWithinRoots } from "./project-roots";
import { ensureProjectArtifactsDir } from "./volli-fs";

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

// Flow control (the VS Code ack pattern): the renderer acks every data event
// it consumes; once the chars in flight exceed the high watermark the pty is
// paused, and it resumes only after acks drain the count below the low one.
// Without this, `yes` or `cat bigfile` queues unbounded IPC in the main
// process faster than the renderer can render.
const FLOW_CONTROL_HIGH_WATERMARK = 100_000;
const FLOW_CONTROL_LOW_WATERMARK = 5_000;

// Output batching: raw pty chunks are tiny (often <1 KiB), so a big `cat` is
// thousands of IPC messages. Chunks coalesce for a frame's worth of time —
// or until the buffer is large enough that waiting just adds latency.
const BATCH_WINDOW_MS = 8;
const BATCH_MAX_CHARS = 256_000;

interface Session {
  pty: PtyProcess;
  /** The workspace this session is scoped to (future `volli` CLI/notifications consumer). */
  workspaceId: string;
  /** Basename of the spawned shell (`zsh`) — the foreground title that means "idle at a prompt". */
  shellName: string;
  /** The window that created the session; where its output events are sent. */
  webContents: WebContents;
  /** The `destroyed` listener we attached, so we can detach it on cleanup. */
  onDestroyed: () => void;
  /** Output chunks coalescing toward the next flush. */
  pendingChunks: string[];
  pendingChars: number;
  flushTimer: NodeJS.Timeout | null;
  /** Chars sent to the renderer and not yet acked; drives pause/resume. */
  unackedChars: number;
  paused: boolean;
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
}

/** Plain awaitable pause; the breathe window between SIGCONT and the verdict. */
const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** The db-resolved shape a PTY is spawned + persisted from (ticket or scratch). */
interface SessionScope {
  projectId: string;
  ticketId: string | null;
  harnessId: HarnessId;
  cwd: string;
  /** Extra env layered over the inherited environment (VOLLI_TICKET/VOLLI_ARTIFACTS_DIR, or just the artifacts dir). */
  env: Record<string, string>;
  title: string;
  /**
   * The MAIN-repo path whose `.volli/artifacts` to ensure before spawn (so an
   * agent can write artifacts the instant its shell is live), or `null` when the
   * project can't be resolved. Also the root-exists guard's stat target.
   */
  artifactsRoot: string | null;
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
  /** Recurring warm-park sweep handle; `null` until `startParkSweep`. */
  private sweepTimer: NodeJS.Timeout | null = null;
  /** Guards against a slow sweep's async stages overlapping the next tick. */
  private sweeping = false;

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
   */
  constructor(
    private readonly db: Database.Database | null,
    private readonly dbError: string,
    private readonly inspector: ProcessInspector = createProcessInspector(),
    private readonly parkConfig: ParkConfig = parkConfigFromEnv(process.env, process.platform),
  ) {}

  /**
   * Lazy dynamic import of node-pty. Isolated in a method so tests can
   * `vi.mock("node-pty")` and so the native module is touched only when a
   * session is actually created.
   */
  private loadNodePty(): Promise<NodePty> {
    return import("node-pty") as unknown as Promise<NodePty>;
  }

  /**
   * Resolves a request to its session scope from the db: a ticket session
   * (VOLLI_TICKET env, MAIN-repo-root cwd, the ticket's harness, `Session N`
   * title) or a project-scoped scratch session (default harness, `Terminal N`).
   * The only failure is a ticket request naming a ticket that does not exist.
   */
  private resolveScope(
    db: Database.Database,
    request: CreateTerminalSessionRequest,
  ): { ok: true; scope: SessionScope } | { ok: false; error: string } {
    if (request.ticket !== undefined) {
      const ctx = getTicketSessionContext(db, request.ticket.ticketId);
      if (ctx === undefined) return { ok: false, error: "Unknown ticket" };
      const displayId = displayTicketId(ctx.ticketPrefix, ctx.ticketNumber);
      return {
        ok: true,
        scope: {
          projectId: ctx.projectId,
          ticketId: request.ticket.ticketId,
          // Harness is no longer a ticket property (migration 004); a ticket
          // session boots the default harness, same as a scratch session.
          harnessId: DEFAULT_HARNESS_ID,
          // Ticket sessions run at the MAIN repo root — worktree automation is
          // future work, and VOLLI_ARTIFACTS_DIR always points at the main .volli.
          cwd: ctx.projectPath,
          env: ticketSessionEnv(ctx.projectPath, displayId),
          title: `Session ${countTicketSessions(db, request.ticket.ticketId) + 1}`,
          artifactsRoot: ctx.projectPath,
        },
      };
    }
    // Scratch session: resolve the project's MAIN path so VOLLI_ARTIFACTS_DIR is
    // injected the same way a ticket session gets it (decision #9). A project
    // that can't be resolved still spawns (no artifacts env) rather than failing.
    const project = getProjectById(db, request.workspaceId);
    return {
      ok: true,
      scope: {
        projectId: request.workspaceId,
        ticketId: null,
        harnessId: DEFAULT_HARNESS_ID,
        cwd: request.cwd,
        env: project ? projectSessionEnv(project.path) : {},
        title: `Terminal ${countProjectScratchSessions(db, request.workspaceId) + 1}`,
        artifactsRoot: project?.path ?? null,
      },
    };
  }

  async create(
    webContents: WebContents,
    request: CreateTerminalSessionRequest,
  ): Promise<CreateTerminalSessionResult> {
    const db = this.db;
    if (db === null) return { ok: false, error: this.dbError };

    const resolved = this.resolveScope(db, request);
    if (!resolved.ok) return resolved;
    const scope = resolved.scope;

    const cwd = resolve(scope.cwd);
    // Same defense-in-depth stance as the filesystem handlers: never spawn a
    // shell rooted outside a registered project.
    if (!isPathWithinRoots(cwd)) {
      return { ok: false, error: "cwd is outside known projects" };
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
      const pty = nodePty.spawn(file, args, {
        name: "xterm-256color",
        cwd,
        cols: request.cols,
        rows: request.rows,
        // Inherit the user's environment; force TERM so the terminal emulator
        // negotiates 256-color regardless of the parent's TERM; layer the ticket
        // env (VOLLI_TICKET/VOLLI_ARTIFACTS_DIR) on top for ticket sessions,
        // or just VOLLI_ARTIFACTS_DIR for scratch sessions.
        env: { ...process.env, TERM: "xterm-256color", ...scope.env } as Record<string, string>,
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
        title: scope.title,
        cwd,
        now,
      });
      try {
        const persist = db.transaction(() => {
          insertSession(db, record);
          if (record.ticketId !== null) {
            recordTicketEvent(
              db,
              record.ticketId,
              {
                kind: "session_started",
                sessionId: record.id,
                title: record.title,
                harnessId: record.harnessId,
              },
              now,
            );
          }
        });
        persist();
      } catch (error) {
        pty.kill();
        return { ok: false, error: errorMessage(error) };
      }

      const onDestroyed = (): void => {
        this.kill(sessionId);
      };
      // A window teardown must not leave an orphaned shell behind.
      webContents.once("destroyed", onDestroyed);
      this.sessions.set(sessionId, {
        pty,
        workspaceId: request.workspaceId,
        shellName: basename(file),
        webContents,
        onDestroyed,
        pendingChunks: [],
        pendingChars: 0,
        flushTimer: null,
        unackedChars: 0,
        paused: false,
        lastActivityAt: now,
        visible: false,
        keepAwake: false,
        parkedPids: null,
        parkedManually: false,
        quietCpuSamples: 0,
      });

      pty.onData((data) => {
        this.enqueueData(sessionId, data);
      });

      pty.onExit(({ exitCode }) => {
        // Flush buffered output first so the renderer never sees the exit
        // event ahead of the shell's final bytes.
        this.flush(sessionId);
        // Close out the durable record (and, for a still-linked ticket session,
        // record `session_ended`) — runs whether the shell exited on its own or
        // was killed, so the row never lingers as falsely-live.
        const endedAt = Date.now();
        try {
          const end = db.transaction(() => {
            endSession(db, sessionId, endedAt);
            // Resolve the ticket link from the CURRENT row, never the stale
            // in-memory `record.ticketId`: `sessions.ticket_id` is ON DELETE SET
            // NULL, so a ticket (or its project) deleted while the session lived
            // leaves this null. Recording `session_ended` off the stale capture
            // would then violate the ticket_events FK, roll the whole
            // transaction back, and strand the row as falsely-live.
            const ticketId = getSessionTicketId(db, sessionId);
            if (ticketId !== null) {
              recordTicketEvent(db, ticketId, { kind: "session_ended", sessionId }, endedAt);
            }
          });
          end();
        } catch (error) {
          // Nothing about closing out the record may prevent the renderer's exit
          // notification or the manager's own cleanup below. Log it, then make a
          // best-effort bare endSession outside the transaction so the row isn't
          // stranded as falsely-live (endLiveSessions sweeps any residue on the
          // next boot).
          console.error(`[volli] failed to close out session ${sessionId}: ${errorMessage(error)}`);
          try {
            endSession(db, sessionId, endedAt);
          } catch {
            // Even the bare end failed (e.g. the db is gone) — leave it to the
            // boot-time endLiveSessions sweep.
          }
        }
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

  /** Buffers a pty chunk toward the next coalesced volli:terminal-data send. */
  private enqueueData(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    // PTY output is activity: it keeps a busy session out of the idle window.
    session.lastActivityAt = Date.now();
    session.pendingChunks.push(data);
    session.pendingChars += data.length;
    if (session.pendingChars >= BATCH_MAX_CHARS) {
      this.flush(sessionId);
      return;
    }
    if (session.flushTimer === null) {
      session.flushTimer = setTimeout(() => {
        this.flush(sessionId);
      }, BATCH_WINDOW_MS);
    }
  }

  /**
   * Sends the session's buffered output as ONE data event and applies the
   * flow-control accounting to the joined payload. No-ops (dropping the
   * buffer) once the owning window is destroyed. Note a paused pty stops
   * producing new onData chunks, but anything already buffered still flushes.
   */
  private flush(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    if (session.flushTimer !== null) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    if (session.pendingChunks.length === 0) return;
    const data = session.pendingChunks.join("");
    session.pendingChunks = [];
    session.pendingChars = 0;
    if (session.webContents.isDestroyed()) return;
    const payload: TerminalDataEvent = { sessionId, data };
    session.webContents.send("volli:terminal-data" satisfies VolliIpcEvent, payload);
    session.unackedChars += data.length;
    if (!session.paused && session.unackedChars > FLOW_CONTROL_HIGH_WATERMARK) {
      session.paused = true;
      session.pty.pause();
    }
  }

  /**
   * Renderer flow-control ack: `chars` of output were consumed. Only honored
   * from the session's owning webContents — the same window-scoping stance as
   * the output events themselves.
   */
  ack(sender: WebContents, sessionId: string, chars: number): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    if (session.webContents !== sender) return;
    session.unackedChars = Math.max(0, session.unackedChars - chars);
    if (session.paused && session.unackedChars <= FLOW_CONTROL_LOW_WATERMARK) {
      session.paused = false;
      session.pty.resume();
    }
  }

  /** The workspace a live session was created for, or undefined if unknown. */
  workspaceIdFor(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.workspaceId;
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
   * Parks a session: SIGSTOP its whole process tree so macOS compresses/pages
   * its memory (issue #51 warm tier). Auto-park (`manual: false`) refuses a
   * visible or kept-awake session — the belt-and-braces half of the safety
   * rule (the sweep already gated on idle + CPU-quiet + no LISTEN socket).
   * Manual park bypasses those guards. Stops parent FIRST then descendants, then
   * re-collects to catch any child that spawned mid-stop (bounded to 3 rounds).
   *
   * `activityBaseline` is the `lastActivityAt` the caller's eligibility verdict
   * was based on. The verdict is a snapshot — PTY output or input can land
   * during the sweep's async inspection stages (or ours below) — so an auto
   * park re-checks it before every SIGSTOP round and refuses if the session
   * resumed work. Defaults to the session's activity at entry.
   */
  async park(
    sessionId: string,
    opts: { manual: boolean; activityBaseline?: number },
  ): Promise<TerminalIoResult> {
    if (!this.parkConfig.enabled) {
      // Refusing (rather than silently "succeeding") keeps a manual Park Now
      // honest on platforms without SIGSTOP or under VOLLI_PARK_DISABLE.
      return { ok: false, error: "Session parking is disabled" };
    }
    const session = this.sessions.get(sessionId);
    if (session === undefined) return { ok: false, error: "Unknown terminal session" };
    if (session.parkedPids !== null) {
      // A Park Now on an already-parked session upgrades it to a manual
      // freeze — explicit intent exempts it from the breathe duty cycle.
      if (opts.manual) session.parkedManually = true;
      return { ok: true };
    }
    const activityBaseline = opts.activityBaseline ?? session.lastActivityAt;
    // The auto-park guards, re-checked after every await below (not just at
    // entry): visibility/pin flips and fresh activity can all land while the
    // inspector calls are in flight, and a session that resumed work must
    // never be frozen — the hard safety rule.
    const autoParkBlocked = (): string | null => {
      if (opts.manual) return null;
      if (session.visible || session.keepAwake) return "Session is visible or kept awake";
      if (session.lastActivityAt > activityBaseline) return "Session became active while parking";
      return null;
    };
    const entryBlock = autoParkBlocked();
    if (entryBlock !== null) return { ok: false, error: entryBlock };
    // The session can be killed (or its window destroyed) across any of the
    // awaits below. kill()'s CONT-before-kill runs off `parkedPids`, which is
    // only assigned at the end — so a kill landing mid-park would SIGHUP an
    // already-stopped tree, and SIGHUP *pends* on a stopped process: the tree
    // would leak frozen. Every await is followed by this liveness re-check,
    // and a mid-park death CONTs whatever was stopped so the pending kill
    // signals can act.
    const stillParking = (): boolean =>
      this.sessions.get(sessionId) === session && session.parkedPids === null;
    const rootPid = session.pty.pid;
    const initial = await this.inspector.descendants(rootPid);
    if (!stillParking()) return { ok: false, error: "Session ended while parking" };
    const preStopBlock = autoParkBlocked();
    if (preStopBlock !== null) return { ok: false, error: preStopBlock };
    // Flush pending output before freezing — the renderer must not be left
    // waiting on bytes the stopped shell can no longer push.
    this.flush(sessionId);
    // Stop parent first so it can't fork new children we haven't seen, then its
    // descendants in listed order.
    const stopOrder = [rootPid, ...initial];
    const stopped = new Set<number>(stopOrder);
    const abortPark = (error: string): TerminalIoResult => {
      for (const pid of stopOrder.toReversed()) this.inspector.signal(pid, "SIGCONT");
      return { ok: false, error };
    };
    for (const pid of stopOrder) this.inspector.signal(pid, "SIGSTOP");
    // A child may have spawned between listing and its parent's stop; re-scan and
    // stop any newcomer until the tree is stable (bounded so a fork bomb can't
    // spin the sweep forever).
    for (let round = 0; round < 3; round += 1) {
      let rescan: number[];
      try {
        rescan = await this.inspector.descendants(rootPid);
      } catch (error) {
        // A failed rescan must never leak a half-stopped tree: CONT what we
        // stopped, then let the failure propagate to the caller's logging.
        abortPark("");
        throw error;
      }
      if (!stillParking()) return abortPark("Session ended while parking");
      // Output buffered before the SIGSTOP can still drain during the rescan
      // awaits — a session that just showed work must not be left frozen.
      const midStopBlock = autoParkBlocked();
      if (midStopBlock !== null) return abortPark(midStopBlock);
      const fresh = rescan.filter((pid) => !stopped.has(pid));
      if (fresh.length === 0) break;
      for (const pid of fresh) {
        this.inspector.signal(pid, "SIGSTOP");
        stopOrder.push(pid);
        stopped.add(pid);
      }
    }
    session.parkedPids = stopOrder;
    session.parkedManually = opts.manual;
    this.pushParkState(session, sessionId);
    return { ok: true };
  }

  /**
   * Wakes a parked session: SIGCONT its tree in REVERSE of the stop order
   * (children before parent). Synchronous so before-quit teardown can call it
   * off the stored pid list. A running session is a no-op.
   */
  wake(sessionId: string): TerminalIoResult {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return { ok: false, error: "Unknown terminal session" };
    const parkedPids = session.parkedPids;
    if (parkedPids === null) return { ok: true };
    for (const pid of parkedPids.toReversed()) this.inspector.signal(pid, "SIGCONT");
    session.parkedPids = null;
    session.parkedManually = false;
    session.quietCpuSamples = 0;
    session.lastActivityAt = Date.now();
    this.pushParkState(session, sessionId);
    return { ok: true };
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
    if (visible && session.parkedPids !== null) this.wake(sessionId);
  }

  /** User pin: excludes a session from auto-park, waking it if already parked. */
  setKeepAwake(sessionId: string, keepAwake: boolean): TerminalIoResult {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return { ok: false, error: "Unknown terminal session" };
    session.keepAwake = keepAwake;
    if (keepAwake && session.parkedPids !== null) this.wake(sessionId);
    this.pushParkState(session, sessionId);
    return { ok: true };
  }

  /**
   * Stage 0 of the sweep — the no-silent-failure duty cycle. A frozen process
   * cannot tell us it has pending work (an expired timer, a file-watch event,
   * data queued on a socket), so once per sweep every auto-parked session
   * breathes: its tree is CONT'd for `breatheWindowMs`, then re-frozen unless
   * the window surfaced real work (output/input, CPU, a fresh child, a new
   * listener — the pure verdict in @volli/shared's breatheShouldWake). Worst
   * case, background work runs one sweep interval late instead of never.
   * Manual Park Now freezes are exempt: explicit intent stays frozen until an
   * explicit wake.
   *
   * `parkedPids` deliberately stays set across the window — SIGCONT is
   * idempotent, so any wake path landing mid-breathe (input, visibility, Keep
   * Awake, kill's CONT-before-kill) works unchanged, and the renderer's
   * parked badge never flickers. Liveness is re-checked after every await;
   * the re-freeze goes through park() so its mid-park death races and
   * fork-rescan rounds stay handled in exactly one place.
   */
  private async breathe(): Promise<void> {
    const breathing: Array<{ id: string; session: Session; activityAtStart: number }> = [];
    for (const [id, session] of this.sessions) {
      if (session.parkedPids === null || session.parkedManually) continue;
      breathing.push({ id, session, activityAtStart: session.lastActivityAt });
      for (const pid of session.parkedPids.toReversed()) this.inspector.signal(pid, "SIGCONT");
    }
    if (breathing.length === 0) return;
    await delay(this.parkConfig.breatheWindowMs);

    // One descendants walk per still-parked tree, then one ps and one lsof
    // across the union. A session killed or explicitly woken during the window
    // is no longer ours to touch.
    const stillBreathing = (id: string, session: Session): boolean =>
      this.sessions.get(id) === session && session.parkedPids !== null;
    try {
      const trees: Array<{
        id: string;
        session: Session;
        activityAtStart: number;
        pids: number[];
      }> = [];
      for (const { id, session, activityAtStart } of breathing) {
        if (!stillBreathing(id, session)) continue;
        const pids = [session.pty.pid, ...(await this.inspector.descendants(session.pty.pid))];
        trees.push({ id, session, activityAtStart, pids });
      }
      if (trees.length === 0) return;
      const union = new Set<number>();
      for (const { pids } of trees) for (const pid of pids) union.add(pid);
      const cpuByPid = await this.inspector.cpuPercents([...union]);
      const listeners = await this.inspector.listeningPids([...union]);

      for (const { id, session, activityAtStart, pids } of trees) {
        // Re-check after the sampling awaits — a kill or wake may have landed.
        if (!stillBreathing(id, session)) continue;
        const stopped = new Set(session.parkedPids);
        const shouldWake = breatheShouldWake({
          activityAtStart,
          activityAtEnd: session.lastActivityAt,
          cpuQuiet: treeIsCpuQuiet(cpuByPid, pids, this.parkConfig.cpuBusyPercent),
          treeGrew: pids.some((pid) => !stopped.has(pid)),
          hasListener: pids.some((pid) => listeners.has(pid)),
        });
        // A Park Now that landed mid-window wins over the verdict: re-freeze,
        // preserving the manual exemption.
        if (shouldWake && !session.parkedManually) {
          this.wake(id);
        } else {
          const manual = session.parkedManually;
          session.parkedPids = null;
          const refrozen = await this.park(id, { manual, activityBaseline: activityAtStart });
          if (!refrozen.ok && this.sessions.get(id) === session && session.parkedPids === null) {
            // The re-freeze was refused — activity or a pin/visibility flip
            // landed mid-park. The session stays awake; sync the renderer's
            // badge (nothing else pushes on this path) and make it re-earn
            // its quiet streak from scratch.
            session.quietCpuSamples = 0;
            this.pushParkState(session, id);
          }
        }
      }
    } catch (error) {
      // Inspection failed mid-cycle: these trees were just CONT'd and we can
      // no longer judge them. Fail open — waking every one still marked parked
      // beats re-freezing unjudged, possibly-working sessions. A session whose
      // re-freeze threw mid-park is already CONT'd and unmarked; it just needs
      // its renderer badge synced.
      for (const { id, session } of breathing) {
        if (stillBreathing(id, session)) this.wake(id);
        else if (this.sessions.get(id) === session) this.pushParkState(session, id);
      }
      throw error;
    }
  }

  /**
   * One warm-park sweep. Stage 0 breathes every auto-parked session (see
   * {@link breathe}), then three staged gates over running sessions, each
   * cheaper-first: (1) the synchronous idle/visible/keep-awake eligibility
   * check; (2) two consecutive CPU-quiet samples across the whole tree (one
   * `ps` call for every candidate's union of pids); (3) no TCP LISTEN socket
   * anywhere in the tree (one `lsof` call) — a quiet dev server must never be
   * frozen, since inbound requests would hang. Survivors are auto-parked. A
   * boolean flag drops a tick that arrives while the previous sweep's async
   * stages are still running.
   */
  async sweep(now = Date.now()): Promise<void> {
    if (!this.parkConfig.enabled) return;
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.breathe();
      // Stage 1: cheap eligibility. A session that fails it loses its quiet
      // streak. `activityAt` snapshots the idle clock the verdict is based on —
      // stage 4's park() refuses any session whose clock advanced past it
      // while stages 2–3 were in flight.
      const candidates: Array<{ id: string; session: Session; activityAt: number }> = [];
      for (const [id, session] of this.sessions) {
        const eligible = isParkCandidate(
          {
            parked: session.parkedPids !== null,
            visible: session.visible,
            keepAwake: session.keepAwake,
            lastActivityAt: session.lastActivityAt,
          },
          now,
          this.parkConfig.idleThresholdMs,
        );
        if (eligible) candidates.push({ id, session, activityAt: session.lastActivityAt });
        else session.quietCpuSamples = 0;
      }
      if (candidates.length === 0) return;

      // Stage 2: one CPU sample across the union of every candidate's tree.
      const withTrees: Array<{
        id: string;
        session: Session;
        activityAt: number;
        pids: number[];
      }> = [];
      const cpuUnion = new Set<number>();
      for (const { id, session, activityAt } of candidates) {
        const pids = [session.pty.pid, ...(await this.inspector.descendants(session.pty.pid))];
        withTrees.push({ id, session, activityAt, pids });
        for (const pid of pids) cpuUnion.add(pid);
      }
      const cpuByPid = await this.inspector.cpuPercents([...cpuUnion]);
      const quietEnough: Array<{ id: string; activityAt: number; pids: number[] }> = [];
      for (const { id, session, activityAt, pids } of withTrees) {
        if (treeIsCpuQuiet(cpuByPid, pids, this.parkConfig.cpuBusyPercent)) {
          session.quietCpuSamples += 1;
          if (session.quietCpuSamples >= this.parkConfig.quietSamplesRequired) {
            quietEnough.push({ id, activityAt, pids });
          }
        } else {
          session.quietCpuSamples = 0;
        }
      }
      if (quietEnough.length === 0) return;

      // Stage 3: one LISTEN-socket check across their union; a tree with any
      // listener is left for next sweep (counter untouched) rather than frozen.
      const listenUnion = new Set<number>();
      for (const { pids } of quietEnough) for (const pid of pids) listenUnion.add(pid);
      const listeners = await this.inspector.listeningPids([...listenUnion]);
      for (const { id, activityAt, pids } of quietEnough) {
        if (pids.some((pid) => listeners.has(pid))) continue;
        await this.park(id, { manual: false, activityBaseline: activityAt });
      }
    } catch (error) {
      // Inspection is best-effort: a failed pgrep/ps/lsof degrades to "nothing
      // parks this sweep" (breathe already woke anything it couldn't judge) —
      // never an unhandled rejection, never a session left wrongly frozen.
      console.error("[park] sweep failed; no sessions parked this sweep:", error);
    } finally {
      this.sweeping = false;
    }
  }

  /** Starts the recurring sweep (no-op when disabled or already running). */
  startParkSweep(): void {
    if (!this.parkConfig.enabled) return;
    if (this.sweepTimer !== null) return;
    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, this.parkConfig.sweepIntervalMs);
    // Never let the sweep keep the process alive at quit.
    this.sweepTimer.unref();
  }

  /** Stops the recurring sweep. */
  stopParkSweep(): void {
    if (this.sweepTimer === null) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
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

  write(sessionId: string, data: string): TerminalIoResult {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return { ok: false, error: "Unknown terminal session" };
    }
    // User input is activity. A parked session must wake BEFORE the write: a
    // SIGSTOP'd shell can't consume input, but SIGCONT delivery is fast and the
    // kernel has already buffered the bytes, so waking here loses nothing.
    session.lastActivityAt = Date.now();
    if (session.parkedPids !== null) this.wake(sessionId);
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
    if (session.parkedPids !== null) this.wake(sessionId);
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
   * discards any buffered-but-unflushed output along with its flush timer.
   */
  private forget(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    if (session.flushTimer !== null) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    session.pendingChunks = [];
    session.pendingChars = 0;
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
 * Native modal confirm for a destructive close over `busy` sessions; resolves
 * true when the user chose to proceed. Native (not the renderer AlertDialog)
 * because its callers — before-quit and the window `close` event — run while
 * the renderer may already be tearing down, and both need a synchronous
 * verdict to preventDefault against.
 *
 * `VOLLI_SKIP_CLOSE_CONFIRM=1` answers "proceed" without showing the dialog —
 * the automation seam for the e2e smokes, whose sessions deliberately run
 * foreground work and which have no way to answer a native modal (a mid-run
 * failure would otherwise hang teardown forever).
 */
export function confirmDestructiveClose(
  busy: Array<{ process: string }>,
  options: { message: string; confirmLabel: string; window?: BrowserWindow },
): boolean {
  if (process.env["VOLLI_SKIP_CLOSE_CONFIRM"] === "1") return true;
  const processes = Array.from(new Set(busy.map((entry) => entry.process))).join(", ");
  const dialogOptions = {
    type: "warning" as const,
    buttons: [options.confirmLabel, "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: options.message,
    detail:
      busy.length === 1
        ? `A terminal is still running “${processes}”. Closing will end it.`
        : `${busy.length} terminals are still running (${processes}). Closing will end them.`,
  };
  const choice =
    options.window === undefined
      ? dialog.showMessageBoxSync(dialogOptions)
      : dialog.showMessageBoxSync(options.window, dialogOptions);
  return choice === 0;
}

// ---- IPC wiring ------------------------------------------------------------

/** `undefined` (scratch session) or a `{ ticketId: string }` object (ticket session). */
function isOptionalTicket(value: unknown): value is { ticketId: string } | undefined {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as Record<string, unknown>)["ticketId"] === "string";
}

function isCreateRequest(value: unknown): value is CreateTerminalSessionRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["workspaceId"] === "string" &&
    typeof candidate["cwd"] === "string" &&
    typeof candidate["cols"] === "number" &&
    typeof candidate["rows"] === "number" &&
    isOptionalTicket(candidate["ticket"])
  );
}

/**
 * Registers the terminal IPC handlers and returns the backing manager so the
 * app lifecycle can kill every PTY on quit. Every handler validates its args
 * at runtime — renderer-supplied types are never trusted — and returns a
 * typed result rather than throwing across the IPC boundary.
 */
export function registerTerminalIpcHandlers(handle: DbHandle): PtyManager {
  // Every session persists a durable record, so the manager needs the db. When
  // it failed to open, `create` reports the open error (write/kill/etc. operate
  // on the — necessarily empty — live map and stay harmless no-ops).
  const manager = handle.ok ? new PtyManager(handle.db, "") : new PtyManager(null, handle.error);

  ipcMain.handle(
    "volli:terminal-create" satisfies VolliIpcChannel,
    (event, request: unknown): Promise<CreateTerminalSessionResult> => {
      if (!isCreateRequest(request)) {
        return Promise.resolve({ ok: false, error: "Invalid terminal request" });
      }
      return manager.create(event.sender, request);
    },
  );

  ipcMain.handle(
    "volli:terminal-write" satisfies VolliIpcChannel,
    (_event, sessionId: unknown, data: unknown): TerminalIoResult => {
      if (typeof sessionId !== "string" || typeof data !== "string") {
        return { ok: false, error: "Invalid terminal write" };
      }
      return manager.write(sessionId, data);
    },
  );

  ipcMain.handle(
    "volli:terminal-resize" satisfies VolliIpcChannel,
    (_event, sessionId: unknown, cols: unknown, rows: unknown): TerminalIoResult => {
      if (typeof sessionId !== "string" || typeof cols !== "number" || typeof rows !== "number") {
        return { ok: false, error: "Invalid terminal resize" };
      }
      return manager.resize(sessionId, cols, rows);
    },
  );

  ipcMain.handle(
    "volli:terminal-kill" satisfies VolliIpcChannel,
    (_event, sessionId: unknown): TerminalIoResult => {
      if (typeof sessionId !== "string") {
        return { ok: false, error: "Invalid terminal kill" };
      }
      return manager.kill(sessionId);
    },
  );

  ipcMain.handle(
    "volli:terminal-park" satisfies VolliIpcChannel,
    (_event, sessionId: unknown): Promise<TerminalIoResult> => {
      if (typeof sessionId !== "string") {
        return Promise.resolve({ ok: false, error: "Invalid terminal park" });
      }
      // A user-initiated park bypasses the visible/keep-awake auto-park guards.
      return manager.park(sessionId, { manual: true });
    },
  );

  ipcMain.handle(
    "volli:terminal-wake" satisfies VolliIpcChannel,
    (_event, sessionId: unknown): TerminalIoResult => {
      if (typeof sessionId !== "string") {
        return { ok: false, error: "Invalid terminal wake" };
      }
      return manager.wake(sessionId);
    },
  );

  ipcMain.handle(
    "volli:terminal-keep-awake" satisfies VolliIpcChannel,
    (_event, sessionId: unknown, keepAwake: unknown): TerminalIoResult => {
      if (typeof sessionId !== "string" || typeof keepAwake !== "boolean") {
        return { ok: false, error: "Invalid terminal keep-awake" };
      }
      return manager.setKeepAwake(sessionId, keepAwake);
    },
  );

  // Fire-and-forget (ipcRenderer.send) — pane visibility flips on every nav and
  // needs no reply; the sender check mirrors the ack channel's window-scoping.
  ipcMain.on(
    "volli:terminal-set-visible" satisfies VolliIpcChannel,
    (event, ...args: unknown[]): void => {
      const [sessionId, visible] = args;
      if (typeof sessionId !== "string" || typeof visible !== "boolean") return;
      manager.setVisible(event.sender, sessionId, visible);
    },
  );

  ipcMain.handle(
    "volli:terminal-busy" satisfies VolliIpcChannel,
    (_event, sessionId: unknown): TerminalBusyResult => {
      if (typeof sessionId !== "string") {
        return { ok: false, error: "Invalid terminal busy query" };
      }
      return manager.busy(sessionId);
    },
  );

  // Fire-and-forget (ipcRenderer.send) — an ack has no result to return, and
  // round-tripping one invoke per data event would defeat the flow control.
  ipcMain.on("volli:terminal-ack" satisfies VolliIpcChannel, (event, ...args: unknown[]): void => {
    const [sessionId, chars] = args;
    if (typeof sessionId !== "string") return;
    if (typeof chars !== "number" || !Number.isFinite(chars) || chars <= 0) return;
    manager.ack(event.sender, sessionId, chars);
  });

  // Kill every PTY on quit so no orphaned shells outlive the app — but a
  // foreground process still running somewhere (a coding agent, a build) must
  // never die to a reflexive ⌘Q: confirm first. Idle shells never block quit.
  // The dialog is synchronous, so the verdict lands inside the event: quit is
  // prevented only on Cancel, and a confirm falls through to killAll with the
  // original quit still in flight. (Never preventDefault-then-app.quit():
  // Electron swallows a quit re-issued from inside before-quit, leaving a
  // confirmed quit doing nothing.)
  app.on("before-quit", (event) => {
    const busy = manager.busySessions();
    if (
      busy.length > 0 &&
      !confirmDestructiveClose(busy, { message: "Quit Volli?", confirmLabel: "Quit" })
    ) {
      event.preventDefault();
      return;
    }
    manager.killAll();
  });

  // Start the recurring warm-park sweep here (not in the constructor) so tests
  // that construct a PtyManager directly never leak an interval.
  manager.startParkSweep();

  return manager;
}
