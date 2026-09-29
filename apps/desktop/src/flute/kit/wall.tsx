/**
 * The wall (VC-464): all 175 Done tickets of 0.2 as real `TicketCardContent`
 * cards, fourteen board-width columns side by side — the scale the hook pulls
 * back to reveal, and the end card dives back into.
 *
 * Each column is its own Surface at a slightly different depth, so a moving
 * camera sees the columns slide against each other rather than one flat
 * picture. The hero card (VC-239) sits at a fixed slot the rigs aim at; its
 * centre in world units is measured, not assumed, and recorded in
 * scripts/film/shots/wall-geometry.mjs.
 */
import * as React from "react";
import { Surface } from "@webprodigies/flute";

import { TicketCardContent } from "@renderer/components/board/ticket-card";

import { RELEASE_BOARD, VOLLI, VOLLI_LABELS } from "./volli-board";

export const WALL_COLUMNS = 14;
export const COLUMN_WIDTH = 288;
export const COLUMN_GAP = 20;
export const WALL_WIDTH = WALL_COLUMNS * COLUMN_WIDTH + (WALL_COLUMNS - 1) * COLUMN_GAP;
/** World y of every column's top edge. */
export const WALL_TOP = -660;
export const HERO = { number: 239, column: 6, row: 5 };

/** Depth per column: a gentle, irregular relief rather than a staircase. */
const RELIEF = [10, -24, 18, -6, 30, -14, 0, 22, -30, 8, -18, 26, -8, 14];

/**
 * Titles that name surfaces the film must not feature (MCP, terminals, native
 * notifications, "Run once", peek). They are real shipped tickets, so they
 * stay on the wall and in the count, but they sit in the far top corners —
 * cells no camera in the film ever brings close enough to read.
 */
const QUIET = /\b(mcp|terminal|xterm|notification|run once|peek|hover)/i;
const QUIET_CELLS: [column: number, row: number][] = [
  [0, 0],
  [13, 0],
  [1, 0],
  [12, 0],
  [0, 1],
  [13, 1],
  [2, 0],
  [11, 0],
  [1, 1],
  [12, 1],
  [0, 2],
  [13, 2],
  [3, 0],
  [10, 0],
  [2, 1],
  [11, 1],
];

function columnsOfTickets() {
  const hero = RELEASE_BOARD.find((ticket) => ticket.ticketNumber === HERO.number)!;
  const others = RELEASE_BOARD.filter((ticket) => ticket.ticketNumber !== HERO.number);
  const quiet = others.filter((ticket) => QUIET.test(ticket.title));
  const loud = others.filter((ticket) => !QUIET.test(ticket.title));
  if (quiet.length > QUIET_CELLS.length) throw new Error("wall: add more QUIET_CELLS");
  const grid: (typeof RELEASE_BOARD)[number][][] = Array.from(
    { length: WALL_COLUMNS },
    (_, column) => Array.from({ length: column < 7 ? 13 : 12 }),
  );
  grid[HERO.column][HERO.row] = hero;
  quiet.forEach((ticket, index) => {
    const [column, row] = QUIET_CELLS[index];
    grid[column][row] = ticket;
  });
  let cursor = 0;
  for (const column of grid) {
    for (let row = 0; row < column.length; row += 1) column[row] ??= loud[cursor++];
  }
  return grid;
}

export const WALL = columnsOfTickets();

export function columnLeft(column: number): number {
  return column * (COLUMN_WIDTH + COLUMN_GAP) - WALL_WIDTH / 2;
}

/**
 * The wall as Surfaces. `dim` (0..1) quiets every card but the hero, for the
 * end card; `stageWidth`/`stageHeight` place world (0,0) at the stage centre.
 */
export function Wall({
  stageWidth,
  stageHeight,
  dim = 0,
}: {
  stageWidth: number;
  stageHeight: number;
  dim?: number;
}) {
  // The cards never change with the clock: memoised so only `dim` rerenders.
  const columns = React.useMemo(
    () =>
      WALL.map((tickets) =>
        tickets.map((ticket) => ({
          ticket,
          node: (
            <TicketCardContent
              ticket={ticket}
              ticketPrefix={VOLLI.ticketPrefix}
              projectLabels={VOLLI_LABELS}
            />
          ),
        })),
      ),
    [],
  );
  return (
    <>
      {columns.map((cards, column) => (
        <Surface
          key={cards[0]!.ticket.id}
          id={`wall-${column}`}
          transform={{ z: RELIEF[column] }}
          style={{
            position: "absolute",
            left: stageWidth / 2 + columnLeft(column),
            top: stageHeight / 2 + WALL_TOP,
            width: COLUMN_WIDTH,
          }}
          content={
            <div
              data-wall-column={column}
              className="flex w-72 flex-col gap-2 rounded-lg bg-muted/30 p-2"
            >
              {cards.map(({ ticket, node }) => (
                <div
                  key={ticket.id}
                  data-wall-card={ticket.ticketNumber}
                  style={{
                    opacity: ticket.ticketNumber === HERO.number ? 1 : 1 - dim,
                  }}
                >
                  {node}
                </div>
              ))}
            </div>
          }
        />
      ))}
    </>
  );
}

export const WALL_NODES = RELIEF.map((z, column) => ({ id: `wall-${column}`, transform: { z } }));
