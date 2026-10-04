/**
 * The disk half of {@link BrowserTraceStore}'s persistence (VC-453): a
 * Session's Browser Traces under Electron `userData`, so a person can replay
 * what a Session did in its tabs after the app has relaunched.
 *
 * Its own directory, beside `browser-pictures/` and never inside the Blob
 * store, for the reason `picture-disk.ts` gives: a Blob linked to a Session
 * becomes the next turn's input, and a trace is the person's evidence only.
 *
 *   browser-traces/<traceId>.json            the self-describing trace record
 *   browser-traces/frames/<pictureId>.jpg    a frame one of its steps names,
 *   browser-traces/frames/<pictureId>.json   beside the picture's own record
 *
 * The frames go through the picture store's existing persistence seam —
 * `browserPictureDisk`, pointed at `frames/` — so a frame on disk is exactly
 * what a kept screenshot is, with the same UUID-only names and the same
 * validating read. What is new here is only the trace record.
 *
 * No database row, for the picture disk's reason too: the directory is its
 * own index, rehydrated and swept by the store at construction. A record this
 * build cannot read — torn by a crash, or written by a build that knew a
 * newer shape — is removed as it is listed, along with any half-written
 * `.tmp`, so nothing here can outgrow the store's bounds unseen.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { readBrowserTrace, type BrowserTrace } from "@volli/shared";

import { BROWSER_FILE_ID, browserPictureDisk } from "./picture-disk";
import type { BrowserTracePersistence } from "./trace-store";

/** The traces directory under a given Electron `userData` path. */
export function browserTracesRoot(userDataPath: string): string {
  return join(userDataPath, "browser-traces");
}

/** A record as it stands, or null when it is not one this build can trust as the file it names. */
function readTrace(root: string, name: string): BrowserTrace | null {
  try {
    const trace = readBrowserTrace(JSON.parse(readFileSync(join(root, name), "utf8")));
    return trace !== null && `${trace.traceId}.json` === name ? trace : null;
  } catch {
    return null;
  }
}

export function browserTraceDisk(root: string): BrowserTracePersistence {
  return {
    frames: browserPictureDisk(join(root, "frames")),
    writeTrace(trace) {
      if (!BROWSER_FILE_ID.test(trace.traceId)) throw new Error("Browser Trace ids are UUIDs");
      mkdirSync(root, { recursive: true });
      // Rewritten on every step, so written aside and renamed into place: a
      // crash mid-write leaves the previous record whole, never a torn one.
      const path = join(root, `${trace.traceId}.json`);
      writeFileSync(`${path}.tmp`, JSON.stringify(trace));
      renameSync(`${path}.tmp`, path);
    },
    listTraces() {
      if (!existsSync(root)) return [];
      const traces: BrowserTrace[] = [];
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const { name } = entry;
        const id = name.split(".")[0] ?? "";
        // Only this directory's own names are ever touched: a UUID record, or
        // the `.tmp` a crash left beside one. Anything else is not ours.
        if (!BROWSER_FILE_ID.test(id)) continue;
        if (name === `${id}.json.tmp`) {
          rmSync(join(root, name), { force: true });
          continue;
        }
        if (name !== `${id}.json`) continue;
        const trace = readTrace(root, name);
        if (trace === null) rmSync(join(root, name), { force: true });
        else traces.push(trace);
      }
      return traces;
    },
    removeTrace(traceId) {
      if (!BROWSER_FILE_ID.test(traceId)) return;
      rmSync(join(root, `${traceId}.json`), { force: true });
    },
  };
}
