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
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("durable move view binding", () => {
  it("keeps sheet navigation and refresh harmless before a binding exists", () => {
    useCloudMovesStore.getState().refresh();
    prepareCloudMove();
    expect(useCloudMovesStore.getState().sheet).toMatchObject({ kind: "prepare" });
    expect(useCloudMovesStore.getState().sheet).not.toHaveProperty("projectIds");
    showCloudMoves();
    expect(useCloudMovesStore.getState().sheet).toMatchObject({ kind: "progress" });
    showCloudMoves("queue", "move");
    expect(useCloudMovesStore.getState().sheet).toMatchObject({
      queueId: "queue",
      cancelMoveId: "move",
    });
    closeCloudMoves();
  });
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
    const reads = api.snapshot.mock.calls.length;
    api.onChanged.mock.calls[0]![0]();
    await flush();
    expect(api.snapshot).toHaveBeenCalledTimes(reads);
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
    api.onChanged.mock.calls[0]![0]();
    api.onChanged.mock.calls[0]![1]!();
    useCloudMovesStore.getState().refresh();
    expect(api.snapshot).toHaveBeenCalledOnce();
    old.resolve({ ...snapshot, moves: [move] });
    await flush();
    expect(useCloudMovesStore.getState().snapshot).toBeNull();
    expect(useCloudMovesStore.getState().api).toBeNull();
  });
  it("ignores superseded and disposed read failures", async () => {
    const api = fakeApi();
    const superseded = deferred<CloudMoveSnapshot>();
    api.snapshot.mockReturnValueOnce(superseded.promise);
    const stop = bindCloudMoves(api);
    api.onChanged.mock.calls[0]![0]();
    await flush();
    superseded.reject(new Error("late old read"));
    await flush();
    expect(useCloudMovesStore.getState().error).toBeNull();
    const disposed = deferred<CloudMoveSnapshot>();
    api.snapshot.mockReturnValueOnce(disposed.promise);
    api.onChanged.mock.calls[0]![0]();
    stop();
    disposed.reject(new Error("late disposed read"));
    await flush();
    expect(useCloudMovesStore.getState().error).toBeNull();
    expect(useCloudMovesStore.getState().snapshot).toBeNull();
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
