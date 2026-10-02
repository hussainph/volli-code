/**
 * A peek reads a local fold before asking for utility prose. The question and
 * transcript fallback stay readable throughout refinement, including refusal
 * or failure. No subscription, adoption, refresh timer, or platform API.
 *
 * The cache is shared with folder lines by the controller. Standalone callers
 * get the same Session/activity coalescing and next-glance cooldown semantics.
 * A late answer may fill the cache, never a card that has moved elsewhere.
 */
import * as React from "react";
import type { SessionPeekContent } from "@volli/shared";

import {
  observePeekContent,
  PeekContentCache,
  type PeekContentRead,
  type ReadPeekContent,
} from "./peek-content-cache";

export interface PeekContentState {
  content: SessionPeekContent | null;
  /** Only the first local fold loads; refinement never hides readable content. */
  loading: boolean;
  /** The local fold failed, or answered with no such Session. */
  failed: boolean;
}

const IDLE: PeekContentState = { content: null, loading: false, failed: false };

export function usePeekContent(
  sessionId: string | null,
  read: ReadPeekContent,
  activityToken: number,
  refine = true,
  sharedCache?: PeekContentCache,
  /** Pinned cards may read new local activity; hovering always holds a snapshot. */
  live = false,
): PeekContentState {
  const cache = React.useMemo(() => sharedCache ?? new PeekContentCache(read), [read, sharedCache]);
  const active = React.useRef<{
    sessionId: string;
    activityToken: number;
    cache: PeekContentCache;
    entry: PeekContentRead;
  } | null>(null);
  const [state, setState] = React.useState<PeekContentState>(IDLE);

  React.useEffect(() => {
    if (sessionId === null) {
      active.current = null;
      setState(IDLE);
      return;
    }
    const previous = active.current;
    // An unpinned peek is a snapshot, not a live feed. Tool/output churn must
    // not replace prose with skeletons or buy another refinement mid-glance.
    // Pinning retains the fold, but later pinned activity may pull local data.
    const entry =
      previous?.sessionId === sessionId &&
      (!live || previous.activityToken === activityToken) &&
      previous.cache === cache
        ? previous.entry
        : cache.get(sessionId, activityToken);
    active.current = { sessionId, activityToken, cache, entry };
    return observePeekContent(entry, refine, (current) => {
      setState({
        content: current.content ?? null,
        loading: current.content === undefined && !current.failed,
        failed: current.failed || current.content === null,
      });
    });
  }, [activityToken, cache, live, refine, sessionId]);

  return state;
}
