import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SecretStore } from "@volli/host-core/secrets";
import { SecretService } from "@volli/host-core/secrets/service";
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
    const before = service.list();
    if (!before.ok) throw new Error("missing metadata");
    const input = { requestId: before.requests[0]!.id, value, scope: "session" };
    const failed = await invoke("volli:secret-submit", input);
    expect(failed).toMatchObject({ ok: false });
    expect(JSON.stringify(failed)).not.toContain(value);
    expect(service.list()).toMatchObject({ requests: before.requests });
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
    const list = service.list();
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
    expect(JSON.stringify(invoke("volli:secrets-list", "p"))).not.toContain(value);
    expect(
      invoke("volli:secret-replace", { id: metadata.id, value: "replacement-sentinel" }),
    ).toEqual({ ok: true });
    expect(store.environment("s", "p")["API_TOKEN"]).toBe("replacement-sentinel");
    expect(invoke("volli:secret-revoke", metadata.id)).toEqual({ ok: true });
    expect(store.environment("s", "p")).toEqual({});
    const next = port.request(
      { name: "API_TOKEN", toolCallId: "c2" },
      new AbortController().signal,
    );
    const pending = service.list();
    if (!pending.ok) throw new Error("missing metadata");
    expect(await invoke("volli:secret-decline", pending.requests[0]!.id)).toEqual({ ok: true });
    expect(await next).toBe("declined");
    expect(invoke("volli:secrets-list", 1)).toMatchObject({ ok: false });
  });
});
