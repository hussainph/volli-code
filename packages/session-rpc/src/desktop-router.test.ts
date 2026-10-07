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
  OperationUnavailableError,
  REMOTE_HOST_DEVICE_TEXT_MAX,
  REMOTE_HOST_DEVICES_MAX,
  REMOTE_HOST_NAME_MAX,
  REMOTE_HOST_UPDATE_UNAVAILABLE,
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
  type DesktopRouter,
  type DesktopRouterContext,
  type DesktopRouterHandlers,
  type DesktopStreamSink,
} from "./desktop-router";
import { RpcDiagnosticLog } from "./index";
import {
  addHostEventSchema,
  addHostFactsSchema,
  remoteHostDevicesSchema,
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
    for (const key of ["hosts.subscribe", "hostAdd.subscribe", "hostSignIns.run"]) {
      expect(schemas[key], key).toMatchObject({
        type: "subscription",
        outputValidation: "documented-yield",
      });
    }
    expect(schemas["hosts.subscribe"]!.output).toBe(remoteHostsSnapshotSchema);
    expect(schemas["hostAdd.subscribe"]!.output).toBe(addHostEventSchema);
    // Every schema publishes as JSON Schema: no transform, no custom parser.
    for (const [key, { input, output }] of Object.entries(schemas)) {
      expect(() => z.toJSONSchema(input, { io: "input" }), key).not.toThrow();
      expect(() => z.toJSONSchema(output, { io: "output" }), key).not.toThrow();
    }
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
