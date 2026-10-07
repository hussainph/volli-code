import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ScreencastAttachment } from "./screencast";
import { consume } from "./test-support/parity-consumer";

const attachments: ScreencastAttachment[] = [];
afterEach(() => {
  for (const cast of attachments.splice(0)) cast.detach();
  vi.useRealTimers();
});

function attachment(): ScreencastAttachment {
  const cast = new ScreencastAttachment(
    { width: 1_280, height: 720, deviceScaleFactor: 2, encoding: "image/jpeg" },
    2,
    () => {},
  );
  attachments.push(cast);
  return cast;
}

/** Minimal JPEG start-of-frame bytes, as in the viewer seam tests. */
function jpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    0x01,
    0x22,
    0x00,
  ]);
}

describe("parity consumer readiness", () => {
  it("waits past the old 300 ms startup sleep until a frame is delivered", async () => {
    vi.useFakeTimers();
    const cast = attachment();
    let ready = false;
    const pending = consume(cast).then((consumer) => {
      ready = true;
      return consumer;
    });
    setTimeout(() => cast.offer(jpeg(2_560, 1_440)), 301);
    await vi.advanceTimersByTimeAsync(300);
    expect(ready).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const consumer = await pending;
    expect(consumer.size).toEqual({ width: 2_560, height: 1_440 });
    expect(consumer.arrivals).toHaveLength(1);
    cast.offer(jpeg(2_560, 1_440));
    await Promise.resolve();
    expect(consumer.arrivals).toHaveLength(2);
    consumer.stop();
    expect(cast.ended).toBe(true);
  });

  it("preserves a wrong-size first frame for the bench's exact assertion", async () => {
    const cast = attachment();
    cast.offer(jpeg(1_280, 720));
    expect((await consume(cast)).size).toEqual({ width: 1_280, height: 720 });
  });

  it("does not skip malformed first-frame bytes", async () => {
    const cast = attachment();
    cast.offer(Uint8Array.from([0]));
    expect((await consume(cast)).size).toBeNull();
  });

  it("fails immediately when the attachment ends before delivering a frame", async () => {
    const cast = attachment();
    const pending = consume(cast);
    cast.end();
    await expect(pending).rejects.toThrow("did not receive its first screencast frame");
  });

  it("bounds a silent attachment's first-frame wait and detaches on timeout", async () => {
    const cast = attachment();
    await expect(consume(cast)).rejects.toThrow("did not receive its first screencast frame");
    expect(cast.ended).toBe(true);
  }, 10_000);
});
