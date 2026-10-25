/**
 * The executor slot: every structured runtime this process can attach, keyed by
 * runtime id, and which one a Session runs on (VC-916).
 *
 * Pi is the only runtime that ships, so today the slot always holds exactly
 * one entry and it is the default. The map exists so a second runtime (a
 * Claude Agent SDK mode is the planned one) can register without reshaping the
 * Session runtime; it is groundwork, not a product choice. No caller picks a
 * runtime: there is no command, setting or UI for it, and `adapterId` stays a
 * field the runtime writes rather than one a caller supplies.
 *
 * **The runtime id is the adapter's own durable `id`.** It is what every
 * attachment records as `adapterId`, so the map is keyed by reading each
 * adapter rather than by a second string beside it that could drift — a
 * renamed key would orphan every attachment on disk that carries the old one.
 *
 * **Selection is per Session and persisted in its own ledger, once it has
 * attached.** A Session runs on the runtime named by its newest attachment —
 * opened, closed or failed — whose runtime this build registers. Every
 * attachment records that id durably, so a relaunch selects the same runtime
 * with no new field to keep in step. Before a registered runtime has attached
 * (a new Session, or one whose attachments all name a runtime this build does
 * not ship, such as a retired adapter or a terminal companion) a Session runs
 * on the slot's default. A replayed attach command keeps the runtime its
 * recorded `executor.start` intent names (see the Session runtime's attach).
 * Nothing yet records a choice before the first attach, so starting a Session
 * on a non-default runtime is not expressible.
 *
 * `terminal` is reserved: it is the adapter id of a terminal companion
 * attachment, which is never a structured runtime.
 */
import type { SessionAttachment } from "@volli/shared";
import type { NativeHarnessAdapter } from "./native-adapter";

/** A terminal companion attachment's adapter id; never a structured runtime's. */
const TERMINAL_ADAPTER_ID = "terminal";

export interface SessionExecutorSlot {
  /** Every runtime this process can attach, keyed by its adapter `id`. */
  readonly runtimes: ReadonlyMap<string, NativeHarnessAdapter>;
  /** The runtime a Session with no registered attachment runs on. */
  readonly defaultRuntime: NativeHarnessAdapter;
}

/**
 * The slot over a default runtime and any others. The default is registered
 * by construction, so a slot can never name a default it cannot attach; two
 * runtimes under one id are refused rather than letting the later one win.
 */
export function createSessionExecutorSlot(
  defaultRuntime: NativeHarnessAdapter,
  others: readonly NativeHarnessAdapter[] = [],
): SessionExecutorSlot {
  const runtimes = new Map<string, NativeHarnessAdapter>();
  for (const runtime of [defaultRuntime, ...others]) {
    if (runtime.id === TERMINAL_ADAPTER_ID) {
      throw new Error(`Executor slot cannot hold a runtime with the reserved id ${runtime.id}`);
    }
    if (runtimes.has(runtime.id)) {
      throw new Error(`Executor slot already holds a runtime with id ${runtime.id}`);
    }
    runtimes.set(runtime.id, runtime);
  }
  return { runtimes, defaultRuntime };
}

/**
 * The same slot with every runtime wrapped — a host decorating each executor
 * the same way, as its log correlation does. The default stays the default.
 */
export function mapSessionExecutorSlot(
  slot: SessionExecutorSlot,
  wrap: (runtime: NativeHarnessAdapter) => NativeHarnessAdapter,
): SessionExecutorSlot {
  return createSessionExecutorSlot(
    wrap(slot.defaultRuntime),
    [...slot.runtimes.values()]
      .filter((runtime) => runtime !== slot.defaultRuntime)
      .map((runtime) => wrap(runtime)),
  );
}

/**
 * The runtime this Session runs on: the one its newest registered attachment
 * names, else the slot's default. See the module comment for why that is the
 * persisted choice.
 */
export function selectSessionExecutor(
  slot: SessionExecutorSlot,
  projection: { readonly attachments: readonly Pick<SessionAttachment, "adapterId">[] },
): NativeHarnessAdapter {
  for (let index = projection.attachments.length - 1; index >= 0; index -= 1) {
    const runtime = slot.runtimes.get(projection.attachments[index]!.adapterId);
    if (runtime !== undefined) return runtime;
  }
  return slot.defaultRuntime;
}
