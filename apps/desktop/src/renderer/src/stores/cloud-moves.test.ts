import { afterEach, describe, expect, it } from "vite-plus/test";
import type { CloudMoveSnapshot } from "@volli/shared";
import {
  bindCloudMoves,
  closeCloudMoves,
  prepareCloudMove,
  showCloudMoves,
  useCloudMovesStore,
} from "./cloud-moves";
import { fakeApi, move, snapshot } from "../components/cloud-moves/test-support";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("durable move view binding", () => {
  it("keeps a failed feed visible until retry re-subscribes, ignoring the old stream afterwards", async () => {
    const api = fakeApi();
    stops.push(bindCloudMoves(api));
    await flush();
    api.onChanged.mock.calls[0]![1]!();
    expect(useCloudMovesStore.getState().error).toContain("Couldn't follow");
    api.onChanged.mock.calls[0]![0]();
    await flush();
    expect(useCloudMovesStore.getState().error).toContain("Couldn't follow");
    useCloudMovesStore.getState().refresh();
    await flush();
    expect(api.onChanged).toHaveBeenCalledTimes(2);
    api.onChanged.mock.calls[0]![1]!();
    expect(useCloudMovesStore.getState().error).toBeNull();
  });
  it("reads persisted moves on startup, follows changes and keeps them when the sheet closes", async () => {
    const api = fakeApi();
    api.snapshot.mockResolvedValue({ ...snapshot, moves: [move] });
    stops.push(bindCloudMoves(api));
    await flush();
    expect(api.onChanged).toHaveBeenCalledBefore(api.snapshot);
    expect(useCloudMovesStore.getState().snapshot?.moves[0]?.moveId).toBe("move");
    showCloudMoves("queue");
    await flush();
    expect(api.onChanged).toHaveBeenCalledTimes(2);
    closeCloudMoves();
    expect(useCloudMovesStore.getState().snapshot?.moves).toHaveLength(1);
    api.snapshot.mockResolvedValue({
      ...snapshot,
      revision: 2,
      moves: [{ ...move, state: "check" }],
    });
    api.onChanged.mock.calls.at(-1)![0]();
    await flush();
    expect(useCloudMovesStore.getState().snapshot?.moves[0]?.state).toBe("check");
    prepareCloudMove("project");
    expect(useCloudMovesStore.getState().sheet).toEqual(
      expect.objectContaining({ kind: "prepare", projectIds: ["project"] }),
    );
  });
  it("never lets a slow read replace a newer journal revision", async () => {
    const api = fakeApi();
    const old = deferred<CloudMoveSnapshot>();
    api.snapshot
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ ...snapshot, revision: 3, moves: [move] });
    stops.push(bindCloudMoves(api));
    api.onChanged.mock.calls[0]![0]();
    await flush();
    old.resolve({ ...snapshot, revision: 1 });
    await flush();
    expect(useCloudMovesStore.getState().snapshot?.revision).toBe(3);
  });
  it("drops facts on disposal and ignores late results from the old person/binding", async () => {
    const api = fakeApi();
    const old = deferred<CloudMoveSnapshot>();
    api.snapshot.mockReturnValue(old.promise);
    const stop = bindCloudMoves(api);
    stop();
    old.resolve({ ...snapshot, moves: [move] });
    await flush();
    expect(useCloudMovesStore.getState().snapshot).toBeNull();
    expect(useCloudMovesStore.getState().api).toBeNull();
  });
  it("keeps the last journal visible on read failure, with a retry", async () => {
    const api = fakeApi();
    stops.push(bindCloudMoves(api));
    await flush();
    api.snapshot.mockRejectedValueOnce(new Error("raw details"));
    api.onChanged.mock.calls[0]![0]();
    await flush();
    expect(useCloudMovesStore.getState().error).toContain("Couldn't read move progress");
    expect(useCloudMovesStore.getState().snapshot?.revision).toBe(1);
    useCloudMovesStore.getState().refresh();
    await flush();
    expect(useCloudMovesStore.getState().error).toBeNull();
  });
});
