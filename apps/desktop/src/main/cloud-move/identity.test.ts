import { describe, expect, it, vi } from "vite-plus/test";
import {
  THIS_MAC_RUNNER_OFF,
  type AccountSnapshot,
  type ThisMacRunnerSnapshot,
} from "@volli/shared";
import type { MacRunner } from "../cloud-runner";
import { moveIdentity } from "./identity";

const person = (id: string): AccountSnapshot => ({
  state: "signed-in",
  provider: "dev",
  signingInWith: null,
  failure: null,
  account: {
    userId: id,
    email: null,
    displayName: id,
    deletionPurgeAfter: null,
    backend: "synced",
  },
});
function runner() {
  let current = THIS_MAC_RUNNER_OFF;
  const listeners = new Set<(value: ThisMacRunnerSnapshot) => void>();
  const live: MacRunner = {
    snapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(current);
      return () => {
        listeners.delete(listener);
      };
    },
    start: vi.fn(),
    stop: vi.fn(async () => {}),
    addThisMac: vi.fn(async () => {}),
    removeThisMac: vi.fn(async () => {}),
    refreshCapabilities: vi.fn(),
  };
  return {
    live,
    listeners,
    publish(value: Partial<ThisMacRunnerSnapshot>) {
      current = { ...current, ...value };
      for (const listener of listeners) listener(current);
    },
  };
}
describe("move-only runner identity lifetime", () => {
  it("is lazy, waits for registration rather than treating registering as signed out, and releases it", async () => {
    const r = runner();
    const factory = vi.fn(async () => r.live);
    const identity = moveIdentity({
      account: { snapshot: () => person("person") },
      runner: factory,
      registrationOnly: true,
    });
    expect(factory).not.toHaveBeenCalled();
    const answer = identity.current();
    await vi.waitFor(() => expect(r.live.start).toHaveBeenCalledOnce());
    r.publish({ state: "registering" });
    r.publish({ state: "offline", runnerId: "runner" });
    await expect(answer).resolves.toEqual({ userId: "person", runnerId: "runner" });
    expect(r.listeners.size).toBe(0);
    await identity.release();
    expect(r.live.stop).toHaveBeenCalledOnce();
  });
  it("never borrows an old person's runner after the account changes", async () => {
    let account = person("one");
    const a = runner();
    const b = runner();
    a.publish({ state: "offline", runnerId: "a" });
    b.publish({ state: "offline", runnerId: "b" });
    const factory = vi.fn(async (userId: string) => (userId === "one" ? a.live : b.live));
    const identity = moveIdentity({
      account: { snapshot: () => account },
      runner: factory,
      registrationOnly: true,
    });
    expect(await identity.current()).toEqual({ userId: "one", runnerId: "a" });
    account = person("two");
    expect(await identity.current()).toEqual({ userId: "two", runnerId: "b" });
    expect(a.live.stop).toHaveBeenCalledOnce();
    await identity.release();
  });
  it("shutdown cancels even the engine's signal-less identity read, and removes its observer", async () => {
    const r = runner();
    const identity = moveIdentity({
      account: { snapshot: () => person("person") },
      runner: async () => r.live,
      registrationOnly: true,
    });
    const answer = identity.current();
    await vi.waitFor(() => expect(r.listeners.size).toBe(1));
    await identity.release();
    await expect(answer).resolves.toBeNull();
    expect(r.listeners.size).toBe(0);
  });
  it("creates a fresh runner after an idle release, including after a failed registration", async () => {
    const failed = runner();
    failed.publish({ state: "failed", problem: "unreachable" });
    const next = runner();
    next.publish({ state: "offline", runnerId: "new" });
    const factory = vi.fn().mockResolvedValueOnce(failed.live).mockResolvedValueOnce(next.live);
    const identity = moveIdentity({
      account: { snapshot: () => person("person") },
      runner: factory,
      registrationOnly: true,
    });
    expect(await identity.current()).toBeNull();
    await identity.release();
    expect(await identity.current()).toEqual({ userId: "person", runnerId: "new" });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(failed.live.start).toHaveBeenCalledOnce();
    expect(next.live.start).toHaveBeenCalledOnce();
    await identity.release();
  });
  it("does not start a lazy factory result that an idle release overtook", async () => {
    const stale = runner();
    let finish!: (value: MacRunner) => void;
    const factory = vi.fn(
      () =>
        new Promise<MacRunner>((resolve) => {
          finish = resolve;
        }),
    );
    const identity = moveIdentity({
      account: { snapshot: () => person("person") },
      runner: factory,
      registrationOnly: true,
    });
    const answer = identity.current();
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
    await identity.release();
    finish(stale.live);
    await expect(answer).resolves.toBeNull();
    expect(stale.live.start).not.toHaveBeenCalled();
    expect(stale.live.stop).toHaveBeenCalledOnce();
  });
  it("does not stop the full cloud runner when a move ends", async () => {
    const r = runner();
    r.publish({ state: "online", runnerId: "runner" });
    const identity = moveIdentity({
      account: { snapshot: () => person("person") },
      runner: async () => r.live,
      registrationOnly: false,
    });
    await identity.current();
    await identity.release();
    expect(r.live.stop).not.toHaveBeenCalled();
  });
});
