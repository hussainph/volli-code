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
 *
 * A trace grows by one step per browser call and was rewritten whole, on
 * Electron main, every time. Writes now leave the caller's turn (VC-1082):
 * each record is still written aside and renamed into place, through
 * `fs.promises`, one write at a time per trace, and the steps that arrive
 * while one is in flight coalesce into the next — only the newest trace is
 * ever written, so a burst of steps costs one rewrite, not one per step.
 * Until it lands, the newest record answers a listing from memory.
 */
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readBrowserTrace, type BrowserTrace } from "@volli/shared";

import {
  BROWSER_FILE_ID,
  type BrowserPictureDisk,
  browserPictureDisk,
  diskQueue,
} from "./picture-disk";
import type { BrowserTracePersistence } from "./trace-store";

/** A trace sink on disk, with the wait an orderly quit gives its writes. */
export interface BrowserTraceDisk extends BrowserTracePersistence {
  frames: BrowserPictureDisk;
  /** Resolves once every trace and frame write asked of it so far is on disk. */
  settled(): Promise<void>;
}

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

export function browserTraceDisk(root: string): BrowserTraceDisk {
  const frames = browserPictureDisk(join(root, "frames"));
  const queue = diskQueue("A Browser Trace");
  /** The newest record of each trace that is not on disk yet; listings answer it from here. */
  const newest = new Map<string, BrowserTrace>();
  /** Traces with a write queued that has not started: it will take the newest record. */
  const scheduled = new Set<string>();
  /** Bumped by each removal, so a write queued before it never lands after it. */
  const removals = new Map<string, number>();
  /** Traces whose removal has not landed yet: no listing answers them. */
  const removing = new Set<string>();
  return {
    frames,
    writeTrace(trace) {
      const { traceId } = trace;
      if (!BROWSER_FILE_ID.test(traceId)) throw new Error("Browser Trace ids are UUIDs");
      newest.set(traceId, trace);
      removing.delete(traceId);
      if (scheduled.has(traceId)) return;
      scheduled.add(traceId);
      const epoch = removals.get(traceId) ?? 0;
      queue.run(traceId, async () => {
        if ((removals.get(traceId) ?? 0) !== epoch) return;
        scheduled.delete(traceId);
        const record = newest.get(traceId);
        if (record === undefined) return;
        await mkdir(root, { recursive: true });
        // Written aside and renamed into place: a crash mid-write leaves the
        // previous record whole, never a torn one.
        const path = join(root, `${traceId}.json`);
        await writeFile(`${path}.tmp`, JSON.stringify(record));
        await rename(`${path}.tmp`, path);
        if (newest.get(traceId) === record) newest.delete(traceId);
      });
    },
    listTraces() {
      if (!existsSync(root)) return [...newest.values()];
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
        if (newest.has(id) || removing.has(id)) continue;
        const trace = readTrace(root, name);
        if (trace === null) rmSync(join(root, name), { force: true });
        else traces.push(trace);
      }
      return [...traces, ...newest.values()];
    },
    removeTrace(traceId) {
      if (!BROWSER_FILE_ID.test(traceId)) return;
      newest.delete(traceId);
      scheduled.delete(traceId);
      const epoch = (removals.get(traceId) ?? 0) + 1;
      removals.set(traceId, epoch);
      removing.add(traceId);
      queue.run(
        traceId,
        () => rm(join(root, `${traceId}.json`), { force: true }),
        () => {
          if (removals.get(traceId) === epoch) removing.delete(traceId);
        },
      );
    },
    async settled() {
      await Promise.all([queue.settled(), frames.settled()]);
    },
  };
}
