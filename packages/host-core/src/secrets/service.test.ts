import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { VERB_REGISTRY } from "@volli/shared";
import { SecretStore } from "./index";
import { retiresSessionSecrets } from "./lifetime";
import { SecretService } from "./service";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup() {
  const dir = mkdtempSync(join(process.cwd(), ".secret-service-test-"));
  dirs.push(dir);
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
  const port = service.port({
    sessionId: "s",
    projectId: "p",
    sessionLabel: "Session s",
    projectLabel: "Project",
  });
  return { service, store, port };
}
const input = { name: "STRIPE_API_KEY", purpose: "Use this in a script", toolCallId: "call" };
const sentinel = "person-only-secret-sentinel";

describe("person-only secret request service", () => {
  it("projects metadata only and resolves with an outcome, not a submitted value", async () => {
    const { service, port } = setup();
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    try {
      const waiting = port.request(input, new AbortController().signal);
      const before = await service.list();
      expect(before.ok).toBe(true);
      if (!before.ok) throw new Error("missing list");
      expect(before.requests[0]).toMatchObject({ name: input.name, agentSays: input.purpose });
      service.submit(before.requests[0]!.id, sentinel, "session");
      const result = await waiting;
      expect(result).toBe("signed in");
      expect(service.environment("s")[input.name]).toBe(sentinel);
      expect(port.redact(`echo ${sentinel}`)).toBe("echo ‹secret:STRIPE_API_KEY›");
      expect(
        JSON.stringify([before, result, await service.list(), logs.map((log) => log.mock.calls)]),
      ).not.toContain(sentinel);
      const listed = await service.list();
      expect(listed.ok && listed).not.toHaveProperty("value");
    } finally {
      for (const log of logs) log.mockRestore();
    }
  });
  it("checking availability never marks any credential used; injection does", async () => {
    const { service, store, port } = setup();
    store.put({ name: input.name, value: sentinel, scope: "session", sessionId: "s" });
    store.put({
      name: "OTHER_TOKEN",
      value: "dummy-other-token",
      scope: "session",
      sessionId: "s",
    });
    expect(await port.request(input, new AbortController().signal)).toBe("signed in");
    expect(store.list().map((item) => item.lastUsedAt)).toEqual([null, null]);
    expect(service.environment("s")[input.name]).toBe(sentinel);
    expect(store.list().every((item) => item.lastUsedAt !== null)).toBe(true);
  });
  it("a done signal preserves live injection, and only executor close retires it", async () => {
    const { service, port } = setup();
    const first = port.request(input, new AbortController().signal);
    const pending = await service.list();
    if (!pending.ok) throw new Error("missing list");
    service.submit(pending.requests[0]!.id, sentinel, "session");
    expect(await first).toBe("signed in");
    if (retiresSessionSecrets({ kind: "session.signaled", signal: "done", reason: null })) {
      await service.endSession("s");
    }
    expect(service.environment("s")[input.name]).toBe(sentinel);
    expect(await port.request(input, new AbortController().signal)).toBe("signed in");
    expect(service.environment("s")[input.name]).toBe(sentinel);
    expect(
      retiresSessionSecrets({ kind: "attachment.closed", attachmentId: "a", outcome: "completed" }),
    ).toBe(true);
    await port.dispose();
    expect(service.environment("s")).toEqual({});
    expect(await port.request(input, new AbortController().signal)).toBe("still missing");
  });
  it("publishes metadata-only waits and settles facts before resuming the request", async () => {
    const { service } = setup();
    const opened = vi.fn(async () => {});
    const commit = Promise.withResolvers<void>();
    const settled = vi.fn(() => commit.promise);
    const port = service.port(
      { sessionId: "s", sessionLabel: "Session s", projectId: "p", projectLabel: "Project" },
      { opened, settled },
    );
    const waiting = port.request(input, new AbortController().signal);
    expect(opened).toHaveBeenCalledTimes(1);
    const list = await service.list();
    if (!list.ok) throw new Error("missing list");
    service.submit(list.requests[0]!.id, sentinel, "session");
    const resumed = vi.fn();
    void waiting.then(resumed);
    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
    expect(settled).toHaveBeenCalledWith(list.requests[0], "signed in");
    expect(resumed).not.toHaveBeenCalled();
    expect(JSON.stringify([opened.mock.calls, settled.mock.calls])).not.toContain(sentinel);
    commit.resolve();
    expect(await waiting).toBe("signed in");
    await port.dispose();
  });
  it("has no credential submission/answer/prefill verb", async () => {
    expect(JSON.stringify(VERB_REGISTRY)).not.toContain("secret-submit");
    expect(JSON.stringify(VERB_REGISTRY)).not.toContain("secret-replace");
    const { port } = setup();
    expect(Object.keys(port).toSorted()).toEqual([
      "cancelPending",
      "dispose",
      "hasValues",
      "redact",
      "request",
      "withdraw",
    ]);
  });
  it("declines without storing, cancels without leaking a stale answer, and expires Session values", async () => {
    const { service, port } = setup();
    const controller = new AbortController();
    const waiting = port.request(input, controller.signal);
    const list = await service.list();
    if (!list.ok) throw new Error("missing list");
    controller.abort();
    expect(await waiting).toBe("still missing");
    expect(() => service.submit(list.requests[0]!.id, sentinel, "session")).toThrow();
    const second = port.request(input, new AbortController().signal);
    const next = await service.list();
    if (!next.ok) throw new Error("missing list");
    service.decline(next.requests[0]!.id);
    expect(await second).toBe("declined");
    const third = port.request(input, new AbortController().signal);
    const last = await service.list();
    if (!last.ok) throw new Error("missing list");
    service.submit(last.requests[0]!.id, sentinel, "session");
    await third;
    await service.endSession("s");
    expect(service.environment("s")).toEqual({});
    expect(port.redact(sentinel)).not.toContain(sentinel);
  });
  it("rejects env-control names and leaves a failed encrypted save waiting for recovery", async () => {
    const { service, port } = setup();
    expect(await port.request({ ...input, name: "BASH_ENV" }, new AbortController().signal)).toBe(
      "still missing",
    );
    const waiting = port.request(input, new AbortController().signal);
    const list = await service.list();
    if (!list.ok) throw new Error("missing list");
    expect(() => service.submit(list.requests[0]!.id, sentinel, "project")).toThrow();
    expect(JSON.stringify(await service.list())).not.toContain(sentinel);
    service.decline(list.requests[0]!.id);
    expect(await waiting).toBe("declined");
  });
  it("reports locked stored secrets and lets a person retry or reset them (VC-641)", async () => {
    const { service, store, port } = setup();
    const dir = dirs.at(-1)!;
    writeFileSync(join(dir, "session-secrets.enc"), "sealed elsewhere");
    const list = await service.list();
    expect(list).toMatchObject({
      ok: true,
      secrets: [],
      credentials: { state: "locked", reason: "unavailable", unavailable: ["session-env"] },
    });
    // Asking for a secret still reaches the person; Session storage still works.
    const waiting = port.request(input, new AbortController().signal);
    const open = await service.list();
    if (!open.ok) throw new Error("missing list");
    expect(() => service.submit(open.requests[0]!.id, sentinel, "always")).toThrow();
    await service.submit(open.requests[0]!.id, sentinel, "session");
    expect(await waiting).toBe("signed in");
    expect(service.environment("s")).toEqual({ [input.name]: sentinel });

    expect(await service.unlock()).toEqual({ ok: true, credentials: store.status() });
    expect(await service.reset()).toEqual({
      ok: true,
      credentials: { state: "empty", reason: null, unavailable: [] },
    });
    expect(readdirSync(dir).filter((name) => name !== "host-credentials.lock")).toEqual([
      expect.stringMatching(/^session-secrets\.enc\.locked-/),
    ]);
    expect(service.environment("s")).toEqual({ [input.name]: sentinel });
  });
  it("warns when a reset could not be synced to disk, and still reports it done", async () => {
    const { service, store } = setup();
    const status = { state: "empty", reason: null, unavailable: [] } as const;
    vi.spyOn(store, "reset").mockReturnValue({ archive: "a", synced: false, status });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await service.reset()).toEqual({ ok: true, credentials: status });
      expect(warn).toHaveBeenCalledWith(
        "[secrets] saved secrets were set aside, but the directory could not be synced",
      );
    } finally {
      warn.mockRestore();
    }
  });
});
