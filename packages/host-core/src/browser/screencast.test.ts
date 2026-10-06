/** One screencast attachment's rules (VC-619; host-protocol.md, Binary framing). */
import type { BrowserScreencastMetadata } from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import { ScreencastAttachment } from "./screencast";

const META: BrowserScreencastMetadata = {
  encoding: "image/jpeg",
  width: 1_280,
  height: 720,
  deviceScaleFactor: 1,
};
const bytes = (n: number): Uint8Array => Uint8Array.of(n);

describe("ScreencastAttachment", () => {
  it("hands a waiting consumer the next frame, numbered from 1", async () => {
    const attachment = new ScreencastAttachment(META, 1, () => undefined);
    const waiting = attachment.next();
    attachment.offer(bytes(1));
    attachment.offer(bytes(2));
    await expect(waiting).resolves.toEqual({ seq: 1, bytes: bytes(1) });
    await expect(attachment.next()).resolves.toEqual({ seq: 2, bytes: bytes(2) });
  });

  it("keeps at most one unsent frame, the newest, and drops stale ones before numbering", async () => {
    const attachment = new ScreencastAttachment(META, 1, () => undefined);
    for (let n = 1; n <= 4; n += 1) attachment.offer(bytes(n));
    expect(attachment.dropped).toBe(3);
    await expect(attachment.next()).resolves.toEqual({ seq: 1, bytes: bytes(4) });
  });

  it("states metadata at attach and on change, dropping a frame drawn to the old shape", async () => {
    const attachment = new ScreencastAttachment(META, 2, () => undefined);
    expect(attachment.metadata()).toEqual(META);
    expect(attachment.requestedScale).toBe(2);
    const seen: BrowserScreencastMetadata[] = [];
    const unsubscribe = attachment.onMetadata((metadata) => seen.push(metadata));
    attachment.offer(bytes(1));
    attachment.setMetadata({ ...META });
    expect(seen).toEqual([]);
    attachment.setMetadata({ ...META, deviceScaleFactor: 2 });
    expect(seen).toEqual([{ ...META, deviceScaleFactor: 2 }]);
    expect(attachment.dropped).toBe(1);
    unsubscribe();
    attachment.setMetadata({ ...META, width: 800 });
    expect(seen).toHaveLength(1);
    attachment.offer(bytes(2));
    await expect(attachment.next()).resolves.toEqual({ seq: 1, bytes: bytes(2) });
  });

  it("cancels a waiting next on its signal, and refuses one already withdrawn", async () => {
    const attachment = new ScreencastAttachment(META, 1, () => undefined);
    const controller = new AbortController();
    const waiting = attachment.next(controller.signal);
    controller.abort(new Error("viewer left"));
    await expect(waiting).rejects.toThrow("viewer left");
    await expect(attachment.next(controller.signal)).rejects.toThrow("viewer left");
    attachment.offer(bytes(1));
    await expect(attachment.next()).resolves.toEqual({ seq: 1, bytes: bytes(1) });
  });

  it("serves one next at a time", async () => {
    const attachment = new ScreencastAttachment(META, 1, () => undefined);
    const first = attachment.next();
    await expect(attachment.next()).rejects.toThrow(/one next/);
    attachment.end();
    await expect(first).resolves.toBeNull();
  });

  it("answers null once ended from the host's side, and ignores what follows", async () => {
    const onDetach = vi.fn();
    const attachment = new ScreencastAttachment(META, 1, onDetach);
    attachment.offer(bytes(1));
    attachment.end();
    expect(attachment.ended).toBe(true);
    attachment.offer(bytes(2));
    attachment.setMetadata({ ...META, width: 10 });
    await expect(attachment.next()).resolves.toBeNull();
    attachment.detach();
    expect(onDetach).not.toHaveBeenCalled();
  });

  it("tells the host once when the viewer detaches", async () => {
    const onDetach = vi.fn();
    const attachment = new ScreencastAttachment(META, 1, onDetach);
    const waiting = attachment.next();
    attachment.detach();
    attachment.detach();
    await expect(waiting).resolves.toBeNull();
    expect(onDetach).toHaveBeenCalledTimes(1);
    expect(onDetach).toHaveBeenCalledWith(attachment);
  });
});
