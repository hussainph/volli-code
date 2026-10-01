import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { VERB_REGISTRY } from "@volli/shared";
import { SecretService } from "./service";
import { SecretStore } from "./store";

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
      const before = service.list();
      expect(before.ok).toBe(true);
      if (!before.ok) throw new Error("missing list");
      expect(before.requests[0]).toMatchObject({ name: input.name, agentSays: input.purpose });
      service.submit(before.requests[0]!.id, sentinel, "session");
      const result = await waiting;
      expect(result).toBe("signed in");
      expect(service.environment("s")[input.name]).toBe(sentinel);
      expect(port.redact(`echo ${sentinel}`)).toBe("echo ‹secret:STRIPE_API_KEY›");
      expect(
        JSON.stringify([before, result, service.list(), logs.map((log) => log.mock.calls)]),
      ).not.toContain(sentinel);
      expect(service.list().ok && service.list()).not.toHaveProperty("value");
    } finally {
      for (const log of logs) log.mockRestore();
    }
  });
  it("has no credential submission/answer/prefill verb", () => {
    expect(JSON.stringify(VERB_REGISTRY)).not.toContain("secret-submit");
    expect(JSON.stringify(VERB_REGISTRY)).not.toContain("secret-replace");
    const { port } = setup();
    expect(Object.keys(port).toSorted()).toEqual(["hasValues", "redact", "request"]);
  });
  it("declines without storing, cancels without leaking a stale answer, and expires Session values", async () => {
    const { service, port } = setup();
    const controller = new AbortController();
    const waiting = port.request(input, controller.signal);
    const list = service.list();
    if (!list.ok) throw new Error("missing list");
    controller.abort();
    expect(await waiting).toBe("still missing");
    expect(() => service.submit(list.requests[0]!.id, sentinel, "session")).toThrow();
    const second = port.request(input, new AbortController().signal);
    const next = service.list();
    if (!next.ok) throw new Error("missing list");
    service.decline(next.requests[0]!.id);
    expect(await second).toBe("declined");
    const third = port.request(input, new AbortController().signal);
    const last = service.list();
    if (!last.ok) throw new Error("missing list");
    service.submit(last.requests[0]!.id, sentinel, "session");
    await third;
    service.endSession("s");
    expect(service.environment("s")).toEqual({});
    expect(port.redact(sentinel)).not.toContain(sentinel);
  });
  it("rejects env-control names and leaves a failed encrypted save waiting for recovery", async () => {
    const { service, port } = setup();
    expect(await port.request({ ...input, name: "BASH_ENV" }, new AbortController().signal)).toBe(
      "still missing",
    );
    const waiting = port.request(input, new AbortController().signal);
    const list = service.list();
    if (!list.ok) throw new Error("missing list");
    expect(() => service.submit(list.requests[0]!.id, sentinel, "project")).toThrow();
    expect(JSON.stringify(service.list())).not.toContain(sentinel);
    service.decline(list.requests[0]!.id);
    expect(await waiting).toBe("declined");
  });
});
