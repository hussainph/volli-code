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

describe("browserTraceDisk", () => {
  it("lives in its own directory under userData, apart from the pictures and the Blob store", () => {
    expect(browserTracesRoot("/data")).toBe(join("/data", "browser-traces"));
  });

  it("writes a self-describing trace and its frames under UUID names, and reads them back", () => {
    const sink = browserTraceDisk(root);

    sink.writeTrace(trace());
    sink.writeFrame(FRAME, { bytes: Buffer.from("jpg"), mime: "image/jpeg" });
    sink.writeFrame(PNG_FRAME, { bytes: Buffer.from("png"), mime: "image/png" });

    expect(readdirSync(root).toSorted()).toEqual([`${TRACE}.json`, "frames"]);
    expect(readdirSync(join(root, "frames")).toSorted()).toEqual([
      `${PNG_FRAME}.png`,
      `${FRAME}.jpg`,
    ]);
    expect(sink.listTraces()).toEqual([trace()]);
    expect(sink.listFrames().toSorted()).toEqual([PNG_FRAME, FRAME].toSorted());
    expect(sink.readFrame(FRAME)).toEqual({ bytes: Buffer.from("jpg"), mime: "image/jpeg" });
    expect(sink.readFrame(PNG_FRAME)).toEqual({ bytes: Buffer.from("png"), mime: "image/png" });
  });

  it("refuses to write any name that is not a UUID, and reads or removes none", () => {
    const sink = browserTraceDisk(root);

    expect(() => sink.writeTrace(trace("../escape"))).toThrow("UUIDs");
    expect(() =>
      sink.writeFrame("../escape", { bytes: Buffer.from("x"), mime: "image/jpeg" }),
    ).toThrow("UUIDs");
    expect(sink.readFrame("../../etc/passwd")).toBeNull();
    sink.writeTrace(trace());
    sink.removeTrace("../escape");
    sink.removeFrame("../escape");
    expect(sink.listTraces()).toHaveLength(1);
  });

  it("answers empty before anything was written, and null for a frame it does not hold", () => {
    const sink = browserTraceDisk(join(root, "never"));
    expect(sink.listTraces()).toEqual([]);
    expect(sink.listFrames()).toEqual([]);
    expect(sink.readFrame(FRAME)).toBeNull();
  });

  it("skips what it cannot trust: a torn record, a renamed one, stray files", () => {
    const sink = browserTraceDisk(root);
    sink.writeTrace(trace());
    writeFileSync(join(root, "7c6b5a4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d.json"), "{ torn");
    // A valid record under someone else's name answers for nothing.
    writeFileSync(join(root, "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a.json"), JSON.stringify(trace()));
    writeFileSync(join(root, "notes.txt"), "hello");
    writeFileSync(join(root, `${FRAME}.json`), JSON.stringify({ ...trace(), traceId: "nope" }));
    mkdirSync(join(root, "frames"), { recursive: true });
    writeFileSync(join(root, "frames", "readme"), "x");
    writeFileSync(join(root, "frames", "not-a-uuid.jpg"), "x");
    writeFileSync(join(root, "frames", `${FRAME}.gif`), "x");

    expect(sink.listTraces().map((one) => one.traceId)).toEqual([TRACE]);
    expect(sink.listFrames()).toEqual([]);
  });

  it("removes a trace and a frame, whichever type the frame was", () => {
    const sink = browserTraceDisk(root);
    sink.writeTrace(trace());
    sink.writeFrame(FRAME, { bytes: Buffer.from("jpg"), mime: "image/jpeg" });
    sink.writeFrame(PNG_FRAME, { bytes: Buffer.from("png"), mime: "image/png" });

    sink.removeTrace(TRACE);
    sink.removeFrame(FRAME);
    sink.removeFrame(PNG_FRAME);

    expect(sink.listTraces()).toEqual([]);
    expect(readdirSync(join(root, "frames"))).toEqual([]);
  });
});
