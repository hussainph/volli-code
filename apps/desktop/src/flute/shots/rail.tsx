/** Simulated wiring: the current ticket document and its real Now rail.
 * Current main places status, priority and labels beneath the document title,
 * not in Now. Keep that production anatomy: the camera surveys the document
 * metadata and the neighbouring chat roster/branch rather than redrawing the
 * retired Properties block in the rail.
 */
import { Surface } from "@webprodigies/flute";
import { useBoardStore } from "@renderer/stores/board";
import { useProjectUiStore } from "@renderer/stores/project-ui";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";
import { useUiStore } from "@renderer/stores/ui";

import {
  FrameLayer,
  Supers,
  useFilm,
  useFilmWallClock,
  useFixtures,
  Vignette,
  type Cue,
  type Format,
} from "../kit/film";
import { NOW, labels } from "../../renderer/lab/fixtures";
import {
  project,
  seedShell,
  sessionRows,
  shellApi,
  ShellWindow,
  tickets,
} from "../kit/split-shell";
import { Backdrop, useFilmTheme } from "../kit/world";

export const WINDOW = {
  landscape: { width: 1400, height: 900 },
  portrait: { width: 1100, height: 1000 },
};
const BASE = tickets.find((ticket) => ticket.id === "tkt-14")!;
// An uncreated worktree is a supported product state; the configured branch
// remains visible. No filesystem read or suppressed fault is needed.
const TICKET = {
  ...BASE,
  title: "Fix checkout form validation",
  labels: ["checkout", "bug"],
  branch: "shop/checkout-validation",
  body: [
    "## Checkout should welcome every address",
    "",
    "Customers with valid delivery addresses are getting blocked at checkout.",
    "Keep the form forgiving without accepting incomplete orders.",
    "",
    "### Acceptance",
    "",
    "- Accept spaces and lowercase letters in postcodes.",
    "- Keep the cart when a customer corrects an address.",
    "- Show a clear inline error for missing delivery details.",
    "- Cover guest checkout and signed-in customers with tests.",
    "",
    "### Verification",
    "",
    "Run the checkout validation tests, then place a test order with a guest cart.",
  ].join("\n"),
  worktreePath: null,
};
const TEMPLATE = sessionRows
  .filter((row) => row.kind === "chat")
  .find((row) => row.record.ticketId === TICKET.id)!;
const CHATS = [
  { ...TEMPLATE, record: { ...TEMPLATE.record, title: "Check checkout validation" } },
  {
    ...TEMPLATE,
    record: {
      ...TEMPLATE.record,
      sessionId: "film-chat-gutter-test",
      title: "Test delivery address validation",
      activity: "working" as const,
      waitingOn: null,
      lastActivityAt: NOW,
    },
  },
  {
    ...TEMPLATE,
    record: {
      ...TEMPLATE.record,
      sessionId: "film-chat-gutter-review",
      title: "Review the checkout changes",
      activity: "idle" as const,
      waitingOn: null,
      lastActivityAt: NOW - 12 * 60000,
    },
  },
];
const ROWS = [...sessionRows.filter((row) => row.record.ticketId !== TICKET.id), ...CHATS];
const COMMENTS = [
  {
    id: "film-checkout-note",
    ticketId: TICKET.id,
    sessionId: null,
    actor: "user",
    body: "Keep this focused on validation. The delivery options and payment flow should stay unchanged.",
    createdAt: NOW - 12 * 60000,
    updatedAt: NOW - 12 * 60000,
  },
];
const API = shellApi({
  tickets: {
    body: () => Promise.resolve({ ok: true, body: TICKET.body }),
    events: () => Promise.resolve({ ok: true, events: [] }),
  },
  comments: { list: () => Promise.resolve({ ok: true, comments: COMMENTS }) },
  sessions: {
    list: () => Promise.resolve({ ok: true, sessions: ROWS }),
    listForTicket: (input: { ticketId: string }) =>
      Promise.resolve({
        ok: true,
        sessions: ROWS.filter((row) => row.record.ticketId === input.ticketId),
      }),
  },
});

function seed(): void {
  seedShell();
  useBoardStore.setState(({ ticketsByProject }) => ({
    labelsByProject: {
      // oxlint-disable-next-line no-map-spread -- preserve the shared lab vocabulary
      [project.id]: labels.map((label) =>
        label.id === "lbl-editor" ? { ...label, name: "checkout" } : label,
      ),
    },
    ticketsByProject: {
      ...ticketsByProject,
      [project.id]: tickets.map((ticket) => (ticket.id === TICKET.id ? TICKET : ticket)),
    },
  }));
  useUiStore.setState({
    railMode: "now",
    railWidth: 320,
    sidebarPinned: false,
    railCollapsed: false,
    costVisible: false,
  });
  useBoardStore.getState().adoptTicketBody(project.id, TICKET.id, TICKET.body);
  useTicketSessionRecordsStore.setState({ byTicket: { [TICKET.id]: CHATS } });
  useProjectUiStore.getState().openTicketView(project.id, TICKET.id);
}
const CUE: Cue = {
  at: 120,
  until: 1150,
  lines: ["The whole ticket.", "One place."],
  size: "medium",
};
const CUES: Record<Format, Cue[]> = {
  landscape: [{ ...CUE, place: "lower-right" }],
  portrait: [{ ...CUE, place: "upper" }],
};

export function RailShot({ format }: { format: Format }) {
  const t = useFilm();
  useFilmWallClock(t, NOW);
  useFilmTheme("cobalt");
  useFixtures({ api: API, seed });
  const windowSize = WINDOW[format];
  return (
    <>
      <Surface
        id="rail"
        style={{
          position: "absolute",
          left: `calc(50% - ${windowSize.width / 2}px)`,
          top: `calc(50% - ${windowSize.height / 2}px)`,
          width: windowSize.width,
          height: windowSize.height,
        }}
        content={
          <ShellWindow
            className="film-ticket-shot"
            width={windowSize.width}
            height={windowSize.height}
          >
            {/* Capture removes the page backdrop; retain the real inset's paper. */}
            <style>{`.film-ticket-shot [data-slot="sidebar-inset"] { background: var(--background) !important; }`}</style>
          </ShellWindow>
        }
      />
      <Backdrop t={t} theme="cobalt" />
      <FrameLayer format={format}>
        <Vignette strength={0.4} />
        <Supers cues={CUES[format]} t={t} format={format} />
      </FrameLayer>
    </>
  );
}
