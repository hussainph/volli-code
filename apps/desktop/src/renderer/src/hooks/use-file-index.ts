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
  const mountedRef = React.useRef(true);
  const [version, setVersion] = React.useState(0);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
    }
  }, [projectId]);

  const refresh = React.useCallback(() => {
    if (Date.now() - lastFetchRef.current < INDEX_CACHE_MS) return;
    void fetchIndex();
  }, [fetchIndex]);

  const forceRefresh = React.useCallback(() => {
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
