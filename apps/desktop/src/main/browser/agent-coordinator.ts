import { BrowserTabController, type CdpTransport, type TabCursorDriver } from "./cdp-controller";

/**
 * The host-owned state behind Browser tool calls on one tab.
 *
 * Calls from every Session share one queue and one Electron debugger transport,
 * while each attachment keeps its own controller and ref map. That preserves
 * Session-local snapshot refs without allowing one port to detach a debugger
 * another port is still using.
 */
interface BrowserTabAgentState {
  tail: Promise<void>;
  busy: number;
  transport: CdpTransport | null;
  controllers: Map<string, BrowserTabController>;
  owners: Set<string>;
  workByOwner: Map<string, Set<Promise<unknown>>>;
}

export interface BrowserAgentControllerFactory {
  transport: () => CdpTransport;
  cursor?: TabCursorDriver;
}

export interface BrowserAgentOperationContext {
  /** Lazily attaches CDP. Navigation and hold-only work does not need it. */
  controller(): Promise<BrowserTabController>;
}

function settled(promise: Promise<unknown>): Promise<void> {
  return promise.then(
    () => undefined,
    () => undefined,
  );
}

/**
 * Coordinates all agent work through the Browser host rather than one Session
 * port. Different tabs remain parallel. Work on one tab is strictly ordered.
 */
export class BrowserAgentCoordinator {
  readonly #tabs = new Map<string, BrowserTabAgentState>();

  #state(tabId: string): BrowserTabAgentState {
    let state = this.#tabs.get(tabId);
    if (state === undefined) {
      state = {
        tail: Promise.resolve(),
        busy: 0,
        transport: null,
        controllers: new Map(),
        owners: new Set(),
        workByOwner: new Map(),
      };
      this.#tabs.set(tabId, state);
    }
    return state;
  }

  async #controller(
    state: BrowserTabAgentState,
    owner: string,
    factory: BrowserAgentControllerFactory,
    signal: AbortSignal,
  ): Promise<BrowserTabController> {
    const existing = state.controllers.get(owner);
    if (existing !== undefined) return existing;

    const transport = (state.transport ??= factory.transport());
    // Controllers own Session-local refs, but the coordinator owns the shared
    // debugger transport. A controller disposal must therefore clear only its
    // own refs and must never detach the shared wire.
    const ensureReady = transport.ensureReady;
    const controller = new BrowserTabController(
      {
        send: async (method, params) => await transport.send(method, params),
        ...(ensureReady === undefined ? {} : { ensureReady: async () => await ensureReady() }),
      },
      {},
      factory.cursor,
    );
    try {
      await controller.enable(signal);
      signal.throwIfAborted();
    } catch (error) {
      controller.dispose();
      // A failed first enable may still have attached the debugger. No live
      // controller can use that wire, so hand it back now rather than keeping
      // it until an unrelated attachment teardown.
      if (state.controllers.size === 0) {
        transport.dispose?.();
        state.transport = null;
      }
      throw error;
    }
    state.controllers.set(owner, controller);
    return controller;
  }

  /**
   * Runs one operation in the tab's host-wide queue.
   *
   * A queued withdrawal rejects at once and the queued function never runs.
   * Once work starts, its answer settles only after the operation settles. This
   * distinction lets CDP finish a best-effort key-up or mouse-up before the
   * caller ends the turn and releases the tab or debugger.
   */
  run<T>(input: {
    tabId: string;
    owner: string;
    signal: AbortSignal;
    factory: BrowserAgentControllerFactory;
    operation: (context: BrowserAgentOperationContext) => Promise<T>;
  }): Promise<T> {
    input.signal.throwIfAborted();
    const state = this.#state(input.tabId);
    state.owners.add(input.owner);
    let ownerWork = state.workByOwner.get(input.owner);
    if (ownerWork === undefined) {
      ownerWork = new Set();
      state.workByOwner.set(input.owner, ownerWork);
    }

    const previous = state.tail;
    let started = false;
    state.busy += 1;
    const work = previous
      .then(async () => {
        input.signal.throwIfAborted();
        started = true;
        return await input.operation({
          controller: async () =>
            await this.#controller(state, input.owner, input.factory, input.signal),
        });
      })
      .finally(() => {
        state.busy -= 1;
      });
    const tail = settled(work);
    state.tail = tail;
    ownerWork.add(work);
    void tail.then(() => {
      ownerWork?.delete(work);
      if (ownerWork?.size === 0) state.workByOwner.delete(input.owner);
    });

    return new Promise<T>((resolve, reject) => {
      let answered = false;
      const finish = (answer: () => void): void => {
        if (answered) return;
        answered = true;
        input.signal.removeEventListener("abort", withdrawn);
        answer();
      };
      const withdrawn = (): void => {
        // Active work owns any input cleanup and therefore owns when its
        // answer settles. Only work still waiting in the queue exits now.
        if (!started) finish(() => reject(input.signal.reason));
      };
      input.signal.addEventListener("abort", withdrawn, { once: true });
      if (input.signal.aborted) withdrawn();
      work.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }

  /** Adds a lifecycle step behind every operation already queued for one tab. */
  afterCurrent(tabId: string, step: () => void): void {
    const state = this.#tabs.get(tabId);
    if (state === undefined || state.busy === 0) {
      step();
      return;
    }
    state.busy += 1;
    const barrier = state.tail.then(step, step).finally(() => {
      state.busy -= 1;
    });
    state.tail = settled(barrier);
  }

  /**
   * Releases one attachment's controllers after all of its internal work,
   * including input cleanup, has settled. The shared debugger is detached only
   * after the last attachment leaves the tab.
   */
  releaseOwner(owner: string, released: () => void): void {
    const owned = [...this.#tabs].filter(([, state]) => state.owners.has(owner));
    const current = owned.flatMap(([, state]) => [...(state.workByOwner.get(owner) ?? [])]);
    const finish = (): void => {
      for (const [tabId, state] of owned) {
        state.controllers.get(owner)?.dispose();
        state.controllers.delete(owner);
        state.owners.delete(owner);
        if (state.owners.size === 0) {
          state.transport?.dispose?.();
          state.transport = null;
          this.#tabs.delete(tabId);
        }
      }
      released();
    };
    if (current.length === 0) {
      finish();
      return;
    }
    void Promise.allSettled(current).then(finish);
  }

  /** Forgets all host-owned tooling state when the native tab closes. */
  closeTab(tabId: string): void {
    const state = this.#tabs.get(tabId);
    if (state === undefined) return;
    this.#tabs.delete(tabId);
    for (const controller of state.controllers.values()) controller.dispose();
    state.controllers.clear();
    state.owners.clear();
    state.transport?.dispose?.();
    state.transport = null;
  }

  /** Tears down every tab when the Browser host closes. */
  dispose(): void {
    for (const tabId of this.#tabs.keys()) this.closeTab(tabId);
  }
}
