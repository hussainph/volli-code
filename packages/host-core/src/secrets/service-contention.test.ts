import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CREDENTIAL_LOCK_FILE_NAME,
  CredentialLock,
  CredentialLockBusyError,
} from "./credential-lock";
import { fileSecretKey } from "./file-key";
import { CREDENTIAL_DOOR_WAIT_MS, SecretService } from "./service";
import { SecretStore } from "./store";
import { startChild } from "./test-support/processes";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) {
    new CredentialLock(join(dir, CREDENTIAL_LOCK_FILE_NAME)).close();
    rmSync(dir, { recursive: true, force: true });
  }
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "volli-secret-service-contention-"));
  dirs.push(dir);
  const store = new SecretStore(
    join(dir, "session-secrets.enc"),
    fileSecretKey({ path: join(dir, "fixture.key") }),
  );
  const record = store.put({ name: "API_TOKEN", value: "fixture-token", scope: "always" });
  const service = new SecretService(store);
  const port = service.port({
    sessionId: "s",
    sessionLabel: "Session",
    projectId: "p",
    projectLabel: "Project",
  });
  return { store, service, port, record, lock: join(dir, CREDENTIAL_LOCK_FILE_NAME) };
}

describe("Session-use credential contention", () => {
  it("waits without blocking for injection, availability and writes beyond the old person-door budget", async () => {
    const { service, port, record, lock } = setup();
    const child = startChild({ kind: "hold", lock, ms: 2500 });
    try {
      expect(await child.next()).toEqual({ held: true });
      expect(() => service.environment("s")).toThrow(CredentialLockBusyError);
      let ticked = false;
      setTimeout(() => {
        ticked = true;
      }, 10);
      const env = service.environmentAsync("s");
      const available = port.request(
        { name: "API_TOKEN", toolCallId: "call" },
        new AbortController().signal,
      );
      const saved = service.replace(record.id, "fixture-token");
      await saved;
      expect(await env).toEqual({ API_TOKEN: "fixture-token" });
      expect(await available).toBe("signed in");
      expect(ticked).toBe(true);
      expect(await service.list()).toMatchObject({ requests: [], credentials: { state: "ready" } });
    } finally {
      child.process.kill("SIGKILL");
      await child.exited;
    }
  }, 30_000);

  it("bounds a stuck lock: no injected values, no false availability and a busy status", async () => {
    const { service, store, lock } = setup();
    const child = startChild({ kind: "hold", lock });
    try {
      expect(await child.next()).toEqual({ held: true });
      vi.useFakeTimers();
      const injection = expect(service.environmentAsync("s")).rejects.toThrow(
        CredentialLockBusyError,
      );
      const availability = expect(store.availableAsync("API_TOKEN", "s", "p")).rejects.toThrow(
        CredentialLockBusyError,
      );
      const listing = service.list();
      await vi.advanceTimersByTimeAsync(CREDENTIAL_DOOR_WAIT_MS);
      await injection;
      await availability;
      expect(await listing).toMatchObject({
        secrets: [],
        credentials: { state: "locked", reason: "busy" },
      });
    } finally {
      vi.useRealTimers();
      child.process.kill("SIGKILL");
      await child.exited;
    }
    expect(await service.environmentAsync("s")).toEqual({ API_TOKEN: "fixture-token" });
  }, 30_000);

  it("cancels stuck availability and injection promptly, without prompts or last-use writes", async () => {
    const { service, port, store, lock } = setup();
    const child = startChild({ kind: "hold", lock });
    try {
      expect(await child.next()).toEqual({ held: true });
      const controller = new AbortController();
      const request = port.request({ name: "API_TOKEN", toolCallId: "call" }, controller.signal);
      const env = expect(service.environmentAsync("s", controller.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
      controller.abort();
      expect(await request).toBe("still missing");
      await env;
      const closing = port.request(
        { name: "API_TOKEN", toolCallId: "closing" },
        new AbortController().signal,
      );
      await port.dispose();
      expect(await closing).toBe("still missing");
    } finally {
      child.process.kill("SIGKILL");
      await child.exited;
    }
    expect(store.list()[0]?.lastUsedAt).toBeNull();
    expect(await service.list()).toMatchObject({ requests: [] });
  }, 30_000);

  it("reports an unusable lock without retrying, and an unknown owner injects nothing", async () => {
    const { service, store, lock } = setup();
    new CredentialLock(lock).close();
    rmSync(lock);
    mkdirSync(lock);
    expect(await store.statusAsync()).toMatchObject({ reason: "lock-unusable" });
    expect(await store.availableAsync("MISSING", "s", "p")).toBe(false);
    expect(await service.environmentAsync("unknown")).toEqual({});
  });
});
