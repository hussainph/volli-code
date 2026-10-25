/**
 * A cloud store's answers for a restart resume (`session-runtime/restart-resume.ts`):
 * whether the runner's link has connected once this launch, and the backend's
 * verdict on each recovered Session's Ticket siblings
 * (`runnerRecovery.ticketSiblings`). No Electron.
 *
 * Both fail closed. The wait resolves `false` past its bound or on close, and
 * a sibling read rejects when no link is live, the link has no reads, the
 * backend refuses (a claim this runner lost, another owner's Session) or its
 * reply is not the shape this build reads. The restart resume then leaves the
 * turn for the person.
 */
import type { BackendLink } from "../cloud-runner/backend-link";
import type { CloudRecoverySiblings, RestartResumeCloud } from "../session-runtime/restart-resume";

export interface CloudRestartRecovery extends RestartResumeCloud {
  /**
   * Follows one link until it first connects; the store calls it whenever it
   * connects a link. Idempotent once connected.
   */
  observe(link: BackendLink): void;
}

export function createCloudRestartRecovery(options: {
  /** The store's live link, or `null` while none is connected. */
  currentLink(): BackendLink | null;
}): CloudRestartRecovery {
  const connected = Promise.withResolvers<void>();
  let hasConnected = false;
  const markConnected = () => {
    hasConnected = true;
    connected.resolve();
  };
  return {
    observe(link) {
      if (hasConnected) return;
      if (link.status.state === "connected") {
        markConnected();
        return;
      }
      const off = link.onStatus((status) => {
        if (status.state !== "connected") return;
        off();
        markConnected();
      });
    },
    async firstConnect({ timeoutMs, signal }) {
      if (hasConnected) return true;
      if (signal.aborted) return false;
      const gaveUp = Promise.withResolvers<false>();
      const onAbort = () => gaveUp.resolve(false);
      const timer = setTimeout(onAbort, timeoutMs);
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await Promise.race([connected.promise.then(() => true as const), gaveUp.promise]);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      }
    },
    async ticketSiblings(input) {
      const link = options.currentLink();
      if (link === null) throw new Error("Volli Cloud is unreachable.");
      if (link.query === undefined) throw new Error("Runner recovery reads are unavailable.");
      return readSiblings(await link.query("runnerRecovery:ticketSiblings", { ...input }));
    },
  };
}

/** The reply as this build reads it, or a throw: a shape it cannot read is no answer. */
function readSiblings(value: unknown): CloudRecoverySiblings {
  if (typeof value !== "object" || value === null) throw unreadable();
  const { siblings, complete } = value as { siblings?: unknown; complete?: unknown };
  if (typeof complete !== "boolean" || !Array.isArray(siblings)) throw unreadable();
  return {
    complete,
    siblings: siblings.map((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) throw unreadable();
      const { sessionId, movedOn } = entry as { sessionId?: unknown; movedOn?: unknown };
      if (typeof sessionId !== "string" || (typeof movedOn !== "boolean" && movedOn !== null)) {
        throw unreadable();
      }
      return { sessionId, movedOn };
    }),
  };
}

const unreadable = () => new Error("Volli Cloud's sibling answer is unreadable.");
