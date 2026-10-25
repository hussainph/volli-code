/** Rebuildable live state: coalesced while connected, never a second retry buffer. */
import { createHash } from "node:crypto";
import type { HostedSessionRuntime, SessionFollowUpItem } from "@volli/session-engine";
import {
  FOLLOW_UP_MESSAGE_MAX_BYTES,
  FOLLOW_UP_MIRROR_MAX_BYTES,
  type FollowUpMirrorItem,
} from "@volli/shared/cloud";
import { LinkResetError, type BackendLink } from "../cloud-runner/backend-link";

export function followUpMirrorItems(queue: readonly SessionFollowUpItem[]): FollowUpMirrorItem[] {
  const items = queue.map((item) => {
    const message = JSON.stringify(item.message);
    return {
      messageId: item.id,
      commandId: item.commandId,
      state: item.state,
      ...(item.afterCurrentStep ? { afterCurrentStep: true } : {}),
      message: Buffer.byteLength(message) <= FOLLOW_UP_MESSAGE_MAX_BYTES ? message : null,
      messageDigest: `sha256:${createHash("sha256").update(message).digest("hex")}`,
    };
  });
  // Keep identity and order when individually small bodies exceed the combined cap.
  for (
    let i = items.length - 1;
    Buffer.byteLength(JSON.stringify(items)) + 1024 > FOLLOW_UP_MIRROR_MAX_BYTES && i >= 0;
    i--
  )
    items[i]!.message = null;
  return items;
}

export function createFollowUpMirror(input: {
  runtime(): HostedSessionRuntime | null;
  link(): BackendLink | null;
  generation(sessionId: string): number | null;
  owns(sessionId: string): boolean;
  onError(error: unknown): void;
}) {
  let off: (() => void) | null = null;
  const pending = new Map<string, { revision: number; items: FollowUpMirrorItem[] }>();
  const sending = new Map<string, Promise<void>>();
  let closed = false;
  function flush(sessionId: string, strict = false): Promise<void> {
    const previous = sending.get(sessionId);
    if (previous !== undefined) return previous.then(() => flush(sessionId, strict));
    const live = input.link();
    const generation = input.generation(sessionId);
    if (closed || live === null || live.status.state !== "connected" || generation === null)
      return strict ? Promise.reject(new LinkResetError()) : Promise.resolve();
    const state = pending.get(sessionId);
    if (state === undefined) return Promise.resolve();
    pending.delete(sessionId);
    const operation = live
      .mutate("followUps:mirror", { sessionId, generation, ...state })
      .then(
        () => {},
        (error) => {
          input.onError(error);
          throw error;
        },
      )
      .finally(() => {
        sending.delete(sessionId);
      });
    sending.set(sessionId, operation);
    return operation;
  }
  async function publish(sessionId: string) {
    const runtime = input.runtime();
    if (closed || runtime === null || !input.owns(sessionId)) throw new LinkResetError();
    const { projection } = await runtime.projection({ sessionId });
    pending.set(sessionId, {
      revision: projection.queueRevision ?? 0,
      items: followUpMirrorItems(projection.queue ?? []),
    });
    // An inbox completion must not overtake a skipped, disconnected mirror.
    await flush(sessionId, true);
  }
  function bind() {
    off?.();
    off =
      input.runtime()?.onFollowUpQueue?.((emission) => {
        if (closed || !input.owns(emission.sessionId)) return;
        pending.set(emission.sessionId, {
          revision: emission.revision,
          items: followUpMirrorItems(emission.queue),
        });
        void flush(emission.sessionId).catch(() => {});
      }) ?? null;
  }
  return {
    publish,
    bind,
    async refresh(sessionIds: readonly string[]) {
      for (const id of sessionIds) await publish(id).catch(input.onError);
    },
    close() {
      closed = true;
      off?.();
      off = null;
      pending.clear();
    },
  };
}
