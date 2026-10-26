import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type {
  HostedSessionRuntime,
  SessionFollowUpItem,
  SessionStreamQueue,
} from "@volli/session-engine";
import type { BackendLink, LinkStatus } from "../cloud-runner/backend-link";
import { createFollowUpMirror, followUpMirrorItems } from "./follow-up-mirror";

const item = {
  id: "m",
  commandId: "c",
  state: "queued" as const,
  message: { id: "m", role: "user" as const, parts: [{ type: "text" as const, text: "body" }] },
};
type Snapshot = Awaited<ReturnType<HostedSessionRuntime["projection"]>>;
function snapshot(
  revision: number,
  queue: readonly SessionFollowUpItem[] = [item],
  read?: () => void,
): Snapshot {
  return {
    throughSequence: 1,
    projection: {
      queue,
      get queueRevision() {
        read?.();
        return revision;
      },
    },
  } as unknown as Snapshot;
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

interface Request {
  args: Record<string, unknown>;
  acknowledge(value?: unknown): void;
  reject(error: unknown): void;
}
function fixture() {
  let listener: ((emission: SessionStreamQueue) => void) | undefined;
  let online = true;
  let generation: number | null = 2;
  let owned = true;
  let current = snapshot(3);
  const off = vi.fn();
  const observe = vi.fn((fn: (emission: SessionStreamQueue) => void) => {
    listener = fn;
    return off;
  });
  const projection = vi.fn(async () => current);
  const runtime = {
    projection,
    onFollowUpQueue: observe,
    subscribe: vi.fn(),
  } as unknown as HostedSessionRuntime;
  let attached: HostedSessionRuntime | null = runtime;
  const requests: Request[] = [];
  const notices = new Map<number, { promise: Promise<Request>; resolve(value: Request): void }>();
  function notice(index: number) {
    let deferred = notices.get(index);
    if (deferred === undefined) {
      deferred = Promise.withResolvers<Request>();
      notices.set(index, deferred);
    }
    return deferred;
  }
  const statuses = new Set<(status: LinkStatus) => void>();
  const mutate = vi.fn((_name: string, args: Record<string, unknown>) => {
    const ack = Promise.withResolvers<unknown>();
    const request: Request = {
      args,
      acknowledge: (value = { written: true }) => ack.resolve(value),
      reject: ack.reject,
    };
    requests.push(request);
    notice(requests.length - 1).resolve(request);
    return ack.promise;
  });
  const status = (): LinkStatus =>
    online ? { state: "connected" } : { state: "offline", since: 0 };
  const link = {
    get status() {
      return status();
    },
    onStatus(fn: (state: LinkStatus) => void) {
      statuses.add(fn);
      return () => statuses.delete(fn);
    },
    mutate,
  } as unknown as BackendLink;
  const onError = vi.fn();
  const pub = createFollowUpMirror({
    runtime: () => attached,
    link: () => link,
    generation: () => generation,
    owns: () => owned,
    onError,
  });
  pub.bind();
  cleanup.push(() => pub.close());
  return {
    pub,
    runtime,
    projection,
    requests,
    mutate,
    onError,
    observe,
    off,
    request: (index: number) => notice(index).promise,
    attach(value: HostedSessionRuntime | null) {
      attached = value;
    },
    project(revision: number, queue: readonly SessionFollowUpItem[] = [item]) {
      current = snapshot(revision, queue);
    },
    online(value: boolean) {
      online = value;
      for (const fn of statuses) fn(status());
    },
    generation(value: number | null) {
      generation = value;
    },
    owns(value: boolean) {
      owned = value;
    },
    emit(revision: number, queue: readonly SessionFollowUpItem[] = [item], sessionId = "s") {
      listener!({ kind: "queue", sessionId, throughSequence: 1, revision, queue });
    },
  };
}

describe("follow-up mirror publisher", () => {
  test("elides large individual and aggregate bodies without changing 32 identities or order", () => {
    expect(followUpMirrorItems([{ ...item, afterCurrentStep: true }])[0]).toMatchObject({
      messageId: "m",
      message: JSON.stringify(item.message),
      messageDigest: expect.stringMatching(/^sha256:/),
      afterCurrentStep: true,
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
    expect(many.map(({ messageId }) => messageId)).toEqual(
      Array.from({ length: 32 }, (_, i) => String(i)),
    );
    expect(Buffer.byteLength(JSON.stringify(many))).toBeLessThan(64 * 1024);
    expect(many.some((i) => i.message === null)).toBe(true);
  });

  test("observes queues without pinning Session history, drops offline observations and refreshes on reconnect", async () => {
    const f = fixture();
    const refreshing = f.pub.refresh(["s"]);
    const first = await f.request(0);
    expect(first.args).toMatchObject({ sessionId: "s", generation: 2, revision: 3 });
    first.acknowledge();
    await refreshing;
    expect(f.observe).toHaveBeenCalledTimes(1);
    expect(f.runtime.subscribe).not.toHaveBeenCalled();
    f.online(false);
    await expect(f.pub.publish("s")).rejects.toMatchObject({ code: "link_reset" });
    f.emit(4, []);
    expect(f.requests).toHaveLength(1);
    f.project(4, []);
    f.online(true);
    const reconnect = f.pub.refresh(["s"]);
    const second = await f.request(1);
    expect(second.args).toMatchObject({ generation: 2, revision: 4, items: [] });
    second.acknowledge();
    await reconnect;
    f.pub.close();
    expect(f.off).toHaveBeenCalledTimes(1);
  });

  test("a delayed older projection cannot replace a newer pending emission while another send is in flight", async () => {
    const f = fixture();
    const delayed = Promise.withResolvers<Snapshot>();
    const observed = Promise.withResolvers<void>();
    f.projection.mockReturnValueOnce(delayed.promise);
    let completed = false;
    const published = f.pub.publish("s").then(() => {
      completed = true;
    });
    f.emit(8);
    const first = await f.request(0);
    const newest = { ...item, id: "newest" };
    f.emit(10, [newest]);
    delayed.resolve(snapshot(4, [], () => observed.resolve()));
    await observed.promise;
    expect(completed).toBe(false);
    first.acknowledge();
    const second = await f.request(1);
    expect(second.args).toMatchObject({
      generation: 2,
      revision: 10,
      items: [expect.objectContaining({ messageId: "newest" })],
    });
    // Revision 8's ACK is already newer than this strict caller's required 4.
    await published;
    second.acknowledge();
    await turn();
    expect(f.requests).toHaveLength(2);
  });

  test("an older delayed emission cannot displace a newer emission or an already acknowledged revision", async () => {
    const f = fixture();
    f.emit(7);
    const first = await f.request(0);
    f.emit(9, []);
    f.emit(8, [item]);
    first.acknowledge();
    const second = await f.request(1);
    expect(second.args).toMatchObject({ revision: 9, items: [] });
    second.acknowledge();
    await turn();
    f.project(8);
    await f.pub.publish("s");
    f.emit(7);
    await turn();
    expect(f.requests).toHaveLength(2);
  });

  test("strict completion waits for the required revision's ACK, not an older in-flight ACK", async () => {
    const f = fixture();
    f.emit(7);
    const first = await f.request(0);
    f.project(9, []);
    let completed = false;
    const published = f.pub.publish("s").then(() => {
      completed = true;
    });
    await turn();
    expect(completed).toBe(false);
    first.acknowledge();
    const required = await f.request(1);
    expect(required.args).toMatchObject({ revision: 9, items: [] });
    expect(completed).toBe(false);
    // written:false is still an ACK: the monotonic backend already has >=9.
    required.acknowledge({ written: false });
    await published;
    expect(completed).toBe(true);
  });

  test("failed calls do not ACK intake and a fresh snapshot can retry that revision", async () => {
    const f = fixture();
    f.project(5);
    const error = new Error("mirror rejected");
    const published = f.pub.publish("s");
    const failure = expect(published).rejects.toBe(error);
    const first = await f.request(0);
    f.onError.mockImplementation(() => {
      throw new Error("diagnostic failed");
    });
    first.reject(error);
    await failure;
    expect(f.onError).toHaveBeenCalledWith(error);
    // Losing a failed payload must not permit a lower revision to stand in.
    f.project(4);
    await expect(f.pub.publish("s")).rejects.toMatchObject({ code: "link_reset" });
    expect(f.requests).toHaveLength(1);
    f.project(5);
    const retry = f.pub.publish("s");
    const second = await f.request(1);
    expect(second.args.revision).toBe(5);
    second.acknowledge();
    await retry;
  });

  test("going offline rejects an in-flight strict barrier and an old ACK cannot satisfy reconnect work", async () => {
    const f = fixture();
    const published = f.pub.publish("s");
    const failure = expect(published).rejects.toMatchObject({ code: "link_reset" });
    const old = await f.request(0);
    f.online(false);
    await failure;
    f.emit(9, []);
    expect(f.requests).toHaveLength(1);
    f.project(9, []);
    f.online(true);
    let completed = false;
    const retry = f.pub.publish("s").then(() => {
      completed = true;
    });
    const current = await f.request(1);
    old.acknowledge();
    await turn();
    expect(completed).toBe(false);
    expect(current.args).toMatchObject({ generation: 2, revision: 9, items: [] });
    current.acknowledge();
    await retry;
  });

  test("a generation change fences delayed projections and accepts revision zero of the new claim", async () => {
    const f = fixture();
    const delayed = Promise.withResolvers<Snapshot>();
    f.projection.mockReturnValueOnce(delayed.promise);
    const old = f.pub.publish("s");
    const failure = expect(old).rejects.toMatchObject({ code: "link_reset" });
    f.generation(3);
    f.emit(0, []);
    await failure;
    const current = await f.request(0);
    expect(current.args).toMatchObject({ generation: 3, revision: 0, items: [] });
    delayed.resolve(snapshot(99));
    await turn();
    expect(f.requests).toHaveLength(1);
    f.project(0, []);
    const published = f.pub.publish("s");
    current.acknowledge();
    await published;
  });

  test("old-generation ACKs cannot clear a new send or discard its newer pending state", async () => {
    const f = fixture();
    f.project(7);
    const oldPublish = f.pub.publish("s");
    const failure = expect(oldPublish).rejects.toMatchObject({ code: "link_reset" });
    const old = await f.request(0);
    f.generation(3);
    f.emit(1, []);
    await failure;
    const current = await f.request(1);
    f.project(1, []);
    let completed = false;
    const published = f.pub.publish("s").then(() => {
      completed = true;
    });
    old.acknowledge();
    await turn();
    expect(completed).toBe(false);
    f.emit(2, [item]);
    await turn();
    expect(f.requests).toHaveLength(2);
    current.acknowledge();
    const newest = await f.request(2);
    expect(newest.args).toMatchObject({ generation: 3, revision: 2 });
    await published;
    newest.acknowledge();
    await turn();
    expect(f.requests).toHaveLength(3);
  });

  test("a delayed observer from a replaced runtime cannot retire the new runtime's strict send", async () => {
    const f = fixture();
    const stale = f.observe.mock.calls[0]![0];
    f.attach({ ...f.runtime });
    f.pub.bind();
    const published = f.pub.publish("s");
    const current = await f.request(0);
    stale({ kind: "queue", sessionId: "s", throughSequence: 1, revision: 99, queue: [] });
    await turn();
    current.acknowledge();
    await published;
    expect(f.requests).toHaveLength(1);
    expect(f.runtime.subscribe).not.toHaveBeenCalled();
  });

  test("unclaimed, foreign, and closed publishers fail strict calls without retaining subscriptions or sends", async () => {
    const f = fixture();
    f.generation(null);
    await expect(f.pub.publish("s")).rejects.toMatchObject({ code: "link_reset" });
    f.generation(2);
    f.owns(false);
    await expect(f.pub.publish("s")).rejects.toMatchObject({ code: "link_reset" });
    f.emit(4);
    expect(f.requests).toHaveLength(0);
    f.pub.close();
    f.pub.bind();
    f.owns(true);
    await expect(f.pub.publish("s")).rejects.toMatchObject({ code: "link_reset" });
    expect(f.off).toHaveBeenCalledTimes(1);
    expect(f.observe).toHaveBeenCalledTimes(1);
  });
});
