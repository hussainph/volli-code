// @vitest-environment node
/** A hostile enrolled HOST peer cannot bypass main's Model Access output validation. */
import { initTRPC } from "@trpc/server";
import { admittedHandlers, createHostHandlers, ROUTER_POLICY } from "@volli/host-core/handlers";
import type { HostConnectionWelcome } from "@volli/host-protocol";
import { createHostScopeLink } from "@volli/host-protocol/client-link";
import { createIpcServer } from "@volli/host-protocol/ipc-server";
import { servedIpcContractLink } from "@volli/host-protocol/testing";
import {
  createDesktopRouter,
  LOCAL_DESKTOP_CALLER,
  RpcDiagnosticLog,
  type DesktopIpcRouter,
} from "@volli/session-rpc";
import { startHostProtocolListener } from "@volli/session-rpc/websocket";
import { EMPTY_MODEL_ACCESS_DEFAULTS } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { relayHostScope } from "../renderer/src/lib/relay-host-scope";
import { createHostScopeRelay, engineHostScopeLinks } from "./host-link-relay";

vi.mock("./broadcast", () => ({ resetDataChangedForTest() {} }));
const HOST = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const DEVICE = "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b";
const selection = { providerId: "fixture", modelId: "model", reasoningLevel: "off" };
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
async function ready(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("HOST model fixture did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const cases = [
  {
    method: "inspect",
    kind: "query",
    input: {},
    value: { observedAt: 1, providers: [], models: [] },
  },
  { method: "defaults", kind: "query", value: EMPTY_MODEL_ACCESS_DEFAULTS },
  {
    method: "setDefault",
    kind: "mutate",
    input: { purpose: "global", selection },
    value: { ...EMPTY_MODEL_ACCESS_DEFAULTS, global: selection },
  },
  { method: "hiddenModels", kind: "query", value: [] },
  { method: "setHiddenModels", kind: "mutate", input: [], value: [] },
  { method: "compactionPolicy", kind: "query", value: { autoCompaction: true } },
  {
    method: "setCompactionPolicy",
    kind: "mutate",
    input: { autoCompaction: false },
    value: { autoCompaction: false },
  },
  { method: "codeModePolicy", kind: "query", value: { enabled: true, models: {} } },
  {
    method: "setCodeModePolicy",
    kind: "mutate",
    input: { enabled: false, models: {} },
    value: { enabled: false, models: {} },
  },
  { method: "pickerView", kind: "query", value: "all" },
  { method: "setPickerView", kind: "mutate", input: "all", value: "all" },
] as const;

async function fixture(features: readonly string[] = ["host.model-defaults"]) {
  let answer: unknown;
  const calls: string[] = [];
  const t = initTRPC.context<{ welcome?: HostConnectionWelcome }>().create();
  // Deliberately no output validators: an enrolled box need not run our server code.
  const hostModels = Object.fromEntries(
    cases.map(({ method, kind }) => {
      const procedure = t.procedure.input((input: unknown) => input);
      const respond = () => {
        calls.push(method);
        return answer;
      };
      return [method, kind === "query" ? procedure.query(respond) : procedure.mutation(respond)];
    }),
  );
  const listener = await startHostProtocolListener({
    router: t.router({
      protocol: t.router({
        welcome: t.procedure.query(({ ctx }) => ctx.welcome),
        hostWelcome: t.procedure.query(({ ctx }) => ctx.welcome),
      }),
      hostModels: t.router(hostModels),
    }),
    bind: { host: "127.0.0.1", port: 0 },
    host: { id: HOST, version: "1.2.0" },
    workspace: () => {
      throw new Error("Model Access must not borrow a Workspace");
    },
    features,
    verifier: {
      verify: (presentation) =>
        "scope" in presentation
          ? { actor: { scope: "host", kind: "device", deviceId: DEVICE }, current: () => true }
          : null,
    },
    context: () => ({}),
  });
  cleanups.push(() => listener.close());
  const link = createHostScopeLink({
    url: listener.url,
    hostId: HOST,
    client: { kind: "desktop", version: "1.2.0" },
    credential: () => "test-only-device",
    features: ["host.model-defaults"],
  });
  cleanups.push(() => link.close());
  await ready(() => link.getState().status === "ready");
  const relay = createHostScopeRelay(
    engineHostScopeLinks({
      snapshot: () => ({ hosts: [{ id: HOST }] }),
      hostScopeLink: () => link,
    }),
  );
  const handlers = admittedHandlers(
    createHostHandlers({ events: { publish() {} }, attention: { deliver: () => ({}) } } as never, {
      db: null,
      dataDir: "",
      runtime: null,
      sessions: null,
      modelAccess: null,
      experiments: null,
      automations: { kind: "degraded" } as never,
      busyWorktreeSites: async () => [],
      hostScopeRelay: relay,
    }),
    ROUTER_POLICY,
  );
  const connection = await servedIpcContractLink<undefined, DesktopIpcRouter>({
    serve: async () =>
      createIpcServer({
        routers: [createDesktopRouter()],
        served: ["hostScope.query", "hostScope.mutate"],
        createContext: () => ({
          caller: LOCAL_DESKTOP_CALLER,
          handlers,
          diagnostics: new RpcDiagnosticLog(),
        }),
      }),
  }).open(undefined);
  cleanups.push(() => connection.close());
  const view = relayHostScope(HOST, {
    rpc: connection.client,
    state: { getState: () => ({ status: "open" }), subscribe: () => () => {} },
  });
  return {
    view,
    link,
    calls,
    answer: (next: unknown) => {
      answer = next;
    },
  };
}

describe("HOST models across real loopback and renderer IPC", () => {
  it("validates every catalog/preference answer before the renderer and refuses wrong procedure kinds", async () => {
    const f = await fixture();
    for (const row of cases) {
      const path = `hostModels.${row.method}`;
      const input = "input" in row ? row.input : undefined;
      f.answer(row.value);
      expect(await f.view[row.kind](path, input)).toEqual(row.value);
      for (const invalid of [null, { unexpected: "unvalidated host object" }]) {
        f.answer(invalid);
        await expect(f.view[row.kind](path, input)).rejects.toMatchObject({
          data: {
            hostError: {
              code: "BAD_GATEWAY",
              reason: "response-invalid",
              message: "The host returned an invalid response.",
            },
          },
        });
      }
      const before = f.calls.length;
      await expect(
        f.view[row.kind === "query" ? "mutate" : "query"](path, input),
      ).rejects.toMatchObject({ data: { hostError: { reason: "verb-refused" } } });
      expect(f.calls).toHaveLength(before);
    }
    f.answer({
      ...EMPTY_MODEL_ACCESS_DEFAULTS,
      global: { ...selection, reasoningLevel: "future-level" },
    });
    await expect(f.view.query("hostModels.defaults")).rejects.toMatchObject({
      data: { hostError: { reason: "response-invalid" } },
    });
    f.answer({
      observedAt: 1,
      providers: [],
      models: [
        {
          ...selection,
          label: "vdc1.body.signature",
          state: "available",
          reasoningLevels: ["off"],
        },
      ],
    });
    await expect(f.view.query("hostModels.inspect", {})).rejects.toMatchObject({
      data: { hostError: { reason: "response-invalid" } },
    });
    const before = f.calls.length;
    await expect(f.view.query("modelAccess.defaults")).rejects.toMatchObject({
      data: { hostError: { reason: "verb-refused" } },
    });
    expect(f.calls).toHaveLength(before);
    f.link.close();
    await expect(f.view.query("hostModels.defaults")).rejects.toThrow("can’t be reached");
  });
  it.each([
    { method: "codeModePolicy", kind: "query" },
    { method: "setCodeModePolicy", kind: "mutate" },
  ] as const)(
    "refuses unsafe record keys in $method before renderer IPC",
    async ({ method, kind }) => {
      const f = await fixture();
      const path = `hostModels.${method}`;
      const input = kind === "mutate" ? { enabled: true, models: {} } : undefined;
      const safe = { enabled: true, models: { "fixture/model": "only" } };
      f.answer(safe);
      expect(await f.view[kind](path, input)).toEqual(safe);
      const heldKey = "fixture/test-only-device";
      expect(f.link.redactDiagnostic(heldKey)).not.toBe(heldKey);
      for (const key of [heldKey, "fixture/vdc1.fixture.signature", "fixture/model\u0007"]) {
        f.answer({ enabled: true, models: { [key]: "only" } });
        await expect(f.view[kind](path, input)).rejects.toMatchObject({
          data: {
            hostError: {
              code: "BAD_GATEWAY",
              reason: "response-invalid",
              message: "The host returned an invalid response.",
            },
          },
        });
        expect(f.calls.at(-1)).toBe(method);
      }
    },
  );
  it("an older host's missing grant refuses without invoking any model handler", async () => {
    const f = await fixture([]);
    await expect(f.view.query("hostModels.defaults")).rejects.toMatchObject({
      data: { hostError: { reason: "verb-refused" } },
    });
    expect(f.calls).toEqual([]);
  });
});
