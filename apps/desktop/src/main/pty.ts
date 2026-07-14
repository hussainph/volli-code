import { app, ipcMain } from "electron";
import type { WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import {
  createSessionRecord,
  DEFAULT_HARNESS_ID,
  displayTicketId,
  errorMessage,
  resolveShell,
  ticketSessionEnv,
} from "@volli/shared";
import type {
  CreateTerminalSessionRequest,
  CreateTerminalSessionResult,
  HarnessId,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalIoResult,
  VolliIpcChannel,
  VolliIpcEvent,
} from "@volli/shared";
import type { DbHandle } from "./data-ipc";
import { recordTicketEvent } from "./db/events-repo";
import {
  countProjectScratchSessions,
  countTicketSessions,
  endSession,
  getSessionTicketId,
  getTicketSessionContext,
  insertSession,
} from "./db/sessions-repo";
import { isPathWithinRoots } from "./project-roots";
import { ensureTicketDir } from "./volli-fs";

// Structural subset of node-pty we depend on — declared here so nothing in
// this module needs a value import of node-pty (whose native binary is built
// for the Electron ABI and must never load under plain-Node vitest).
interface PtyProcess {
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
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
}

/** The db-resolved shape a PTY is spawned + persisted from (ticket or scratch). */
interface SessionScope {
  projectId: string;
  ticketId: string | null;
  harnessId: HarnessId;
  cwd: string;
  /** Extra env layered over the inherited environment (ticket vars, or none). */
  env: Record<string, string>;
  title: string;
  /** Ticket sessions only: ensure this `.volli` dir before spawn. */
  ticketDir: { projectPath: string; displayId: string } | null;
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
   * @param db      the app database, or `null` when it failed to open. Every
   *                session persists a durable record, so with no db `create`
   *                fails outright (surfacing {@link dbError}).
   * @param dbError the open failure to report when `db` is `null`.
   */
  constructor(
    private readonly db: Database.Database | null,
    private readonly dbError: string,
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
          // future work, and VOLLI_TICKET_DIR always points at the main .volli.
          cwd: ctx.projectPath,
          env: ticketSessionEnv(ctx.projectPath, displayId),
          title: `Session ${countTicketSessions(db, request.ticket.ticketId) + 1}`,
          ticketDir: { projectPath: ctx.projectPath, displayId },
        },
      };
    }
    return {
      ok: true,
      scope: {
        projectId: request.workspaceId,
        ticketId: null,
        harnessId: DEFAULT_HARNESS_ID,
        cwd: request.cwd,
        env: {},
        title: `Terminal ${countProjectScratchSessions(db, request.workspaceId) + 1}`,
        ticketDir: null,
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
      // Ticket sessions: ensure the ticket's `.volli` dir exists up front so an
      // agent can write artifacts the instant its shell is live. A window
      // closing during this await is caught by the post-spawn destroyed check.
      if (scope.ticketDir !== null) {
        await ensureTicketDir(scope.ticketDir.projectPath, scope.ticketDir.displayId);
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
        // env (VOLLI_TICKET/VOLLI_TICKET_DIR) on top for ticket sessions.
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
        webContents,
        onDestroyed,
        pendingChunks: [],
        pendingChars: 0,
        flushTimer: null,
        unackedChars: 0,
        paused: false,
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

  write(sessionId: string, data: string): TerminalIoResult {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return { ok: false, error: "Unknown terminal session" };
    }
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

  // Fire-and-forget (ipcRenderer.send) — an ack has no result to return, and
  // round-tripping one invoke per data event would defeat the flow control.
  ipcMain.on("volli:terminal-ack" satisfies VolliIpcChannel, (event, ...args: unknown[]): void => {
    const [sessionId, chars] = args;
    if (typeof sessionId !== "string") return;
    if (typeof chars !== "number" || !Number.isFinite(chars) || chars <= 0) return;
    manager.ack(event.sender, sessionId, chars);
  });

  // Kill every PTY on quit so no orphaned shells outlive the app.
  app.on("before-quit", () => {
    manager.killAll();
  });

  return manager;
}
