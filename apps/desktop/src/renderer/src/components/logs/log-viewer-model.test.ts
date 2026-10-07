import type { LogLevel, LogRecord } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  clockOf,
  componentsOf,
  EMPTY_FILTER,
  filterLines,
  linesOf,
  mergeLines,
  recordFields,
  rowDetail,
  toJsonl,
  traceSummary,
  type ViewerLine,
} from "./log-viewer-model";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";

function line(
  source: string,
  seq: number,
  ts: string,
  extra: Partial<LogRecord> & { level?: LogLevel } = {},
): ViewerLine {
  return linesOf(source, [
    {
      cursor: `i:${seq}`,
      record: { ts, level: "info", component: "session", msg: `m${seq}`, ...extra } as LogRecord,
    },
  ])[0]!;
}

describe("the log viewer's model", () => {
  it("keys lines by source and cursor", () => {
    expect(line("this-mac", 1, "t").key).toBe("this-mac:i:1");
  });

  it("merges two machines' lines in time order, once each, and keeps the newest past the cap", () => {
    const mac = [line("mac", 1, "2026-10-07T00:00:01Z"), line("mac", 2, "2026-10-07T00:00:03Z")];
    const box = [line("box", 1, "2026-10-07T00:00:02Z"), line("box", 2, "2026-10-07T00:00:04Z")];
    const merged = mergeLines(mergeLines([], mac), box);
    expect(merged.map((held) => held.key)).toEqual(["mac:i:1", "box:i:1", "mac:i:2", "box:i:2"]);
    // An append in order takes the fast path; a repeat is dropped.
    const appended = mergeLines(merged, [
      line("mac", 3, "2026-10-07T00:00:05Z"),
      line("mac", 2, "x"),
    ]);
    expect(appended.map((held) => held.key).at(-1)).toBe("mac:i:3");
    expect(appended).toHaveLength(5);
    expect(mergeLines(merged, [])).toBe(merged);
    expect(
      mergeLines(appended, [line("mac", 4, "2026-10-07T00:00:06Z")], 3).map((held) => held.key),
    ).toEqual(["box:i:2", "mac:i:3", "mac:i:4"]);
    // An unordered batch is sorted, ties keeping arrival.
    const unordered = mergeLines(
      [],
      [
        line("a", 2, "2026-10-07T00:00:02Z"),
        line("a", 1, "2026-10-07T00:00:01Z"),
        line("b", 1, "2026-10-07T00:00:01Z"),
      ],
    );
    expect(unordered.map((held) => held.key)).toEqual(["a:i:1", "b:i:1", "a:i:2"]);
  });

  it("filters by level, source, component, trace, Session, ticket and text", () => {
    const lines = [
      line("mac", 1, "t1", { level: "debug", component: "rpc", traceId: TRACE }),
      line("box", 2, "t2", {
        level: "warn",
        component: "session",
        sessionId: "s-1",
        traceId: TRACE,
      }),
      line("box", 3, "t3", {
        level: "error",
        component: "publish",
        ticketId: "tk-1",
        branch: "volli/VC-1",
      }),
    ];
    const keys = (filter: Partial<typeof EMPTY_FILTER>) =>
      filterLines(lines, { ...EMPTY_FILTER, ...filter }).map((held) => held.key);
    expect(keys({})).toHaveLength(3);
    expect(keys({ minLevel: "warn" })).toEqual(["box:i:2", "box:i:3"]);
    expect(keys({ source: "mac" })).toEqual(["mac:i:1"]);
    expect(keys({ component: "publish" })).toEqual(["box:i:3"]);
    expect(keys({ traceId: TRACE })).toEqual(["mac:i:1", "box:i:2"]);
    expect(keys({ sessionId: "s-1" })).toEqual(["box:i:2"]);
    expect(keys({ ticketId: "tk-1" })).toEqual(["box:i:3"]);
    expect(keys({ text: "VC-1" })).toEqual(["box:i:3"]);
    expect(componentsOf(lines)).toEqual(["publish", "rpc", "session"]);
  });

  it("summarises a trace across machines", () => {
    const lines = [
      line("mac", 1, "2026-10-07T00:00:01.000Z", { traceId: TRACE }),
      line("box", 2, "2026-10-07T00:00:01.250Z", { traceId: TRACE }),
      line("box", 3, "2026-10-07T00:00:02.000Z"),
    ];
    expect(traceSummary(lines, TRACE)).toEqual({
      lines: 2,
      sources: ["mac", "box"],
      firstTs: "2026-10-07T00:00:01.000Z",
      lastTs: "2026-10-07T00:00:01.250Z",
      durationMs: 250,
    });
    expect(traceSummary(lines, "none")).toEqual({
      lines: 0,
      sources: [],
      firstTs: null,
      lastTs: null,
      durationMs: null,
    });
  });

  it("writes JSON lines naming each source, and shows a record's own fields", () => {
    const lines = [line("mac", 1, "t1", { traceId: TRACE })];
    expect(toJsonl(lines)).toBe(
      `{"source":"mac","ts":"t1","level":"info","component":"session","msg":"m1","traceId":"${TRACE}"}`,
    );
    expect(recordFields(lines[0]!.record)).toEqual({ traceId: TRACE });
    expect(
      rowDetail(line("mac", 2, "t", { step: "probe", durationMs: 570, other: "x" }).record),
    ).toBe("step=probe durationMs=570");
  });

  it("shows a row's time on the clock, or the raw value when it is not a time", () => {
    expect(clockOf("2026-10-07T00:00:01.005Z")).toMatch(/^\d{2}:\d{2}:01\.005$/u);
    expect(clockOf("not a time")).toBe("not a time");
  });
});
