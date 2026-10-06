import type { SessionEvent } from "@volli/shared";
import { scrubSessionEventPayload } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  appendFrames,
  EMPTY_TRANSCRIPT,
  seedTranscriptWindow,
  type ChatSessionFrame,
} from "./transcript";
import { chatSessionFrame } from "./wire";

/**
 * What a chat pays between the snapshot leaving the host and the first store
 * write it paints from, by Session age (VC-315).
 *
 * `snapshot-replay-cost.bench.test.ts` prices the host's half: what a snapshot
 * reads and how many bytes it sends. This prices the Client's half on the same
 * shape of history: the IPC copy (`structuredClone`, which is what Electron's
 * bridge does to the payload), the wire read of every frame, and the fold
 * into the transcript the plane renders. Before VC-315 the Client did all
 * three over the whole log; now over the window the host bounds, so the cost
 * stays flat as the Session ages. React's own render is not here: the plane
 * already mounts a bounded tail of rows (VC-338), and jsdom has no layout to
 * time. The paint itself is the Electron chat-window bench's to measure.
 *
 * Frames are synthetic but sized like the real profile's busiest day — four
 * tool results cycling through its spread, a reply, and the turn marks — and
 * the window is cut with the host's rule (512 KiB or 256 frames, newest
 * first). Counts are asserted; times are printed.
 */

const SIZES = [50, 500, 1_668, 5_000] as const;
const RESULT_CHARS = [400, 1_200, 3_000, 800, 600, 2_000, 900, 24_000] as const;
const REPLY_CHARS = 1_500;
const WINDOW = { events: 256, bytes: 512 * 1024 };

function filler(chars: number, seed: string): string {
  const line = `${seed}: deterministic history fixture line for the paint probe.\n`;
  return line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
}

function wireFrame(sequence: number, payload: SessionEvent["payload"], text: string | null) {
  return {
    sessionId: "session-1",
    sequence,
    event: {
      id: `event-${sequence}`,
      sessionId: "session-1",
      sequence,
      occurredAt: sequence,
      recordedAt: sequence,
      attachmentId: "attachment-1",
      commandId: null,
      provenance: { source: { kind: "system", id: "session-runtime", detail: null }, venue: null },
      payload: scrubSessionEventPayload(payload),
    },
    transcript:
      text === null
        ? null
        : {
            message: {
              id: `message-${sequence}`,
              role: "assistant",
              parts: [{ type: "text", text }],
            },
          },
  };
}

/** `events` frames as they cross the wire: plain JSON, oldest first. */
function history(events: number): unknown[] {
  const frames: unknown[] = [];
  let result = 0;
  for (let turn = 0; frames.length < events; turn += 1) {
    const turnId = `turn-${turn}`;
    const mark = (kind: "turn.started" | "turn.completed") =>
      wireFrame(frames.length + 1, { kind, attachmentId: "attachment-1", turnId }, null);
    const said = (chars: number) =>
      wireFrame(
        frames.length + 1,
        {
          kind: "transcript.referenced",
          attachmentId: "attachment-1",
          turnId,
          reference: { id: `artifact-${frames.length}`, mediaType: null, digest: null },
        },
        filler(chars, `${turnId}-${frames.length}`),
      );
    const steps = [
      () => mark("turn.started"),
      ...Array.from({ length: 4 }, () => () => said(RESULT_CHARS[result++ % RESULT_CHARS.length]!)),
      () => said(REPLY_CHARS),
      () => mark("turn.completed"),
    ];
    for (const step of steps) if (frames.length < events) frames.push(step());
  }
  return frames;
}

/** The host's cut: newest first, until the next frame would pass a bound. */
function newestWindow(frames: readonly unknown[]): unknown[] {
  const kept: unknown[] = [];
  let bytes = 1;
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const size = new TextEncoder().encode(JSON.stringify(frames[index])).length + 1;
    if (kept.length >= WINDOW.events || (kept.length > 0 && bytes + size > WINDOW.bytes)) break;
    kept.push(frames[index]);
    bytes += size;
  }
  return kept.toReversed();
}

interface Cost {
  frames: number;
  ms: number;
  messages: number;
}

/** IPC copy, wire read and fold: the path from the reply to the first store write. */
function firstWrite(payload: readonly unknown[], windowed: boolean): Cost {
  const started = performance.now();
  const copied = structuredClone(payload);
  const frames = copied.flatMap((value) => {
    const frame = chatSessionFrame(value);
    return frame === null ? [] : [frame];
  });
  const state = windowed
    ? seedTranscriptWindow(
        EMPTY_TRANSCRIPT,
        { frames, before: frames[0]!.sequence > 1 ? frames[0]!.sequence : null },
        PROJECTION,
      )
    : appendFrames(EMPTY_TRANSCRIPT, frames as ChatSessionFrame[]);
  return {
    frames: frames.length,
    ms: performance.now() - started,
    messages: state.messages.length,
  };
}

const PROJECTION = {
  session: {
    id: "session-1",
    projectId: "project-1",
    ticketId: null,
    role: "project" as const,
    parentSessionId: null,
    title: null,
    createdAt: 1,
  },
  status: "open" as const,
  signal: null,
  modelSelection: null,
  modelTier: null,
  turnActive: false,
  lastActivityAt: 1,
  bornTicketless: true,
  attention: { active: [], primary: null },
  interactions: { active: [], resolved: [] },
  liveExecutor: null,
  scheduledResume: null,
};

describe("first paint cost (VC-315)", () => {
  it("folds the same window however old the Session is", () => {
    const rows: { events: number; before: Cost; after: Cost }[] = [];
    for (const events of SIZES) {
      const whole = history(events);
      rows.push({
        events,
        before: firstWrite(whole, false),
        after: firstWrite(newestWindow(whole), true),
      });
    }

    for (const row of rows) {
      expect(row.before.frames).toBe(row.events);
      expect(row.after.frames).toBeLessThanOrEqual(WINDOW.events);
      expect(row.after.messages).toBeGreaterThan(0);
    }
    const [, at500, , at5000] = rows;
    expect(at5000!.after.frames).toBeLessThanOrEqual(at500!.after.frames * 1.1);

    // eslint-disable-next-line no-console -- the probe's numbers ARE the deliverable
    console.log(
      [
        "",
        "[first-paint-cost] IPC copy + wire read + fold, whole log (before) vs host window (after)",
        "  events | before frames | before ms | after frames | after ms",
        ...rows.map((row) =>
          [
            String(row.events).padStart(8),
            String(row.before.frames).padStart(13),
            row.before.ms.toFixed(1).padStart(9),
            String(row.after.frames).padStart(12),
            row.after.ms.toFixed(1).padStart(8),
          ].join(" | "),
        ),
        "",
      ].join("\n"),
    );
  });
});
