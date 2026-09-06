/**
 * The Activity Island's now channel, bound for React (VC-268).
 *
 * One small hook that every feed pushes into: `{ event, payload }`, the two
 * registers the contract keeps apart (`activity-island.ts`, "TWO GRAMMARS").
 * Latest wins — the island's drop shows one announcement at a time and
 * `mode="wait"` queues nothing — and every push mints a new `id`, because a
 * new id is what the island reads as a new announcement: the same words twice
 * in a row are two events, not one.
 *
 * Feeds never join the two halves. `flashLine` is the only function allowed
 * to, and it lives in the contract; a feed that pre-joined would hand the
 * drawing a string it had to parse back apart to weight.
 *
 * `push` keeps its identity for the life of the hook so a feed can hold it in
 * an effect's dependency list without re-running the effect per flash.
 */
import * as React from "react";

import type { IslandFlash } from "@volli/session-presentation";

/** What a feed holds: the one verb of the now channel. */
export type IslandFlashPush = (event: string, payload: string) => void;

export interface IslandFlashChannel {
  /** The latest announcement, or `null` before the first. */
  flash: IslandFlash | null;
  push: IslandFlashPush;
}

/**
 * Ids are minted from a counter scoped to this hook — the island keys the
 * drop on the id alone, and a stable prefix keeps two chats' channels from
 * ever colliding if a drawing is one day shared between them.
 */
export function useIslandFlash(): IslandFlashChannel {
  const [flash, setFlash] = React.useState<IslandFlash | null>(null);
  const prefix = React.useId();
  const serial = React.useRef(0);
  const push = React.useCallback<IslandFlashPush>(
    (event, payload) => {
      serial.current += 1;
      setFlash({ id: `${prefix}${serial.current}`, event, payload });
    },
    [prefix],
  );
  return React.useMemo(() => ({ flash, push }), [flash, push]);
}
