/** The parity bench's latest-frame consumer, ready only after a real frame arrives. */
import { performance } from "node:perf_hooks";

import type { BrowserScreencastAttachment } from "../screencast";
import { jpegSize } from "./jpeg";

export interface Consumer {
  /** When each frame was taken, in `performance.now()` ms. */
  arrivals: number[];
  /** The pixel size of the frames, as decoded from the last one taken. */
  size: { width: number; height: number } | null;
  stop(): void;
}

/**
 * Attach starts the cast asynchronously. Wait for its first delivered frame,
 * not elapsed time or a quiet, possibly empty history. Do not filter by the
 * expected size here: the bench must still assert the pixels it actually got.
 */
export async function consume(attachment: BrowserScreencastAttachment): Promise<Consumer> {
  let first;
  try {
    first = await attachment.next(AbortSignal.timeout(5_000));
    if (first === null) throw new Error("screencast ended before its first frame");
  } catch (error) {
    attachment.detach();
    throw new Error("parity bench did not receive its first screencast frame", { cause: error });
  }
  const consumer: Consumer = {
    arrivals: [performance.now()],
    size: jpegSize(first.bytes),
    stop: () => attachment.detach(),
  };
  // As on the binary channel, take the newest frame as soon as the last is sent.
  void (async () => {
    for (;;) {
      const frame = await attachment.next();
      if (frame === null) return;
      consumer.arrivals.push(performance.now());
      consumer.size = jpegSize(frame.bytes);
    }
  })();
  return consumer;
}
