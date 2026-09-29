/**
 * Shot — fast at scale (VC-316). A ten-thousand-ticket board as a cliff: the
 * five real status columns, headed by their real count badges (3418 · 1206 ·
 * 42 · 61 · 5273 = 10,000), plunge away below the camera. The first thirty
 * rows of each column are real `TicketCardContent` cards; past them the
 * column carries on as unmounted slots fading into the dark — which is what a
 * windowed column is (VC-316 mounts ~200 of 10,000 and spacers the rest).
 *
 * The stat is docs/research/perf/board-windowing-vc316.md: p50 board render
 * at 10,000 tickets, 5,797.6 ms before → 365.6 ms after.
 *
 * Fixture project "Atlas" (ATL-): invented work, so nothing here is presented
 * as Volli's own tickets. The rig is scripts/film/shots/scale.mjs.
 */
import * as React from "react";
import { Surface } from "@webprodigies/flute";
import { TICKET_STATUS_LABELS, type TicketStatus } from "@volli/shared";

import { TicketCardContent } from "@renderer/components/board/ticket-card";
import { Badge } from "@renderer/components/ui/badge";

import { ATLAS, ATLAS_LABELS, atlasTicket } from "../kit/atlas";
import { ease, progress } from "../kit/clock";
import { FORMAT_SIZE, FrameLayer, Supers, useFilm, Vignette, type Cue, type Format } from "../kit/film";

export const SCALE_COLUMNS: { status: TicketStatus; count: number; first: number }[] = [
  { status: "backlog", count: 3418, first: 9960 },
  { status: "todo", count: 1206, first: 9712 },
  { status: "doing", count: 42, first: 9648 },
  { status: "needs_review", count: 61, first: 9593 },
  { status: "done", count: 5273, first: 9504 },
];

export const SCALE = {
  columnWidth: 288,
  gap: 20,
  top: -240,
  header: 44,
  slot: 110,
  pitch: 118,
  realRows: 30,
  ghostRows: 60,
};
export const SCALE_WIDTH = SCALE_COLUMNS.length * SCALE.columnWidth + (SCALE_COLUMNS.length - 1) * SCALE.gap;
const columnLeft = (index: number) => index * (SCALE.columnWidth + SCALE.gap) - SCALE_WIDTH / 2;

function Ghost() {
  return (
    <div
      className="flex flex-none flex-col gap-2 rounded-lg border bg-card px-3 py-3"
      style={{ height: SCALE.slot }}
    >
      <div className="h-2 w-14 rounded-full bg-muted" />
      <div className="h-2.5 w-52 rounded-full bg-muted-foreground/20" />
      <div className="h-2.5 w-36 rounded-full bg-muted-foreground/20" />
    </div>
  );
}

function Column({ index, stageWidth, stageHeight }: { index: number; stageWidth: number; stageHeight: number }) {
  const { status, count } = SCALE_COLUMNS[index];
  const cards = React.useMemo(
    () =>
      Array.from({ length: SCALE.realRows }, (_, row) => {
        const ticket = atlasTicket(index * 7 + row * 5, SCALE_COLUMNS[index].first - row * 3 - (row % 4), SCALE_COLUMNS[index].status, row);
        return (
          <div key={ticket.id} className="flex-none [&>*]:h-full" style={{ height: SCALE.slot }}>
            <TicketCardContent ticket={ticket} ticketPrefix={ATLAS.ticketPrefix} projectLabels={ATLAS_LABELS} />
          </div>
        );
      }),
    [index],
  );
  const left = stageWidth / 2 + columnLeft(index);
  const top = stageHeight / 2 + SCALE.top;
  const ghostTop = top + SCALE.header + SCALE.realRows * SCALE.pitch;
  return (
    <>
      <Surface
        id={`scale-${index}`}
        style={{ position: "absolute", left, top, width: SCALE.columnWidth }}
        content={
          <div className="flex w-72 flex-col rounded-t-lg bg-muted/30 px-2">
            <div className="flex items-center gap-2 px-2 pt-2 pb-2" style={{ height: SCALE.header }}>
              <span className="text-ui font-medium text-foreground">{TICKET_STATUS_LABELS[status]}</span>
              <Badge variant="count">{count}</Badge>
            </div>
            <div className="flex flex-col gap-2">{cards}</div>
          </div>
        }
      />
      <Surface
        id={`scale-ghost-${index}`}
        style={{ position: "absolute", left, top: ghostTop, width: SCALE.columnWidth }}
        content={
          <div
            className="flex w-72 flex-col gap-2 bg-muted/30 px-2 pt-2"
            style={{
              maskImage: "linear-gradient(to bottom, black 0%, black 25%, transparent 100%)",
            }}
          >
            {Array.from({ length: SCALE.ghostRows }, (_, row) => (
              <Ghost key={row} />
            ))}
          </div>
        }
      />
    </>
  );
}

const CUES: Record<Format, Cue[]> = {
  landscape: [
    {
      at: 300,
      until: 3650,
      eyebrow: "VC-316 · p50 board render",
      lines: ["10,000 tickets.", "5.8s → 366ms."],
      size: "large",
      place: "lower-right",
    },
  ],
  portrait: [
    {
      at: 300,
      until: 3650,
      eyebrow: "VC-316 · p50 board render",
      lines: ["10,000 tickets.", "5.8s → 366ms."],
      size: "large",
      place: "upper",
    },
  ],
};

export function ScaleShot({ format }: { format: Format }) {
  const t = useFilm();
  const size = FORMAT_SIZE[format];
  return (
    <>
      {SCALE_COLUMNS.map((column, index) => (
        <Column key={column.status} index={index} stageWidth={size.width} stageHeight={size.height} />
      ))}
      <FrameLayer format={format}>
        <Vignette strength={0.5 + 0.15 * progress(t, 0, 3800, ease.inOutCubic)} />
        <Supers cues={CUES[format]} t={t} format={format} />
      </FrameLayer>
    </>
  );
}
