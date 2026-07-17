/**
 * The project file index behind the `@file` picker (global-artifacts decision
 * #3). Fetches `api.files.index` and hands the editor a stable getter plus a
 * `version` counter it bumps when the index changes — the editor reads the
 * getter lazily (so index refreshes never remount it) and re-resolves its chips
 * when `version` advances.
 *
 * `refresh()` is cache-gated (~10s) for the common "picker opened again"
 * path; `forceRefresh()` bypasses the cache for the moment right after creating
 * an artifact, when the new file must appear in the index immediately.
 */
import * as React from "react";
import { errorMessage, type IndexedFile } from "@volli/shared";
import { toast } from "sonner";

/** How long a fetched index is served without re-hitting main on a picker open. */
const INDEX_CACHE_MS = 10_000;

export interface FileIndexHandle {
  /** The latest cached index — stable identity, reads current data via a ref. */
  getIndex(): readonly IndexedFile[];
  /** Cache-gated background refresh (picker open). */
  refresh(): void;
  /** Immediate refresh, bypassing the cache (after creating an artifact). */
  forceRefresh(): void;
  /** Bumps whenever `getIndex()` would return new data — the editor's chip-rebuild trigger. */
  version: number;
}

export function useFileIndex(projectId: string): FileIndexHandle {
  const indexRef = React.useRef<readonly IndexedFile[]>([]);
  const lastFetchRef = React.useRef(0);
  const inflightRef = React.useRef(false);
  // A forceRefresh that arrived while a fetch was in flight. The inflight
  // fetch's finally re-runs once (bypassing the cache) so a just-created
  // artifact's chip resolves now, not after the stale fetch's ~10s cache window.
  const pendingForceRef = React.useRef(false);
  const mountedRef = React.useRef(true);
  const [version, setVersion] = React.useState(0);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Latest-callback ref so fetchIndex's finally can re-invoke the current
  // fetchIndex without listing itself as a dependency (a circular dep).
  const fetchIndexRef = React.useRef<(() => Promise<void>) | null>(null);
  const fetchIndex = React.useCallback(async () => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    try {
      const result = await window.api.files.index({ projectId });
      if (!mountedRef.current) return;
      if (!result.ok) {
        toast.error(`Could not load the file index: ${result.error}`);
        return;
      }
      indexRef.current = result.files;
      lastFetchRef.current = Date.now();
      setVersion((n) => n + 1);
    } catch (error) {
      if (mountedRef.current) toast.error(`Could not load the file index: ${errorMessage(error)}`);
    } finally {
      inflightRef.current = false;
      // A forceRefresh landed while this fetch was in flight; run one more now
      // so the freshly-created file shows up immediately instead of being lost
      // behind the cache until the next uncached fetch.
      if (pendingForceRef.current) {
        pendingForceRef.current = false;
        if (mountedRef.current) void fetchIndexRef.current?.();
      }
    }
  }, [projectId]);
  React.useEffect(() => {
    fetchIndexRef.current = fetchIndex;
  }, [fetchIndex]);

  const refresh = React.useCallback(() => {
    if (Date.now() - lastFetchRef.current < INDEX_CACHE_MS) return;
    void fetchIndex();
  }, [fetchIndex]);

  const forceRefresh = React.useCallback(() => {
    // If a fetch is already inflight it holds a pre-create index; don't let it
    // stamp the cache and swallow this force. Defer to the inflight fetch's
    // finally, which re-runs once we know the new file could be present.
    if (inflightRef.current) {
      pendingForceRef.current = true;
      return;
    }
    void fetchIndex();
  }, [fetchIndex]);

  const getIndex = React.useCallback(() => indexRef.current, []);

  // Reset and eagerly fetch when the project changes, so chips resolve on first
  // paint without waiting for the picker to open.
  React.useEffect(() => {
    indexRef.current = [];
    lastFetchRef.current = 0;
    setVersion((n) => n + 1);
    void fetchIndex();
  }, [projectId, fetchIndex]);

  // A stable handle whose identity only changes with `version` (the getters are
  // stable useCallbacks), so consumers can depend on the whole object without
  // re-running effects every render.
  return React.useMemo(
    () => ({ getIndex, refresh, forceRefresh, version }),
    [getIndex, refresh, forceRefresh, version],
  );
}
