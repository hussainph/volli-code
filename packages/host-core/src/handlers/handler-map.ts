/**
 * The host's handler map as a door may invoke it: policy first, always
 * (VC-668; HP § Command catalog, "One handler map").
 *
 * {@link createHostHandlers} hands a composition root a {@link HostHandlerMap}:
 * a sealed object with no callable entries. The one way to reach an entry is
 * {@link invokeHandler} (or the {@link admittedHandlers} view built on it),
 * and both take the door's {@link HandlerPolicy}. The policy answers before
 * the handler is touched; a refusal throws {@link HandlerRefusedError} and the
 * handler never runs. So "every command goes through the one map plus the
 * policy middleware" (D-A1) is the only path the type offers, not a
 * convention a new door must remember.
 *
 * Transport-independent: a policy judges a catalog key, the input and the
 * {@link HandlerCall} the door authenticated. No tRPC, no Electron, no socket
 * envelope. Each door brings its own policy (`./policies` for the catalog's
 * doors, the agent socket's coordination policy in `agent-dispatch`), so a
 * door's rules stay its own: the router's person-only `ticket.move` does not
 * deny a Session the socket's coordination policy admits.
 *
 * A synchronous policy over a synchronous handler answers synchronously, so
 * the desktop window's legacy channels keep their synchronous replies.
 *
 * `sealHostHandlers` is for {@link createHostHandlers} and test support only;
 * `package-interface.test.ts` refuses any other production importer.
 */
import { HandlerRefusedError, type HandlerCall, type HostHandlerKey } from "@volli/shared";

import type { HostHandlers } from "./host-handlers";

/** What a door's policy answers about one call, before its handler runs. */
export type AdmissionVerdict = HandlerAdmitted | HandlerRefusal;

export interface HandlerAdmitted {
  readonly admitted: true;
}

export interface HandlerRefusal {
  readonly admitted: false;
  /** The caller's message: what was refused and why. */
  readonly message: string;
  /** What the caller can do about it, when the policy knows. */
  readonly hint?: string | null;
}

/** The one admitted verdict. */
export const ADMITTED: HandlerAdmitted = Object.freeze({ admitted: true });

/** A refusal, for a policy to return. */
export function refused(message: string, hint: string | null = null): HandlerRefusal {
  return { admitted: false, message, hint };
}

/**
 * A door's policy at the map's boundary. It reads only what every door has:
 * the key, the input the door decoded, and who the door authenticated.
 */
export interface HandlerPolicy {
  /** Which door judges: recorded with every verdict. */
  readonly door: string;
  admit(
    key: HostHandlerKey,
    input: unknown,
    call: HandlerCall,
  ): AdmissionVerdict | PromiseLike<AdmissionVerdict>;
}

/** One verdict, as an {@link AdmissionObserver} sees it: before the handler runs, or instead of it. */
export interface AdmissionRecord {
  readonly door: string;
  readonly key: HostHandlerKey;
  readonly admitted: boolean;
}

/** Sees every verdict the map's policies give, in order with the handlers they admit. */
export type AdmissionObserver = (record: AdmissionRecord) => void;

declare const SEALED: unique symbol;

/**
 * The host's one handler map, sealed: it has no entry a door can call. Hand
 * it to {@link invokeHandler} or {@link admittedHandlers} with a policy.
 */
export interface HostHandlerMap {
  readonly [SEALED]: "HostHandlerMap";
}

interface Sealed {
  readonly entries: HostHandlers;
  readonly observe: AdmissionObserver | undefined;
}

const sealedMaps = new WeakMap<HostHandlerMap, Sealed>();

/** Seals a map's entries behind policy. For `createHostHandlers` and test support only. */
export function sealHostHandlers(
  entries: HostHandlers,
  observe?: AdmissionObserver,
): HostHandlerMap {
  const map = Object.freeze(Object.create(null) as object) as HostHandlerMap;
  sealedMaps.set(map, { entries, observe });
  return map;
}

/** Whether `value` is a map {@link sealHostHandlers} sealed: what a door checks it was handed. */
export function isHostHandlerMap(value: unknown): value is HostHandlerMap {
  return typeof value === "object" && value !== null && sealedMaps.has(value as HostHandlerMap);
}

function opened(map: HostHandlerMap): Sealed {
  const sealed = sealedMaps.get(map);
  if (sealed === undefined)
    throw new Error("Not a host handler map: build one with createHostHandlers.");
  return sealed;
}

function isPromiseLike<Value>(value: Value | PromiseLike<Value>): value is PromiseLike<Value> {
  return typeof (value as Partial<PromiseLike<Value>> | null)?.then === "function";
}

type EntryArgs<Key extends HostHandlerKey> = Parameters<HostHandlers[Key]>;
type EntryResult<Key extends HostHandlerKey> = ReturnType<HostHandlers[Key]>;

/**
 * Runs `policy` on the call, then, only if it admitted, `handlers[key]`. A
 * refusal throws {@link HandlerRefusedError} and the handler is not reached.
 * Synchronous when the policy's verdict and the handler both are.
 */
export function invokeHandler<Key extends HostHandlerKey>(
  map: HostHandlerMap,
  policy: HandlerPolicy,
  key: Key,
  ...args: EntryArgs<Key>
): EntryResult<Key> {
  const { entries, observe } = opened(map);
  const handler = entries[key] as unknown as (...args: EntryArgs<Key>) => EntryResult<Key>;
  if (typeof handler !== "function") throw new Error(`The handler map has no ${key}.`);
  const [input, call] = args as unknown as [unknown, HandlerCall];
  const proceed = (verdict: AdmissionVerdict): EntryResult<Key> => {
    observe?.({ door: policy.door, key, admitted: verdict.admitted });
    if (!verdict.admitted) throw new HandlerRefusedError(verdict.message, verdict.hint ?? null);
    return handler(...args);
  };
  const verdict = policy.admit(key, input, call);
  if (!isPromiseLike(verdict)) return proceed(verdict);
  return Promise.resolve(verdict).then((settled): unknown => proceed(settled)) as EntryResult<Key>;
}

/**
 * The map as one door projects it: every entry callable, every call through
 * `policy` first. A router's context takes this view, so `ctx.handlers[key]`
 * is admitted at the map as well as by the router's own middleware.
 */
export function admittedHandlers(map: HostHandlerMap, policy: HandlerPolicy): HostHandlers {
  const { entries } = opened(map);
  const view: Record<string, unknown> = {};
  for (const key of Object.keys(entries) as HostHandlerKey[]) {
    view[key] = (...args: EntryArgs<typeof key>) => invokeHandler(map, policy, key, ...args);
  }
  return Object.freeze(view) as unknown as HostHandlers;
}
