import { describe, expect, it } from "vite-plus/test";
import type { RuntimeActivityObservation } from "../contracts";
import { OrderedObservationDelivery } from "./ordered-observation-delivery";

function progress(activityId: string): RuntimeActivityObservation {
  return {
    kind: "activity",
    state: "progress",
    turnId: "turn-1",
    activityId,
    descriptor: {
      kind: "read-file",
      nativeToolName: "read",
      subject: { label: "MARKER.txt", path: "MARKER.txt", lineRange: null },
      outcome: null,
      startedAt: 100,
      endedAt: null,
    },
    input: { path: "MARKER.txt" },
    output: null,
  };
}

describe("OrderedObservationDelivery", () => {
  it("serializes concurrent progress observations and retains only the first observer failure", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstEntered = Promise.withResolvers<void>();
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const seen: string[] = [];
    const failure = new Error("durable commit failed");
    const delivery = new OrderedObservationDelivery<RuntimeActivityObservation>(
      async (observation) => {
        seen.push(observation.activityId);
        if (observation.activityId === "first") {
          firstEntered.resolve();
          await firstMayFinish;
          throw failure;
        }
      },
    );

    const pending = Promise.all([
      delivery.deliver(progress("first")),
      delivery.deliver(progress("second")),
      delivery.deliver(progress("third")),
    ]);
    await firstEntered.promise;
    expect(seen).toEqual(["first"]);

    releaseFirst?.();
    await expect(pending).resolves.toEqual([undefined, undefined, undefined]);
    expect(seen).toEqual(["first", "second", "third"]);
    expect(delivery.consumeFailure()).toBe(failure);
    expect(delivery.consumeFailure()).toBeUndefined();

    await delivery.deliver(progress("fourth"));
    expect(seen).toEqual(["first", "second", "third", "fourth"]);
    expect(delivery.consumeFailure()).toBeUndefined();
  });
});
