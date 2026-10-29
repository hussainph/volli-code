/** One desktop lane owns move work; windows only observe the durable journal and send intents. */
import type {
  AccountSnapshot,
  CloudMoveAction,
  CloudMoveAutomationRearm,
  CloudMoveCommand,
  CloudMovePreflightInput,
  CloudMoveSnapshot,
  CloudMoveStartInput,
  CloudMoveStatus,
} from "@volli/shared";
import { OperationUnavailableError } from "@volli/shared";
import {
  MOVE_STATES,
  type MoveBackend,
  type MoveEngine,
  type MoveRow,
  type QueueRow,
} from "@volli/host-core/cloud-move";
import type { CloudMovesPort } from "@volli/host-core/handlers";
import type { PreparedLocalMoves, PreviewSummary } from "./preflight";
import type { MoveRearmPort } from "./rearm";

export interface MoveDesktopOptions {
  enabled(): boolean;
  engine: MoveEngine;
  backend: Pick<MoveBackend, "query">;
  account: Pick<import("../account/service").AccountService, "snapshot" | "subscribe">;
  identity(signal?: AbortSignal): Promise<{ userId: string; runnerId: string } | null>;
  prepare(input: CloudMovePreflightInput, signal: AbortSignal): Promise<PreparedLocalMoves>;
  /** UI facts from the journal, checked report and canonical plan; never raw exceptions. */
  describe(move: MoveRow, queue: QueueRow): Promise<Omit<CloudMoveStatus, "actions">>;
  remember(move: MoveRow, summary: PreviewSummary | undefined): Promise<void>;
  setExportBudget(bytes: number): Promise<void>;
  openCloud(move: MoveRow): void | Promise<void>;
  rearm?: MoveRearmPort;
  assertIdle(projectId: string): void;
  track?(work: Promise<unknown>): void;
  releaseIdentity?(): Promise<void>;
  withSignal?<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T>;
  disposeBackend?(): void;
}
export interface DesktopMovesService extends CloudMovesPort {
  startWatching(): void;
  resume(): Promise<void>;
  /** No new quit gate: abort current work and leave its last durable boundary for the next launch. */
  dispose(): Promise<void>;
  signInLost(): void;
}
const BEFORE_COMMIT = new Set<MoveRow["state"]>([
  "queued",
  "frozen",
  "exported",
  "reserved",
  "staged",
  "objects",
  "rows",
  "history",
  "verified",
]);
const AFTER_COMMIT = new Set<MoveRow["state"]>([
  "committed",
  "handed_over",
  "checked",
  "confirmed",
  "returning",
]);
const SETTLED = new Set<MoveRow["state"]>(["rolled_back", "returned", "superseded"]);
const REPORT_ONLY_FAILURES = new Set([
  "already_migrated",
  "preview_waitlisted",
  "preview_agreement_required",
]);

function personOf(snapshot: AccountSnapshot) {
  const account = snapshot.state === "signed-in" ? snapshot.account : null;
  return account?.userId == null
    ? null
    : { userId: account.userId, displayName: account.displayName };
}
function unavailable(snapshot: AccountSnapshot): string | null {
  if (personOf(snapshot) === null) return "Sign in to Volli Cloud to move projects.";
  if (snapshot.account?.backend === "refused")
    return "Volli Cloud did not accept this account. Check your sign-in and preview access.";
  return null;
}
function changedCloud(error: unknown): { changes: string[]; requiresConfirmation: true } | null {
  const value = error as {
    code?: unknown;
    detail?: Record<string, unknown>;
    data?: Record<string, unknown>;
  } | null;
  if (value?.code !== "changed_since_commit" && value?.data?.code !== "changed_since_commit")
    return null;
  const detail = value.detail ?? value.data ?? {};
  const changes: string[] = [];
  if (
    typeof detail.boardChanges === "number" &&
    Number.isSafeInteger(detail.boardChanges) &&
    detail.boardChanges !== 0
  )
    changes.push(`${Math.abs(detail.boardChanges)} board changes`);
  if (detail.sessionActive === true) changes.push("Session history changed");
  if (changes.length === 0) changes.push("The project changed in Volli Cloud since the move");
  return { changes, requiresConfirmation: true };
}

async function recoverable<T>(work: Promise<T>, fallback: string): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof OperationUnavailableError) throw error;
    throw new OperationUnavailableError(fallback);
  }
}

export function createDesktopMovesService(options: MoveDesktopOptions): DesktopMovesService {
  const { engine } = options;
  const scoped = <T>(signal: AbortSignal, work: () => Promise<T>) =>
    options.withSignal === undefined ? work() : options.withSignal(signal, work);
  const listeners = new Map<() => void, (error: unknown) => void>();
  const prepared = new Map<
    string,
    { owner: string | null; value: PreparedLocalMoves; started?: string; intent?: string }
  >();
  const rollback = new Map<string, CloudMoveStatus["rollback"]>();
  const rearmDetails = new Map<
    string,
    { at: number; pending: boolean; fresh: boolean; value?: CloudMoveAutomationRearm }
  >();
  const pending = new Set<string>();
  const preflightReads = new Set<AbortController>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let revision = 0;
  let disposed = false;
  let watching: (() => void) | null = null;
  let workspaceOwner: string | null = null;
  let workspaces: CloudMoveSnapshot["workspaces"] = [];
  let contextError: string | null = null;
  let signInLost = false;
  let contextRead: Promise<void> | null = null;
  let contextEpoch = 0;
  let active: { queueId: string; controller: AbortController; done: Promise<void> } | null = null;
  let controlLane = Promise.resolve();
  let controlling = 0;
  let controlAbort: AbortController | null = null;
  let accountOwner = personOf(options.account.snapshot())?.userId ?? null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const requireEnabled = () => {
    if (disposed || !options.enabled())
      throw new OperationUnavailableError("Moves to Volli Cloud are unavailable.");
  };
  const notify = () => {
    revision += 1;
    for (const [listener, fail] of listeners) {
      try {
        listener();
      } catch {
        try {
          fail(new Error("Could not follow move progress."));
        } catch {
          /* A disconnected observer cannot break a move. */
        }
      }
    }
  };
  const currentPerson = () => personOf(options.account.snapshot());
  const own = (row: MoveRow) => currentPerson()?.userId === row.userId;
  const readMove = (id: string): MoveRow => {
    const row = engine.journal.move(id);
    if (row === null || !own(row))
      throw new OperationUnavailableError("This move belongs to the person who started it.");
    return row;
  };
  const cancelRetry = (queueId: string) => {
    const handle = retryTimers.get(queueId);
    if (handle !== undefined) clearTimeout(handle);
    retryTimers.delete(queueId);
  };
  const refreshContext = async () => {
    const person = currentPerson();
    const owner = person?.userId ?? null;
    if (workspaceOwner !== owner) {
      workspaceOwner = owner;
      workspaces = [];
      contextError = null;
      contextEpoch += 1;
      contextRead = null;
    }
    if (person === null || unavailable(options.account.snapshot()) !== null || contextRead !== null)
      return contextRead ?? undefined;
    const mine = contextEpoch;
    const work = (async () => {
      try {
        const answer = await options.backend.query("workspaces:listMine", {});
        if (!Array.isArray(answer)) throw new Error("Unreadable Workspaces");
        const next = answer.map((raw: unknown) => {
          const item = raw as Record<string, unknown> | null;
          if (typeof item?.workspaceId !== "string" || typeof item.name !== "string")
            throw new Error("Unreadable Workspace");
          return {
            id: item.workspaceId,
            name: item.name,
            canMove: item.role === "owner" || item.role === "admin",
          };
        });
        if (!disposed && mine === contextEpoch && currentPerson()?.userId === owner) {
          workspaces = next;
          contextError = null;
          signInLost = false;
        }
      } catch {
        if (!disposed && mine === contextEpoch)
          contextError = "Couldn’t read your Workspaces. Try again.";
      } finally {
        if (mine === contextEpoch) contextRead = null;
      }
    })();
    contextRead = work;
    await work;
  };

  const currentOwnedMove = (row: MoveRow) => {
    const latest = engine.journal
      .movesIn(MOVE_STATES)
      .findLast((item) => item.projectId === row.projectId);
    return (
      own(row) && latest?.moveId === row.moveId && unavailable(options.account.snapshot()) === null
    );
  };
  const actionsFor = (
    row: MoveRow,
    status: Omit<CloudMoveStatus, "actions">,
  ): CloudMoveAction[] => {
    if (!currentOwnedMove(row)) return [];
    const queue = engine.journal.queue(row.queueId);
    const rearmActions: CloudMoveAction[] =
      row.state === "confirmed" &&
      active === null &&
      status.automationRearm?.canRearmOnThisMac === true &&
      status.automationRearm.columns.length + status.automationRearm.schedules.length > 0
        ? ["re-arm"]
        : [];
    if (row.state === "returned") return ["open-cloud"];
    if (row.state === "superseded" || REPORT_ONLY_FAILURES.has(row.failure?.code ?? "")) return [];
    if (row.state === "rolling_back") return ["resume"];
    if (row.state === "returning") return ["go-back"];
    if (row.state === "rolled_back")
      return row.failure?.code === "cancelled" || active !== null
        ? []
        : ["retry", ...(queue?.state === "stopped" ? ["skip" as const] : [])];
    if (row.state === "confirmed")
      return ["open-cloud", ...rearmActions, ...(status.localReadOnly ? ["go-back" as const] : [])];
    if (AFTER_COMMIT.has(row.state))
      return [
        "open-cloud",
        ...(row.state === "checked" && row.report?.ok === true
          ? ["finish" as const]
          : ["retry" as const]),
        "roll-back",
        ...rearmActions,
        ...(status.localReadOnly ? ["go-back" as const] : []),
      ];
    if (row.paused === "disk_full") return ["retry", "cancel"];
    return [
      row.paused !== null || queue?.state === "stopped" ? "resume" : "pause",
      "cancel",
      ...(row.paused === "not_idle" || row.paused === "waiting_for_purge" ? ["skip" as const] : []),
    ];
  };

  const describe = async (row: MoveRow, queue: QueueRow) => {
    const view = await options.describe(row, queue);
    const port = options.rearm;
    if (
      port === undefined ||
      !currentOwnedMove(row) ||
      row.report?.ok !== true ||
      (row.state !== "checked" && row.state !== "confirmed")
    )
      return view;
    const key = row.userId + ":" + row.moveId;
    let cached = rearmDetails.get(key);
    if (cached === undefined) {
      cached = {
        at: 0,
        pending: false,
        fresh: false,
        ...(view.pausedAutomations.length === 0
          ? {}
          : {
              value: {
                columns: [],
                schedules: [],
                inertGlobals: [],
                canRearmOnThisMac: false,
                unavailable: "Reading paused Automations…",
                retryable: false,
              },
            }),
      };
      rearmDetails.set(key, cached);
      while (rearmDetails.size > 128) rearmDetails.delete(rearmDetails.keys().next().value!);
    }
    if (!cached.pending && (cached.fresh || Date.now() - cached.at >= 5_000)) {
      const reading = cached;
      const fresh = reading.fresh;
      reading.fresh = false;
      reading.pending = true;
      reading.at = Date.now();
      // Optional network details never hold up the journal or its recovery controls.
      const work = Promise.resolve()
        .then(() => port.read(row, fresh))
        .then((value) => {
          if (!disposed && currentOwnedMove(row) && rearmDetails.get(key) === reading) {
            reading.value = value;
            reading.at = Date.now();
            notify();
          }
        })
        .catch(() => {
          if (!disposed && currentOwnedMove(row) && rearmDetails.get(key) === reading) {
            reading.value = {
              columns: [],
              schedules: [],
              inertGlobals: [],
              canRearmOnThisMac: false,
              unavailable: "Couldn’t read paused Automations.",
              retryable: true,
            };
            reading.at = Date.now();
            notify();
          }
        })
        .finally(() => {
          reading.pending = false;
          if (!disposed && reading.fresh && rearmDetails.get(key) === reading) notify();
        });
      options.track?.(work);
    }
    const value =
      cached.value === undefined
        ? undefined
        : cached.pending && cached.value.retryable
          ? {
              ...cached.value,
              canRearmOnThisMac: false,
              unavailable: "Refreshing paused Automations…",
              retryable: false,
            }
          : cached.value;
    if (value !== undefined) {
      const blocked =
        value.columns.length + value.schedules.length > 0
          ? row.state !== "confirmed"
            ? "Finish the move before re-arming Automations."
            : active !== null
              ? "Wait for the running move to finish."
              : null
          : null;
      view.automationRearm =
        blocked === null
          ? value
          : { ...value, canRearmOnThisMac: false, unavailable: blocked, retryable: false };
    }
    return view;
  };

  const runnable = (queue: QueueRow) =>
    queue.state === "running" ||
    engine.journal.moves(queue.queueId).some((row) => row.state === "rolling_back");
  const schedule = (queueId: string) => {
    if (disposed || !options.enabled() || signInLost) return;
    const queue = engine.journal.queue(queueId);
    if (queue === null || !runnable(queue) || currentPerson()?.userId !== queue.userId) return;
    cancelRetry(queueId);
    pending.add(queueId);
    pump();
  };
  const later = (queueId: string) => {
    cancelRetry(queueId);
    const handle = setTimeout(() => {
      retryTimers.delete(queueId);
      schedule(queueId);
    }, 15_000);
    handle.unref?.();
    retryTimers.set(queueId, handle);
  };
  function pump() {
    if (disposed || controlling > 0 || active !== null || !options.enabled()) return;
    const queueId = pending.values().next().value as string | undefined;
    if (queueId === undefined) return;
    pending.delete(queueId);
    const queue = engine.journal.queue(queueId);
    if (queue === null || !runnable(queue) || currentPerson()?.userId !== queue.userId) {
      pump();
      return;
    }
    const controller = new AbortController();
    const done = (async () => {
      try {
        const result = await Promise.resolve().then(() =>
          scoped(controller.signal, () => engine.run(queueId, controller.signal)),
        );
        if (result.kind === "waiting" && signInLost && engine.journal.move(result.moveId) !== null)
          engine.journal.patch(result.moveId, { paused: "signed_out" });
        if (
          !signInLost &&
          result.kind === "waiting" &&
          (result.reason === "network" ||
            result.reason === "not_idle" ||
            result.reason === "waiting_for_purge")
        )
          later(queueId);
      } catch {
        contextError = "A move stopped. Open its progress to continue.";
      } finally {
        active = null;
        notify();
        pump();
        if (active === null && controlling === 0 && pending.size === 0)
          await options.releaseIdentity?.();
      }
    })();
    active = { queueId, controller, done };
    options.track?.(done);
    notify();
  }
  const controlled = async <Value>(
    work: (signal: AbortSignal) => Promise<Value>,
  ): Promise<Value> => {
    controlling += 1;
    let release!: () => void;
    const prior = controlLane;
    controlLane = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    const interrupted = active;
    if (interrupted !== null) {
      interrupted.controller.abort();
      await interrupted.done;
    }
    const controller = new AbortController();
    controlAbort = controller;
    try {
      requireEnabled();
      return await scoped(controller.signal, () => work(controller.signal));
    } finally {
      if (controlAbort === controller) controlAbort = null;
      controlling -= 1;
      release();
      if (interrupted !== null) schedule(interrupted.queueId);
      notify();
      pump();
      if (active === null && controlling === 0 && pending.size === 0)
        await options.releaseIdentity?.();
    }
  };
  const snapshot = async (): Promise<CloudMoveSnapshot> => {
    requireEnabled();
    if (
      workspaceOwner !== (currentPerson()?.userId ?? null) ||
      workspaces.length === 0 ||
      contextError !== null ||
      signInLost
    )
      await refreshContext();
    const account = currentPerson();
    const moves: CloudMoveStatus[] = [];
    for (const row of engine.journal.movesIn(MOVE_STATES)) {
      const queue = engine.journal.queue(row.queueId);
      if (queue === null) continue;
      const view = await describe(row, queue);
      view.workspaceName =
        workspaces.find((item) => item.id === row.workspaceId)?.name ?? view.workspaceName;
      if (row.state === "queued" && active?.queueId === row.queueId) {
        const next = engine.journal
          .moves(row.queueId)
          .find(
            (item) =>
              !SETTLED.has(item.state) && !AFTER_COMMIT.has(item.state) && item.paused === null,
          );
        if (next?.moveId === row.moveId) {
          view.state = "moving";
          view.message = "Making and checking the full backup.";
        }
      }
      view.rollback =
        rollback.get(row.moveId) ??
        (AFTER_COMMIT.has(row.state) && row.state !== "confirmed"
          ? { changes: [], requiresConfirmation: false }
          : null);
      if (row.state === "rolled_back" && queue.state === "done") view.state = "rolled-back";
      if (
        row.state === "rolled_back" &&
        row.failure?.code !== "cancelled" &&
        !REPORT_ONLY_FAILURES.has(row.failure?.code ?? "") &&
        active !== null &&
        currentOwnedMove(row)
      )
        view.message += " Retry after the running move finishes.";
      moves.push({ ...view, actions: actionsFor(row, view) });
    }
    return {
      revision,
      account,
      workspaces,
      moves,
      unavailable:
        unavailable(options.account.snapshot()) ??
        (signInLost ? "Sign in as the person who started this move." : contextError),
    };
  };

  const service: DesktopMovesService = {
    snapshot,
    onChanged(listener, fail) {
      requireEnabled();
      listeners.set(listener, fail);
      // The window resubscribes on an explicit refresh. Bypass both metadata
      // caches then, while still coalescing a read that is already in flight.
      for (const cached of rearmDetails.values()) cached.fresh = true;
      service.startWatching();
      return () => {
        listeners.delete(listener);
      };
    },
    async preflight(input) {
      requireEnabled();
      const read = new AbortController();
      preflightReads.add(read);
      try {
        await refreshContext();
        if (
          input.workspaceId !== null &&
          !workspaces.some((item) => item.id === input.workspaceId && item.canMove)
        )
          throw new OperationUnavailableError("Choose a Workspace you can manage.");
        // A read-only dry run must never pause a different project's active move.
        if (active !== null)
          throw new OperationUnavailableError(
            "Wait for the running move to finish, then run the dry run again.",
          );
        return await controlled(async (signal) => {
          const lifetime = AbortSignal.any([signal, read.signal]);
          lifetime.throwIfAborted();
          const owner = currentPerson()?.userId ?? null;
          const value = await options.prepare(input, lifetime);
          lifetime.throwIfAborted();
          if ((currentPerson()?.userId ?? null) !== owner)
            throw new OperationUnavailableError("The sign-in changed. Run the dry run again.");
          prepared.set(value.preflight.id, { owner, value });
          while (prepared.size > 4) prepared.delete(prepared.keys().next().value!);
          return value.preflight;
        });
      } catch (error) {
        if (error instanceof OperationUnavailableError) throw error;
        if ((error as { name?: unknown } | null)?.name === "AbortError")
          throw new OperationUnavailableError("The dry run was cancelled. Run it again.");
        throw new OperationUnavailableError(
          "Couldn’t check these projects. Run the dry run again.",
        );
      } finally {
        preflightReads.delete(read);
      }
    },
    async start(input: CloudMoveStartInput) {
      return recoverable(
        controlled(async (signal) => {
          const entry = prepared.get(input.preflightId);
          const person = currentPerson();
          if (unavailable(options.account.snapshot()) !== null)
            throw new OperationUnavailableError(
              "Check your Volli Cloud sign-in before starting a move.",
            );
          if (
            entry === undefined ||
            person === null ||
            entry.owner !== person.userId ||
            entry.value.input.workspaceId !== input.workspaceId
          )
            throw new OperationUnavailableError(
              "Run a fresh dry run for this account and Workspace.",
            );
          const intent = JSON.stringify([
            input.workspaceId,
            input.projectIds.toSorted(),
            input.stopAtFirstProblem,
          ]);
          if (entry.started !== undefined) {
            if (entry.intent !== intent)
              throw new OperationUnavailableError(
                "This dry run already started a different selection. Run it again.",
              );
            schedule(entry.started);
            return;
          }
          await refreshContext();
          if (contextError !== null || signInLost)
            throw new OperationUnavailableError(
              "Check your sign-in and connection, then run the dry run again.",
            );
          if (!workspaces.some((item) => item.id === input.workspaceId && item.canMove))
            throw new OperationUnavailableError("This Workspace cannot accept the move.");
          const selected = new Set(input.projectIds);
          if (
            selected.size === 0 ||
            selected.size !== input.projectIds.length ||
            input.projectIds.some(
              (id) =>
                !entry.value.preflight.projects.some(
                  (project) =>
                    project.id === id && project.blockers.length === 0 && project.counts !== null,
                ),
            )
          )
            throw new OperationUnavailableError("Choose projects that passed the dry run.");
          if (entry.value.preflight.disk.freeBytes < entry.value.preflight.disk.requiredBytes)
            throw new OperationUnavailableError("Free disk space, then run the dry run again.");
          const identity = await options.identity(signal);
          if (
            identity === null ||
            identity.userId !== person.userId ||
            currentPerson()?.userId !== person.userId
          )
            throw new OperationUnavailableError(
              "This Mac must be registered for the person who is moving the project.",
            );
          await options.setExportBudget(entry.value.estimatedExportBytes);
          signal.throwIfAborted();
          if (currentPerson()?.userId !== person.userId)
            throw new OperationUnavailableError("The sign-in changed. Run the dry run again.");
          for (const id of input.projectIds) options.assertIdle(id);
          const result = engine.enqueue({
            projectIds: input.projectIds,
            target: { ...identity, workspaceId: input.workspaceId },
            includeRemoved: entry.value.input.includeRemoved,
            stopAtFirstProblem: input.stopAtFirstProblem,
          });
          entry.started = result.queue.queueId;
          entry.intent = intent;
          try {
            for (const row of result.moves)
              await options.remember(row, entry.value.summaries[row.projectId]);
          } finally {
            notify();
            schedule(result.queue.queueId);
          }
        }),
        "Couldn’t start the move. Run the dry run again, then retry.",
      );
    },
    async command(input: CloudMoveCommand) {
      requireEnabled();
      const first = readMove(input.moveId);
      if (input.action === "re-arm" && active !== null)
        throw new OperationUnavailableError("Wait for the running move to finish, then try again.");
      if (
        (input.action === "retry" || input.action === "skip") &&
        first.state === "rolled_back" &&
        active !== null
      )
        throw new OperationUnavailableError("Wait for the running move to finish, then try again.");
      // Commands keep their priority over a read-only export, including a queued one.
      for (const read of preflightReads) read.abort();
      if (input.action === "pause" && BEFORE_COMMIT.has(first.state)) {
        engine.journal.setQueue(first.queueId, { state: "stopped" });
        cancelRetry(first.queueId);
        pending.delete(first.queueId);
      }
      return recoverable(
        controlled(async (signal) => {
          const row = readMove(input.moveId);
          const queue = engine.journal.queue(row.queueId)!;
          const view = await options.describe(row, queue);
          const allowed =
            input.action === "re-arm" &&
            row.state === "confirmed" &&
            options.rearm !== undefined &&
            currentOwnedMove(row)
              ? ["re-arm"]
              : actionsFor(row, view);
          // Pause was made durable before interrupting the worker, so it now reads as Resume.
          if (input.action !== "pause" && !allowed.includes(input.action))
            throw new OperationUnavailableError("This action is no longer available.");
          switch (input.action) {
            case "pause":
              if (!BEFORE_COMMIT.has(row.state))
                throw new OperationUnavailableError("This move is no longer running.");
              engine.journal.patch(row.moveId, { paused: "paused" });
              break;
            case "resume":
              await refreshContext();
              if (signInLost)
                throw new OperationUnavailableError("Sign in as the person who started this move.");
              engine.proceed(row.queueId);
              schedule(row.queueId);
              break;
            case "skip":
            case "cancel":
              if (BEFORE_COMMIT.has(row.state)) await engine.rollBack(row.moveId, { signal });
              engine.proceed(row.queueId);
              schedule(row.queueId);
              break;
            case "retry": {
              if (row.state === "checked") {
                engine.recheck(row.moveId);
                schedule(row.queueId);
                break;
              }
              if (row.state !== "rolled_back") {
                engine.proceed(row.queueId);
                schedule(row.queueId);
                break;
              }
              await refreshContext();
              if (
                !workspaces.some((item) => item.id === row.workspaceId && item.canMove) ||
                contextError !== null ||
                signInLost
              )
                throw new OperationUnavailableError(
                  "Choose a Workspace you can manage, then run the dry run again.",
                );
              const read = new AbortController();
              preflightReads.add(read);
              let fresh: PreparedLocalMoves;
              try {
                fresh = await options.prepare(
                  {
                    projectIds: [row.projectId],
                    workspaceId: row.workspaceId,
                    includeRemoved: queue.includeRemoved,
                  },
                  AbortSignal.any([signal, read.signal]),
                );
                signal.throwIfAborted();
                read.signal.throwIfAborted();
              } finally {
                preflightReads.delete(read);
              }
              const project = fresh.preflight.projects.find((item) => item.id === row.projectId);
              if (
                project === undefined ||
                project.blockers.length > 0 ||
                project.counts === null ||
                fresh.preflight.disk.freeBytes < fresh.preflight.disk.requiredBytes
              )
                throw new OperationUnavailableError(
                  "This project no longer passes the dry run. Resolve its problems before retrying.",
                );
              await options.setExportBudget(fresh.estimatedExportBytes);
              options.assertIdle(row.projectId);
              const identity = await options.identity(signal);
              if (
                identity === null ||
                identity.userId !== row.userId ||
                currentPerson()?.userId !== row.userId
              )
                throw new OperationUnavailableError("Sign in as the person who started the move.");
              const result = engine.enqueue({
                projectIds: [row.projectId],
                target: { ...identity, workspaceId: row.workspaceId },
                includeRemoved: queue.includeRemoved,
                stopAtFirstProblem: queue.stopAtFirstProblem,
              });
              await options.remember(result.moves[0]!, fresh.summaries[row.projectId]);
              schedule(result.queue.queueId);
              break;
            }
            case "re-arm":
              if (input.rearm === undefined || options.rearm === undefined)
                throw new OperationUnavailableError("Choose a paused Automation to re-arm.");
              {
                let accepted = false;
                try {
                  await options.rearm.perform(row, input.rearm);
                  accepted = true;
                } finally {
                  const key = row.userId + ":" + row.moveId;
                  const previous = rearmDetails.get(key)?.value;
                  const value =
                    previous === undefined
                      ? undefined
                      : !accepted
                        ? previous
                        : {
                            ...previous,
                            columns: previous.columns.filter(
                              (item) =>
                                input.rearm?.kind !== "column" ||
                                item.automationId !== input.rearm.automationId ||
                                item.status !== input.rearm.status,
                            ),
                            schedules: previous.schedules.filter(
                              (item) =>
                                input.rearm?.kind !== "schedule" ||
                                item.automationId !== input.rearm.automationId,
                            ),
                          };
                  rearmDetails.set(key, {
                    at: 0,
                    pending: false,
                    fresh: true,
                    ...(value === undefined ? {} : { value }),
                  });
                }
              }
              break;
            case "finish":
              if (row.state !== "checked" || row.report?.ok !== true)
                throw new OperationUnavailableError(
                  "Every move check must pass before you finish.",
                );
              await engine.confirm(row.moveId);
              break;
            case "open-cloud":
              await options.openCloud(row);
              break;
            case "roll-back": {
              options.assertIdle(row.projectId);
              const changed = rollback.get(row.moveId)?.requiresConfirmation === true;
              if (changed && input.confirmation !== view.projectName)
                throw new OperationUnavailableError(
                  "Type the project name to confirm losing the cloud changes.",
                );
              try {
                await engine.rollBack(row.moveId, { confirmChanged: changed, signal });
                rollback.delete(row.moveId);
              } catch (error) {
                const details = changedCloud(error);
                if (details !== null) rollback.set(row.moveId, details);
                throw new OperationUnavailableError(
                  details === null
                    ? "Could not roll the move back."
                    : "The cloud project changed. Check the changes and type its name to confirm.",
                );
              }
              break;
            }
            case "go-back":
              options.assertIdle(row.projectId);
              engine.journal.patch(row.moveId, { paused: null });
              try {
                await engine.goBackToLocal(row.moveId, signal);
              } catch (error) {
                if (engine.journal.move(row.moveId)?.state === "returning")
                  engine.journal.patch(row.moveId, {
                    paused: signInLost ? "signed_out" : "paused",
                  });
                throw error;
              }
              break;
            case "remove-local":
              throw new OperationUnavailableError("Local copy removal is not available.");
          }
          notify();
        }),
        "Couldn’t complete that move action. Check its progress or copy the report, then try again.",
      );
    },
    async report(id) {
      requireEnabled();
      const preview = prepared.get(id);
      if (preview !== undefined && preview.owner === (currentPerson()?.userId ?? null))
        return JSON.stringify(
          {
            kind: "dry-run",
            projects: preview.value.preflight.projects.map((project) => ({
              projectId: project.id,
              counts: project.counts,
              blocked: project.blockers.length,
              code: preview.value.failures[project.id] ?? null,
            })),
          },
          null,
          2,
        );
      const row = readMove(id);
      const view = await options.describe(row, engine.journal.queue(row.queueId)!);
      return JSON.stringify(
        {
          moveId: row.moveId,
          projectId: row.projectId,
          state: row.state,
          paused: row.paused,
          failure: row.failure?.code ?? null,
          checks: view.checks,
          counts: view.counts,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        },
        null,
        2,
      );
    },
    startWatching() {
      if (watching !== null || disposed || !options.enabled()) return;
      watching = options.account.subscribe(() => {
        contextEpoch += 1;
        contextRead = null;
        const person = currentPerson();
        if (active !== null && engine.journal.queue(active.queueId)?.userId !== person?.userId)
          active.controller.abort();
        const nextOwner = person?.userId ?? null;
        if (nextOwner !== accountOwner) {
          controlAbort?.abort();
          for (const read of preflightReads) read.abort();
        }
        accountOwner = nextOwner;
        void refreshContext()
          .then(() => service.resume())
          .then(notify)
          .catch(() => {
            if (!disposed) notify();
          });
      });
      timer = setInterval(() => {
        if (!options.enabled()) active?.controller.abort();
        if (active !== null) notify();
      }, 1000);
      timer.unref?.();
    },
    async resume() {
      requireEnabled();
      service.startWatching();
      for (const queue of engine.journal.runningQueues()) schedule(queue.queueId);
      for (const row of engine.journal.movesIn(["rolling_back"])) schedule(row.queueId);
      for (const row of engine.journal.movesIn(["returning"])) {
        if (!own(row)) continue;
        try {
          await service.command({ moveId: row.moveId, action: "go-back" });
        } catch {
          notify(); /* Each returning move keeps its own recovery action; continue the others. */
        }
      }
    },
    signInLost() {
      signInLost = true;
      contextEpoch += 1;
      contextRead = null;
      for (const read of preflightReads) read.abort();
      active?.controller.abort();
      controlAbort?.abort();
      for (const id of retryTimers.keys()) cancelRetry(id);
      pending.clear();
      notify();
    },
    async dispose() {
      disposed = true;
      options.disposeBackend?.();
      watching?.();
      watching = null;
      controlAbort?.abort();
      for (const read of preflightReads) read.abort();
      if (timer !== null) clearInterval(timer);
      for (const handle of retryTimers.values()) clearTimeout(handle);
      retryTimers.clear();
      pending.clear();
      const running = active;
      running?.controller.abort();
      const identityStopped = options.releaseIdentity?.();
      if (running !== null) await running.done;
      await controlLane;
      await identityStopped;
      listeners.clear();
      prepared.clear();
      rearmDetails.clear();
    },
  };
  return service;
}
