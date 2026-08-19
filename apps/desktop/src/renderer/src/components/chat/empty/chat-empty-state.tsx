/**
 * What an empty chat opens on (VC-55).
 *
 * IT REPLACES A BARE MARK, and that reversal is deliberate rather than drift:
 * this surface used to draw one squircle and nothing else, on the argument that
 * an empty transcript has nothing to say. It has one thing to say, and it is
 * the thing no surface in the app was saying — WHERE this Session runs. A
 * Project Session works in the user's own main checkout; a Ticket Session works
 * in a throwaway worktree. That is "safe to let it run" against "it is editing
 * my working tree".
 *
 * It is answered by drawing rather than by labelling. The visual a scope can
 * offer is legible only at that scope ({@link resolveEmptyVisual}), so the SHAPE
 * carries the identity: Home can draw a field of many, a ticket draws one
 * thing's state, and many-against-one is read before anything is read. CLAUDE.md's
 * "let controls talk" is upheld, not broken — what replaces the mark is data
 * and controls, never prose.
 *
 * THE PICKER IS PART OF THE SIGNAL. Home offers three drawings and shows the
 * choice; a ticket offers one and shows no picker at all, because a menu with a
 * single item is a statement dressed as a question. The shortness is the point.
 */
import * as React from "react";

import {
  EMPTY_VISUAL_LABELS,
  resolveEmptyVisual,
  visualsForScope,
  type ChatScope,
} from "@renderer/components/chat/empty-visual";
import { BoardVisual } from "@renderer/components/chat/empty/board-visual";
import { StreakVisual } from "@renderer/components/chat/empty/streak-visual";
import { VenueChips } from "@renderer/components/chat/empty/venue-chips";
import { VenueVisual } from "@renderer/components/chat/empty/venue-visual";
import { Segmented } from "@renderer/components/ui/segmented";
import { useUiStore } from "@renderer/stores/ui";
import { useVenueStore, venueKey, type VenueEntry } from "@renderer/stores/venue";

export function ChatEmptyState({
  projectId,
  ticketId,
}: {
  projectId: string;
  /** `null` for a Project Session — the scope, not a missing value. */
  ticketId: string | null;
}) {
  const scope: ChatScope = ticketId === null ? "project" : "ticket";
  const chosen = useUiStore((state) => state.homeEmptyVisual);
  const setVisual = useUiStore((state) => state.setHomeEmptyVisual);
  const visual = resolveEmptyVisual(scope, chosen);
  const offered = visualsForScope(scope);

  const venue = useVenueStore((state) => state.byScope[venueKey(projectId, ticketId)]);
  const refreshVenue = useVenueStore((state) => state.refresh);
  // Re-read on every open rather than once per app run: an empty chat is what
  // you see right after starting a Session, and the tree it is standing in has
  // been moving while nobody was asking. Whatever was last read stays on screen
  // until this answers.
  React.useEffect(() => {
    void refreshVenue(projectId, ticketId);
  }, [projectId, ticketId, refreshVenue]);

  return (
    <div className="flex flex-col items-center gap-6">
      {visual === "streak" ? <StreakVisual /> : null}
      {visual === "board" ? <BoardVisual projectId={projectId} /> : null}
      {visual === "venue" ? <VenueDrawing venue={venue} /> : null}
      <VenueCaption venue={venue} />
      {offered.length > 1 ? (
        <Segmented
          ariaLabel="Empty chat visual"
          testId="empty-visual-picker"
          value={visual}
          options={offered.map((key) => ({ key, label: EMPTY_VISUAL_LABELS[key] }))}
          onChange={setVisual}
        />
      ) : null}
    </div>
  );
}

/**
 * The venue drawing, or the space it will take.
 *
 * A venue that cannot be read draws NOTHING — not an error, not a zeroed bar.
 * The error is a git message about a directory, and this surface is a chat
 * somebody is about to type into; the rail is where a failure has room to be
 * named. A zeroed bar would be worse than either: it is a measurement, and it
 * would be a false one.
 */
function VenueDrawing({ venue }: { venue: VenueEntry | undefined }) {
  if (venue?.status === "ready") return <VenueVisual venue={venue.venue} />;
  // The waiting shape is the real one with nothing in it, rather than a height
  // somebody measured once: an empty track and an invisible caption reserve
  // exactly what the drawing will take, and stay right when it changes.
  return (
    <div className="flex w-80 flex-col gap-3" aria-hidden>
      <div className="h-8 rounded-control bg-muted" />
      <div className="invisible flex items-baseline justify-center gap-3">
        <span className="text-title">0</span>
        <span className="text-ui">files changed</span>
      </div>
    </div>
  );
}

/** The chips, once there is a venue to name. */
function VenueCaption({ venue }: { venue: VenueEntry | undefined }) {
  if (venue?.status !== "ready") return null;
  return <VenueChips venue={venue.venue} />;
}
