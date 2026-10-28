import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SecretStore } from "./store";
import { SecretService } from "./service";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const owner = {
  sessionId: "s",
  sessionLabel: "Session",
  projectId: "p",
  projectLabel: "Project",
};
const codec = {
  isEncryptionAvailable: () => false,
  encryptString: (): Buffer => {
    throw new Error("unused");
  },
  decryptString: (): string => {
    throw new Error("unused");
  },
};
function setup() {
  const dir = mkdtempSync(join(process.cwd(), ".secret-queue-test-"));
  dirs.push(dir);
  const path = join(dir, "session-secrets.enc");
  const store = new SecretStore(path, codec);
  const service = new SecretService(store);
  const wait = { opened: vi.fn(async () => {}), settled: vi.fn(async () => {}) };
  const port = service.port(owner, wait);
  return { service, port, wait, path };
}
const input = (name: string, toolCallId = name) => ({ name, toolCallId });
const signal = () => new AbortController().signal;
async function requests(service: SecretService) {
  const list = await service.list();
  if (!list.ok) throw new Error("Missing request list");
  return list.requests;
}

describe("secret request queue", () => {
  it("opens every sequential and parallel call, then returns signed in for each", async () => {
    const { service, port, wait } = setup();
    const first = port.request(input("DEPLOY_TOKEN"), signal());
    await service.submit((await requests(service))[0]!.id, "fixture-deploy", "session");
    expect(await first).toBe("signed in");

    const names = ["STORAGE_ACCESS_ID", "STORAGE_SECRET_KEY"];
    const parallel = names.map((name) => port.request(input(name), signal()));
    const resumed = parallel.map(() => vi.fn());
    parallel.forEach((promise, index) => void promise.then(resumed[index]!));
    const queued = await requests(service);
    expect(queued.map(({ name }) => name)).toEqual(names);
    expect(wait.opened).toHaveBeenCalledTimes(3);
    expect(resumed.every((callback) => callback.mock.calls.length === 0)).toBe(true);
    await service.submit(queued[0]!.id, "fixture-access", "session");
    expect(await parallel[0]).toBe("signed in");
    expect(resumed[1]).not.toHaveBeenCalled();
    expect((await requests(service)).map(({ name }) => name)).toEqual([names[1]]);
    await service.submit(queued[1]!.id, "fixture-storage", "session");
    expect(await parallel[1]).toBe("signed in");

    const last = port.request(input("AFTER_PARALLEL_TOKEN"), signal());
    await service.submit((await requests(service))[0]!.id, "fixture-last", "session");
    expect(await last).toBe("signed in");
    expect(await requests(service)).toEqual([]);
    expect(service.environment(owner.sessionId)).toEqual({
      DEPLOY_TOKEN: "fixture-deploy",
      STORAGE_ACCESS_ID: "fixture-access",
      STORAGE_SECRET_KEY: "fixture-storage",
      AFTER_PARALLEL_TOKEN: "fixture-last",
    });
    expect(JSON.stringify([wait.opened.mock.calls, wait.settled.mock.calls])).not.toContain(
      "fixture-",
    );
    await port.dispose();
  });

  it("keeps a retry independent of an older pending call and re-prompts after still missing", async () => {
    const { service, port } = setup();
    const old = new AbortController();
    const first = port.request(input("API_TOKEN", "old"), old.signal);
    const retry = port.request(input("API_TOKEN", "retry"), signal());
    const queued = await requests(service);
    expect(queued).toHaveLength(2);
    expect(queued[0]!.id).not.toBe(queued[1]!.id);
    old.abort();
    expect(await first).toBe("still missing");
    expect((await requests(service)).map(({ id }) => id)).toEqual([queued[1]!.id]);
    await service.decline(queued[1]!.id);
    expect(await retry).toBe("declined");
    const fresh = port.request(input("API_TOKEN", "fresh"), signal());
    const pending = (await requests(service))[0]!;
    expect(queued.map(({ id }) => id)).not.toContain(pending.id);
    await service.submit(pending.id, "fixture-retry", "session");
    expect(await fresh).toBe("signed in");
    await port.dispose();
  });

  it("withdraws head or tail without swallowing siblings and clears all on teardown", async () => {
    const { service, port, wait } = setup();
    const pending = ["FIRST_TOKEN", "SECOND_TOKEN", "THIRD_TOKEN"].map((name) =>
      port.request(input(name), signal()),
    );
    const queued = await requests(service);
    await port.withdraw(queued[2]!.id);
    expect(await pending[2]).toBe("still missing");
    expect(wait.settled).not.toHaveBeenCalled();
    await service.decline(queued[0]!.id);
    expect(await pending[0]).toBe("declined");
    expect((await requests(service)).map(({ id }) => id)).toEqual([queued[1]!.id]);
    await port.cancelPending();
    expect(await pending[1]).toBe("still missing");
    expect(await requests(service)).toEqual([]);
    await port.dispose();
    expect(await port.request(input("CLOSED_TOKEN"), signal())).toBe("still missing");
  });

  it("keeps queued prompts waiting on failed saves and failed settlement commits", async () => {
    const { service, port, wait } = setup();
    const first = port.request(input("FIRST_TOKEN"), signal());
    const second = port.request(input("SECOND_TOKEN"), signal());
    const queued = await requests(service);
    expect(() => service.submit(queued[0]!.id, "fixture-value", "always")).toThrow();
    expect(await requests(service)).toEqual(queued);
    wait.settled.mockRejectedValueOnce(new Error("ledger unavailable"));
    await expect(service.submit(queued[0]!.id, "fixture-value", "session")).rejects.toThrow();
    expect(await requests(service)).toEqual(queued);
    await service.submit(queued[0]!.id, "fixture-value", "session");
    expect(await first).toBe("signed in");
    await port.dispose();
    expect(await second).toBe("still missing");
    expect(await requests(service)).toEqual([]);
  });

  it("opens fresh prompts after a host restart without restoring memory-only values or correlations", async () => {
    const { service, port, path } = setup();
    const first = port.request(input("API_TOKEN"), signal());
    await service.submit((await requests(service))[0]!.id, "fixture-value", "session");
    expect(await first).toBe("signed in");
    const interrupted = port.request(input("OTHER_TOKEN"), signal());
    const oldId = (await requests(service))[0]!.id;
    await port.dispose();
    expect(await interrupted).toBe("still missing");
    const restarted = new SecretService(new SecretStore(path, codec));
    const restored = restarted.port(owner);
    expect(restarted.environment(owner.sessionId)).toEqual({});
    for (const name of ["API_TOKEN", "OTHER_TOKEN"]) {
      const next = restored.request(input(name), signal());
      const prompt = (await requests(restarted))[0]!;
      expect(prompt.id).not.toBe(oldId);
      expect(prompt.name).toBe(name);
      await restarted.submit(prompt.id, "fixture-new", "session");
      expect(await next).toBe("signed in");
    }
    expect(() => restarted.submit(oldId, "fixture-stale", "session")).toThrow();
    await restored.dispose();
  });
});
