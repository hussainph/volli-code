import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fileSecretKey, SecretStore, SecretService } from "@volli/host-core/secrets";
import { startChild } from "@volli/host-core/testing";
import { registerSecretIpc } from "./ipc";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
      handlers.set(channel, fn),
  },
}));
const directories: string[] = [];
afterEach(() => {
  handlers.clear();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup() {
  const dir = mkdtempSync(join(process.cwd(), ".secret-ipc-test-"));
  directories.push(dir);
  const store = new SecretStore(join(dir, "session-secrets.enc"), {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error("unused");
    },
    decryptString: () => {
      throw new Error("unused");
    },
  });
  const service = new SecretService(store);
  const sender = { mainFrame: {} };
  registerSecretIpc(service, (candidate) => candidate === sender);
  const invoke = (channel: string, ...args: unknown[]) =>
    handlers.get(channel)!({ sender, senderFrame: sender.mainFrame }, ...args);
  const port = service.port({
    sessionId: "s",
    projectId: "p",
    sessionLabel: "Session s",
    projectLabel: "Project p",
  });
  return { store, service, sender, invoke, port };
}
const value = "IPC-person-credential-sentinel";

describe("dedicated credential IPC", () => {
  it("rejects foreign senders and iframes without calling the service", () => {
    const { service, sender } = setup();
    const submit = vi.spyOn(service, "submit");
    const fn = handlers.get("volli:secret-submit")!;
    const input = { requestId: "fake", value, scope: "session" };
    for (const event of [
      { sender: { mainFrame: {} }, senderFrame: {} },
      { sender, senderFrame: {} },
    ]) {
      const result = fn(event, input);
      expect(result).toMatchObject({ ok: false });
      expect(JSON.stringify(result)).not.toContain(value);
    }
    expect(submit).not.toHaveBeenCalled();
  });
  it("rejects stale/fabricated answers and never serializes exception input or causes", () => {
    const { service, invoke } = setup();
    expect(
      invoke("volli:secret-submit", { requestId: "agent-fabrication", value, scope: "session" }),
    ).toMatchObject({ ok: false });
    vi.spyOn(service, "replace").mockImplementation(() => {
      throw new Error(value, { cause: value });
    });
    const result = invoke("volli:secret-replace", { id: "id", value });
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain(value);
  });
  it.each([
    null,
    [],
    1,
    {},
    { scope: "forever" },
    { scope: "session", requestId: "id", value: 1 },
    { scope: "session", requestId: "id", value: "" },
  ])("refuses malformed credential submissions: %j", (input) => {
    expect(setup().invoke("volli:secret-submit", input)).toMatchObject({ ok: false });
  });
  it("reports settlement failures safely and keeps the Engine wait retryable", async () => {
    const { service, invoke } = setup();
    const settled = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error(value))
      .mockResolvedValue(undefined);
    const port = service.port(
      { sessionId: "s", projectId: "p", sessionLabel: "Session", projectLabel: "Project" },
      {
        opened: async () => {},
        settled,
      },
    );
    const waiting = port.request(
      { name: "API_TOKEN", toolCallId: "c" },
      new AbortController().signal,
    );
    const before = await service.list();
    if (!before.ok) throw new Error("missing metadata");
    const input = { requestId: before.requests[0]!.id, value, scope: "session" };
    const failed = await invoke("volli:secret-submit", input);
    expect(failed).toMatchObject({ ok: false });
    expect(JSON.stringify(failed)).not.toContain(value);
    expect(await service.list()).toMatchObject({ requests: before.requests });
    expect(await invoke("volli:secret-submit", input)).toEqual({ ok: true });
    expect(await waiting).toBe("signed in");
    expect(settled).toHaveBeenCalledTimes(2);
    await port.dispose();
  });
  it("accepts one person submission, metadata-only lists, replacement, revocation and decline", async () => {
    const { invoke, service, store, port } = setup();
    const waiting = port.request(
      { name: "API_TOKEN", toolCallId: "c" },
      new AbortController().signal,
    );
    const list = await service.list();
    if (!list.ok) throw new Error("missing metadata");
    expect(
      await invoke("volli:secret-submit", {
        requestId: list.requests[0]!.id,
        value,
        scope: "session",
      }),
    ).toEqual({ ok: true });
    expect(await waiting).toBe("signed in");
    const metadata = store.list()[0]!;
    expect(JSON.stringify(await invoke("volli:secrets-list", "p"))).not.toContain(value);
    expect(
      await invoke("volli:secret-replace", { id: metadata.id, value: "replacement-sentinel" }),
    ).toEqual({ ok: true });
    expect(store.environment("s", "p")["API_TOKEN"]).toBe("replacement-sentinel");
    expect(await invoke("volli:secret-revoke", metadata.id)).toEqual({ ok: true });
    expect(store.environment("s", "p")).toEqual({});
    const next = port.request(
      { name: "API_TOKEN", toolCallId: "c2" },
      new AbortController().signal,
    );
    const pending = await service.list();
    if (!pending.ok) throw new Error("missing metadata");
    expect(await invoke("volli:secret-decline", pending.requests[0]!.id)).toEqual({ ok: true });
    expect(await next).toBe("declined");
    expect(invoke("volli:secrets-list", 1)).toMatchObject({ ok: false });
  });
  it("lets the person retry or reset locked stored secrets, and nothing else (VC-641)", async () => {
    // Nothing is locked: a reset is refused, generically.
    expect(await setup().invoke("volli:secrets-reset")).toEqual({
      ok: false,
      error: "Could not update the secret. Retry or choose Session storage.",
    });
    const { invoke } = setup();
    const dir = directories.at(-1)!;
    writeFileSync(join(dir, "session-secrets.enc"), "sealed by a keychain that is locked");
    expect(await invoke("volli:secrets-list", "p")).toMatchObject({
      ok: true,
      secrets: [],
      credentials: { state: "locked", reason: "unavailable" },
    });
    expect(await invoke("volli:secrets-unlock")).toMatchObject({
      ok: true,
      credentials: { state: "locked" },
    });
    const foreign = handlers.get("volli:secrets-reset")!({
      sender: { mainFrame: {} },
      senderFrame: {},
    });
    expect(foreign).toMatchObject({ ok: false });
    expect(readdirSync(dir)).toEqual(["host-credentials.lock", "session-secrets.enc"]);
    expect(await invoke("volli:secrets-reset")).toEqual({
      ok: true,
      credentials: { state: "empty", reason: null, unavailable: [] },
    });
    expect(readdirSync(dir)).toEqual([
      "host-credentials.lock",
      expect.stringMatching(/^session-secrets\.enc\.locked-/),
    ]);
  });
  it("never blocks the main thread while another Volli process holds the lock (VC-642)", async () => {
    const dir = mkdtempSync(join(process.cwd(), ".secret-ipc-test-"));
    directories.push(dir);
    const service = new SecretService(
      new SecretStore(join(dir, "session-secrets.enc"), fileSecretKey({ path: join(dir, "key") })),
    );
    service.store.put({ name: "STORED", value: "stored-sentinel", scope: "always" });
    const sender = { mainFrame: {} };
    registerSecretIpc(service, (candidate) => candidate === sender);
    const invoke = (channel: string, ...args: unknown[]) =>
      handlers.get(channel)!({ sender, senderFrame: sender.mainFrame }, ...args);
    const child = startChild({ kind: "hold", lock: join(dir, "host-credentials.lock") });
    try {
      await child.next();
      const order: string[] = [];
      setTimeout(() => order.push("timer"), 10);
      const started = performance.now();
      const listing = (invoke("volli:secrets-list", "p") as Promise<unknown>).then((result) => {
        order.push("settled");
        return result;
      });
      // The handler returned without waiting for the other process.
      expect(performance.now() - started).toBeLessThan(100);
      const settled = await listing;
      // The 10 ms timer ran while the list waited, asynchronously, for the lock.
      expect(order).toEqual(["timer", "settled"]);
      // Still held after the bounded wait: busy for this answer, never a stale ready.
      expect(settled).toEqual({
        ok: true,
        requests: [],
        secrets: [],
        credentials: { state: "locked", reason: "busy", unavailable: ["session-env"] },
      });
      // Injection on the same thread refuses at once rather than stall it.
      const injecting = performance.now();
      expect(() => service.store.environment("s", "p")).toThrow("busy");
      expect(performance.now() - injecting).toBeLessThan(100);
    } finally {
      child.process.kill("SIGKILL");
      await child.exited;
    }
    expect(await invoke("volli:secrets-list", "p")).toMatchObject({
      credentials: { state: "ready" },
      secrets: [{ name: "STORED" }],
    });
  }, 30_000);
});
