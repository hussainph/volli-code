/**
 * What the structured runtime has open inside a worktree — the two questions
 * every destructive worktree action has to ask about agents, and the only place
 * that asks them.
 *
 * Both are scoped to ONE directory, and that is the point. `openNativeBindings`
 * lists every binding this process holds, and answering "is anything working
 * here?" from the whole list means one durable projection read per open chat —
 * enough of them to evict the runtime's own projection cache and force-replay
 * the ledger of the Session the live chat is reading. Narrowing to the target
 * first makes the cost proportional to what is actually being destroyed, which
 * is one or two Sessions, not to how many chats the launch has opened.
 *
 * The release half exists because a binding outlives its tab. It opens on
 * attach and is dropped only by an explicit release, by the executor closing
 * itself, or by app shutdown — so deleting a checkout with nothing else in the
 * way leaves a Session still pointed at a path that no longer exists, and the
 * next message dispatches an agent into it. Releasing here is what ends that,
 * and it ends it the honest way: `adapter.release` writes `attachment.closed`
 * into the Session's own ledger, so the chat surface reading that Session sees
 * the attachment end instead of finding out when a dispatch fails.
 */
import type { HostedSessionRuntime, OpenNativeBinding } from "@volli/session-engine";

import { isInside } from "./paths";

/**
 * The slice of the hosted runtime this module drives. The listing is taken from
 * {@link HostedSessionRuntime} outright; the other two are narrowed to what is
 * read, so the suite can stand one up without a Session Engine and a full
 * durable projection behind it.
 *
 * Drift in those two is caught where it matters: `index.ts` passes the real
 * `HostedSessionRuntime` into these functions, so a port that stops being a
 * slice of it fails to compile at that call site.
 */
export interface AgentSiteRuntime extends Pick<HostedSessionRuntime, "openNativeBindings"> {
  projection(input: { sessionId: string }): Promise<{ projection: { turnActive: boolean } }>;
  command(request: {
    commandId: string;
    sessionId: string;
    command: { kind: "adapter.release"; attachmentId: string };
  }): Promise<unknown>;
}

/** What a release attempt left behind, named per Session so a caller can say which. */
export interface AgentSiteReleaseReport {
  /** Sessions whose binding on this directory is gone. */
  released: readonly string[];
  /**
   * Sessions still bound to it. Non-empty means the release did not take — the
   * executor refused to stop, or the Session's own ledger would not record the
   * close — and whoever deletes the directory next is deleting it out from
   * under a live binding.
   */
  stillOpen: readonly string[];
}

/** Every binding this process holds open at or under `directory`. */
export function agentSitesWithin(
  runtime: Pick<AgentSiteRuntime, "openNativeBindings">,
  directory: string,
): readonly OpenNativeBinding[] {
  return runtime.openNativeBindings().filter((binding) => isInside(directory, binding.directory));
}

/**
 * Whether an agent has a turn open at or under `directory` right now.
 *
 * Attachment is not the question — an idle chat holds a binding for the life of
 * the process, and reading that as "busy" is what made a Ticket with one empty
 * chat in it permanently unarchivable. A turn is: the loop is inside it and
 * resumes writing into this directory the moment it is answered, blocked on a
 * question included.
 *
 * A Session whose history cannot be read answers "no". That is fail-open, and
 * deliberate: the alternative hands the user a worktree no route can remove.
 */
export async function agentTurnOpenWithin(
  runtime: Pick<AgentSiteRuntime, "openNativeBindings" | "projection">,
  directory: string,
  onUnreadable: (sessionId: string, error: unknown) => void,
): Promise<boolean> {
  for (const binding of agentSitesWithin(runtime, directory)) {
    try {
      const { projection } = await runtime.projection({ sessionId: binding.sessionId });
      if (projection.turnActive) return true;
    } catch (error) {
      onUnreadable(binding.sessionId, error);
    }
  }
  return false;
}

/**
 * Ends every binding rooted at `directory`, for a checkout that is about to
 * stop existing.
 *
 * Idempotent by construction rather than by receipt: the work is derived from
 * the bindings this process currently holds, so a second call over a directory
 * already released finds nothing to do. The report is read the same way —
 * whether a release took is decided by whether the binding is still listed, not
 * by interpreting the receipt it returned, because "already stopped" and
 * "stopped just now" are the same outcome here and arrive as different receipts.
 *
 * A failure never throws. It is reported through `onError` and left in
 * `stillOpen` for the caller to decide about, because the caller's alternative
 * — refusing the delete — is how a worktree becomes unremovable by any route.
 */
export async function releaseAgentSites(
  runtime: AgentSiteRuntime,
  directory: string,
  deps: { newCommandId: () => string; onError: (sessionId: string, error: unknown) => void },
): Promise<AgentSiteReleaseReport> {
  const bindings = agentSitesWithin(runtime, directory);
  if (bindings.length === 0) return { released: [], stillOpen: [] };
  for (const binding of bindings) {
    try {
      await runtime.command({
        commandId: deps.newCommandId(),
        sessionId: binding.sessionId,
        command: { kind: "adapter.release", attachmentId: binding.attachmentId },
      });
    } catch (error) {
      deps.onError(binding.sessionId, error);
    }
  }
  const remaining = agentSitesWithin(runtime, directory);
  const stillOpen = new Set(remaining.map(({ sessionId }) => sessionId));
  return {
    released: bindings
      .map(({ sessionId }) => sessionId)
      .filter((sessionId) => !stillOpen.has(sessionId)),
    stillOpen: [...stillOpen],
  };
}
