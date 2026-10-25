/** Turn-end/interval packing is background work, independent of the ordered fact drain. */
import type { TranscriptReference } from "@volli/shared";
import { TRANSCRIPT_PACK_INTERVAL_MS, TRANSCRIPT_PACK_MAX_BYTES } from "@volli/shared/cloud";
import { withRootLogContext } from "../log/context";
import { ObjectUploadError } from "../transcript-spool/object-store";
import type { BackendLink } from "../cloud-runner/backend-link";
import type { DrainCursorStore, DrainLedger } from "../cloud-runner/drain";
import type { createCloudTranscriptPublisher } from "./transcripts";

const RETRY_MS = 5_000;
const STOP_MS = 2_000;
const PASS_MS = 5 * 60 * 1000;
const TERMINAL = new Set([
  "stale_claim",
  "not_claimed",
  "fenced",
  "not_your_runner",
  "not_found",
  "revoked",
  "not_a_runner",
  "forbidden",
  "unauthenticated",
  "conflict",
  "invalid_argument",
  "storage_unconfigured",
  "invalid_request",
]);

type PackingReport = Awaited<ReturnType<ReturnType<typeof createCloudTranscriptPublisher>["pack"]>>;

export function createTranscriptPacking(options: {
  ownerUserId: string;
  link: Pick<BackendLink, "status" | "onStatus">;
  cursors: DrainCursorStore;
  ledger: DrainLedger;
  pack: ReturnType<typeof createCloudTranscriptPublisher>["pack"];
  artifactBytes(reference: TranscriptReference): Promise<number | null>;
  onError(sessionId: string, code: string): void;
  onReport(sessionId: string, report: PackingReport): void;
}) {
  let started = false;
  let closing = false;
  let closed = false;
  let running: Promise<void> | null = null;
  let interval: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let passTimer: ReturnType<typeof setTimeout> | undefined;
  const lifetime = new AbortController();
  const pending = new Set<string>();
  const retryAt = new Map<string, number>();
  const checked = new Map<string, number>();
  const acceptedChecks = new Map<string, number>();
  const unpackedBytes = new Map<string, { sizes: Map<number, number>; total: number }>();
  const packedThrough = new Map<string, number>();
  let checkQueued = false;
  // Permanent refusals require a new claim or an explicit store restart, not a network flap.
  const refused = new Map<string, number>();
  const eligible = (sessionId: string) => {
    const row = options.cursors.get(sessionId);
    return (
      row !== null &&
      row.ownerUserId === options.ownerUserId &&
      row.blocked === null &&
      row.acceptedThrough > 0 &&
      refused.get(sessionId) !== row.generation
    );
  };
  const all = () => {
    for (const row of options.cursors.list()) {
      if (!eligible(row.sessionId)) continue;
      pending.add(row.sessionId);
      checked.set(row.sessionId, row.acceptedThrough);
    }
  };
  function scheduleRetry() {
    clearTimeout(retry);
    retry = undefined;
    if (closed || closing || retryAt.size === 0) return;
    retry = setTimeout(
      () => {
        retry = undefined;
        for (const [id, at] of retryAt) {
          if (at > Date.now()) continue;
          retryAt.delete(id);
          if (eligible(id)) pending.add(id);
        }
        kick();
      },
      Math.max(0, Math.min(...retryAt.values()) - Date.now()),
    );
    retry.unref?.();
  }
  function kick() {
    if (
      !started ||
      closed ||
      running !== null ||
      pending.size === 0 ||
      options.link.status.state !== "connected"
    )
      return;
    running = withRootLogContext({}, () =>
      Promise.resolve()
        .then(async () => {
          while (pending.size > 0) {
            if (closed || options.link.status.state !== "connected") break;
            const id = pending.values().next().value!;
            pending.delete(id);
            if (!eligible(id)) continue;
            const { generation, acceptedThrough } = options.cursors.get(id)!;
            await withRootLogContext({ sessionId: id }, async () => {
              const deadline = new AbortController();
              passTimer = setTimeout(
                () => deadline.abort(new Error("Session history upload timed out.")),
                PASS_MS,
              );
              passTimer.unref?.();
              try {
                const report = await options.pack(
                  id,
                  AbortSignal.any([lifetime.signal, deadline.signal]),
                );
                if (!closed) {
                  options.onReport(id, report);
                  packedThrough.set(id, acceptedThrough);
                  const bytes = unpackedBytes.get(id);
                  if (bytes !== undefined) {
                    for (const [sequence, size] of bytes.sizes) {
                      if (sequence <= acceptedThrough) {
                        bytes.total -= size;
                        bytes.sizes.delete(sequence);
                      }
                    }
                    if (bytes.sizes.size === 0) unpackedBytes.delete(id);
                  }
                }
                retryAt.delete(id);
              } catch (error) {
                if (closed) return;
                const value = error as { code?: string; data?: { code?: string } } | null;
                const permanentUpload = error instanceof ObjectUploadError && !error.retriable;
                const code =
                  error instanceof ObjectUploadError
                    ? `object_http_${error.status}`
                    : (value?.data?.code ?? value?.code ?? "upload_failed");
                options.onError(id, code);
                if (permanentUpload || TERMINAL.has(code)) {
                  refused.set(id, generation);
                  pending.delete(id);
                } else if (!closing) {
                  pending.delete(id);
                  retryAt.set(id, Date.now() + RETRY_MS);
                }
              } finally {
                clearTimeout(passTimer);
                passTimer = undefined;
              }
            });
          }
        })
        .finally(() => {
          running = null;
          scheduleRetry();
          // An acknowledgement can enqueue between loop exhaustion and finalization.
          kick();
        }),
    );
  }
  let off: (() => void) | undefined;
  function close() {
    closed = true;
    off?.();
    clearInterval(interval);
    clearTimeout(retry);
    clearTimeout(passTimer);
    lifetime.abort(new Error("Session history publisher closed."));
    pending.clear();
    retryAt.clear();
    checked.clear();
    acceptedChecks.clear();
    unpackedBytes.clear();
    packedThrough.clear();
    refused.clear();
  }
  return {
    start() {
      if (started || closed) return;
      started = true;
      off = options.link.onStatus((status) => {
        if (closing || closed || status.state !== "connected") return;
        retryAt.clear();
        clearTimeout(retry);
        all();
        kick();
      });
      // Rebuild from backend heads, even if the drain has nothing left to send.
      all();
      kick();
      interval = setInterval(() => {
        if (!closing) {
          all();
          kick();
        }
      }, TRANSCRIPT_PACK_INTERVAL_MS);
      interval.unref?.();
    },
    accepted(sessionId: string, through: number) {
      if (!started || closing || closed) return;
      acceptedChecks.set(sessionId, Math.max(through, acceptedChecks.get(sessionId) ?? 0));
      if (checkQueued) return;
      checkQueued = true;
      // Never do IO or throw into sessions.accept's acknowledgement callback.
      void withRootLogContext({}, () =>
        Promise.resolve()
          .then(async () => {
            if (closing || closed) return;
            for (const [id, acceptedThrough] of acceptedChecks) {
              acceptedChecks.delete(id);
              if (!eligible(id)) continue;
              let after = Math.min(checked.get(id) ?? 0, acceptedThrough);
              let settled = false;
              while (after < acceptedThrough) {
                const page = options.ledger.listEvents({
                  sessionId: id,
                  afterSequence: after,
                  limit: 256,
                });
                if (page.length === 0) break;
                for (const event of page) {
                  if (event.sequence > acceptedThrough) break;
                  const kind = event.payload.kind;
                  if (kind === "transcript.referenced") {
                    const bytes = await options.artifactBytes(event.payload.reference);
                    if (closed) return;
                    if (event.sequence > (packedThrough.get(id) ?? 0)) {
                      let measured = unpackedBytes.get(id);
                      if (measured === undefined) {
                        measured = { sizes: new Map(), total: 0 };
                        unpackedBytes.set(id, measured);
                      }
                      // Unknown size is a reason to try packing, never to drop history.
                      const size = bytes ?? TRANSCRIPT_PACK_MAX_BYTES;
                      measured.total += size - (measured.sizes.get(event.sequence) ?? 0);
                      measured.sizes.set(event.sequence, size);
                      settled ||= measured.total >= TRANSCRIPT_PACK_MAX_BYTES;
                    }
                  }
                  settled ||=
                    kind === "turn.completed" ||
                    kind === "turn.interrupted" ||
                    kind === "attachment.closed" ||
                    kind === "attachment.failed" ||
                    kind === "session.stopped";
                }
                after = Math.min(page.at(-1)!.sequence, acceptedThrough);
              }
              checked.set(id, acceptedThrough);
              if (settled) pending.add(id);
            }
            kick();
          })
          .catch(() => {
            if (!closed) options.onError(sessionId, "history_read_failed");
          })
          .finally(() => {
            checkQueued = false;
            if (!closed && !closing && acceptedChecks.size > 0) {
              const [id, sequence] = acceptedChecks.entries().next().value!;
              this.accepted(id, sequence);
            }
          }),
      );
    },
    refresh() {
      if (closing || closed) return;
      all();
      kick();
    },
    /** Abort before host shutdown can close SQLite; a restart recovers from backend heads. */
    async stop() {
      if (closed) return;
      closing = true;
      close();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          running,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, STOP_MS);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        close();
      }
    },
    close,
  };
}
