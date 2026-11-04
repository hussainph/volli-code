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
    reconnect() {
      act(() => handlers?.onStatus("connecting", "Reconnecting"));
    },
    fail(detail: string) {
      act(() => handlers?.onStatus("failed", detail));
    },
  };
}

let container: HTMLDivElement;
let root: Root;
const scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (scrollDescriptor)
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
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
    act(() =>
      (
        container.querySelector(
          '[data-testid="log-row"] [aria-expanded="false"]',
        ) as HTMLButtonElement
      ).click(),
    );
    expect(container.querySelector("pre")?.textContent).toContain(TRACE);
    // The disclosure carries source and component in full, wherever they truncate.
    expect(container.querySelector("pre")?.textContent).toContain('"source": "This Mac"');
    expect(container.querySelector("pre")?.textContent).toContain('"component": "rpc"');
    act(() =>
      (container.querySelector('[aria-label="Clear filters"]') as HTMLButtonElement).click(),
    );
    expect(rows()).toHaveLength(3);
    act(() => unregister());
  });

  it("searches through one named field, and folds source and component under a narrow row", () => {
    const mac = fakeSource("this-mac", "This Mac");
    const box = fakeSource("box", "Box");
    const unregister = registerRemoteLogSource(box.source);
    act(() => root.render(<LogViewer local={mac.source} />));
    mac.push([entry(1, "2026-10-07T00:00:01.000Z", { component: "rpc", msg: "rpc call" })]);
    box.push([entry(2, "2026-10-07T00:00:02.000Z", { component: "hostd", msg: "serving" })]);
    settle();

    // The one search field carries its own accessible name, not just a placeholder.
    const search = container.querySelectorAll<HTMLInputElement>('input[aria-label="Search logs"]');
    expect(search).toHaveLength(1);
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(search[0], "serving");
      search[0]!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(rows()).toHaveLength(1);

    // The row names its machine and component even where their columns fold
    // away (container queries do not apply here, so both copies are present;
    // each hides at the width where its own column shows).
    const row = container.querySelector('[data-testid="log-row"]')!;
    const folded = row.querySelector(".col-span-full > span")!;
    expect(folded.className).toContain("@4xl/logs:hidden");
    expect(folded.textContent).toBe("Boxhostd");
    const foldedComponent = folded.querySelector("button")!;
    expect(foldedComponent.className).toContain("@2xl/logs:hidden");
    act(() => foldedComponent.click());
    expect(button("component: hostd")).toBeDefined();

    // One machine: the source buttons already say whose lines these are, so
    // a narrow row folds only its component.
    act(() => unregister());
    act(() =>
      (container.querySelector('[aria-label="Clear filters"]') as HTMLButtonElement).click(),
    );
    const rpc = [...container.querySelectorAll('[data-testid="log-row"]')].find((candidate) =>
      candidate.textContent?.includes("rpc call"),
    )!;
    const only = rpc.querySelector(".col-span-full > span")!;
    expect(only.className).toContain("@2xl/logs:hidden");
    expect(only.textContent).toBe("rpc");
  });

  it("pauses the view while lines keep arriving, and says a source failed", () => {
    const mac = fakeSource("this-mac", "This Mac");
    act(() => root.render(<LogViewer local={mac.source} />));
    expect(container.textContent).toContain("No lines");
    act(() => button("Pause").click());
    mac.push([entry(1, "2026-10-07T00:00:01.000Z")]);
    settle();
    expect(rows()).toHaveLength(0);
    act(() => button("Resume").click());
    expect(rows()).toHaveLength(1);
    mac.fail("bridge gone");
    expect(button("This Mac").title).toBe("bridge gone");
    act(() => (container.querySelector('[aria-label="Filter logs"]') as HTMLButtonElement).click());
    act(() =>
      (document.querySelector('[aria-label="Minimum level"]') as HTMLButtonElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    act(() =>
      (
        [...document.querySelectorAll('[role="option"]')].find(
          (option) => option.textContent === "Error",
        ) as HTMLElement
      ).click(),
    );
    expect(container.textContent).toContain("No lines match");
  });

  it("shows only the fault when no logs landed, and retries only the failed source", () => {
    const mac = fakeSource("this-mac", "This Mac");
    const box = fakeSource("box", "Box");
    const localStart = vi.spyOn(mac.source, "start");
    const remoteStart = vi.spyOn(box.source, "start");
    const unregister = registerRemoteLogSource(box.source);
    act(() => root.render(<LogViewer local={mac.source} />));
    mac.fail("bridge gone");
    expect(container.textContent).toContain("Couldn't read This Mac logs");
    expect(container.textContent).not.toContain("No lines");
    act(() => button("Retry").click());
    expect(localStart).toHaveBeenCalledTimes(2);
    expect(remoteStart).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("Couldn't read This Mac logs");
    mac.push([entry(1, "2026-10-07T00:00:01.000Z")]);
    settle();
    expect(rows()).toHaveLength(1);
    act(() => unregister());
  });

  it("draws a connecting source with a spinner, not a ready dot", () => {
    const mac = fakeSource("this-mac", "This Mac");
    act(() => root.render(<LogViewer local={mac.source} />));
    mac.reconnect();
    settle();
    expect(button("This Mac").querySelector('svg[role="status"]')).not.toBeNull();
    expect(button("This Mac").querySelector('svg[aria-label="Loading"]')).not.toBeNull();
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
