import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { BackendConnection } from "@volli/host-core/cloud-runner";
import { runnerSleepSimulation } from "./smoke-power";

afterEach(() => vi.useRealTimers());
const create = (emit = vi.fn()) =>
  runnerSleepSimulation({ dev: true, env: { VOLLI_SMOKE_CLOUD_RUNNER_POWER: "1" }, emit })!;

describe("power/link simulation", () => {
  it("requires both locks", () => {
    for (const dev of [true, false])
      for (const flag of [undefined, "0", "1"]) {
        const result = runnerSleepSimulation({
          dev,
          env: { VOLLI_SMOKE_CLOUD_RUNNER_POWER: flag },
          emit: vi.fn(),
        });
        expect(result !== null).toBe(dev && flag === "1");
      }
  });
  it("uses the real asleep report, then holds every runner connection down until resume", async () => {
    const emit = vi.fn();
    const simulation = create(emit);
    const mutation = vi.fn(async () => "ack");
    const query = vi.fn(async () => "facts");
    const close = vi.fn(async () => {});
    let update: ((value: unknown) => void) | undefined;
    let change: ((connected: boolean) => void) | undefined;
    const live: BackendConnection = {
      mutation,
      query,
      close,
      isConnected: () => true,
      onUpdate: (_name, _args, listener) => {
        update = listener;
        return () => {};
      },
      onConnectionChange: (listener) => {
        change = listener;
        return () => {};
      },
    };
    const connect = vi.fn(() => live);
    const wrapped = simulation.wrap(connect);
    const connection = wrapped(async () => null);
    const onChange = vi.fn();
    const off = connection.onConnectionChange(onChange);
    const onUpdate = vi.fn();
    connection.onUpdate("inbox", {}, onUpdate);
    expect(await connection.query!("context", {})).toBe("facts");
    update!("before");
    change!(true);
    expect(onChange).toHaveBeenCalledWith(true);
    const sleeping = simulation.suspend();
    expect(emit).toHaveBeenCalledExactlyOnceWith("suspend");
    await expect(simulation.suspend()).rejects.toThrow("already pending");
    await connection.mutation("runners:reportState", { state: "asleep" });
    await sleeping;
    expect(close).toHaveBeenCalledOnce();
    expect(connection.isConnected()).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith(false);
    change!(true);
    update!("after");
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith("before");
    await expect(connection.mutation("runnerJobs:claim", {})).rejects.toThrow("link held down");
    await expect(connection.query!("context", {})).rejects.toThrow();
    const inert = wrapped(async () => null);
    expect(connect).toHaveBeenCalledOnce();
    expect(inert.isConnected()).toBe(false);
    await expect(inert.mutation("runners:heartbeat", {})).rejects.toThrow();
    await expect(inert.query!("context", {})).rejects.toThrow();
    inert.onConnectionChange(vi.fn())();
    inert.onUpdate("inbox", {}, vi.fn())();
    await inert.close();
    await connection.close();
    await simulation.suspend();
    simulation.resume();
    expect(emit).toHaveBeenLastCalledWith("resume");
    const fresh = wrapped(async () => null);
    expect(fresh.isConnected()).toBe(true);
    await fresh.close();
    expect(close).toHaveBeenCalledTimes(2);
    off();
    expect(() => simulation.resume()).toThrow("not in simulated sleep");
  });
  it("fails rather than simulating successful sleep if the report fails or never arrives", async () => {
    vi.useFakeTimers();
    const simulation = create();
    const failed = simulation.suspend();
    const failure = expect(failed).rejects.toThrow("did not report asleep");
    await vi.advanceTimersByTimeAsync(3_000);
    await failure;
    const bad = simulation.wrap(() => ({
      mutation: async () => {
        throw new Error("offline");
      },
      close: async () => {},
      isConnected: () => true,
      onConnectionChange: () => () => {},
      onUpdate: () => () => {},
    }))(async () => null);
    const sleeping = simulation.suspend();
    const rejected = expect(sleeping).rejects.toThrow("offline");
    await expect(bad.mutation("runners:reportState", { state: "asleep" })).rejects.toThrow(
      "offline",
    );
    await rejected;
    await expect(bad.query!("context", {})).rejects.toThrow();
    await bad.close();
  });
});
