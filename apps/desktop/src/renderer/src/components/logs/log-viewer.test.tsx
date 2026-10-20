// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { HostLogEntry, LogRecord } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@renderer/lib/session-rpc-ipc-link", () => ({
  sessionRpcClient: () => ({
    settings: { experiments: { query: async () => ({ cloud: { enabled: true } }) } },
  }),
}));

import { registerRemoteLogSource, type LogSource, type LogSourceHandlers } from "./log-sources";
import { LogStream, LogViewer } from "./log-viewer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";

function entry(seq: number, ts: string, extra: Partial<LogRecord> = {}): HostLogEntry {
  return {
    cursor: `i:${seq}`,
    record: { ts, level: "info", component: "session", msg: `line ${seq}`, ...extra } as LogRecord,
  };
}

/** A source a test drives by hand. */
function fakeSource(id: string, label: string) {
  let handlers: LogSourceHandlers | null = null;
  const source: LogSource = {
    id,
    label,
    start(next) {
      handlers = next;
      next.onStatus("live");
      return () => {
        handlers = null;
      };
    },
  };
  return {
    source,
    push(entries: HostLogEntry[], gap = false) {
      act(() => handlers?.onLines(entries, gap));
    },
    fail(detail: string) {
      act(() => handlers?.onStatus("failed", detail));
    },
  };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const rows = () =>
  [...container.querySelectorAll('[data-testid="log-row"]')].map((row) => row.textContent ?? "");
const settle = () => act(() => vi.advanceTimersByTime(150));
const button = (name: string) =>
  [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(name),
  )!;

describe("the dev log viewer", () => {
  it("merges this Mac and a remote host in time order, and follows one trace across both", () => {
    const mac = fakeSource("this-mac", "This Mac");
    const box = fakeSource("box", "Box");
    const unregister = registerRemoteLogSource(box.source);
    act(() => root.render(<LogViewer local={mac.source} />));
    mac.push([
      entry(1, "2026-10-07T00:00:01.000Z", { component: "rpc", traceId: TRACE }),
      entry(3, "2026-10-07T00:00:03.000Z", { component: "power" }),
    ]);
    box.push([entry(2, "2026-10-07T00:00:02.000Z", { traceId: TRACE, sessionId: "s-1" })], true);
    settle();
    expect(rows().map((row) => row.match(/line \d/u)?.[0])).toEqual(["line 1", "line 2", "line 3"]);
    expect(rows()[1]).toContain("Box");

    // Follow the trace from any line that carries it.
    act(() =>
      (container.querySelector(`button[title="traceId ${TRACE}"]`) as HTMLButtonElement).click(),
    );
    expect(rows()).toHaveLength(2);
    expect(container.querySelector('[data-testid="trace-summary"]')?.textContent).toBe(
      "Trace 4bf92f35… · 2 lines · This Mac → Box · 1.00 s",
    );
    // A row opens to its fields.
    act(() => (container.querySelector('[aria-expanded="false"]') as HTMLButtonElement).click());
    expect(container.querySelector("pre")?.textContent).toContain(TRACE);
    act(() => button("Clear").click());
    expect(rows()).toHaveLength(3);
    unregister();
  });

  it("pauses the view while lines keep arriving, and says a source failed", () => {
    const mac = fakeSource("this-mac", "This Mac");
    act(() => root.render(<LogViewer local={mac.source} />));
    expect(container.textContent).toContain("No lines yet.");
    act(() => button("Pause").click());
    mac.push([entry(1, "2026-10-07T00:00:01.000Z")]);
    settle();
    expect(rows()).toHaveLength(0);
    act(() => button("Resume").click());
    expect(rows()).toHaveLength(1);
    mac.fail("bridge gone");
    expect(button("This Mac").title).toBe("bridge gone");
    act(() => {
      const level = container.querySelector('[data-choice="error"]') as HTMLButtonElement;
      level.click();
    });
    expect(container.textContent).toContain("No lines match.");
  });

  it("shows one operation's lines under a fixed filter", () => {
    const mac = fakeSource("this-mac", "This Mac");
    act(() => root.render(<LogStream local={mac.source} filter={{ traceId: TRACE }} />));
    mac.push([
      entry(1, "2026-10-07T00:00:01.000Z", { traceId: TRACE }),
      entry(2, "2026-10-07T00:00:02.000Z"),
    ]);
    settle();
    expect(rows()).toHaveLength(1);
  });
});
