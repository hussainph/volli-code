// @vitest-environment node
/** Dedicated HOST relay: grants, identity, trace and the same bounded stream owner. */
import { hostError, readHostError } from "@volli/host-protocol";
import type {
  HostScopeLink,
  HostScopeLinkState,
  HostLinkSubscribeOptions,
  HostLinkSubscriptionHandlers,
} from "@volli/host-protocol/client-link";
import type { HostLinkRelayEvent } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";
import { createHostScopeRelay, engineHostScopeLinks } from "./host-link-relay";

vi.mock("./broadcast", () => ({ resetDataChangedForTest() {} }));

const HOST = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const DEVICE = "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b";
const TRACE = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736" };
function fixture() {
  let state: HostScopeLinkState = {
    status: "ready",
    welcome: {
      scope: "host",
      protocolVersion: 1,
      host: { id: HOST, version: "1" },
      actor: { kind: "device", deviceId: DEVICE, scope: "host" },
      features: ["host.workspaces", "host.logs", "sign-ins", "auth.callback"],
      proof: null,
    },
  };
  const watchers = new Set<(state: HostScopeLinkState) => void>();
  const opened: {
    handlers: HostLinkSubscriptionHandlers;
    options: HostLinkSubscribeOptions | undefined;
    stop: ReturnType<typeof vi.fn>;
  }[] = [];
  const link: HostScopeLink = {
    hostId: HOST,
    redactDiagnostic: (text) => text.replaceAll("held-fixture-secret", "[redacted]"),
    getState: () => state,
    subscribeState: (listener) => {
      watchers.add(listener);
      return () => {
        watchers.delete(listener);
      };
    },
    query: vi.fn(async (path) =>
      path === "protocol.hostWelcome"
        ? (state as Extract<HostScopeLinkState, { status: "ready" }>).welcome
        : { workspaces: [], omitted: 0 },
    ),
    mutate: vi.fn(async () => ({
      ok: false,
      failure: { code: "clone-failed", message: "Failed" },
    })),
    subscribe: vi.fn((_path, _input, handlers, options) => {
      const stop = vi.fn();
      opened.push({ handlers, options, stop });
      return { unsubscribe: stop };
    }),
    wake: vi.fn(),
    reconnect: vi.fn(),
    close: vi.fn(),
  };
  let hosts = [{ id: HOST }];
  let held: HostScopeLink | null = link;
  const source = engineHostScopeLinks({
    hostScopeLink: (id) => (id === HOST ? held : null),
    snapshot: () => ({ hosts }),
  });
  const relay = createHostScopeRelay(source, { trace: () => TRACE, streamsPerLink: 1 });
  return {
    link,
    source,
    relay,
    opened,
    watchers,
    forget: () => {
      hosts = [];
    },
    withdraw: () => {
      held = null;
    },
    set: (next: HostScopeLinkState) => {
      state = next;
      for (const listener of watchers) listener(next);
    },
  };
}
async function failure(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    return readHostError(error);
  }
  throw new Error("Expected refusal");
}

describe("HOST relay without a Workspace", () => {
  it("uses enrolled host identity, host bootstrap/grants and request traces", async () => {
    const f = fixture();
    expect(f.source.serves(HOST)).toBe(true);
    expect(f.source.serves("unknown")).toBe(false);
    expect(f.source.hostScopeLink(HOST)).toBe(f.link);
    await f.relay.query(HOST, "protocol.hostWelcome", undefined);
    await f.relay.query(HOST, "workspaces.list", undefined);
    await f.relay.mutate(HOST, "workspaces.create", {
      commandId: DEVICE,
      source: { path: "/project" },
    });
    expect(f.link.query).toHaveBeenLastCalledWith("workspaces.list", undefined, { trace: TRACE });
    expect(f.link.mutate).toHaveBeenCalledWith(
      "workspaces.create",
      { commandId: DEVICE, source: { path: "/project" } },
      { trace: TRACE },
    );
    for (const path of [
      "protocol.welcome",
      "board.snapshot",
      "signIns.status",
      "auth.callback.deliver",
    ])
      expect(await failure(f.relay.query(HOST, path, {}))).toMatchObject({
        reason: "verb-refused",
      });
    f.withdraw();
    expect(await failure(f.relay.query(HOST, "workspaces.list", undefined))).toMatchObject({
      reason: "host-unreachable",
      message: "The host can’t be reached right now.",
    });
    f.forget();
    expect(await failure(f.relay.query(HOST, "workspaces.list", undefined))).toMatchObject({
      reason: "host-unreachable",
      message: "No enrolled host on this Mac has that identity.",
    });
  });

  it("bounds HOST streams, preserves cursors, releases once on loss and owner cancellation", () => {
    const f = fixture();
    const seen: HostLinkRelayEvent[] = [];
    const stop = f.relay.subscribe(HOST, "logs.follow", {}, "cursor-1", (event) => {
      seen.push(event);
    });
    expect(f.opened[0]?.options).toEqual({ trace: TRACE, lastEventId: "cursor-1" });
    expect(f.relay.open()).toBe(1);
    expect(f.relay.open(HOST)).toBe(1);
    const refused: HostLinkRelayEvent[] = [];
    f.relay.subscribe(HOST, "logs.follow", {}, undefined, (event) => {
      refused.push(event);
    });
    expect(refused).toMatchObject([{ kind: "error", error: { reason: "subscription-limit" } }]);
    expect(f.opened).toHaveLength(1);
    f.opened[0]!.handlers.onStarted?.();
    const batch = { entries: [], gap: false, cursor: "cursor-2" };
    f.opened[0]!.handlers.onData({ id: "cursor-2", data: batch }, { id: "cursor-2" });
    f.set({ status: "closed" });
    expect(seen).toMatchObject([
      { kind: "started" },
      { kind: "data", data: { id: "cursor-2", data: batch }, id: "cursor-2" },
      {
        kind: "lost",
        error: { reason: "host-unreachable", message: "The host can’t be reached right now." },
      },
    ]);
    expect(f.relay.open()).toBe(0);
    expect(f.watchers.size).toBe(0);
    stop();
    expect(f.opened[0]!.stop).toHaveBeenCalledOnce();
  });

  it("ends a HOST stream with its own error and does not retain an unavailable stream", () => {
    const f = fixture();
    const seen: HostLinkRelayEvent[] = [];
    f.relay.subscribe(HOST, "logs.follow", {}, undefined, (event) => {
      seen.push(event);
    });
    f.set({
      status: "refused",
      error: hostError("credential-invalid", "Enrollment revoked"),
      closeCode: 4401,
    });
    expect(seen).toMatchObject([{ kind: "lost", error: { message: "Enrollment revoked" } }]);
    f.relay.subscribe(HOST, "logs.follow", {}, undefined, (event) => {
      seen.push(event);
    });
    expect(seen.at(-1)).toMatchObject({ kind: "lost" });
    expect(f.relay.open()).toBe(0);
  });
});

describe("HOST output trust boundary", () => {
  const row = { id: DEVICE, name: "app", path: "/srv/app", gitRemoteUrl: null };
  const batch = { entries: [], cursor: "cursor", gap: false };
  it("refuses invalid and oversized catalogs whole with fixed, named safe errors", async () => {
    const f = fixture();
    for (const value of [
      null,
      { workspaces: [row], omitted: -1 },
      { workspaces: Array.from({ length: 501 }, () => row), omitted: 0 },
      { workspaces: [{ ...row, path: "x".repeat(4097) }], omitted: 0 },
    ]) {
      vi.mocked(f.link.query).mockResolvedValueOnce(value);
      expect(await failure(f.relay.query(HOST, "workspaces.list", undefined))).toEqual(
        hostError("response-invalid", "The host returned an invalid response."),
      );
    }
    for (const field of ["name", "path"]) {
      for (const unsafe of [
        "bad\u0000locator",
        "bad\u202elocator",
        "held-fixture-secret",
        "vdc1.body.signature",
        "ghp_" + "a".repeat(36),
      ]) {
        vi.mocked(f.link.query).mockResolvedValueOnce({
          workspaces: [{ ...row, [field]: unsafe }],
          omitted: 0,
        });
        expect(await failure(f.relay.query(HOST, "workspaces.list", undefined))).toHaveProperty(
          "reason",
          "response-invalid",
        );
      }
    }
  });
  it("preserves safe locators, nulls unsafe remote URLs and scrubs create failures and thrown diagnostics", async () => {
    const f = fixture();
    for (const url of [
      null,
      "https://github.com/owner/repo.git",
      "ssh://git@github.com/owner/repo.git",
      "https://user:password@host/repo.git",
      "https://TOKEN@host/repo.git",
      "https://host/repo.git?token=dummy",
      "https://host/vdc1.body.signature/repo.git",
      `ssh://ghp_${"a".repeat(36)}@host/repo.git`,
      "held-fixture-secret",
    ]) {
      vi.mocked(f.link.query).mockResolvedValueOnce({
        workspaces: [{ ...row, gitRemoteUrl: url }],
        omitted: 2,
      });
      const output = await f.relay.query(HOST, "workspaces.list", undefined);
      expect(output).toEqual({
        workspaces: [
          { ...row, gitRemoteUrl: url === null || url.includes("github.com") ? url : null },
        ],
        omitted: 2,
      });
    }
    vi.mocked(f.link.mutate).mockResolvedValueOnce({ ok: true, workspace: row });
    expect(
      await f.relay.mutate(HOST, "workspaces.create", {
        commandId: DEVICE,
        source: { path: "/srv/app" },
      }),
    ).toEqual({ ok: true, workspace: row });
    vi.mocked(f.link.mutate).mockResolvedValueOnce({
      ok: false,
      failure: {
        code: "clone-failed",
        message:
          "held-fixture-secret https://user:password@host/repo?token=dummy\u0007\n vdc1.body.signature",
      },
    });
    const output = JSON.stringify(
      await f.relay.mutate(HOST, "workspaces.create", {
        commandId: DEVICE,
        source: { path: "/srv/app" },
      }),
    );
    for (const secret of ["held-fixture-secret", "password", "dummy", "vdc1.", "\\u0007"])
      expect(output).not.toContain(secret);
    vi.mocked(f.link.query).mockRejectedValueOnce(
      hostError("host-unreachable", "held-fixture-secret\u0007"),
    );
    expect(await failure(f.relay.query(HOST, "workspaces.list", undefined))).toHaveProperty(
      "message",
      "[redacted]",
    );
  });
  it("scrubs every log string including nested fields/keys, and refuses unsafe cursors", async () => {
    const f = fixture();
    vi.mocked(f.link.query).mockResolvedValueOnce({
      ...batch,
      entries: [
        {
          cursor: "cursor",
          record: {
            ts: "now",
            level: "info",
            component: "test",
            msg: "held-fixture-secret\u0007",
            nested: [
              {
                "held-fixture-secret": "https://user:password@host/p?token=dummy",
                count: 2,
                enabled: true,
                empty: null,
              },
            ],
            token: "opaque",
          },
        },
      ],
    });
    const output = JSON.stringify(await f.relay.query(HOST, "logs.tail", undefined));
    for (const secret of ["held-fixture-secret", "password", "dummy", "opaque", "\\u0007"])
      expect(output).not.toContain(secret);
    vi.mocked(f.link.query).mockResolvedValueOnce({ ...batch, cursor: "held-fixture-secret" });
    expect(await failure(f.relay.query(HOST, "logs.tail", undefined))).toHaveProperty(
      "reason",
      "response-invalid",
    );
  });
  it.each([undefined, { id: "cursor" }])(
    "validates subscription yields before delivery (%j)",
    (tracked) => {
      const f = fixture();
      const seen: HostLinkRelayEvent[] = [];
      f.relay.subscribe(HOST, "logs.follow", {}, undefined, (event) => {
        seen.push(event);
      });
      f.opened[0]!.handlers.onData(
        tracked === undefined ? batch : { id: tracked.id, data: batch },
        tracked,
      );
      expect(seen[0]).toHaveProperty("kind", "data");
      f.opened[0]!.handlers.onData(null, tracked);
      expect(seen[1]).toEqual({
        kind: "error",
        error: hostError("response-invalid", "The host returned an invalid response."),
      });
      expect(f.opened[0]!.stop).toHaveBeenCalledOnce();
      expect(f.relay.open()).toBe(0);
    },
  );
  it("refuses secret-bearing bootstrap proofs without rewriting valid proof identity", async () => {
    const f = fixture();
    const welcome = (f.link.getState() as Extract<HostScopeLinkState, { status: "ready" }>).welcome;
    for (const value of [
      "held-fixture-secret",
      "vdc1.body.signature",
      "https://user:password@host/repo?token=dummy",
      "bad\u202e",
    ]) {
      vi.mocked(f.link.query).mockResolvedValueOnce({
        ...welcome,
        proof: { scheme: "fixture", value },
      });
      expect(await failure(f.relay.query(HOST, "protocol.hostWelcome", undefined))).toMatchObject({
        reason: "response-invalid",
        message: "The host returned an invalid response.",
      });
    }
    const longProof = { ...welcome, proof: { scheme: "fixture", value: "x".repeat(8192) } };
    vi.mocked(f.link.query).mockResolvedValueOnce(longProof);
    expect(await f.relay.query(HOST, "protocol.hostWelcome", undefined)).toEqual(longProof);
  });
  it("refuses unsafe tracking identities independently of the log batch cursor", () => {
    const f = fixture();
    const seen: HostLinkRelayEvent[] = [];
    f.relay.subscribe(HOST, "logs.follow", {}, undefined, (event) => {
      seen.push(event);
    });
    f.opened[0]!.handlers.onData(
      { id: "held-fixture-secret", data: batch },
      { id: "held-fixture-secret" },
    );
    expect(seen).toEqual([
      {
        kind: "error",
        error: hostError("response-invalid", "The host returned an invalid response."),
      },
    ]);
    expect(f.opened[0]!.stop).toHaveBeenCalledOnce();
  });
  it("scrubs subscription errors and resnapshot diagnostics", () => {
    for (const kind of ["onError", "onResnapshot"] as const) {
      const f = fixture();
      const seen: HostLinkRelayEvent[] = [];
      f.relay.subscribe(HOST, "logs.follow", {}, undefined, (event) => {
        seen.push(event);
      });
      f.opened[0]!.handlers[kind](
        hostError("subscription-resnapshot-required", "held-fixture-secret\u0007"),
      );
      expect(seen[0]).toHaveProperty("error.message", "[redacted]");
    }
  });
});
