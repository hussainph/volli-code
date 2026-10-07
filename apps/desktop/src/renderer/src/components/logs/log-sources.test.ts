import type { HostLogEntry, HostLogsBatch } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  batchOf,
  hostLinkLogSource,
  localLogSource,
  registerRemoteLogSource,
  remoteLogSources,
  type LocalLogClient,
  type LogSourceHandlers,
  type LogSourceLink,
} from "./log-sources";

const entry = (cursor: string): HostLogEntry => ({
  cursor,
  record: { ts: "2026-10-07T00:00:00.000Z", level: "info", component: "c", msg: cursor },
});
const page = (cursor: string, gap = false): HostLogsBatch => ({
  entries: [entry(cursor)],
  gap,
  cursor,
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function recorder() {
  const lines: [string[], boolean][] = [];
  const statuses: [string, string | undefined][] = [];
  const handlers: LogSourceHandlers = {
    onLines: (entries, gap) => lines.push([entries.map(({ cursor }) => cursor), gap]),
    onStatus: (status, detail) => statuses.push([status, detail]),
  };
  return { lines, statuses, handlers };
}

describe("the viewer's sources", () => {
  it("reads a batch out of any frame envelope", () => {
    expect(batchOf(page("a"))).toEqual(page("a"));
    expect(batchOf({ id: "a", data: page("a") })).toEqual(page("a"));
    expect(batchOf({ id: "a" })).toBeNull();
    expect(batchOf(null)).toBeNull();
  });

  it("reads this Mac's recent page, then follows from its cursor", async () => {
    let push!: (value: unknown) => void;
    let fail!: (error: unknown) => void;
    const unsubscribe = vi.fn();
    const follow = vi.fn(
      (
        _input: { after?: string },
        handlers: { onData?(v: unknown): void; onError?(e: unknown): void },
      ) => {
        push = handlers.onData!;
        fail = handlers.onError!;
        return { unsubscribe };
      },
    );
    const client: LocalLogClient = {
      logs: { tail: { query: async () => page("i:1") }, follow: { subscribe: follow } },
    };
    const { lines, statuses, handlers } = recorder();
    const stop = localLogSource(() => client).start(handlers);
    await flush();
    expect(follow).toHaveBeenCalledWith({ after: "i:1" }, expect.anything());
    push({ id: "i:2", data: page("i:2", true) });
    push({ id: "nothing" });
    fail(new Error("bridge gone"));
    expect(lines).toEqual([
      [["i:1"], false],
      [["i:2"], true],
    ]);
    expect(statuses).toEqual([
      ["connecting", undefined],
      ["live", undefined],
      ["failed", "bridge gone"],
    ]);
    stop();
    expect(unsubscribe).toHaveBeenCalled();
    push(page("i:3"));
    fail("late");
    expect(lines).toHaveLength(2);
  });

  it("says a source failed when its first read fails, and ignores a read that lands after stop", async () => {
    const failing: LocalLogClient = {
      logs: {
        tail: { query: async () => Promise.reject("refused") },
        follow: { subscribe: () => ({ unsubscribe: () => undefined }) },
      },
    };
    const first = recorder();
    localLogSource(() => failing).start(first.handlers);
    await flush();
    expect(first.statuses.at(-1)).toEqual(["failed", "refused"]);

    const late = recorder();
    const stop = localLogSource(() => failing).start(late.handlers);
    stop();
    await flush();
    expect(late.statuses).toEqual([["connecting", undefined]]);
    const slow = recorder();
    const stopSlow = localLogSource(() => ({
      ...failing,
      logs: { ...failing.logs, tail: { query: async () => page("x") } },
    })).start(slow.handlers);
    stopSlow();
    await flush();
    expect(slow.lines).toEqual([]);
  });

  it("reads a remote host's log over its link's host.logs", async () => {
    let handlersOf!: Parameters<LogSourceLink["subscribe"]>[2];
    const calls: unknown[] = [];
    const link: LogSourceLink = {
      query: async (path, input) => {
        calls.push([path, input]);
        return page("r:1");
      },
      subscribe: (path, input, handlers) => {
        calls.push([path, input]);
        handlersOf = handlers;
        return { unsubscribe: () => undefined };
      },
    };
    const { lines, statuses, handlers } = recorder();
    const source = hostLinkLogSource({ id: "box", label: "Box", link });
    expect(source).toMatchObject({ id: "box", label: "Box" });
    source.start(handlers);
    await flush();
    handlersOf.onData(page("r:2"));
    handlersOf.onData("garbage");
    handlersOf.onResnapshot(new Error("resnapshot"));
    expect(calls).toEqual([
      ["logs.tail", { limit: 500 }],
      ["logs.follow", { after: "r:1" }],
    ]);
    expect(lines.map(([cursors]) => cursors)).toEqual([["r:1"], ["r:2"]]);
    expect(statuses.at(-1)).toEqual(["failed", "resnapshot"]);
  });

  it("registers remote hosts until their owner removes them", () => {
    const box = hostLinkLogSource({ id: "box", label: "Box", link: {} as LogSourceLink });
    const again = hostLinkLogSource({ id: "box", label: "Box 2", link: {} as LogSourceLink });
    const remove = registerRemoteLogSource(box);
    expect(remoteLogSources()).toEqual([box]);
    const removeAgain = registerRemoteLogSource(again);
    expect(remoteLogSources()).toEqual([again]);
    remove();
    expect(remoteLogSources()).toEqual([again]);
    removeAgain();
    expect(remoteLogSources()).toEqual([]);
  });
});
