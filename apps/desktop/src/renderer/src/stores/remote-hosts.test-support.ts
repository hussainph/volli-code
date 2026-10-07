/**
 * A scripted {@link RemoteHostsApi} for tests and the lab (VC-700 PR 3): it
 * records every call, lets the caller push flow events as desktop main would,
 * and answers `devices` from a table and `addFacts` with the facts of the
 * last view pushed (a {@link flowView}'s `facts`). Nothing here talks to main.
 */
import type {
  AddHostEvent,
  AddHostFacts,
  AddHostStepId,
  CreateRemoteProjectInput,
  CreateRemoteProjectResult,
  RemoteHost,
  RemoteHostDevice,
  RemoteHostProjects,
} from "@volli/shared";

import { NO_FACTS, type AddHostFlowView } from "@renderer/components/hosts/add-host-model";

import type { RemoteHostsApi } from "./remote-hosts";

export { NO_FACTS };

export type FakeCall =
  | readonly ["startAdd", string]
  /** The flow, the answer's kind, and the question it named. */
  | readonly ["answerAdd", string, string, string]
  /** The flow, the password, and the question it named. */
  | readonly ["sudoPassword", string, string, string]
  | readonly ["retryAdd", string, AddHostStepId | undefined]
  | readonly ["cancelAdd", string]
  | readonly ["rename", string, string]
  | readonly ["forget", string]
  | readonly ["devices", string]
  | readonly ["projects", string]
  | readonly ["createProject", CreateRemoteProjectInput]
  | readonly ["openWorkspace", string, string]
  | readonly ["closeWorkspace", string, string];

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
  /** What `addFacts` answers next for a flow, over the last view's; or a refusal. */
  factsOf: Map<string, AddHostFacts | Error>;
  /** What `devices(hostId)` answers: a list, or a refusal. */
  devicesOf: Map<string, readonly RemoteHostDevice[] | Error>;
  /** What `projects(hostId)` answers (VC-710): a listing, or a refusal; none listed, ready. */
  projectsOf: Map<string, Omit<RemoteHostProjects, "hostId"> | Error>;
  /** What `createProject` answers next: a result, or a refusal; by default the project it names, made. */
  nextCreate: CreateRemoteProjectResult | Error | null;
  /** Makes the next call of `method` refuse with `message`. */
  refuseNext(
    method:
      | "answerAdd"
      | "sudoPassword"
      | "retryAdd"
      | "rename"
      | "forget"
      | "openWorkspace"
      | "closeWorkspace",
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
  /** Each flow's facts, from the last view pushed that carried some. */
  const found = new Map<string, AddHostFacts>();
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
    projectsOf: new Map(),
    nextCreate: null,
    factsOf: new Map(),
    emit(flowId, event) {
      if (event.kind !== "log" && "facts" in event.view) {
        found.set(flowId, (event.view as AddHostFlowView).facts);
      }
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
    answerAdd(flowId, questionId, answer) {
      calls.push(["answerAdd", flowId, answer.kind, questionId]);
      return settle("answerAdd");
    },
    sudoPassword(flowId, questionId, password) {
      calls.push(["sudoPassword", flowId, password, questionId]);
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
    addFacts(flowId) {
      const answer = api.factsOf.get(flowId) ?? found.get(flowId) ?? NO_FACTS;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
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
    projects(hostId) {
      calls.push(["projects", hostId]);
      const answer = api.projectsOf.get(hostId) ?? { projects: [], adds: { kind: "ready" } };
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve({ hostId, ...answer });
    },
    async createProject(input) {
      calls.push(["createProject", input]);
      const next = api.nextCreate;
      if (next instanceof Error) throw next;
      return (
        next ?? {
          ok: true,
          created: true,
          project: {
            id: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b",
            name: "Acme",
            prefix: "AC",
            path: "/srv/volli/acme",
            tickets: 0,
          },
        }
      );
    },
    openWorkspace(hostId, workspaceId) {
      calls.push(["openWorkspace", hostId, workspaceId]);
      return settle("openWorkspace");
    },
    closeWorkspace(hostId, workspaceId) {
      calls.push(["closeWorkspace", hostId, workspaceId]);
      return settle("closeWorkspace");
    },
  };
  return api;
}

const STEP_IDS = ["connect", "probe", "deliver", "install", "start", "enroll", "link"] as const;

/**
 * An add flow's view, every step pending unless `done` / `at` say otherwise,
 * with the facts the fake's `addFacts` will answer for it.
 */
export function flowView(
  patch: Partial<AddHostFlowView> & { done?: number; at?: AddHostStepId } = {},
): AddHostFlowView {
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
    facts: NO_FACTS,
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
    system: null,
    arch: null,
    hostKeys: [],
    ...patch,
  };
}
