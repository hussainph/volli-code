/**
 * The desktop-only tier's policy, judged by the router the same way over both
 * links (VC-608): the generic IPC bridge and a real WebSocket, one set of
 * cases (`describeContract`), no procedure list of their own.
 */
import type { TRPCClient } from "@trpc/client";
import {
  describeContract,
  expectHostError,
  ipcContractLink,
  webSocketContractLink,
} from "@volli/host-protocol/testing";
import {
  HOST_LINK_RELAY_PATH_MAX,
  OperationUnavailableError,
  REMOTE_HOST_DEVICE_TEXT_MAX,
  REMOTE_HOST_DEVICES_MAX,
  REMOTE_HOST_NAME_MAX,
  REMOTE_HOST_PROJECT_TEXT_MAX,
  REMOTE_HOST_PROJECTS_MAX,
  REMOTE_HOST_UPDATE_UNAVAILABLE,
  REMOTE_PROJECT_FAILURE_TEXT_MAX,
  MAX_ACTIVE_ADD_HOSTS,
  type ActiveAddHost,
  type CreateRemoteProjectResult,
  type RemoteHostProjects,
  type AddHostEvent,
  type AddHostFacts,
  type HandlerCall,
  type RemoteHostDevices,
  type RemoteHostsSnapshot,
  type WorktreeTrimSettings,
} from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { LOCAL_DESKTOP_CALLER, type RouterCaller } from "./catalog";
import {
  createDesktopRouter,
  DESKTOP_STREAM_CAPACITY,
  DESKTOP_STREAM_OVERFLOW_MESSAGE,
  DESKTOP_STREAM_SOURCE_FAILURE_MESSAGE,
  desktopProcedureSchemas,
  hostLinkRelayEventSchema,
  type DesktopRouter,
  type DesktopRouterContext,
  type DesktopRouterHandlers,
  type DesktopStreamSink,
} from "./desktop-router";
import { RpcDiagnosticLog } from "./index";
import {
  activeAddHostsSchema,
  addHostEventSchema,
  addHostFactsSchema,
  createProjectResultSchema,
  MAX_GRANTED_FEATURE_LENGTH,
  MAX_GRANTED_FEATURES,
  remoteHostDevicesSchema,
  remoteHostProjectsSchema,
  remoteHostsSnapshotSchema,
} from "./remote-hosts-schema";

const WORKSPACE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const SIGN_IN_STATUS = {
  providers: [{ providerId: "xai", label: "xAI", state: "missing", kind: null, methods: [] }],
  git: [],
} as const;
const TRIM: WorktreeTrimSettings = { keepPatterns: [".env"], trimOnFinish: true };
const HOST = "0b9e6c1a-2d3f-4a5b-8c7d-6e5f4a3b2c1d";
const FLOW = "flow-1";
/** A password no diagnostic, error or log may ever carry. */
const PASSWORD = "correct-horse-battery-staple-7f3a";

const SNAPSHOT: RemoteHostsSnapshot = {
  v: 1,
  hosts: [
    {
      id: HOST,
      name: "Build box",
      target: "you@box:2222",
      transport: "ssh-tunnel",
      os: "linux",
      mode: "user",
      agentsShareAccount: true,
      version: "0.9.0",
      availableUpdate: "0.9.1",
      hostIsNewer: false,
      deviceId: "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b",
      addedAt: "2026-10-06T00:00:00.000Z",
      liveSessions: null,
      system: "Ubuntu 24.04.1 LTS",
      arch: "x86-64",
      hostKeys: ["SHA256:abc"],
    },
  ],
  projects: {
    "project-1": {
      hostId: HOST,
      link: {
        status: "unreachable",
        attempt: 2,
        error: { code: "SERVICE_UNAVAILABLE", reason: "host-unreachable", message: "down" },
        closeCode: null,
        retryAt: 1_000,
      },
    },
    "project-2": { hostId: HOST, link: { status: "connecting", attempt: 1 } },
  },
  readOnly: null,
};
const NEXT: RemoteHostsSnapshot = {
  v: 1,
  hosts: [],
  projects: {},
  readOnly: "This Mac’s hosts file is from a newer Volli.",
};

const DEVICES: RemoteHostDevices = {
  hostId: HOST,
  devices: [
    {
      deviceId: "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b",
      name: "Alice's Mac",
      fingerprint: "SHA256:mac",
      enrolledAt: "2026-10-06T00:00:00.000Z",
      via: "ssh",
      revokedAt: null,
      thisMac: true,
    },
    {
      deviceId: "8e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b",
      name: "Old laptop",
      fingerprint: "SHA256:old",
      enrolledAt: "2026-09-01T00:00:00.000Z",
      via: "ssh",
      revokedAt: "2026-09-02T00:00:00.000Z",
      thisMac: false,
    },
  ],
};
const PROJECTS: RemoteHostProjects = {
  hostId: HOST,
  projects: [{ id: WORKSPACE, name: "Acme", prefix: "AC", path: "/srv/volli/acme", tickets: 2 }],
  adds: { kind: "needs-operator", command: "sudo volli-hostd operator-token --for 'you'" },
};
const CREATED: CreateRemoteProjectResult = {
  ok: true,
  created: true,
  project: PROJECTS.projects[0]!,
};
const VIEW: Extract<AddHostEvent, { kind: "view" }> = {
  kind: "view",
  view: {
    flowId: FLOW,
    target: "you@box",
    name: "you@box",
    status: "question",
    steps: [
      { id: "connect", status: "running" },
      { id: "probe", status: "pending" },
    ],
    question: {
      id: "q1",
      kind: "host-key",
      step: "connect",
      fingerprints: ["SHA256:abc", "SHA256:def"],
      detail: { algorithm: "ed25519", port: 2222, known: false, previous: null },
    },
    failure: null,
    hostId: null,
    startup: null,
  },
};
const FACTS: AddHostFacts = {
  user: "you",
  os: "linux",
  system: "Ubuntu 24.04.1 LTS",
  arch: "x86-64",
  memoryBytes: 8 * 1024 ** 3,
  version: null,
  keepsRunning: null,
  alreadyPaired: false,
};
/** The add flows main still owns (VC-720): the newest first, views elsewhere. */
const ACTIVE: readonly ActiveAddHost[] = [
  { flowId: "flow-2", target: "you@other:2222", name: "Other box", status: "running" },
  { flowId: FLOW, target: "you@box", name: "you@box", status: "question" },
];
const FAILED: AddHostEvent = {
  kind: "view",
  view: {
    ...VIEW.view,
    status: "failed",
    question: null,
    failure: {
      code: "install-failed",
      step: "install",
      line: "Installing failed.",
      recovery: { action: "retry", label: "Retry", from: "install" },
      detail: "journal tail",
    },
  },
} as AddHostEvent;
const LOG: AddHostEvent = {
  kind: "log",
  flowId: FLOW,
  line: {
    at: "2026-10-06T00:00:01.000Z",
    level: "info",
    message: "probed",
    fields: { os: "linux", port: 22, sudo: true, version: null },
  },
};

type Recorded = { key: string; input: unknown; call: HandlerCall };

interface Host {
  readonly caller: RouterCaller;
  readonly calls: Recorded[];
  readonly diagnostics: RpcDiagnosticLog;
  /** Each open stream's sink, by key, and how many times a stream was closed. */
  readonly sinks: Map<string, DesktopStreamSink<unknown>>;
  readonly unsubscribed: string[];
  readonly overrides: Partial<DesktopRouterHandlers>;
}

function host(caller: RouterCaller, overrides: Partial<DesktopRouterHandlers> = {}): Host {
  return {
    caller,
    calls: [],
    diagnostics: new RpcDiagnosticLog(),
    sinks: new Map(),
    unsubscribed: [],
    overrides,
  };
}

/** Every handler the slice names, recording what it was called with. */
function recordingHandlers(fixture: Host): DesktopRouterHandlers {
  const record =
    <Output>(key: string, output: Output) =>
    (input: unknown, call: HandlerCall): Output => {
      fixture.calls.push({ key, input, call });
      return output;
    };
  const stream =
    <Emission>(key: string, first: Emission) =>
    async (input: unknown, call: HandlerCall, sink: DesktopStreamSink<Emission>) => {
      fixture.calls.push({ key, input, call });
      fixture.sinks.set(key, sink as DesktopStreamSink<unknown>);
      await sink.emit(first);
      return () => void fixture.unsubscribed.push(key);
    };
  return {
    "project.reorder": record("project.reorder", null),
    "worktree.trimSettings": record("worktree.trimSettings", TRIM),
    "hosts.snapshot": record("hosts.snapshot", SNAPSHOT),
    "hosts.subscribe": stream("hosts.subscribe", SNAPSHOT),
    "hosts.retry": record("hosts.retry", null),
    "hosts.updateHost": record("hosts.updateHost", null),
    "hosts.cancelScheduledUpdate": record("hosts.cancelScheduledUpdate", null),
    "hosts.signIn": record("hosts.signIn", null),
    "hosts.forget": record("hosts.forget", null),
    "hostAdd.start": record("hostAdd.start", { flowId: FLOW }),
    "hostAdd.subscribe": stream("hostAdd.subscribe", VIEW),
    "hostAdd.answer": record("hostAdd.answer", null),
    "hostAdd.sudoPassword": record("hostAdd.sudoPassword", null),
    "hostAdd.retry": record("hostAdd.retry", null),
    "hostAdd.cancel": record("hostAdd.cancel", null),
    "hostSignIns.status": record("hostSignIns.status", SIGN_IN_STATUS),
    "hostSignIns.macKeys": record("hostSignIns.macKeys", ["openrouter"]),
    "hostSignIns.sendFromThisMac": record("hostSignIns.sendFromThisMac", {
      ok: true,
      status: SIGN_IN_STATUS,
    }),
    "hostSignIns.setApiKey": record("hostSignIns.setApiKey", SIGN_IN_STATUS),
    "hostSignIns.setGitCredential": record("hostSignIns.setGitCredential", SIGN_IN_STATUS),
    "hostSignIns.run": stream("hostSignIns.run", { kind: "progress", message: "Starting" }),
    "hostSignIns.answer": record("hostSignIns.answer", null),
    "hostSignIns.cancel": record("hostSignIns.cancel", null),
    "hosts.rename": record("hosts.rename", null),
    "hosts.devices": record("hosts.devices", DEVICES),
    "hostAdd.facts": record("hostAdd.facts", FACTS),
    "hostAdd.active": record("hostAdd.active", ACTIVE),
    "hosts.projects": record("hosts.projects", PROJECTS),
    "hosts.createProject": record("hosts.createProject", CREATED),
    "hosts.openWorkspace": record("hosts.openWorkspace", null),
    "hosts.closeWorkspace": record("hosts.closeWorkspace", null),
    "hostLink.query": record("hostLink.query", { answered: "query" }),
    "hostLink.mutate": record("hostLink.mutate", { answered: "mutate" }),
    "hostLink.subscribe": stream("hostLink.subscribe", { kind: "started" }),
    ...fixture.overrides,
  };
}

function context(fixture: Host): DesktopRouterContext {
  return {
    caller: fixture.caller,
    diagnostics: fixture.diagnostics,
    // Every resource this host knows is in the one Workspace, so a refusal
    // below is the entry's policy, never the Workspace check.
    resourceWorkspace: () => WORKSPACE,
    handlers: recordingHandlers(fixture),
  };
}

const device: RouterCaller = {
  actor: {
    kind: "device",
    deviceId: "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b",
    workspaceId: WORKSPACE,
  },
  current: () => true,
};
const session: RouterCaller = {
  actor: { kind: "session", sessionId: "session-1", workspaceId: WORKSPACE },
  current: () => true,
};

interface StreamHandlers<Emission> {
  onData(value: Emission): void;
  onError(error: unknown): void;
  onComplete(): void;
}

/** A handler that answers what a host with no registry (or v1) answers. */
function unavailable(message: string) {
  return () => {
    throw new OperationUnavailableError(message);
  };
}

/** A client subscription's emissions so far, the error it ended on, and its stop. */
function collect<Emission>(open: (handlers: StreamHandlers<Emission>) => { unsubscribe(): void }) {
  const values: Emission[] = [];
  const ended = Promise.withResolvers<never>();
  const failed = ended.promise;
  // Observed here so an unawaited end is never an unhandled rejection.
  failed.catch(() => {});
  const subscription = open({
    onData: (value) => void values.push(value),
    onError: (error) => ended.reject(error),
    onComplete: () => {},
  });
  return { values, failed, unsubscribe: () => subscription.unsubscribe() };
}

/** Every remote hosts procedure, called with a valid input. */
function everyRemoteCall(client: TRPCClient<DesktopRouter>) {
  return {
    "hosts.snapshot": () => client.hosts.snapshot.query(),
    "hosts.subscribe": () =>
      collect((handlers) => client.hosts.subscribe.subscribe(undefined, handlers)).failed,
    "hosts.retry": () => client.hosts.retry.mutate({ hostId: HOST }),
    "hosts.updateHost": () => client.hosts.updateHost.mutate({ hostId: HOST, when: "now" }),
    "hosts.cancelScheduledUpdate": () =>
      client.hosts.cancelScheduledUpdate.mutate({ hostId: HOST }),
    "hosts.signIn": () => client.hosts.signIn.mutate({ hostId: HOST, providerId: "anthropic" }),
    "hosts.forget": () => client.hosts.forget.mutate({ hostId: HOST }),
    "hosts.rename": () => client.hosts.rename.mutate({ hostId: HOST, name: "Build box" }),
    "hosts.devices": () => client.hosts.devices.query({ hostId: HOST }),
    "hostAdd.facts": () => client.hostAdd.facts.query({ flowId: FLOW }),
    "hostAdd.active": () => client.hostAdd.active.query(),
    "hosts.projects": () => client.hosts.projects.query({ hostId: HOST }),
    "hosts.createProject": () => client.hosts.createProject.mutate({ hostId: HOST, path: "/a" }),
    "hosts.openWorkspace": () =>
      client.hosts.openWorkspace.mutate({ hostId: HOST, workspaceId: WORKSPACE }),
    "hosts.closeWorkspace": () =>
      client.hosts.closeWorkspace.mutate({ hostId: HOST, workspaceId: WORKSPACE }),
    "hostAdd.start": () => client.hostAdd.start.mutate({ target: "you@box" }),
    "hostAdd.subscribe": () =>
      collect((handlers) => client.hostAdd.subscribe.subscribe({ flowId: FLOW }, handlers)).failed,
    "hostAdd.answer": () =>
      client.hostAdd.answer.mutate({
        flowId: FLOW,
        questionId: "q1",
        answer: { kind: "accept-host-key" },
      }),
    "hostAdd.sudoPassword": () =>
      client.hostAdd.sudoPassword.mutate({ flowId: FLOW, questionId: "q1", password: PASSWORD }),
    "hostAdd.retry": () => client.hostAdd.retry.mutate({ flowId: FLOW }),
    "hostAdd.cancel": () => client.hostAdd.cancel.mutate({ flowId: FLOW }),
  };
}

const WINDOW_CALL = { actor: { kind: "user" }, origin: "desktop-window" };

describeContract<Host, DesktopRouter>(
  "the desktop-only tier",
  [
    ipcContractLink({ router: createDesktopRouter(), createContext: context }),
    webSocketContractLink({ router: createDesktopRouter(), createContext: context }),
  ],
  ({ connect }) => {
    it("serves the desktop's own window, as the person, through the host's map", async () => {
      const fixture = host(LOCAL_DESKTOP_CALLER);
      const client = await connect(fixture);
      expect(await client.worktree.trimSettings.query()).toEqual(TRIM);
      expect(await client.project.reorder.mutate({ orderedIds: ["b", "a"] })).toBeNull();
      expect(fixture.calls).toEqual([
        { key: "worktree.trimSettings", input: undefined, call: WINDOW_CALL },
        { key: "project.reorder", input: { orderedIds: ["b", "a"] }, call: WINDOW_CALL },
      ]);
    });

    // Placement-derived policy: host-placed, so device-as-user, and on no
    // network door. A paired device and a Session are refused before input.
    it("refuses every network caller, whatever its Workspace, before the handler", async () => {
      for (const caller of [device, session]) {
        const fixture = host(caller);
        const client = await connect(fixture);
        expect(await expectHostError(client.worktree.trimSettings.query())).toEqual({
          code: "FORBIDDEN",
          message: "worktree.trimSettings is not open to this caller.",
          reason: "verb-refused",
        });
        expect(
          await expectHostError(client.project.reorder.mutate({ orderedIds: [WORKSPACE] })),
        ).toMatchObject({ code: "FORBIDDEN", reason: "verb-refused" });
        expect(fixture.calls).toEqual([]);
      }
    });

    it("validates input before the handler, on every link", async () => {
      const fixture = host(LOCAL_DESKTOP_CALLER);
      const client = await connect(fixture);
      expect(
        await expectHostError(
          client.project.reorder.mutate({ orderedIds: [2] as unknown as string[] }),
        ),
      ).toMatchObject({ code: "BAD_REQUEST" });
      expect(fixture.calls).toEqual([]);
    });

    // Sign-ins on a remote host (VC-702 PR 2): the window's alone, values in only.
    it("serves the window every remote sign-in command, and ends a sign-in at its end", async () => {
      const fixture = host(LOCAL_DESKTOP_CALLER);
      const client = await connect(fixture);
      expect(await client.hostSignIns.status.query({ hostId: HOST })).toEqual(SIGN_IN_STATUS);
      expect(await client.hostSignIns.macKeys.query()).toEqual(["openrouter"]);
      expect(
        await client.hostSignIns.sendFromThisMac.mutate({
          hostId: HOST,
          providerId: "openrouter",
          confirmed: true,
        }),
      ).toEqual({ ok: true, status: SIGN_IN_STATUS });
      expect(
        await client.hostSignIns.setApiKey.mutate({
          hostId: HOST,
          providerId: "openrouter",
          key: "sk-pasted",
        }),
      ).toEqual(SIGN_IN_STATUS);
      expect(
        await client.hostSignIns.setGitCredential.mutate({
          hostId: HOST,
          host: "github.com",
          username: "x-access-token",
          password: "ghp_pasted",
        }),
      ).toEqual(SIGN_IN_STATUS);
      // A blank answer is a real answer (GitHub Copilot's "blank for github.com").
      expect(
        await client.hostSignIns.answer.mutate({
          hostId: HOST,
          providerId: "github-copilot",
          promptId: "p1",
          value: "",
        }),
      ).toBeNull();
      expect(
        await client.hostSignIns.cancel.mutate({ hostId: HOST, providerId: "xai" }),
      ).toBeNull();
      // Nothing is sent without the confirm.
      expect(
        await expectHostError(
          client.hostSignIns.sendFromThisMac.mutate({
            hostId: HOST,
            providerId: "openrouter",
            confirmed: false as unknown as true,
          }),
        ),
      ).toMatchObject({ code: "BAD_REQUEST" });
      // The sign-in's stream: its events, then complete after its end.
      const completed = Promise.withResolvers<void>();
      const events: unknown[] = [];
      const subscription = client.hostSignIns.run.subscribe(
        { hostId: HOST, providerId: "xai" },
        {
          onData: (event) => void events.push(event),
          onError: (error) => completed.reject(error),
          onComplete: () => completed.resolve(),
        },
      );
      for (let tries = 0; tries < 200 && !fixture.sinks.has("hostSignIns.run"); tries++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const sink = fixture.sinks.get("hostSignIns.run")!;
      await sink.emit({ kind: "relay", state: "listening" });
      await sink.emit({ kind: "done" });
      await sink.emit({ kind: "progress", message: "after the end" });
      await completed.promise;
      subscription.unsubscribe();
      expect(events).toEqual([
        { kind: "progress", message: "Starting" },
        { kind: "relay", state: "listening" },
        { kind: "done" },
      ]);
      expect(fixture.calls.map(({ key }) => key)).toEqual([
        "hostSignIns.status",
        "hostSignIns.macKeys",
        "hostSignIns.sendFromThisMac",
        "hostSignIns.setApiKey",
        "hostSignIns.setGitCredential",
        "hostSignIns.answer",
        "hostSignIns.cancel",
        "hostSignIns.run",
      ]);
    });

    // The Workspace link relay (VC-711): the window's alone, through the map.
    it("relays the window's calls to a remote project, and ends a stream at its last event", async () => {
      const fixture = host(LOCAL_DESKTOP_CALLER);
      const client = await connect(fixture);
      const call = { workspaceId: WORKSPACE, path: "board.snapshot", input: { projectId: "p" } };
      expect(await client.hostLink.query.query(call)).toEqual({ answered: "query" });
      expect(
        await client.hostLink.mutate.mutate({ workspaceId: WORKSPACE, path: "board.setPriority" }),
      ).toEqual({ answered: "mutate" });
      const ended = Promise.withResolvers<void>();
      const events: unknown[] = [];
      const subscription = client.hostLink.subscribe.subscribe(
        { workspaceId: WORKSPACE, path: "board.changes", input: {}, lastEventId: "41" },
        {
          onData: (event) => void events.push(event),
          onError: (error) => ended.reject(error),
          onComplete: () => ended.resolve(),
        },
      );
      await vi.waitFor(() => expect(fixture.sinks.has("hostLink.subscribe")).toBe(true));
      const sink = fixture.sinks.get("hostLink.subscribe")!;
      await sink.emit({ kind: "data", data: { cursor: "42" }, id: "42" });
      const lost = {
        kind: "lost",
        error: { code: "SERVICE_UNAVAILABLE", message: "gone", reason: "host-unreachable" },
      };
      await sink.emit(lost);
      await sink.emit({ kind: "data", data: "after the end" });
      await ended.promise;
      subscription.unsubscribe();
      expect(events).toEqual([
        { kind: "started" },
        { kind: "data", data: { cursor: "42" }, id: "42" },
        lost,
      ]);
      await vi.waitFor(() => expect(fixture.unsubscribed).toEqual(["hostLink.subscribe"]));
      expect(fixture.calls.map(({ key, input }) => [key, input])).toEqual([
        ["hostLink.query", call],
        ["hostLink.mutate", { workspaceId: WORKSPACE, path: "board.setPriority" }],
        [
          "hostLink.subscribe",
          { workspaceId: WORKSPACE, path: "board.changes", input: {}, lastEventId: "41" },
        ],
      ]);
      for (const { call: made } of fixture.calls) expect(made).toEqual(WINDOW_CALL);
    });

    // What main answers travels typed: the link's own reasons, the host's, and
    // a code with no reason; the map's unavailable stays the router's.
    it("passes a relayed failure's reason on, and a host's bare code", async () => {
      const thrown: unknown[] = [
        // A link's own failure: the host error is the error's `data.hostError`.
        {
          message: "x",
          data: {
            code: "SERVICE_UNAVAILABLE",
            hostError: {
              code: "SERVICE_UNAVAILABLE",
              message: "The project's host can't be reached",
              reason: "host-unreachable",
            },
          },
        },
        Object.assign(new Error("board.setPriority is not granted"), {
          code: "FORBIDDEN",
          reason: "verb-refused",
        }),
        { message: "Not found", data: { code: "NOT_FOUND" } },
        new OperationUnavailableError("Remote projects are unavailable on this host"),
      ];
      let index = 0;
      const fixture = host(LOCAL_DESKTOP_CALLER, {
        "hostLink.query": () => {
          throw thrown[index++];
        },
      });
      const client = await connect(fixture);
      const call = () => client.hostLink.query.query({ workspaceId: WORKSPACE, path: "board.x" });
      expect(await expectHostError(call())).toEqual({
        code: "SERVICE_UNAVAILABLE",
        message: "The project's host can't be reached",
        reason: "host-unreachable",
      });
      expect(await expectHostError(call())).toEqual({
        code: "FORBIDDEN",
        message: "board.setPriority is not granted",
        reason: "verb-refused",
      });
      expect(await expectHostError(call())).toEqual({ code: "NOT_FOUND", message: "Not found" });
      expect(await expectHostError(call())).toEqual({
        code: "NOT_IMPLEMENTED",
        message: "Remote projects are unavailable on this host",
        reason: "operation-unavailable",
      });
    });

    it("refuses a network caller the relay, and a malformed relay call before the handler", async () => {
      for (const caller of [device, session]) {
        const fixture = host(caller);
        const client = await connect(fixture);
        expect(
          await expectHostError(
            client.hostLink.mutate.mutate({ workspaceId: WORKSPACE, path: "board.setPriority" }),
          ),
        ).toMatchObject({ code: "FORBIDDEN", reason: "verb-refused" });
        expect(fixture.calls).toEqual([]);
      }
      const fixture = host(LOCAL_DESKTOP_CALLER);
      const client = await connect(fixture);
      const longest = `a.${"b".repeat(HOST_LINK_RELAY_PATH_MAX - 2)}`;
      expect(await client.hostLink.query.query({ workspaceId: WORKSPACE, path: longest })).toEqual({
        answered: "query",
      });
      const malformed: [string, () => Promise<unknown>][] = [
        [
          "not a Workspace id",
          () => client.hostLink.query.query({ workspaceId: "w", path: "a.b" }),
        ],
        ["no dot", () => client.hostLink.query.query({ workspaceId: WORKSPACE, path: "board" })],
        [
          "path too long",
          () => client.hostLink.query.query({ workspaceId: WORKSPACE, path: `${longest}c` }),
        ],
        [
          "a path that is not a name",
          () => client.hostLink.mutate.mutate({ workspaceId: WORKSPACE, path: "../board.x" }),
        ],
        [
          "an unknown key",
          () =>
            client.hostLink.query.query({ workspaceId: WORKSPACE, path: "a.b", extra: 1 } as never),
        ],
        [
          "an empty resume id",
          () =>
            collect((handlers) =>
              client.hostLink.subscribe.subscribe(
                { workspaceId: WORKSPACE, path: "a.b", lastEventId: "" },
                handlers,
              ),
            ).failed,
        ],
      ];
      for (const [what, call] of malformed) {
        expect(await expectHostError(call()), what).toMatchObject({ code: "BAD_REQUEST" });
      }
      expect(fixture.calls.map(({ key }) => key)).toEqual(["hostLink.query"]);
    });

    // Remote hosts (VC-700 PR 2): desktop main's registry, the window's alone.
    it("serves the window every remote hosts command, through the host's map", async () => {
      const fixture = host(LOCAL_DESKTOP_CALLER);
      const client = await connect(fixture);
      expect(await client.hosts.snapshot.query()).toEqual(SNAPSHOT);
      expect(await client.hosts.retry.mutate({ hostId: HOST })).toBeNull();
      expect(await client.hosts.updateHost.mutate({ hostId: HOST, when: "when-idle" })).toBeNull();
      expect(await client.hosts.cancelScheduledUpdate.mutate({ hostId: HOST })).toBeNull();
      expect(
        await client.hosts.signIn.mutate({ hostId: HOST, providerId: "anthropic" }),
      ).toBeNull();
      expect(await client.hosts.forget.mutate({ hostId: HOST })).toBeNull();
      // A label is trimmed before it is bounded: the longest passes, padded or not.
      const label = "l".repeat(REMOTE_HOST_NAME_MAX);
      expect(await client.hosts.rename.mutate({ hostId: HOST, name: ` ${label}\t` })).toBeNull();
      expect(await client.hosts.devices.query({ hostId: HOST })).toEqual(DEVICES);
      // Each bound is inclusive: the longest target, name and password pass.
      const target = "t".repeat(255);
      const name = "n".repeat(120);
      expect(await client.hostAdd.start.mutate({ target, name })).toEqual({ flowId: FLOW });
      expect(await client.hostAdd.start.mutate({ target: "you@box" })).toEqual({ flowId: FLOW });
      expect(
        await client.hostAdd.answer.mutate({
          flowId: FLOW,
          questionId: "q1",
          answer: { kind: "user-install" },
        }),
      ).toBeNull();
      const longest = "p".repeat(1024);
      expect(
        await client.hostAdd.sudoPassword.mutate({
          flowId: FLOW,
          questionId: "q1",
          password: longest,
        }),
      ).toBeNull();
      expect(await client.hostAdd.retry.mutate({ flowId: FLOW, from: "deliver" })).toBeNull();
      expect(await client.hostAdd.retry.mutate({ flowId: FLOW })).toBeNull();
      expect(await client.hostAdd.cancel.mutate({ flowId: FLOW })).toBeNull();
      expect(await client.hostAdd.facts.query({ flowId: FLOW })).toEqual(FACTS);
      expect(await client.hostAdd.active.query()).toEqual(ACTIVE);
      expect(fixture.calls.map(({ key, input }) => [key, input])).toEqual([
        ["hosts.snapshot", undefined],
        ["hosts.retry", { hostId: HOST }],
        ["hosts.updateHost", { hostId: HOST, when: "when-idle" }],
        ["hosts.cancelScheduledUpdate", { hostId: HOST }],
        ["hosts.signIn", { hostId: HOST, providerId: "anthropic" }],
        ["hosts.forget", { hostId: HOST }],
        ["hosts.rename", { hostId: HOST, name: label }],
        ["hosts.devices", { hostId: HOST }],
        ["hostAdd.start", { target, name }],
        ["hostAdd.start", { target: "you@box" }],
        ["hostAdd.answer", { flowId: FLOW, questionId: "q1", answer: { kind: "user-install" } }],
        ["hostAdd.sudoPassword", { flowId: FLOW, questionId: "q1", password: longest }],
        ["hostAdd.retry", { flowId: FLOW, from: "deliver" }],
        ["hostAdd.retry", { flowId: FLOW }],
        ["hostAdd.cancel", { flowId: FLOW }],
        ["hostAdd.facts", { flowId: FLOW }],
        ["hostAdd.active", undefined],
      ]);
      for (const { call } of fixture.calls) expect(call).toEqual(WINDOW_CALL);
    });

    it("refuses a paired device and a Session every remote hosts command, streams too", async () => {
      for (const caller of [device, session]) {
        const fixture = host(caller);
        const client = await connect(fixture);
        for (const [key, call] of Object.entries(everyRemoteCall(client))) {
          expect(await expectHostError(call()), key).toEqual({
            code: "FORBIDDEN",
            message: `${key} is not open to this caller.`,
            reason: "verb-refused",
          });
        }
        expect(fixture.calls).toEqual([]);
      }
    });

    it("refuses a malformed, unbounded or unknown-keyed input before the handler", async () => {
      const fixture = host(LOCAL_DESKTOP_CALLER);
      const client = await connect(fixture);
      const malformed: [string, () => Promise<unknown>][] = [
        ["hostId not a UUID", () => client.hosts.retry.mutate({ hostId: "box" })],
        ["unknown key", () => client.hosts.forget.mutate({ hostId: HOST, extra: 1 } as never)],
        [
          "unknown update time",
          () => client.hosts.updateHost.mutate({ hostId: HOST, when: "later" as never }),
        ],
        [
          "provider id too long",
          () => client.hosts.signIn.mutate({ hostId: HOST, providerId: "p".repeat(129) }),
        ],
        ["empty provider id", () => client.hosts.signIn.mutate({ hostId: HOST, providerId: "" })],
        ["empty label", () => client.hosts.rename.mutate({ hostId: HOST, name: "" })],
        ["blank label", () => client.hosts.rename.mutate({ hostId: HOST, name: "   " })],
        [
          "label too long",
          () =>
            client.hosts.rename.mutate({
              hostId: HOST,
              name: "l".repeat(REMOTE_HOST_NAME_MAX + 1),
            }),
        ],
        ["rename without a host", () => client.hosts.rename.mutate({ name: "Box" } as never)],
        [
          "rename with an unknown key",
          () => client.hosts.rename.mutate({ hostId: HOST, name: "Box", label: "x" } as never),
        ],
        ["devices of no host", () => client.hosts.devices.query({ hostId: "box" })],
        [
          "devices with an unknown key",
          () => client.hosts.devices.query({ hostId: HOST, all: true } as never),
        ],
        ["facts of no flow", () => client.hostAdd.facts.query({} as never)],
        ["target too long", () => client.hostAdd.start.mutate({ target: "t".repeat(256) })],
        ["empty target", () => client.hostAdd.start.mutate({ target: "" })],
        [
          "name too long",
          () => client.hostAdd.start.mutate({ target: "you@box", name: "n".repeat(121) }),
        ],
        [
          "unknown answer",
          () =>
            client.hostAdd.answer.mutate({
              flowId: FLOW,
              questionId: "q1",
              answer: { kind: "sudo" } as never,
            }),
        ],
        [
          "answer with a field",
          () =>
            client.hostAdd.answer.mutate({
              flowId: FLOW,
              questionId: "q1",
              answer: { kind: "adopt", password: PASSWORD } as never,
            }),
        ],
        [
          "password too long",
          () =>
            client.hostAdd.sudoPassword.mutate({
              flowId: FLOW,
              questionId: "q1",
              password: PASSWORD + "p".repeat(1024),
            }),
        ],
        [
          "empty password",
          () =>
            client.hostAdd.sudoPassword.mutate({ flowId: FLOW, questionId: "q1", password: "" }),
        ],
        [
          "no question id",
          () => client.hostAdd.answer.mutate({ flowId: FLOW, answer: { kind: "adopt" } } as never),
        ],
        [
          "question id too long",
          () =>
            client.hostAdd.sudoPassword.mutate({
              flowId: FLOW,
              questionId: "q".repeat(65),
              password: PASSWORD,
            }),
        ],
        [
          "empty flow id",
          () =>
            client.hostAdd.sudoPassword.mutate({
              flowId: "",
              questionId: "q1",
              password: PASSWORD,
            }),
        ],
        [
          "unknown step",
          () => client.hostAdd.retry.mutate({ flowId: FLOW, from: "nowhere" as never }),
        ],
        ["flow id too long", () => client.hostAdd.cancel.mutate({ flowId: "f".repeat(129) })],
        [
          "stream's flow id empty",
          () =>
            collect((handlers) => client.hostAdd.subscribe.subscribe({ flowId: "" }, handlers))
              .failed,
        ],
      ];
      for (const [what, call] of malformed) {
        const error = await expectHostError(call());
        expect(error.code, what).toBe("BAD_REQUEST");
        // A refused input is never repeated back: not the password, anyway.
        expect(error.message, what).not.toContain(PASSWORD);
      }
      expect(fixture.calls).toEqual([]);
    });

    // A host with no registry (hostd), and v1's refusals: the shared brand, said
    // as `operation-unavailable` with the registry's own words.
    it("answers the registry's unavailable as NOT_IMPLEMENTED, in a stream too", async () => {
      const fixture = host(LOCAL_DESKTOP_CALLER, {
        "hosts.snapshot": unavailable("Remote hosts are unavailable on this host"),
        "hosts.updateHost": unavailable(REMOTE_HOST_UPDATE_UNAVAILABLE),
        "hosts.subscribe": unavailable("Remote hosts are unavailable on this host") as never,
        "hostAdd.subscribe": async () => {
          throw new OperationUnavailableError("Remote hosts are unavailable on this host");
        },
      });
      const client = await connect(fixture);
      const refusal = {
        code: "NOT_IMPLEMENTED",
        message: "Remote hosts are unavailable on this host",
        reason: "operation-unavailable",
      };
      expect(await expectHostError(client.hosts.snapshot.query())).toEqual(refusal);
      expect(
        await expectHostError(client.hosts.updateHost.mutate({ hostId: HOST, when: "now" })),
      ).toEqual({ ...refusal, message: REMOTE_HOST_UPDATE_UNAVAILABLE });
      expect(
        await expectHostError(
          collect((handlers) => client.hosts.subscribe.subscribe(undefined, handlers)).failed,
        ),
      ).toEqual(refusal);
      expect(
        await expectHostError(
          collect((handlers) => client.hostAdd.subscribe.subscribe({ flowId: FLOW }, handlers))
            .failed,
        ),
      ).toEqual(refusal);
    });

    it("streams the hosts snapshot, the current first, until the window stops it", async () => {
      const fixture = host(LOCAL_DESKTOP_CALLER);
      const client = await connect(fixture);
      const stream = collect<RemoteHostsSnapshot>((handlers) =>
        client.hosts.subscribe.subscribe(undefined, handlers),
      );
      await vi.waitFor(() => expect(stream.values).toEqual([SNAPSHOT]));
      await fixture.sinks.get("hosts.subscribe")!.emit(NEXT);
      await vi.waitFor(() => expect(stream.values).toEqual([SNAPSHOT, NEXT]));
      expect(fixture.calls).toEqual([
        { key: "hosts.subscribe", input: undefined, call: WINDOW_CALL },
      ]);
      stream.unsubscribe();
      // The window's stop reaches the registry: its listener is let go.
      await vi.waitFor(() => expect(fixture.unsubscribed).toEqual(["hosts.subscribe"]));
    });

    it("streams one add flow's view and log lines, until the window stops it", async () => {
      const fixture = host(LOCAL_DESKTOP_CALLER);
      const client = await connect(fixture);
      const stream = collect<AddHostEvent>((handlers) =>
        client.hostAdd.subscribe.subscribe({ flowId: FLOW }, handlers),
      );
      await vi.waitFor(() => expect(stream.values).toEqual([VIEW]));
      const sink = fixture.sinks.get("hostAdd.subscribe")!;
      await sink.emit(LOG);
      await sink.emit(FAILED);
      await vi.waitFor(() => expect(stream.values).toEqual([VIEW, LOG, FAILED]));
      expect(fixture.calls).toEqual([
        { key: "hostAdd.subscribe", input: { flowId: FLOW }, call: WINDOW_CALL },
      ]);
      stream.unsubscribe();
      await vi.waitFor(() => expect(fixture.unsubscribed).toEqual(["hostAdd.subscribe"]));
    });

    // Write-only: the router records a call's route and its error's message,
    // never its input, and the map scrubs the password from an error.
    it("never records the sudo password, whether the call succeeds or fails", async () => {
      let attempt = 0;
      const fixture = host(LOCAL_DESKTOP_CALLER, {
        "hostAdd.sudoPassword": () => {
          attempt += 1;
          if (attempt === 1) return null;
          throw new Error("sudo refused the password");
        },
      });
      const client = await connect(fixture);
      expect(
        await client.hostAdd.sudoPassword.mutate({
          flowId: FLOW,
          questionId: "q1",
          password: PASSWORD,
        }),
      ).toBeNull();
      const failure = await expectHostError(
        client.hostAdd.sudoPassword.mutate({ flowId: FLOW, questionId: "q1", password: PASSWORD }),
      );
      expect(failure.message).toBe("sudo refused the password");
      for (const input of [
        { flowId: FLOW, password: PASSWORD + "p".repeat(1024) },
        { flowId: FLOW, password: PASSWORD, extra: PASSWORD },
        { flowId: PASSWORD.repeat(10), password: PASSWORD },
      ]) {
        const refused = await expectHostError(client.hostAdd.sudoPassword.mutate(input as never));
        expect(refused.code).toBe("BAD_REQUEST");
        // An unknown key is named, never its value; a bound, never the input.
        expect(refused.message).not.toContain(PASSWORD);
      }
      const recorded = fixture.diagnostics.list();
      expect(recorded.map(({ procedure, phase }) => [procedure, phase])).toEqual([
        ["hostAdd.sudoPassword", "start"],
        ["hostAdd.sudoPassword", "success"],
        ["hostAdd.sudoPassword", "start"],
        ["hostAdd.sudoPassword", "error"],
        ["hostAdd.sudoPassword", "start"],
        ["hostAdd.sudoPassword", "error"],
        ["hostAdd.sudoPassword", "start"],
        ["hostAdd.sudoPassword", "error"],
        ["hostAdd.sudoPassword", "start"],
        ["hostAdd.sudoPassword", "error"],
      ]);
      expect(JSON.stringify(recorded)).not.toContain(PASSWORD);
    });
  },
);

/** A router caller straight onto the desktop tier, for the stream's own edges. */
function directCaller(
  overrides: Partial<DesktopRouterHandlers>,
  signal?: AbortSignal,
  /** `null`: a context with no transport named. */
  transport: NonNullable<DesktopRouterContext["transport"]> | null = "electron-ipc",
): { caller: ReturnType<ReturnType<typeof createDesktopRouter>["createCaller"]>; fixture: Host } {
  const fixture = host(LOCAL_DESKTOP_CALLER, overrides);
  const caller = createDesktopRouter().createCaller(
    { ...context(fixture), ...(transport === null ? {} : { transport }) },
    signal === undefined ? undefined : { signal },
  );
  return { caller, fixture };
}

async function drain<Emission>(stream: AsyncIterable<Emission>) {
  const values: Emission[] = [];
  try {
    for await (const value of stream) values.push(value);
  } catch (error) {
    return { values, error };
  }
  return { values, error: null };
}

describe("a desktop-only stream's edges", () => {
  it.each([["electron-ipc"], [null]] as const)(
    "ends with subscription-overflow once its window falls behind, and says so (%s)",
    async (transport) => {
      const unsubscribe = vi.fn();
      const { caller, fixture } = directCaller(
        {
          "hosts.subscribe": async (_input, _call, sink) => {
            for (let index = 0; index <= DESKTOP_STREAM_CAPACITY; index += 1) void sink.emit(NEXT);
            return unsubscribe;
          },
        },
        undefined,
        transport,
      );
      const { values, error } = await drain(await caller.hosts.subscribe());
      expect(values).toHaveLength(DESKTOP_STREAM_CAPACITY);
      expect(error).toMatchObject({
        code: "TOO_MANY_REQUESTS",
        reason: "subscription-overflow",
        message: DESKTOP_STREAM_OVERFLOW_MESSAGE,
      });
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(fixture.diagnostics.list().at(-1)).toMatchObject({
        procedure: "hosts.subscribe",
        phase: "error",
        transport: transport ?? "unknown",
        code: "SUBSCRIPTION_OVERFLOW",
        message: DESKTOP_STREAM_OVERFLOW_MESSAGE,
      });
    },
  );

  it("drains what it held, then ends with subscription-source-failed", async () => {
    const unsubscribe = vi.fn();
    const { caller } = directCaller({
      "hostAdd.subscribe": async (_input, _call, sink) => {
        void sink.emit(VIEW);
        sink.fail(new Error("registry gone"));
        return unsubscribe;
      },
    });
    const { values, error } = await drain(await caller.hostAdd.subscribe({ flowId: FLOW }));
    expect(values).toEqual([VIEW]);
    expect(error).toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      reason: "subscription-source-failed",
      message: DESKTOP_STREAM_SOURCE_FAILURE_MESSAGE,
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("passes on a source's own failure to open, as thrown", async () => {
    const { caller } = directCaller({
      "hosts.subscribe": async () => {
        throw new Error("no such registry");
      },
    });
    const { values, error } = await drain(await caller.hosts.subscribe());
    expect(values).toEqual([]);
    expect(error).toMatchObject({ message: "no such registry" });
  });

  it("opens nothing for a request already aborted, and lets go on abort", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const early = directCaller({}, aborted.signal);
    expect(await drain(await early.caller.hosts.subscribe())).toEqual({ values: [], error: null });
    expect(early.fixture.calls).toEqual([]);

    const controller = new AbortController();
    const { caller, fixture } = directCaller({}, controller.signal);
    const iterator = (await caller.hostAdd.subscribe({ flowId: FLOW }))[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: VIEW });
    const pending = iterator.next();
    controller.abort();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(fixture.unsubscribed).toEqual(["hostAdd.subscribe"]);
  });
});

describe("the desktop router's grammar", () => {
  it("publishes both validators of every desktop-only procedure", () => {
    const schemas = desktopProcedureSchemas();
    expect(Object.keys(schemas).toSorted()).toEqual(
      [
        "project.reorder",
        "worktree.trimSettings",
        "hosts.snapshot",
        "hosts.subscribe",
        "hosts.retry",
        "hosts.updateHost",
        "hosts.cancelScheduledUpdate",
        "hosts.signIn",
        "hosts.forget",
        "hostAdd.start",
        "hostAdd.subscribe",
        "hostAdd.answer",
        "hostAdd.sudoPassword",
        "hostAdd.retry",
        "hostAdd.cancel",
        "hostSignIns.status",
        "hostSignIns.macKeys",
        "hostSignIns.sendFromThisMac",
        "hostSignIns.setApiKey",
        "hostSignIns.setGitCredential",
        "hostSignIns.run",
        "hostSignIns.answer",
        "hostSignIns.cancel",
        "hosts.rename",
        "hosts.devices",
        "hostAdd.facts",
        "hostAdd.active",
        "hosts.projects",
        "hosts.createProject",
        "hosts.openWorkspace",
        "hosts.closeWorkspace",
        "hostLink.query",
        "hostLink.mutate",
        "hostLink.subscribe",
      ].toSorted(),
    );
    expect(schemas["worktree.trimSettings"]).toMatchObject({
      type: "query",
      noInput: true,
      outputValidation: "network-and-tests",
    });
    expect(schemas["project.reorder"]).toMatchObject({
      type: "mutation",
      outputValidation: "network-and-tests",
    });
    expect(schemas["hosts.rename"]).toMatchObject({ type: "mutation" });
    expect(schemas["hosts.devices"]).toMatchObject({
      type: "query",
      outputValidation: "network-and-tests",
    });
    expect(schemas["hosts.devices"]!.output).toBe(remoteHostDevicesSchema);
    expect(schemas["hostAdd.facts"]).toMatchObject({ type: "query" });
    expect(schemas["hostAdd.facts"]!.output).toBe(addHostFactsSchema);
    expect(schemas["hostAdd.active"]).toMatchObject({ type: "query", noInput: true });
    expect(schemas["hostAdd.active"]!.output).toBe(activeAddHostsSchema);
    expect(schemas["hosts.projects"]).toMatchObject({ type: "query" });
    expect(schemas["hosts.projects"]!.output).toBe(remoteHostProjectsSchema);
    expect(schemas["hosts.createProject"]).toMatchObject({ type: "mutation" });
    expect(schemas["hosts.createProject"]!.output).toBe(createProjectResultSchema);
    expect(schemas["hosts.openWorkspace"]).toMatchObject({ type: "mutation" });
    expect(schemas["hosts.closeWorkspace"]).toMatchObject({ type: "mutation" });
    for (const key of ["hosts.subscribe", "hostAdd.subscribe", "hostSignIns.run"]) {
      expect(schemas[key], key).toMatchObject({
        type: "subscription",
        outputValidation: "documented-yield",
      });
    }
    expect(schemas["hosts.subscribe"]!.output).toBe(remoteHostsSnapshotSchema);
    expect(schemas["hostAdd.subscribe"]!.output).toBe(addHostEventSchema);
    expect(schemas["hostLink.subscribe"]).toMatchObject({ type: "subscription" });
    expect(schemas["hostLink.subscribe"]!.output).toBe(hostLinkRelayEventSchema);
    // Every schema publishes as JSON Schema: no transform, no custom parser.
    for (const [key, { input, output }] of Object.entries(schemas)) {
      expect(() => z.toJSONSchema(input, { io: "input" }), key).not.toThrow();
      expect(() => z.toJSONSchema(output, { io: "output" }), key).not.toThrow();
    }
  });

  it("bounds a project's granted features as a welcome bounds its own (VC-712)", () => {
    const granting = (granted: readonly string[]) => ({
      ...SNAPSHOT,
      projects: { p1: { hostId: HOST, link: { status: "ready" as const }, granted } },
    });
    const most = Array.from({ length: MAX_GRANTED_FEATURES }, (_, index) =>
      `f${index}`.padEnd(MAX_GRANTED_FEATURE_LENGTH, "x"),
    );
    expect(remoteHostsSnapshotSchema.parse(granting(most))).toEqual(granting(most));
    expect(remoteHostsSnapshotSchema.safeParse(granting([...most, "one more"])).success).toBe(
      false,
    );
    expect(
      remoteHostsSnapshotSchema.safeParse(granting(["x".repeat(MAX_GRANTED_FEATURE_LENGTH + 1)]))
        .success,
    ).toBe(false);
  });

  it("answers the flows main still owns: exactly four secret-free fields, no terminal one (VC-720)", () => {
    expect(activeAddHostsSchema.parse(ACTIVE)).toEqual(ACTIVE);
    // Nothing of the view crosses: a step row is an unknown key, refused.
    expect(activeAddHostsSchema.safeParse([{ ...ACTIVE[0]!, steps: [] }]).success).toBe(false);
    // Closed status: a finished flow has left the list.
    for (const status of ["done", "cancelled", "paused"] as const) {
      expect(activeAddHostsSchema.safeParse([{ ...ACTIVE[0]!, status }]).success, status).toBe(
        false,
      );
    }
    // Bounded, as the engine bounds it: `MAX_ACTIVE_ADD_HOSTS` in, one past out.
    const full = Array.from({ length: MAX_ACTIVE_ADD_HOSTS }, (_, index): ActiveAddHost => ({
      flowId: `flow-${index}`,
      target: `you@box-${index}`,
      name: `box-${index}`,
      status: "running",
    }));
    expect(activeAddHostsSchema.parse(full)).toHaveLength(MAX_ACTIVE_ADD_HOSTS);
    expect(activeAddHostsSchema.safeParse([...full, ...ACTIVE]).success).toBe(false);
    // Empty is a fine answer: no flow under way.
    expect(activeAddHostsSchema.parse([])).toEqual([]);
  });

  it("describes the wire's own values: a snapshot, a view with an open question, a log line", () => {
    expect(remoteHostsSnapshotSchema.parse(SNAPSHOT)).toEqual(SNAPSHOT);
    const REPLAY: AddHostEvent = {
      kind: "replay",
      view: VIEW.view,
      log: [LOG.kind === "log" ? LOG.line : (null as never)],
      omitted: 412,
    };
    for (const event of [REPLAY, VIEW, FAILED, LOG]) {
      expect(addHostEventSchema.parse(event)).toEqual(event);
    }
    expect(() => addHostEventSchema.parse({ ...REPLAY, omitted: -1 })).toThrow();
    expect(addHostFactsSchema.parse(FACTS)).toEqual(FACTS);
    expect(() => addHostFactsSchema.parse({ ...FACTS, memoryBytes: -1 })).toThrow();
    expect(() =>
      addHostEventSchema.parse({ ...VIEW, view: { ...VIEW.view, status: "paused" } }),
    ).toThrow();
  });

  it("describes a host's devices strictly and boundedly: never a key, never unbounded", () => {
    expect(remoteHostDevicesSchema.parse(DEVICES)).toEqual(DEVICES);
    const mine = DEVICES.devices[0]!;
    for (const [what, value] of [
      ["a key", { ...DEVICES, devices: [{ ...mine, publicKey: "MFkw" }] }],
      ["an extra field", { ...DEVICES, cachedAt: 1 }],
      [
        "a long name",
        { ...DEVICES, devices: [{ ...mine, name: "n".repeat(REMOTE_HOST_DEVICE_TEXT_MAX + 1) }] },
      ],
      [
        "too many",
        { ...DEVICES, devices: Array.from({ length: REMOTE_HOST_DEVICES_MAX + 1 }, () => mine) },
      ],
      ["no thisMac", { ...DEVICES, devices: [{ ...mine, thisMac: undefined }] }],
    ] as const) {
      expect(() => remoteHostDevicesSchema.parse(value), what).toThrow();
    }
    expect(
      remoteHostDevicesSchema.parse({
        ...DEVICES,
        devices: Array.from({ length: REMOTE_HOST_DEVICES_MAX }, () => mine),
      }).devices,
    ).toHaveLength(REMOTE_HOST_DEVICES_MAX);
  });
});

// A host's projects (VC-710): listed and created over SSH, opened and closed on this Mac.
describeContract<Host, DesktopRouter>(
  "a remote host's projects, on the desktop tier",
  [
    ipcContractLink({ router: createDesktopRouter(), createContext: context }),
    webSocketContractLink({ router: createDesktopRouter(), createContext: context }),
  ],
  ({ connect }) => {
    it("serves the window each, through the host's map", async () => {
      const fixture = host(LOCAL_DESKTOP_CALLER);
      const client = await connect(fixture);
      expect(await client.hosts.projects.query({ hostId: HOST })).toEqual(PROJECTS);
      const git = {
        hostId: HOST,
        gitUrl: "https://github.com/me/acme.git",
        path: "/srv/volli/acme",
        name: "n".repeat(REMOTE_HOST_NAME_MAX),
      };
      expect(await client.hosts.createProject.mutate(git)).toEqual(CREATED);
      expect(await client.hosts.createProject.mutate({ hostId: HOST, path: "/a" })).toEqual(
        CREATED,
      );
      // The longest sudo password passes (write-only: never in a call's record).
      const sudo = {
        hostId: HOST,
        gitUrl: "https://github.com/me/acme",
        sudoPassword: "p".repeat(1024),
      };
      expect(await client.hosts.createProject.mutate(sudo)).toEqual(CREATED);
      const workspace = { hostId: HOST, workspaceId: WORKSPACE };
      expect(await client.hosts.openWorkspace.mutate(workspace)).toBeNull();
      expect(await client.hosts.closeWorkspace.mutate(workspace)).toBeNull();
      expect(fixture.calls.map(({ key, input }) => [key, input])).toEqual([
        ["hosts.projects", { hostId: HOST }],
        ["hosts.createProject", git],
        ["hosts.createProject", { hostId: HOST, path: "/a" }],
        ["hosts.createProject", sudo],
        ["hosts.openWorkspace", workspace],
        ["hosts.closeWorkspace", workspace],
      ]);
    });

    it("answers a refused create as a result, with its one line and command", async () => {
      const refused: CreateRemoteProjectResult = {
        ok: false,
        failure: {
          code: "not-operator",
          message: "This Mac can’t add projects on box yet.",
          command: "sudo volli-hostd operator-token --for 'you'",
        },
      };
      const fixture = host(LOCAL_DESKTOP_CALLER, { "hosts.createProject": () => refused });
      const client = await connect(fixture);
      expect(await client.hosts.createProject.mutate({ hostId: HOST, path: "/a" })).toEqual(
        refused,
      );
    });

    it("refuses a malformed, unbounded or unknown-keyed input before the handler", async () => {
      const fixture = host(LOCAL_DESKTOP_CALLER);
      const client = await connect(fixture);
      const malformed: [string, () => Promise<unknown>][] = [
        ["projects of no host", () => client.hosts.projects.query({ hostId: "box" })],
        ["neither a folder nor a URL", () => client.hosts.createProject.mutate({ hostId: HOST })],
        [
          "a path too long",
          () =>
            client.hosts.createProject.mutate({
              hostId: HOST,
              path: "p".repeat(REMOTE_HOST_PROJECT_TEXT_MAX + 1),
            }),
        ],
        [
          "a URL too long",
          () => client.hosts.createProject.mutate({ hostId: HOST, gitUrl: "u".repeat(2049) }),
        ],
        [
          "a name too long",
          () =>
            client.hosts.createProject.mutate({
              hostId: HOST,
              path: "/a",
              name: "n".repeat(REMOTE_HOST_NAME_MAX + 1),
            }),
        ],
        [
          "an unknown key",
          () => client.hosts.createProject.mutate({ hostId: HOST, path: "/a", sudo: 1 } as never),
        ],
        [
          "an empty sudo password",
          () => client.hosts.createProject.mutate({ hostId: HOST, gitUrl: "u", sudoPassword: "" }),
        ],
        [
          "a sudo password too long",
          () =>
            client.hosts.createProject.mutate({
              hostId: HOST,
              gitUrl: "u",
              sudoPassword: "p".repeat(1025),
            }),
        ],
        [
          "a Workspace that is no id",
          () => client.hosts.openWorkspace.mutate({ hostId: HOST, workspaceId: "acme" }),
        ],
        [
          "a close of no host",
          () => client.hosts.closeWorkspace.mutate({ workspaceId: WORKSPACE } as never),
        ],
      ];
      for (const [what, call] of malformed) {
        expect((await expectHostError(call())).code, what).toBe("BAD_REQUEST");
      }
      expect(fixture.calls).toEqual([]);
    });

    it("describes a host's projects strictly and boundedly", () => {
      expect(remoteHostProjectsSchema.parse(PROJECTS)).toEqual(PROJECTS);
      const row = PROJECTS.projects[0]!;
      for (const [what, value] of [
        ["an extra field", { ...PROJECTS, projects: [{ ...row, archived: 1 }] }],
        ["no adds", { ...PROJECTS, adds: undefined }],
        ["an unknown adds", { ...PROJECTS, adds: { kind: "maybe" } }],
        [
          "too many",
          {
            ...PROJECTS,
            projects: Array.from({ length: REMOTE_HOST_PROJECTS_MAX + 1 }, () => row),
          },
        ],
        [
          "a path too long",
          {
            ...PROJECTS,
            projects: [{ ...row, path: "p".repeat(REMOTE_HOST_PROJECT_TEXT_MAX + 1) }],
          },
        ],
      ] as const) {
        expect(() => remoteHostProjectsSchema.parse(value), what).toThrow();
      }
      // Every output is bounded (review N2): no million-character line or command.
      const long = "x".repeat(REMOTE_PROJECT_FAILURE_TEXT_MAX + 1);
      for (const failure of [
        { code: "refused", message: long, command: null },
        { code: "needs-sudo", message: "x", command: long },
      ]) {
        expect(() => createProjectResultSchema.parse({ ok: false, failure })).toThrow();
      }
      expect(() =>
        remoteHostProjectsSchema.parse({
          ...PROJECTS,
          adds: { kind: "needs-operator", command: long },
        }),
      ).toThrow();
      expect(() =>
        remoteHostProjectsSchema.parse({ ...PROJECTS, hostId: "h".repeat(129) }),
      ).toThrow();
      expect(createProjectResultSchema.parse(CREATED)).toEqual(CREATED);
      for (const code of ["needs-password", "wrong-password", "needs-credential"] as const) {
        const refused = { ok: false, failure: { code, message: "x", command: null } } as const;
        expect(createProjectResultSchema.parse(refused)).toEqual(refused);
      }
      expect(() =>
        createProjectResultSchema.parse({
          ok: false,
          failure: { code: "made-up", message: "x", command: null },
        }),
      ).toThrow();
    });
  },
);
