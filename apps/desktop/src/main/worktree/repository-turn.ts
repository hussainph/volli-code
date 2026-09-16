/**
 * The per-repository turn for worktree CHANGES (VC-389) — a queue, not a lease.
 *
 * This is a correctness guard rather than a load limit, and the two are worth
 * keeping apart: the bound in `git.ts` is about how many git children this
 * process runs at once, while this is about the order two of them may run in.
 * Git does not promise that concurrent `worktree add`, `remove` and `prune`
 * against ONE repository are safe, and names the race itself: its documentation
 * offers `worktree add --lock` as "the equivalent of `git worktree lock` after
 * `git worktree add`, but without a race condition". Underneath, git picks the
 * admin folder name under `$GIT_DIR/worktrees/` by finding a free name and then
 * creating it (`test-next`, then `test-next1` if taken) — find-then-create
 * between processes — and `prune` deletes admin records whose working directory
 * is missing, which is hostile to an `add` or a `remove` that is mid-flight.
 *
 * It is reachable in this app: `ensure()` is single-flight PER TICKET, not per
 * repository, so two tickets in one project could run `worktree add` and
 * `worktree prune` against the same repository at the same time.
 *
 * The key is the PROJECT PATH because every worktree change already passes it
 * as the working directory — `ensure.ts` (`projectPath`), `remove.ts`
 * (`project.path`), `cleanup.ts` (`gate.projectPath`) — so nothing has to run
 * `rev-parse --git-common-dir` to discover which repository it is about. It is
 * canonicalized, so two spellings of one checkout cannot become two queues.
 *
 * Contenders WAIT IN LINE; they are never refused. That is the opposite of the
 * nearest existing pattern, and deliberately so: the deletion lease in
 * `deletion-lease.ts` answers `null` and its caller skips, because a directory
 * something else is destroying is not one this act should also be destroying.
 * Here the contender is a Session start, and refusing it would fail the start
 * outright whenever another start happened to be mid-`worktree add` in the same
 * project. Waiting costs a moment; skipping costs the user their Session.
 *
 * Two shapes of the callback matter to callers:
 *
 *  - A SYNCHRONOUS change runs as one uninterrupted unit. `cleanup.ts` relies
 *    on this: its final safety gate and the irreversible mutation that follows
 *    are passed in together precisely because nothing may `await` between the
 *    gate's answer and the removal.
 *  - An IDLE repository runs the change in the CALLER'S OWN TURN, before this
 *    function returns. So taking the turn costs a Session start nothing when it
 *    is the only one changing that repository, and it does not insert a
 *    microtask between a caller's own decision and its mutation.
 *
 *    "Idle" is settled one microtask LATE, and it is worth knowing which way:
 *    a repository's entry is dropped after the previous caller's `await` has
 *    already resumed, so a successor arriving in that same tick finds the entry
 *    and queues instead of running inline. It is still ordered — only the fast
 *    path is missed — and no caller's gate is ever split, because the gate and
 *    the mutation travel together inside one callback either way.
 *
 * A change that throws or rejects belongs to its own caller and does not wedge
 * the repository: the next change in line still gets its turn.
 *
 * TWO OBLIGATIONS ON THE CALLER, because neither can be checked here:
 *
 *  - A change must NOT take the same repository's turn again from inside
 *    itself. It would wait on a tail that only settles when it does, which is
 *    a deadlock with no deadline to break it. Every mutation today takes the
 *    turn at exactly one depth, and `remove.ts` takes it three times in one
 *    call only because those three are mutually exclusive branches. A caller
 *    that wants to wrap a whole `remove()` or `ensure()` must not wrap it in
 *    this.
 *  - A change must be BOUNDED. Waiting here has no deadline, so an unbounded
 *    change stops every Session start in that project for as long as it runs.
 *    Today that holds because every change is git under a runner deadline
 *    (`GIT_COMMAND_TIMEOUT_MS`, worst case a prune-add-prune-add retry).
 *    A change with no deadline of its own does not belong in here.
 *
 * The word is CONTEXT.md's. A Tab hold is "one party's turn to drive" a shared
 * thing, and that entry tells us to avoid `lock` and `lease` for exactly this
 * shape — so a repository's turn is the house word for it, not a new one.
 *
 * Deliberately process-local, exactly like `deletion-lease.ts`. It makes no
 * promise against a second Volli install or the user's own terminal running
 * `git worktree prune` — inside this process, one queue per repository is the
 * whole ordering the race needs.
 */
import { canonicalize } from "./paths";

interface RepositoryQueue {
  /** Resolves when the last change asked for so far has settled, either way. */
  tail: Promise<void>;
  /** Changes asked for and not yet settled; at zero the queue is forgotten. */
  pending: number;
}

const queues = new Map<string, RepositoryQueue>();

/**
 * Runs `change` when this repository's turn comes, and answers with its result.
 *
 * Callers pass the change as a callback rather than acquiring a handle so that
 * the critical section is a function: there is no way to take the turn and
 * forget to give it back, and a synchronous body cannot be split by an `await`
 * somebody adds later.
 */
export function withRepositoryWorktreeTurn<T>(
  projectPath: string,
  change: () => T | Promise<T>,
): Promise<T> {
  const key = canonicalize(projectPath);
  const queued = queues.get(key);
  const queue: RepositoryQueue = queued ?? { tail: Promise.resolve(), pending: 0 };
  if (queued === undefined) queues.set(key, queue);
  queue.pending += 1;

  // Nothing is changing this repository, so this change runs HERE, in the
  // caller's own turn. Chaining it onto an already-resolved `tail` would be
  // simpler by one branch and would cost every uncontended Session start a
  // microtask between its decision and its mutation — which is the one thing
  // `cleanup.ts`'s gate discipline asks not to happen.
  const run = queued === undefined ? runNow(change) : queue.tail.then(change);
  // `tail` never rejects: a failed change is its own caller's business, and the
  // change behind it in line must still get a turn.
  queue.tail = run.then(ignore, ignore);
  void queue.tail.then(() => release(key, queue));
  return run;
}

/** Invokes the change immediately, with a synchronous throw folded into the promise. */
function runNow<T>(change: () => T | Promise<T>): Promise<T> {
  try {
    return Promise.resolve(change());
  } catch (thrown) {
    return Promise.reject(thrown);
  }
}

/** Discards a settled change's outcome, so `tail` carries neither value nor rejection. */
const ignore = (): void => undefined;

/**
 * Forgets a repository once nothing is queued for it, so a long session does
 * not accumulate one entry per project it ever touched. The identity check is
 * what makes it safe: a caller that arrived after this change settled has
 * already replaced the entry, and that queue is still in use.
 */
function release(key: string, queue: RepositoryQueue): void {
  queue.pending -= 1;
  if (queue.pending === 0 && queues.get(key) === queue) queues.delete(key);
}

/** Test seam: drops every queue, so one test's leak cannot hang the next. */
export function resetRepositoryTurnsForTest(): void {
  queues.clear();
}
