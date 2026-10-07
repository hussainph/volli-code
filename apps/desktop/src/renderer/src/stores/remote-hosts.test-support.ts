/**
 * A scripted {@link RemoteHostsApi} for tests and the lab (VC-700 PR 3): it
 * records every call, lets the caller push flow events as desktop main would,
 * and answers `devices` from a table. Nothing here talks to main.
 */
import type {
  AddHostEvent,
  AddHostStepId,
  AddHostView,
  RemoteHost,
  RemoteHostDevice,
} from "@volli/shared";

import type { RemoteHostsApi } from "./remote-hosts";

export type FakeCall =
  | readonly ["startAdd", string]
  | readonly ["answerAdd", string, string]
  | readonly ["sudoPassword", string, string]
  | readonly ["retryAdd", string, AddHostStepId | undefined]
  | readonly ["cancelAdd", string]
  | readonly ["rename", string, string]
  | readonly ["forget", string]
  | readonly ["devices", string];

export interface FakeRemoteHostsApi extends RemoteHostsApi {
  readonly calls: FakeCall[];
  /** Sends an event to every subscriber of `flowId`. */
  emit(flowId: string, event: AddHostEvent): void;
  /** Whether anything still follows `flowId`. */
  following(flowId: string): boolean;
  /** Ends `flowId`'s subscriptions with an error. */
  fail(flowId: string): void;
  /** What `startAdd` answers next: a flow id, or a refusal. */
  nextStart: { flowId: string } | Error;
  /** What `devices(hostId)` answers: a list, or a refusal. */
  devicesOf: Map<string, readonly RemoteHostDevice[] | Error>;
  /** Makes the next call of `method` refuse with `message`. */
  refuseNext(
    method: "answerAdd" | "sudoPassword" | "retryAdd" | "rename" | "forget",
    message: string,
  ): void;
}

export function createFakeRemoteHostsApi(): FakeRemoteHostsApi {
  const subscribers = new Map<
    string,
    Set<{ onEvent(event: AddHostEvent): void; onError(error: unknown): void }>
  >();
  const refusals = new Map<string, string>();
  const calls: FakeCall[] = [];
  const settle = (method: string): Promise<null> => {
    const message = refusals.get(method);
    if (message === undefined) return Promise.resolve(null);
    refusals.delete(method);
    return Promise.reject(new Error(message));
  };
  const api: FakeRemoteHostsApi = {
    calls,
    nextStart: { flowId: "flow-1" },
    devicesOf: new Map(),
    emit(flowId, event) {
      for (const handlers of subscribers.get(flowId) ?? []) handlers.onEvent(event);
    },
    following: (flowId) => (subscribers.get(flowId)?.size ?? 0) > 0,
    fail(flowId) {
      for (const handlers of subscribers.get(flowId) ?? [])
        handlers.onError(new Error("stream ended"));
      subscribers.delete(flowId);
    },
    refuseNext(method, message) {
      refusals.set(method, message);
    },
    startAdd(input) {
      calls.push(["startAdd", input.target]);
      const next = api.nextStart;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    subscribeAdd(flowId, handlers) {
      const set = subscribers.get(flowId) ?? new Set();
      set.add(handlers);
      subscribers.set(flowId, set);
      return () => set.delete(handlers);
    },
    answerAdd(flowId, answer) {
      calls.push(["answerAdd", flowId, answer.kind]);
      return settle("answerAdd");
    },
    sudoPassword(flowId, password) {
      calls.push(["sudoPassword", flowId, password]);
      return settle("sudoPassword");
    },
    retryAdd(flowId, from) {
      calls.push(["retryAdd", flowId, from]);
      return settle("retryAdd");
    },
    cancelAdd(flowId) {
      calls.push(["cancelAdd", flowId]);
      return Promise.resolve(null);
    },
    rename(hostId, name) {
      calls.push(["rename", hostId, name]);
      return settle("rename");
    },
    forget(hostId) {
      calls.push(["forget", hostId]);
      return settle("forget");
    },
    devices(hostId) {
      calls.push(["devices", hostId]);
      const answer = api.devicesOf.get(hostId) ?? [];
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve({ hostId, devices: answer });
    },
  };
  return api;
}

const STEP_IDS = ["connect", "probe", "deliver", "install", "start", "enroll", "link"] as const;

/** An add flow's view, every step pending unless `done` / `at` say otherwise. */
export function flowView(
  patch: Partial<AddHostView> & { done?: number; at?: AddHostStepId } = {},
): AddHostView {
  const { done = 0, at, ...rest } = patch;
  return {
    flowId: "flow-1",
    target: "deploy@box",
    name: "deploy@box",
    status: "running",
    steps: STEP_IDS.map((id, index) => ({
      id,
      status: index < done ? "done" : id === at ? "running" : "pending",
    })),
    question: null,
    failure: null,
    hostId: null,
    startup: null,
    ...rest,
  };
}

/** A remote host's registry record. */
export function registryHost(patch: Partial<RemoteHost> = {}): RemoteHost {
  return {
    id: "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f",
    name: "deploy@box",
    target: "deploy@box",
    transport: "ssh-tunnel",
    os: "linux",
    mode: "system",
    agentsShareAccount: false,
    version: "1.1.0",
    availableUpdate: null,
    hostIsNewer: false,
    deviceId: "1f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f",
    addedAt: "2026-10-07T00:00:00.000Z",
    liveSessions: null,
    ...patch,
  };
}
