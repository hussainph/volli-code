/** One desktop lane owns move work; windows only observe the durable journal and send intents. */
import type { AccountSnapshot, CloudMoveAction, CloudMoveCommand, CloudMovePreflightInput, CloudMoveSnapshot, CloudMoveStartInput, CloudMoveStatus } from "@volli/shared";
import { OperationUnavailableError } from "@volli/shared";
import { MOVE_STATES, type MoveBackend, type MoveEngine, type MoveRow, type QueueRow } from "@volli/host-core/cloud-move";
import type { CloudMovesPort } from "@volli/host-core/handlers";
import type { PreparedLocalMoves, PreviewSummary } from "./preflight";

/** MOVE-5's post-commit commands. The composition receives the real engine, never a second implementation. */
export interface DesktopMoveEngine extends MoveEngine {
  confirm(moveId: string): Promise<MoveRow>;
  recheck(moveId: string): void;
  goBackToLocal(moveId: string, signal?: AbortSignal): Promise<MoveRow>;
}
export interface MoveDesktopOptions {
  enabled(): boolean;
  engine: DesktopMoveEngine;
  backend: MoveBackend;
  account: Pick<import("../account/service").AccountService, "snapshot" | "subscribe">;
  identity(): Promise<{ userId: string; runnerId: string } | null>;
  prepare(input: CloudMovePreflightInput, signal: AbortSignal): Promise<PreparedLocalMoves>;
  /** UI facts from the journal, checked report and canonical plan; never raw exceptions. */
  describe(move: MoveRow, queue: QueueRow): Promise<Omit<CloudMoveStatus, "actions">>;
  remember(move: MoveRow, summary: PreviewSummary | undefined): Promise<void>;
  setExportBudget(bytes: number): Promise<void>;
  openCloud(projectId: string): void | Promise<void>;
  /** An engine-owned cleanup only. Absent until it can preserve the runner's live ledger and paths. */
  removeLocalCopy?(move: MoveRow, confirmation: string): Promise<void>;
  assertIdle(projectId: string): void;
  now?: () => number;
}
export interface DesktopMovesService extends CloudMovesPort {
  startWatching(): void;
  resume(): Promise<void>;
  /** No new quit gate: abort current work and leave its last durable boundary for the next launch. */
  dispose(): Promise<void>;
  signInLost(): void;
}
const BEFORE_COMMIT = new Set<MoveRow["state"]>(["queued", "frozen", "exported", "reserved", "staged", "objects", "rows", "history", "verified"]);
const AFTER_COMMIT = new Set<MoveRow["state"]>(["committed", "handed_over", "checked", "confirmed", "returning"]);
const SETTLED = new Set<MoveRow["state"]>(["rolled_back", "returned", "superseded"]);

function personOf(snapshot: AccountSnapshot) {
  const account = snapshot.state === "signed-in" ? snapshot.account : null;
  return account?.userId == null ? null : { userId: account.userId, displayName: account.displayName };
}
function unavailable(snapshot: AccountSnapshot): string | null {
  if (personOf(snapshot) === null) return "Sign in to Volli Cloud to move projects.";
  if (snapshot.account?.backend === "refused") return "Volli Cloud did not accept this account. Check your sign-in and preview access.";
  if (snapshot.account?.backend !== "synced") return "Waiting for Volli Cloud. Try again when you’re connected.";
  return null;
}
function changedCloud(error: unknown): { changes: string[]; requiresConfirmation: true } | null {
  const value = error as { code?: unknown; detail?: Record<string, unknown>; data?: Record<string, unknown> } | null;
  if (value?.code !== "changed_since_commit" && value?.data?.code !== "changed_since_commit") return null;
  const detail = value.detail ?? value.data ?? {};
  const changes: string[] = [];
  if (typeof detail.boardChanges === "number" && Number.isSafeInteger(detail.boardChanges) && detail.boardChanges !== 0) changes.push(`${Math.abs(detail.boardChanges)} board changes`);
  if (detail.sessionActive === true) changes.push("Session history changed");
  if (changes.length === 0) changes.push("The project changed in Volli Cloud since the move");
  return { changes, requiresConfirmation: true };
}

export function createDesktopMovesService(options: MoveDesktopOptions): DesktopMovesService {
  const { engine } = options;
  const now = options.now ?? Date.now;
  const listeners = new Map<() => void, (error: unknown) => void>();
  const prepared = new Map<string, { owner: string | null; value: PreparedLocalMoves; started?: string }>();
  const rollback = new Map<string, CloudMoveStatus["rollback"]>();
  const pending = new Set<string>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let revision = 0;
  let disposed = false;
  let watching: (() => void) | null = null;
  let workspaceOwner: string | null = null;
  let workspaces: CloudMoveSnapshot["workspaces"] = [];
  let contextError: string | null = null;
  let contextRead: Promise<void> | null = null;
  let contextEpoch = 0;
  let active: { queueId: string; controller: AbortController; done: Promise<void> } | null = null;
  let controlLane = Promise.resolve();
  let controlling = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const requireEnabled = () => { if (disposed || !options.enabled()) throw new OperationUnavailableError("Moves to Volli Cloud are unavailable."); };
  const notify = () => {
    revision += 1;
    for (const [listener, fail] of listeners) {
      try { listener(); } catch { fail(new Error("Could not follow move progress.")); }
    }
  };
  const currentPerson = () => personOf(options.account.snapshot());
  const own = (row: MoveRow) => currentPerson()?.userId === row.userId;
  const readMove = (id: string): MoveRow => {
    const row = engine.journal.move(id);
    if (row === null || !own(row)) throw new OperationUnavailableError("This move belongs to the person who started it.");
    return row;
  };
  const cancelRetry = (queueId: string) => { const handle = retryTimers.get(queueId); if (handle !== undefined) clearTimeout(handle); retryTimers.delete(queueId); };
  const refreshContext = async () => {
    const person = currentPerson();
    const owner = person?.userId ?? null;
    if (workspaceOwner !== owner) { workspaceOwner = owner; workspaces = []; contextError = null; contextEpoch += 1; contextRead = null; }
    if (person === null || unavailable(options.account.snapshot()) !== null || contextRead !== null) return contextRead ?? undefined;
    const mine = contextEpoch;
    const work = (async () => {
      try {
        const answer = await options.backend.query("workspaces:listMine", {});
        if (!Array.isArray(answer)) throw new Error("Unreadable Workspaces");
        const next = answer.map((raw: unknown) => {
          const item = raw as Record<string, unknown> | null;
          if (typeof item?.workspaceId !== "string" || typeof item.name !== "string") throw new Error("Unreadable Workspace");
          return { id: item.workspaceId, name: item.name, canMove: item.role === "owner" || item.role === "admin" };
        });
        if (!disposed && mine === contextEpoch && currentPerson()?.userId === owner) { workspaces = next; contextError = null; }
      } catch { if (!disposed && mine === contextEpoch) contextError = "Couldn’t read your Workspaces. Try again."; }
      finally { if (mine === contextEpoch) contextRead = null; }
    })();
    contextRead = work;
    await work;
  };

  const actionsFor = (row: MoveRow, status: Omit<CloudMoveStatus, "actions">): CloudMoveAction[] => {
    if (!own(row) || unavailable(options.account.snapshot()) !== null) return [];
    const queue = engine.journal.queue(row.queueId);
    if (row.state === "returned" || row.state === "superseded") return [];
    if (row.state === "rolling_back") return ["resume"];
    if (row.state === "returning") return ["go-back"];
    if (row.state === "rolled_back") return row.failure?.code === "cancelled" ? [] : ["retry", ...(queue?.state === "stopped" ? ["skip" as const] : [])];
    if (row.state === "confirmed") return ["open-cloud", ...(status.localReadOnly ? ["go-back" as const, ...(options.removeLocalCopy === undefined ? [] : ["remove-local" as const])] : [])];
    if (AFTER_COMMIT.has(row.state)) return ["open-cloud", ...(row.state === "checked" && row.report?.ok === true ? ["finish" as const] : ["retry" as const]), "roll-back", ...(status.localReadOnly ? ["go-back" as const] : [])];
    return [row.paused !== null || queue?.state === "stopped" ? "resume" : "pause", "cancel", ...(row.paused === "not_idle" || row.paused === "waiting_for_purge" ? ["skip" as const] : [])];
  };

  const schedule = (queueId: string) => {
    if (disposed || !options.enabled()) return;
    const queue = engine.journal.queue(queueId);
    if (queue === null || queue.state !== "running" || currentPerson()?.userId !== queue.userId) return;
    cancelRetry(queueId);
    pending.add(queueId);
    pump();
  };
  const later = (queueId: string) => {
    cancelRetry(queueId);
    const handle = setTimeout(() => { retryTimers.delete(queueId); schedule(queueId); }, 15_000);
    handle.unref?.(); retryTimers.set(queueId, handle);
  };
  function pump() {
    if (disposed || controlling > 0 || active !== null || !options.enabled()) return;
    const queueId = pending.values().next().value as string | undefined;
    if (queueId === undefined) return;
    pending.delete(queueId);
    const queue = engine.journal.queue(queueId);
    if (queue === null || queue.state !== "running" || currentPerson()?.userId !== queue.userId) { pump(); return; }
    const controller = new AbortController();
    const done = (async () => {
      try {
        const result = await engine.run(queueId, controller.signal);
        if (result.kind === "waiting" && (result.reason === "network" || result.reason === "not_idle" || result.reason === "waiting_for_purge")) later(queueId);
      } catch { contextError = "A move stopped. Open its progress to continue."; }
      finally { if (active?.queueId === queueId) active = null; notify(); pump(); }
    })();
    active = { queueId, controller, done };
    notify();
  }
  const controlled = async <Value>(work: () => Promise<Value>): Promise<Value> => {
    controlling += 1;
    let release!: () => void;
    const prior = controlLane;
    controlLane = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    const interrupted = active;
    if (interrupted !== null) { interrupted.controller.abort(); await interrupted.done; }
    try { requireEnabled(); return await work(); }
    finally {
      controlling -= 1;
      release();
      if (interrupted !== null) schedule(interrupted.queueId);
      pump();
    }
  };
  const snapshot = async (): Promise<CloudMoveSnapshot> => {
    requireEnabled();
    if (workspaceOwner !== currentPerson()?.userId || (workspaces.length === 0 && contextError === null)) await refreshContext();
    const account = currentPerson();
    const moves: CloudMoveStatus[] = [];
    for (const row of engine.journal.movesIn(MOVE_STATES)) {
      const queue = engine.journal.queue(row.queueId);
      if (queue === null) continue;
      const view = await options.describe(row, queue);
      if (row.state === "queued" && active?.queueId === row.queueId) {
        const next = engine.journal.moves(row.queueId).find((item) => !SETTLED.has(item.state) && !AFTER_COMMIT.has(item.state) && item.paused === null);
        if (next?.moveId === row.moveId) { view.state = "moving"; view.message = "Making and checking the full backup."; }
      }
      view.rollback = rollback.get(row.moveId) ?? (AFTER_COMMIT.has(row.state) && row.state !== "confirmed" ? { changes: [], requiresConfirmation: false } : null);
      if (row.state === "rolled_back" && queue.state === "done") view.state = "rolled-back";
      moves.push({ ...view, actions: actionsFor(row, view) });
    }
    return { revision, account, workspaces, moves, unavailable: unavailable(options.account.snapshot()) ?? contextError };
  };

  const service: DesktopMovesService = {
    snapshot,
    onChanged(listener, fail) { requireEnabled(); listeners.set(listener, fail); return () => { listeners.delete(listener); }; },
    async preflight(input) {
      requireEnabled();
      await refreshContext();
      if (input.workspaceId !== null && !workspaces.some((item) => item.id === input.workspaceId && item.canMove)) throw new OperationUnavailableError("Choose a Workspace you can manage.");
      return controlled(async () => {
        const owner = currentPerson()?.userId ?? null;
        const value = await options.prepare(input, new AbortController().signal);
        if ((currentPerson()?.userId ?? null) !== owner) throw new OperationUnavailableError("The sign-in changed. Run the dry run again.");
        prepared.set(value.preflight.id, { owner, value });
        while (prepared.size > 4) prepared.delete(prepared.keys().next().value!);
        return value.preflight;
      });
    },
    async start(input: CloudMoveStartInput) {
      return controlled(async () => {
        const entry = prepared.get(input.preflightId);
        const person = currentPerson();
        if (entry === undefined || person === null || entry.owner !== person.userId || entry.value.input.workspaceId !== input.workspaceId) throw new OperationUnavailableError("Run a fresh dry run for this account and Workspace.");
        if (entry.started !== undefined) { schedule(entry.started); return; }
        await refreshContext();
        if (!workspaces.some((item) => item.id === input.workspaceId && item.canMove)) throw new OperationUnavailableError("This Workspace cannot accept the move.");
        const selected = new Set(input.projectIds);
        if (selected.size === 0 || selected.size !== input.projectIds.length || input.projectIds.some((id) => !entry.value.preflight.projects.some((project) => project.id === id && project.blockers.length === 0 && project.counts !== null))) throw new OperationUnavailableError("Choose projects that passed the dry run.");
        const identity = await options.identity();
        if (identity === null || identity.userId !== person.userId) throw new OperationUnavailableError("This Mac must be registered for the person who is moving the project.");
        await options.setExportBudget(entry.value.estimatedExportBytes);
        const result = engine.enqueue({ projectIds: input.projectIds, target: { ...identity, workspaceId: input.workspaceId }, includeRemoved: entry.value.input.includeRemoved, stopAtFirstProblem: input.stopAtFirstProblem });
        entry.started = result.queue.queueId;
        for (const row of result.moves) await options.remember(row, entry.value.summaries[row.projectId]);
        notify(); schedule(result.queue.queueId);
      });
    },
    async command(input: CloudMoveCommand) {
      requireEnabled();
      const first = readMove(input.moveId);
      if (input.action === "pause") {
        engine.journal.setQueue(first.queueId, { state: "stopped" });
        cancelRetry(first.queueId); pending.delete(first.queueId);
      }
      return controlled(async () => {
        const row = readMove(input.moveId);
        const queue = engine.journal.queue(row.queueId)!;
        const view = await options.describe(row, queue);
        const allowed = actionsFor(row, view);
        // Pause was made durable before interrupting the worker, so it now reads as Resume.
        if (input.action !== "pause" && !allowed.includes(input.action)) throw new OperationUnavailableError("This action is no longer available.");
        switch (input.action) {
          case "pause":
            if (!BEFORE_COMMIT.has(row.state)) throw new OperationUnavailableError("This move is no longer running.");
            engine.journal.patch(row.moveId, { paused: "paused" });
            break;
          case "resume": engine.proceed(row.queueId); schedule(row.queueId); break;
          case "skip":
          case "cancel":
            if (BEFORE_COMMIT.has(row.state)) await engine.rollBack(row.moveId);
            engine.proceed(row.queueId); schedule(row.queueId); break;
          case "retry": {
            if (row.state === "checked") { engine.recheck(row.moveId); schedule(row.queueId); break; }
            const identity = await options.identity();
            if (identity === null || identity.userId !== row.userId) throw new OperationUnavailableError("Sign in as the person who started the move.");
            const result = engine.enqueue({ projectIds: [row.projectId], target: { ...identity, workspaceId: row.workspaceId }, includeRemoved: queue.includeRemoved, stopAtFirstProblem: queue.stopAtFirstProblem });
            await options.remember(result.moves[0]!, undefined); schedule(result.queue.queueId); break;
          }
          case "finish":
            if (row.state !== "checked" || row.report?.ok !== true) throw new OperationUnavailableError("Every move check must pass before you finish.");
            await engine.confirm(row.moveId); break;
          case "open-cloud": await options.openCloud(row.projectId); break;
          case "roll-back": {
            options.assertIdle(row.projectId);
            const changed = rollback.get(row.moveId)?.requiresConfirmation === true;
            if (changed && input.confirmation !== view.projectName) throw new OperationUnavailableError("Type the project name to confirm losing the cloud changes.");
            try { await engine.rollBack(row.moveId, { confirmChanged: changed }); rollback.delete(row.moveId); }
            catch (error) { const details = changedCloud(error); if (details !== null) rollback.set(row.moveId, details); throw new OperationUnavailableError(details === null ? "Could not roll the move back." : "The cloud project changed. Check the changes and type its name to confirm."); }
            break;
          }
          case "go-back": options.assertIdle(row.projectId); await engine.goBackToLocal(row.moveId); break;
          case "remove-local":
            if (options.removeLocalCopy === undefined || row.state !== "confirmed" || input.confirmation !== view.projectName) throw new OperationUnavailableError("Type the project name to remove its local copy.");
            options.assertIdle(row.projectId); await options.removeLocalCopy(row, input.confirmation); break;
        }
        notify();
      });
    },
    async report(id) {
      requireEnabled();
      const preview = prepared.get(id);
      if (preview !== undefined && preview.owner === (currentPerson()?.userId ?? null)) return JSON.stringify({ kind: "dry-run", projects: preview.value.preflight.projects.map((project) => ({ projectId: project.id, counts: project.counts, blocked: project.blockers.length, code: preview.value.failures[project.id] ?? null })) }, null, 2);
      const row = readMove(id);
      const view = await options.describe(row, engine.journal.queue(row.queueId)!);
      return JSON.stringify({ moveId: row.moveId, projectId: row.projectId, state: row.state, paused: row.paused, failure: row.failure?.code ?? null, checks: view.checks, counts: view.counts, createdAt: row.createdAt, updatedAt: row.updatedAt }, null, 2);
    },
    startWatching() {
      if (watching !== null || disposed || !options.enabled()) return;
      watching = options.account.subscribe(() => {
        contextEpoch += 1; contextRead = null;
        const person = currentPerson();
        if (active !== null && engine.journal.queue(active.queueId)?.userId !== person?.userId) active.controller.abort();
        void refreshContext().then(notify);
      });
      timer = setInterval(() => { if (!options.enabled()) active?.controller.abort(); if (active !== null) notify(); }, 1000); timer.unref?.();
    },
    async resume() {
      requireEnabled(); service.startWatching();
      for (const queue of engine.journal.runningQueues()) schedule(queue.queueId);
      for (const row of engine.journal.movesIn(["rolling_back"])) schedule(row.queueId);
      for (const row of engine.journal.movesIn(["returning"])) if (own(row)) await service.command({ moveId: row.moveId, action: "go-back" });
    },
    signInLost() { active?.controller.abort(); contextError = "Sign in as the person who started this move."; notify(); },
    async dispose() {
      disposed = true; watching?.(); watching = null;
      if (timer !== null) clearInterval(timer);
      for (const handle of retryTimers.values()) clearTimeout(handle);
      retryTimers.clear(); pending.clear();
      const running = active; running?.controller.abort(); if (running !== null) await running.done;
      listeners.clear(); prepared.clear();
    },
  };
  void now; // The view's revision is process-local, never a durable clock or command id.
  return service;
}
