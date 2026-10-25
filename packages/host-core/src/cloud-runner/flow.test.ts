import { describe, expect, it } from "vite-plus/test";

import { createMutationGate } from "./flow";

const later = () => {
  let release!: (value?: unknown) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise((done, reject) => {
    release = done;
    fail = reject;
  });
  return { promise, release, fail };
};

describe("the mutation gate", () => {
  it("holds at most maxInFlight, and serves control before live before backlog", async () => {
    const gate = createMutationGate({ maxInFlight: 1, maxBytes: 1_000 });
    const order: string[] = [];
    const first = later();
    const running = gate.run("backlog", 1, () => {
      order.push("first");
      return first.promise;
    });
    const queued = (["backlog", "live", "control"] as const).map((priority) =>
      gate.run(priority, 1, async () => {
        order.push(priority);
      }),
    );
    expect(gate.inFlight).toBe(1);
    expect(gate.inFlightBytes).toBe(1);
    expect(gate.waiting).toBe(3);
    first.release("done");
    await expect(running).resolves.toBe("done");
    await Promise.all(queued);
    expect(order).toEqual(["first", "control", "live", "backlog"]);
    expect(gate.inFlight).toBe(0);
  });

  it("keeps the byte budget, but sends one call over it alone", async () => {
    const gate = createMutationGate({ maxInFlight: 10, maxBytes: 100 });
    const a = later();
    const big = later();
    const pa = gate.run("live", 60, () => a.promise);
    const pb = gate.run("live", 60, async () => "b");
    expect(gate.inFlight).toBe(1);
    a.release();
    await pa;
    await expect(pb).resolves.toBe("b");
    const pbig = gate.run("backlog", 500, () => big.promise);
    expect(gate.inFlightBytes).toBe(500);
    big.release("big");
    await expect(pbig).resolves.toBe("big");
  });

  it("frees the slot when a call rejects or throws", async () => {
    const gate = createMutationGate({ maxInFlight: 1, maxBytes: 100 });
    const failing = later();
    const pa = gate.run("control", 1, () => failing.promise);
    failing.fail(new Error("no"));
    await expect(pa).rejects.toThrow("no");
    await expect(
      gate.run("control", 1, () => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
    await expect(gate.run("control", 1, async () => "ok")).resolves.toBe("ok");
  });

  it("uses the documented limits by default", async () => {
    const gate = createMutationGate();
    const held = Array.from({ length: 33 }, () => later());
    const runs = held.map((h) => gate.run("live", 1, () => h.promise));
    expect(gate.inFlight).toBe(32);
    expect(gate.waiting).toBe(1);
    for (const h of held) h.release();
    await Promise.all(runs);
  });
});
