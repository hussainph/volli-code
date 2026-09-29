/**
 * Montage shot (DRAFT, unrendered): the Now rail (VC-406).
 *
 * Real: the ticket detail's right rail, `TicketRail`, on its resting "Now"
 * page, for the path-safe fixture ticket VLT-14, reading the real stores
 * seeded by `seedShell`. The camera surveys it top → bottom (see
 * scripts/film/shots/rail.mjs — not written yet).
 *
 * TODO (next agent): write scripts/film/shots/rail.mjs, run
 * `node scripts/film/recipes.mjs rail`, check the Now page's sessions block
 * shows no terminal rows, then render stills.
 */
import { useMemo } from "react";
import { Surface } from "@webprodigies/flute";

import { TicketRail } from "@renderer/components/ticket/ticket-rail";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useUiStore } from "@renderer/stores/ui";

import {
  FrameLayer,
  Supers,
  useFilm,
  useFixtures,
  Vignette,
  type Cue,
  type Format,
} from "../kit/film";
import { project, seedShell, sessionRows, shellApi, tickets } from "../kit/split-shell";

/** The rail column, in lab CSS px. */
export const RAIL = { width: 340, height: 420 };

/** Chat Sessions only: the Now page must not list terminal rows in the film. */
const BASE_CHATS = sessionRows.filter((row) => row.kind === "chat");
const CHAT_TEMPLATE = BASE_CHATS.find((row) => row.record.ticketId === "tkt-14") ?? BASE_CHATS[0]!;
/** Two more chat Sessions on VLT-14 (fixture-only): one working, one idle. */
const EXTRA_CHATS = [
  {
    sessionId: "chat-14b",
    title: "Write the regression test for the debounce",
    activity: "working",
    minutesAgo: 0,
  },
  { sessionId: "chat-14c", title: "Review the decoration diff", activity: "idle", minutesAgo: 12 },
]
  // One template, a few fields changed per row: a fixture list built once at
  // module load, so the copy per row costs nothing that matters.
  // oxlint-disable-next-line no-map-spread
  .map((extra) => ({
    ...CHAT_TEMPLATE,
    record: {
      ...CHAT_TEMPLATE.record,
      sessionId: extra.sessionId,
      title: extra.title,
      activity: extra.activity,
      waitingOn: null,
      live: true,
      lastActivityAt: CHAT_TEMPLATE.record.lastActivityAt + (2 - extra.minutesAgo) * 60_000,
    },
  })) as typeof BASE_CHATS;
const CHAT_ROWS = [...BASE_CHATS, ...EXTRA_CHATS];
const ok = <T extends object>(value: T) => Promise.resolve({ ok: true as const, ...value });
const API = shellApi({
  sessions: {
    list: () => ok({ sessions: CHAT_ROWS }),
    listForTicket: (input: { ticketId: string }) =>
      ok({ sessions: CHAT_ROWS.filter((row) => row.record.ticketId === input.ticketId) }),
  },
});
const BASE = tickets.find((ticket) => ticket.id === "tkt-14") ?? tickets[0]!;
/** No worktree: the lab has no readable one, which would show a fault banner. */
const TICKET = { ...BASE, worktreePath: null };
/** The automations block offers only "Run once" here, which the film must not show. */
const HIDE = `[data-film-rail] [data-testid="ticket-rail-automations"]{display:none!important}`;
const noop = () => undefined;

function seed(): void {
  seedShell();
  useUiStore.setState({ railMode: "now", railWidth: RAIL.width });
}

const CUE: Cue = { at: 120, until: 1150, eyebrow: "VC-406", lines: ["The Now rail."] };
const CUES: Record<Format, Cue[]> = {
  landscape: [CUE],
  portrait: [{ ...CUE, place: "upper" }],
};

export function RailShot({ format }: { format: Format }) {
  const t = useFilm();
  useFixtures({ api: API, seed });
  // Built once: the shot re-renders every frame (useFilm), and re-rendering the
  // rail would let the tab pill's `motion` layout projection re-measure through
  // the moving 3D camera and throw the selected "Now" tab off its track.
  const content = useMemo(
    () => (
      // A long delay: no tab tooltip can open inside a 1.2s shot.
      <TooltipProvider delayDuration={60_000}>
        <style>{HIDE}</style>
        <div
          data-film-rail=""
          className="flex overflow-hidden rounded-[14px]"
          style={{ width: RAIL.width, height: RAIL.height, background: "var(--canvas)" }}
        >
          <TicketRail
            projectId={project.id}
            ticket={TICKET}
            creating={false}
            onNewSession={noop}
            onNewChat={noop}
            onActivateSession={noop}
            onActivateChat={noop}
            activeTabId="overview"
          />
        </div>
      </TooltipProvider>
    ),
    [],
  );
  return (
    <>
      <Surface
        id="rail"
        style={{
          position: "absolute",
          left: `calc(50% - ${RAIL.width / 2}px)`,
          top: `calc(50% - ${RAIL.height / 2}px)`,
          width: RAIL.width,
          height: RAIL.height,
        }}
        content={content}
      />
      <FrameLayer format={format}>
        <Vignette strength={0.6} />
        <Supers cues={CUES[format]} t={t} format={format} />
      </FrameLayer>
    </>
  );
}
