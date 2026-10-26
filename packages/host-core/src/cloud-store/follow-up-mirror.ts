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

type QueueState = { revision: number; items: FollowUpMirrorItem[] };
interface ClaimState {
  generation: number;
  highest: number;
  acknowledged: number;
  pending?: QueueState;
  sending?: Promise<void>;
  retired: boolean;
  waiters: Set<(error: LinkResetError) => void>;
}

function waitForClaim<T>(state: ClaimState, operation: Promise<T>): Promise<T> {
  if (state.retired) {
    void operation.catch(() => {});
    return Promise.reject(new LinkResetError());
  }
  return new Promise((resolve, reject) => {
    const stop = (error: LinkResetError) => reject(error);
    state.waiters.add(stop);
    void operation.then(
      (value) => {
        state.waiters.delete(stop);
        resolve(value);
      },
      (error: unknown) => {
        state.waiters.delete(stop);
        reject(error);
      },
    );
  });
}

function offerQueue(
  state: ClaimState,
  revision: number,
  queue: readonly SessionFollowUpItem[],
): void {
  if (
    revision < state.highest ||
    (revision === state.highest &&
      (state.pending !== undefined ||
        state.sending !== undefined ||
        state.acknowledged >= revision))
  )
    return;
  state.highest = revision;
  state.pending = { revision, items: followUpMirrorItems(queue) };
}

export function createFollowUpMirror(input: {
  runtime(): HostedSessionRuntime | null;
  link(): BackendLink | null;
  generation(sessionId: string): number | null;
  owns(sessionId: string): boolean;
  onError(error: unknown): void;
}) {
  let off: (() => void) | null = null;
  let boundRuntime: HostedSessionRuntime | null = null;
  let watchedLink: BackendLink | null = null;
  let offStatus: (() => void) | null = null;
  const claims = new Map<string, ClaimState>();
  let closed = false;

  function report(error: unknown): void {
    try {
      input.onError(error);
    } catch {
      // Diagnostics do not change a mirror acknowledgement or an intake result.
    }
  }

  function retire(sessionId: string, state: ClaimState): void {
    if (claims.get(sessionId) === state) claims.delete(sessionId);
    state.retired = true;
    state.pending = undefined;
    state.sending = undefined;
    for (const reject of state.waiters) reject(new LinkResetError());
    state.waiters.clear();
  }

  function retireAll(): void {
    for (const [sessionId, state] of claims) retire(sessionId, state);
  }

  function connectedLink(): BackendLink | null {
    if (closed) return null;
    const live = input.link();
    if (live !== watchedLink) {
      offStatus?.();
      retireAll();
      watchedLink = live;
      offStatus =
        live?.onStatus((status) => {
          if (watchedLink === live && status.state !== "connected") retireAll();
        }) ?? null;
    }
    if (closed || live === null || live.status.state !== "connected") {
      retireAll();
      return null;
    }
    return live;
  }

  function claim(sessionId: string): ClaimState {
    const live = connectedLink();
    const generation = input.generation(sessionId);
    const previous = claims.get(sessionId);
    if (live === null || generation === null || !input.owns(sessionId)) {
      if (previous !== undefined) retire(sessionId, previous);
      throw new LinkResetError();
    }
    if (previous?.generation === generation) return previous;
    if (previous !== undefined) retire(sessionId, previous);
    const state: ClaimState = {
      generation,
      highest: -1,
      acknowledged: -1,
      retired: false,
      waiters: new Set(),
    };
    claims.set(sessionId, state);
    return state;
  }

  function currentLink(sessionId: string, state: ClaimState): BackendLink {
    const live = connectedLink();
    if (
      live === null ||
      state.retired ||
      claims.get(sessionId) !== state ||
      input.generation(sessionId) !== state.generation ||
      !input.owns(sessionId)
    ) {
      retire(sessionId, state);
      throw new LinkResetError();
    }
    return live;
  }

  function flush(sessionId: string, state: ClaimState): Promise<void> | undefined {
    const live = currentLink(sessionId, state);
    if (state.sending !== undefined) return state.sending;
    const outgoing = state.pending;
    if (outgoing === undefined) return undefined;
    state.pending = undefined;
    // Keep the high-water revision independently of pending/in-flight payloads.
    // A late projection cannot replace a newer pending emission, even while
    // the previous mutation is still awaiting its acknowledgement.
    const operation: Promise<void> = Promise.resolve()
      .then(() => {
        currentLink(sessionId, state);
        return live.mutate("followUps:mirror", {
          sessionId,
          generation: state.generation,
          ...outgoing,
        });
      })
      .then(() => {
        currentLink(sessionId, state);
        // A successful monotonic mirror mutation acknowledges this revision or
        // a newer one already stored by the backend, including written:false.
        state.acknowledged = Math.max(state.acknowledged, outgoing.revision);
      })
      .catch((error: unknown) => {
        report(error);
        throw error;
      })
      .finally(() => {
        if (state.sending === operation) state.sending = undefined;
        if (!state.retired && state.pending !== undefined) background(sessionId, state);
      });
    state.sending = operation;
    // Background updates are best effort; strict callers separately await this
    // operation. A failed payload is not buffered or retried indefinitely.
    void operation.catch(() => {});
    return operation;
  }

  function background(sessionId: string, state: ClaimState): void {
    try {
      void flush(sessionId, state)?.catch(() => {});
    } catch {
      // Offline/fenced state is discarded and rebuilt by refresh, never replayed.
    }
  }

  async function publish(sessionId: string): Promise<void> {
    const runtime = input.runtime();
    if (closed || runtime === null || !input.owns(sessionId)) {
      const previous = claims.get(sessionId);
      if (previous !== undefined) retire(sessionId, previous);
      throw new LinkResetError();
    }
    const state = claim(sessionId);
    const { projection } = await waitForClaim(state, runtime.projection({ sessionId }));
    currentLink(sessionId, state);
    if (runtime !== input.runtime()) {
      retire(sessionId, state);
      throw new LinkResetError();
    }
    const required = projection.queueRevision ?? 0;
    offerQueue(state, required, projection.queue ?? []);
    while (true) {
      currentLink(sessionId, state);
      if (state.acknowledged >= required) return;
      const operation = flush(sessionId, state);
      if (operation === undefined) throw new LinkResetError();
      // Intake completion cannot overtake the required revision (or a newer
      // acknowledged snapshot), nor succeed using a retired claim's ACK.
      await waitForClaim(state, operation);
    }
  }

  function bind(): void {
    if (closed) return;
    const runtime = input.runtime();
    if (boundRuntime !== runtime) retireAll();
    boundRuntime = runtime;
    off?.();
    off =
      runtime?.onFollowUpQueue?.((emission) => {
        if (closed || runtime !== input.runtime()) return;
        if (!input.owns(emission.sessionId)) {
          const previous = claims.get(emission.sessionId);
          if (previous !== undefined) retire(emission.sessionId, previous);
          return;
        }
        try {
          const state = claim(emission.sessionId);
          offerQueue(state, emission.revision, emission.queue);
          background(emission.sessionId, state);
        } catch {
          // Offline/unclaimed observations are live state, not a retry buffer.
        }
      }) ?? null;
  }

  return {
    publish,
    bind,
    async refresh(sessionIds: readonly string[]) {
      for (const id of sessionIds) await publish(id).catch(report);
    },
    close() {
      closed = true;
      off?.();
      off = null;
      offStatus?.();
      offStatus = null;
      watchedLink = null;
      retireAll();
    },
  };
}
