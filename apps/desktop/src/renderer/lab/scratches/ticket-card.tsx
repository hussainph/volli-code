/**
 * The app's real `TicketCardContent`, rendered against fixture tickets.
 *
 * This is the lab's worked example of the pattern every store-backed scratch
 * follows, and it is worth copying wholesale:
 *
 *   1. `seed` — populate the store the component reads from, directly
 *      (`setState`). The board's read path is plain state; going through the
 *      bridge to fill it would be an elaborate way of writing the same object.
 *   2. `api` — stub only what the component actually *calls*. Here that is the
 *      card's retention badge, which issues one IPC read per card that has a
 *      branch.
 *
 * Both are exported, not run at module scope, so they apply only while this
 * scratch is the one on screen (see scratch.ts).
 */
import type { ReactNode } from "react";

import { TicketCardContent } from "@renderer/components/board/ticket-card";

import { project, ticketById } from "../fixtures";
import { appApi, seedBoard } from "../seed";

export const title = "Ticket card";
export const note = "Real card component, fixture tickets — states side by side";

export const seed = seedBoard;
/** Includes the retention stub the archive-ready badge reads. */
export const api = appApi;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="font-mono text-label uppercase text-muted-foreground">{label}</p>
      {/* The board column's real card width — a card judged at any other width
          is a card you have not judged. */}
      <div className="w-72">{children}</div>
    </div>
  );
}

export default function TicketCardScratch() {
  const archiveReady = ticketById("tkt-11");
  const twoLabels = ticketById("tkt-14");
  const singleLabel = ticketById("tkt-12");
  const longTitle = ticketById("tkt-9");
  const plain = ticketById("tkt-7");

  return (
    <div className="flex flex-wrap gap-8">
      <Row label="High + labels + archive-ready">
        <TicketCardContent ticket={archiveReady} ticketPrefix={project.ticketPrefix} />
      </Row>
      <Row label="Same card, selected">
        <TicketCardContent ticket={archiveReady} ticketPrefix={project.ticketPrefix} selected />
      </Row>
      <Row label="Two labels">
        <TicketCardContent ticket={twoLabels} ticketPrefix={project.ticketPrefix} />
      </Row>
      <Row label="Single label">
        <TicketCardContent ticket={singleLabel} ticketPrefix={project.ticketPrefix} />
      </Row>
      <Row label="Two-line title clamp">
        <TicketCardContent ticket={longTitle} ticketPrefix={project.ticketPrefix} />
      </Row>
      <Row label="No labels">
        <TicketCardContent ticket={plain} ticketPrefix={project.ticketPrefix} />
      </Row>
    </div>
  );
}
