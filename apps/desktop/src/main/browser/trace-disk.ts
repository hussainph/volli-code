/**
 * The disk half of {@link BrowserTraceStore}'s persistence (VC-453): a
 * Session's Browser Traces under Electron `userData`, so a person can replay
 * what a Session did in its tabs after the app has relaunched.
 *
 * Its own directory, beside `browser-pictures/` and never inside the Blob
 * store, for the reason `picture-disk.ts` gives: a Blob linked to a Session
 * becomes the next turn's input, and a trace is the person's evidence only.
 *
 *   browser-traces/<traceId>.json         the self-describing trace record
 *   browser-traces/frames/<pictureId>.jpg the frame one of its steps names
 *
 * No database row, for the picture disk's reason too: the directory is its
 * own index, rehydrated and swept by the store at construction. Every file
 * name is a UUID the host minted and nothing else; the checks here are a
 * second lock on the same door. A record a half-finished write left behind is
 * skipped, never a boot failure.
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

import type { BrowserPictureMime } from "./picture-store";
import type { BrowserTracePersistence } from "./trace-store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EXTENSION: Record<BrowserPictureMime, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
};

const MIME_OF = new Map<string, BrowserPictureMime>(
  (Object.entries(EXTENSION) as [BrowserPictureMime, string][]).map(([mime, ext]) => [ext, mime]),
);

/** The traces directory under a given Electron `userData` path. */
export function browserTracesRoot(userDataPath: string): string {
  return join(userDataPath, "browser-traces");
}

function readTrace(path: string): BrowserTrace | null {
  try {
    const trace = readBrowserTrace(JSON.parse(readFileSync(path, "utf8")));
    return trace !== null && UUID.test(trace.traceId) ? trace : null;
  } catch {
    return null;
  }
}

export function browserTraceDisk(root: string): BrowserTracePersistence {
  const frames = join(root, "frames");
  return {
    writeTrace(trace) {
      if (!UUID.test(trace.traceId)) throw new Error("Browser Trace ids are UUIDs");
      mkdirSync(root, { recursive: true });
      // Rewritten on every step, so written aside and renamed into place: a
      // crash mid-write leaves the previous record whole, never a torn one.
      const path = join(root, `${trace.traceId}.json`);
      writeFileSync(`${path}.tmp`, JSON.stringify(trace));
      renameSync(`${path}.tmp`, path);
    },
    writeFrame(pictureId, frame) {
      if (!UUID.test(pictureId)) throw new Error("Browser Trace frame ids are UUIDs");
      mkdirSync(frames, { recursive: true });
      writeFileSync(join(frames, `${pictureId}.${EXTENSION[frame.mime]}`), frame.bytes);
    },
    readFrame(pictureId) {
      if (!UUID.test(pictureId)) return null;
      for (const [ext, mime] of MIME_OF) {
        const path = join(frames, `${pictureId}.${ext}`);
        if (existsSync(path)) return { bytes: readFileSync(path), mime };
      }
      return null;
    },
    listTraces() {
      if (!existsSync(root)) return [];
      const traces: BrowserTrace[] = [];
      for (const name of readdirSync(root)) {
        // The record's own id must match its file name, or a copied file
        // would answer for a trace that is not the one it names.
        if (!name.endsWith(".json")) continue;
        const trace = readTrace(join(root, name));
        if (trace !== null && `${trace.traceId}.json` === name) traces.push(trace);
      }
      return traces;
    },
    listFrames() {
      if (!existsSync(frames)) return [];
      const ids: string[] = [];
      for (const name of readdirSync(frames)) {
        const dot = name.lastIndexOf(".");
        const id = name.slice(0, dot);
        if (dot > 0 && MIME_OF.has(name.slice(dot + 1)) && UUID.test(id)) ids.push(id);
      }
      return ids;
    },
    removeTrace(traceId) {
      if (!UUID.test(traceId)) return;
      rmSync(join(root, `${traceId}.json`), { force: true });
    },
    removeFrame(pictureId) {
      if (!UUID.test(pictureId)) return;
      for (const ext of MIME_OF.keys()) {
        rmSync(join(frames, `${pictureId}.${ext}`), { force: true });
      }
    },
  };
}
