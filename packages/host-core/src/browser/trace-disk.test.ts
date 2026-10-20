import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { appendBrowserTraceStep, newBrowserTrace, type BrowserTrace } from "@volli/shared";

import { browserTraceDisk, browserTracesRoot } from "./trace-disk";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "volli-traces-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const TRACE = "3f9c1a2e-5b6d-4c7e-8f90-1a2b3c4d5e6f";
const FRAME = "8a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
const PNG_FRAME = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";

function trace(traceId = TRACE): BrowserTrace {
  return appendBrowserTraceStep(
    newBrowserTrace({ traceId, sessionId: "session-1", tabId: "tab-1", startedAt: 1_000 }),
    {
      action: "click",
      target: "Save",
      url: "https://example.com/",
      title: "Example",
      generation: 1,
      at: 1_100,
      outcome: "ok",
      rule: null,
      error: null,
      pictureId: FRAME,
    },
  ).trace;
}

const pictureRecord = (id: string, mime: "image/jpeg" | "image/png") => ({
  id,
  tabId: "tab-1",
  generation: 1,
  capturedAt: 1_100,
  ownerSessionId: "session-1",
  mime,
});

describe("browserTraceDisk", () => {
  it("lives in its own directory under userData, apart from the pictures and the Blob store", () => {
    expect(browserTracesRoot("/data")).toBe(join("/data", "browser-traces"));
  });

  it("writes a self-describing trace, and its frames through the picture disk's seam", () => {
    const sink = browserTraceDisk(root);

    sink.writeTrace(trace());
    sink.frames.write(Buffer.from("jpg"), pictureRecord(FRAME, "image/jpeg"));
    sink.frames.write(Buffer.from("png"), pictureRecord(PNG_FRAME, "image/png"));

    expect(readdirSync(root).toSorted()).toEqual([`${TRACE}.json`, "frames"]);
    expect(readdirSync(join(root, "frames")).toSorted()).toEqual(
      [`${PNG_FRAME}.json`, `${PNG_FRAME}.png`, `${FRAME}.jpg`, `${FRAME}.json`].toSorted(),
    );
    expect(sink.listTraces()).toEqual([trace()]);
    expect(
      sink.frames
        .list()
        .map((one) => one.id)
        .toSorted(),
    ).toEqual([PNG_FRAME, FRAME].toSorted());
    expect(sink.frames.read(FRAME)).toEqual({ bytes: Buffer.from("jpg"), mime: "image/jpeg" });
  });

  it("refuses to write a trace under any name that is not a UUID, and removes none", () => {
    const sink = browserTraceDisk(root);

    expect(() => sink.writeTrace(trace("../escape"))).toThrow("UUIDs");
    sink.writeTrace(trace());
    sink.removeTrace("../escape");
    expect(sink.listTraces()).toHaveLength(1);
  });

  it("answers empty before anything was written", () => {
    const sink = browserTraceDisk(join(root, "never"));
    expect(sink.listTraces()).toEqual([]);
    expect(sink.frames.list()).toEqual([]);
  });

  it("sweeps what it cannot trust as it lists — a torn record, a renamed one, a crash's .tmp — and leaves what is not its own", () => {
    const sink = browserTraceDisk(root);
    sink.writeTrace(trace());
    const torn = "7c6b5a4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d.json";
    const renamed = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a.json";
    const leftover = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e.json.tmp";
    writeFileSync(join(root, torn), "{ torn");
    // A valid record under someone else's name answers for nothing.
    writeFileSync(join(root, renamed), JSON.stringify(trace()));
    writeFileSync(join(root, leftover), "{");
    writeFileSync(join(root, "notes.txt"), "hello");
    mkdirSync(join(root, "7e6d5c4b-3a2f-4e1d-8c0b-9a8f7e6d5c4b.json"));

    expect(sink.listTraces().map((one) => one.traceId)).toEqual([TRACE]);
    expect(readdirSync(root).toSorted()).toEqual(
      [`${TRACE}.json`, "7e6d5c4b-3a2f-4e1d-8c0b-9a8f7e6d5c4b.json", "notes.txt"].toSorted(),
    );
  });

  it("removes a trace record", () => {
    const sink = browserTraceDisk(root);
    sink.writeTrace(trace());
    sink.removeTrace(TRACE);
    expect(sink.listTraces()).toEqual([]);
  });
});
