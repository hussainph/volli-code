/** The process-local subscriptions over the host-owned durable outbox. */
import { shortSessionId, type CommandReceipt, type SessionEvent } from "@volli/shared";
import {
  isSessionStreamFrame,
  type HostNotice,
  type HostNoticeOutbox,
  type HostNoticeReceipt,
} from "@volli/session-engine";
import {
  errorText,
  hostNoticeCommand,
  type HostNoticeDelivery,
  type HostNoticeDeliveryPorts,
  type NoticeDelivery,
} from "./host-notice-delivery";

type Ports = Omit<HostNoticeDeliveryPorts, "delivery"> & {
  outbox: HostNoticeOutbox;
  /** Direct Engine writers can stop detached readers without a runtime frame. */
  subscribeEvents?: (listener: (event: SessionEvent) => void) => () => void;
};

interface PendingDelivery {
  notice: HostNotice;
  initializing: Promise<NoticeDelivery>;
  checking: Promise<NoticeDelivery> | null;
  ready: boolean;
  terminal: boolean;
  failed: boolean;
  liveId: string | null;
  sequence: number;
  inFlight: boolean;
  retryAfterFlight: boolean;
  release: (() => void) | null;
  outcome: NoticeDelivery;
}

function terminalReceipt(receipt: CommandReceipt): HostNoticeReceipt | null {
  switch (receipt.status) {
    case "accepted":
    case "completed":
      return { status: "accepted" };
    case "rejected":
      return { status: "rejected", code: receipt.code, detail: receipt.detail };
    case "unreconciled":
      return null;
  }
}

function release(entry: PendingDelivery): void {
  entry.release?.();
  entry.release = null;
}

/**
 * Persist before even reading the projection. Subscribe before submission,
 * including for live readers: replay can contain a stop, detach, or a receipt
 * committed by the prior host. A replay never submits until subscribe returns.
 * Stream listeners never await the command (idle turns need those listeners).
 *
 * One process-local entry coalesces duplicate producers and retries. Failures
 * and unreconciled outcomes keep the first stored text/nonce; another delivery,
 * a later attachment, or boot recovery can retry it. No polling or retry timer.
 */
export function createHostNoticeDelivery(ports: Ports): HostNoticeDelivery {
  const pending = new Map<string, PendingDelivery>();
  let closed = false;

  const forget = (entry: PendingDelivery): void => {
    release(entry);
    if (pending.get(entry.notice.commandId) === entry) pending.delete(entry.notice.commandId);
  };
  const finish = async (entry: PendingDelivery, receipt: HostNoticeReceipt): Promise<void> => {
    if (entry.terminal) return;
    entry.terminal = true;
    release(entry);
    if (receipt.status === "rejected") {
      ports.report(`${entry.notice.label} was refused: ${receipt.code} ${receipt.detail}`);
    } else if (receipt.status === "dropped") {
      entry.outcome = "reader-stopped";
      ports.report(
        `${entry.notice.label} was not delivered: Session ${shortSessionId(entry.notice.sessionId)} is stopped`,
      );
    }
    try {
      await ports.outbox.settle(entry.notice.commandId, receipt);
    } catch (error) {
      // The durable runtime receipt/stop lets recovery repeat just this cleanup.
      ports.report(`${entry.notice.label} could not settle its outbox: ${errorText(error)}`);
    } finally {
      forget(entry);
    }
  };
  const submit = (entry: PendingDelivery): void => {
    if (closed || !entry.ready || entry.terminal || entry.failed || entry.inFlight) return;
    if (entry.liveId === null) {
      entry.outcome = "parked";
      return;
    }
    entry.inFlight = true;
    entry.outcome = "delivered";
    // The microtask also catches a synchronous command throw and prevents an
    // attachment replay listener from submitting into its own publish stack.
    void Promise.resolve()
      .then(() => {
        if (closed || entry.terminal || entry.failed || entry.liveId === null) return null;
        return ports.runtime.command(hostNoticeCommand(entry.notice));
      })
      .then(async (result) => {
        if (result === null || entry.terminal) return;
        const receipt = result.receipt === null ? null : terminalReceipt(result.receipt);
        if (receipt !== null) await finish(entry, receipt);
        else ports.report(`${entry.notice.label} has no terminal receipt; retained for retry`);
      })
      .catch((error: unknown) => {
        ports.report(`${entry.notice.label} failed: ${errorText(error)}`);
      })
      .finally(() => {
        entry.inFlight = false;
        if (entry.retryAfterFlight) {
          entry.retryAfterFlight = false;
          submit(entry);
        }
      });
  };
  const read = async (entry: PendingDelivery) => {
    const snapshot = await ports.runtime.projection({ sessionId: entry.notice.sessionId });
    if (closed || entry.terminal || entry.failed) return snapshot;
    // Do not overwrite newer subscription state with an older projection.
    if (snapshot.throughSequence >= entry.sequence) {
      entry.liveId = snapshot.projection.liveExecutor?.id ?? null;
      entry.sequence = snapshot.throughSequence;
    }
    const receipt = snapshot.projection.receipts.find(
      (candidate) => candidate.commandId === entry.notice.commandId && terminalReceipt(candidate),
    );
    if (receipt !== undefined) {
      entry.outcome = "already-settled";
      await finish(entry, terminalReceipt(receipt)!);
    } else if (snapshot.projection.stopped !== null) {
      await finish(entry, { status: "dropped", reason: "reader-stopped" });
    }
    return snapshot;
  };
  const connect = async (entry: PendingDelivery): Promise<NoticeDelivery> => {
    entry.ready = false;
    entry.failed = false;
    const snapshot = await read(entry);
    if (closed || entry.terminal) return entry.outcome;
    const unsubscribe = await ports.runtime.subscribe(
      { sessionId: entry.notice.sessionId, afterSequence: snapshot.throughSequence },
      (emission) => {
        if (closed || entry.terminal || entry.failed || !isSessionStreamFrame(emission)) return;
        if (emission.sequence <= entry.sequence) return;
        entry.sequence = emission.sequence;
        const payload = emission.event.payload;
        if (payload.kind === "command.receipt.recorded") {
          if (payload.receipt.commandId !== entry.notice.commandId) return;
          const receipt = terminalReceipt(payload.receipt);
          if (receipt !== null) void finish(entry, receipt);
        } else if (payload.kind === "session.stopped") {
          void finish(entry, { status: "dropped", reason: "reader-stopped" });
        } else if (payload.kind === "attachment.opened") {
          // A reattachment can race the failure of the old attempt. Remember
          // the edge, rather than losing its only wake to the in-flight guard.
          if (entry.inFlight && entry.liveId !== payload.attachment.id) {
            entry.retryAfterFlight = true;
          }
          entry.liveId = payload.attachment.id;
          submit(entry);
        } else if (payload.kind === "attachment.closed" && payload.attachmentId === entry.liveId) {
          entry.liveId = null;
          entry.outcome = "parked";
        }
      },
      (error) => {
        entry.failed = true;
        release(entry);
        // Keep the durable payload tracked for direct receipts/stops and the
        // next attachment wake; the shell producer may never run again.
        ports.report(`${entry.notice.label} lost its stream: ${errorText(error)}`);
      },
    );
    entry.release = unsubscribe;
    if (closed || entry.terminal || entry.failed) release(entry);
    entry.ready = true;
    if (entry.inFlight) entry.retryAfterFlight = true;
    submit(entry);
    return entry.outcome;
  };
  const reconnect = (entry: PendingDelivery): Promise<NoticeDelivery> => {
    entry.checking ??= connect(entry)
      .catch((error: unknown) => {
        entry.failed = true;
        entry.ready = true;
        release(entry);
        throw error;
      })
      .finally(() => {
        entry.checking = null;
      });
    return entry.checking;
  };
  const initialize = async (entry: PendingDelivery): Promise<NoticeDelivery> => {
    // put returns the FIRST payload, not this attempt's regenerated text.
    const stored = await ports.outbox.put(entry.notice);
    if (stored === null) {
      forget(entry);
      return "already-settled";
    }
    entry.notice = stored;
    if (closed || entry.terminal) return entry.outcome;
    return reconnect(entry);
  };
  const deliver = (notice: HostNotice): Promise<NoticeDelivery> => {
    if (closed) return Promise.reject(new Error("Host notice delivery is closed"));
    const existing = pending.get(notice.commandId);
    if (existing !== undefined) {
      if (existing.notice.sessionId !== notice.sessionId) {
        return Promise.reject(
          new Error(`Host notice ${notice.commandId} belongs to a different Session`),
        );
      }
      if (existing.terminal) return existing.initializing;
      if (!existing.ready) return existing.checking ?? existing.initializing;
      if (existing.failed) return reconnect(existing);
      if (existing.inFlight) return existing.initializing;
      existing.checking ??= read(existing)
        .then(() => {
          submit(existing);
          return existing.outcome;
        })
        .finally(() => {
          existing.checking = null;
        });
      return existing.checking;
    }
    const entry: PendingDelivery = {
      notice,
      initializing: Promise.resolve("parked"),
      checking: null,
      ready: false,
      terminal: false,
      failed: false,
      liveId: null,
      sequence: 0,
      inFlight: false,
      retryAfterFlight: false,
      release: null,
      outcome: "parked",
    };
    pending.set(notice.commandId, entry);
    entry.initializing = initialize(entry).catch((error: unknown) => {
      // A failed put has no stored payload. A failed subscription does, and
      // reconnect marks it failed so direct cleanup and attachment wakes work.
      if (!entry.failed) forget(entry);
      throw error;
    });
    return entry.initializing;
  };
  const unsubscribeEvents = ports.subscribeEvents?.((event) => {
    if (closed) return;
    const payload = event.payload;
    // Healthy subscriptions use the runtime attachment frame. Failed ones
    // wake on the accepted start receipt: Engine attachment.opened is too
    // early (the runtime has not installed the binding yet), while this
    // receipt is recorded only after installation and runtime publication.
    if (payload.kind === "session.stopped") {
      for (const entry of pending.values()) {
        if (entry.notice.sessionId === event.sessionId) {
          void finish(entry, { status: "dropped", reason: "reader-stopped" });
        }
      }
    } else if (payload.kind === "command.receipt.recorded") {
      const receiptEntry = pending.get(payload.receipt.commandId);
      const receipt = terminalReceipt(payload.receipt);
      if (
        receiptEntry !== undefined &&
        receiptEntry.notice.sessionId === event.sessionId &&
        receipt !== null
      ) {
        void finish(receiptEntry, receipt);
      }
      if (
        payload.receipt.status === "accepted" &&
        payload.receipt.result.kind === "executor.start.requested"
      ) {
        for (const entry of pending.values()) {
          if (entry.notice.sessionId !== event.sessionId || !entry.failed || entry.terminal)
            continue;
          // Do not await subscription replay (or an idle command) in a writer.
          void entry.initializing
            .catch(() => undefined)
            .then(() => {
              if (closed || entry.terminal || !entry.failed) return;
              return reconnect(entry);
            })
            .catch((error: unknown) => {
              ports.report(`${entry.notice.label} recovery failed: ${errorText(error)}`);
            });
        }
      }
    }
  });
  return {
    deliver,
    recover: async () => {
      for (const notice of await ports.outbox.pending()) {
        if (closed) break;
        try {
          await deliver(notice);
        } catch (error) {
          ports.report(`${notice.label} recovery failed: ${errorText(error)}`);
        }
      }
    },
    close: () => {
      if (closed) return;
      closed = true;
      unsubscribeEvents?.();
      for (const entry of pending.values()) release(entry);
      pending.clear();
    },
  };
}
