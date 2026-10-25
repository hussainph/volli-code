import { describe, expect, test, vi } from "vite-plus/test";
import type { HostedSessionRuntime, SessionStreamEmission } from "@volli/session-engine";
import type { BackendLink } from "../cloud-runner/backend-link";
import { createFollowUpMirror, followUpMirrorItems } from "./follow-up-mirror";
const item = {
  id: "m",
  commandId: "c",
  state: "queued" as const,
  message: { id: "m", role: "user" as const, parts: [{ type: "text" as const, text: "body" }] },
};
describe("follow-up mirror publisher", () => {
  test("elides large individual and aggregate bodies without changing identity", () => {
    expect(followUpMirrorItems([item])[0]).toMatchObject({
      messageId: "m",
      message: JSON.stringify(item.message),
      messageDigest: expect.stringMatching(/^sha256:/),
    });
    const large = {
      ...item,
      message: { ...item.message, parts: [{ type: "text" as const, text: "x".repeat(9000) }] },
    };
    expect(followUpMirrorItems([large])[0]!.message).toBeNull();
    const many = followUpMirrorItems(
      Array.from({ length: 32 }, (_, i) => ({
        ...item,
        id: String(i),
        message: { ...item.message, parts: [{ type: "text" as const, text: "x".repeat(8000) }] },
      })),
    );
    expect(Buffer.byteLength(JSON.stringify(many))).toBeLessThan(64 * 1024);
    expect(many.some((i) => i.message === null)).toBe(true);
  });
  test("observes queues without pinning Session history and republishes on reconnect", async () => {
    let listener: ((emission: SessionStreamEmission) => unknown) | undefined;
    let online = true;
    const off = vi.fn();
    const observe = vi.fn((fn: (emission: SessionStreamEmission) => unknown) => {
      listener = fn;
      return off;
    });
    const runtime = {
      projection: async () => ({
        throughSequence: 1,
        projection: { queue: [item], queueRevision: 3 },
      }),
      onFollowUpQueue: observe,
      subscribe: vi.fn(),
    } as unknown as HostedSessionRuntime;
    const mutate = vi.fn(async () => ({ written: true }));
    const link = {
      get status() {
        return { state: online ? "connected" : "offline" };
      },
      mutate,
    } as unknown as BackendLink;
    const pub = createFollowUpMirror({
      runtime: () => runtime,
      link: () => link,
      generation: () => 2,
      owns: () => true,
      onError: vi.fn(),
    });
    pub.bind();
    await pub.refresh(["s"]);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(runtime.subscribe).not.toHaveBeenCalled();
    expect(mutate).toHaveBeenLastCalledWith(
      "followUps:mirror",
      expect.objectContaining({ sessionId: "s", generation: 2, revision: 3 }),
    );
    online = false;
    await expect(pub.publish("s")).rejects.toMatchObject({ code: "link_reset" });
    listener!({ kind: "queue", sessionId: "s", throughSequence: 1, revision: 4, queue: [] });
    const count = mutate.mock.calls.length;
    online = true;
    await pub.refresh(["s"]);
    expect(mutate.mock.calls.length).toBeGreaterThan(count);
    pub.close();
    await Promise.resolve();
    expect(off).toHaveBeenCalledTimes(1);
  });
});
