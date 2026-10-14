import type { SessionRuntimeSpec } from "@volli/shared";

type Request = Parameters<NonNullable<SessionRuntimeSpec["refreshTools"]>>[0];
type Identity = { projectId: string; parentId: string | null };

/** Per-host memo, never a persisted permission. Cold boundaries always recheck.
 * A cached desired context is returned by reference: an adapter that failed to
 * adopt it must retry; one that adopted it can skip rebuilding bindings entirely.
 * MCP writes increment an in-process revision; parent high-water is an indexed
 * read (no history decoding), and policy is a bounded settings fingerprint.
 */
export function codeModeRefreshGate<T>(options: { revision(identity: Identity): Promise<string> }) {
  const cache = new Map<string, { identity: Identity; key: string; context: T }>();
  const keyFor = async (identity: Identity, request: Request) =>
    JSON.stringify([await options.revision(identity), request.model]);
  return {
    forget(sessionId: string): void {
      cache.delete(sessionId);
    },
    async check(
      sessionId: string,
      request: Request,
      refresh: (rememberIdentity: (identity: Identity) => Promise<void>) => Promise<T | null>,
    ): Promise<T | null> {
      const prior = cache.get(sessionId);
      if (
        request.trigger === "code-mode" &&
        prior !== undefined &&
        prior.key === (await keyFor(prior.identity, request))
      )
        return prior.context;
      cache.delete(sessionId);
      let snapshot: { identity: Identity; key: string } | undefined;
      const context = await refresh(async (identity) => {
        // Capture BEFORE candidate reads/awaits, so a concurrent write cannot
        // be mistaken for a revision already incorporated in this result.
        snapshot = { identity, key: await keyFor(identity, request) };
      });
      if (context !== null && snapshot !== undefined)
        cache.set(sessionId, { ...snapshot, context });
      return context;
    },
  };
}
