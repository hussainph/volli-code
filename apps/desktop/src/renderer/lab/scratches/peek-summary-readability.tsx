/** VC-473: real peek cards with short summaries and deliberately overlong fixtures. */
import * as React from "react";
import { PERSON_STARTED, type Ticket } from "@volli/shared";
import { SessionPeekCard } from "@renderer/components/session-peek/session-peek-card";
import { TicketPeekCard } from "@renderer/components/session-peek/ticket-peek-card";
import { SessionGlyph } from "@renderer/components/sessions/session-glyph";
import { Button } from "@renderer/components/ui/button";

export const title = "Peek summary readability · VC-473";
export const note = "Production cards, fixture text, no model calls";
export const viewport = "window";

const NOW = 1_700_000_600_000;
const ticket: Ticket = {
  id: "vc-473",
  projectId: "p1",
  ticketNumber: 473,
  title: "Fix the summaries with prompting + UI",
  body: "",
  status: "doing",
  priority: "medium",
  labels: [],
  usesWorktree: true,
  preferredHarnessId: "claude-code",
  order: 0,
  worktreePath: null,
  branch: null,
  baseBranch: null,
  prUrl: null,
  createdAt: 1,
  updatedAt: 1,
};
const SUMMARY =
  "Make hover summaries readable without extra model spend: added scrolling, combined prose summaries, and hover-only caching with rate limits; tool calls are excluded. Next: verify the hover flow in the app.";
const LONG_SUMMARY = `${SUMMARY}\n\n${"Long transcript excerpts remain readable instead of disappearing behind a five-line clamp. The header and conversation action stay in place while the body scrolls. ".repeat(7)}\n\nEnd of the long summary — nothing was hidden by a line clamp.`;

export default function PeekSummaryReadability() {
  const [long, setLong] = React.useState(false);
  const [pinned, setPinned] = React.useState(false);
  const summary = long ? LONG_SUMMARY : SUMMARY;
  return (
    <main className="h-svh bg-background p-8 text-foreground">
      <div className="flex items-center gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-ui font-semibold">Hover-peek summaries</h1>
          <p className="text-label text-muted-foreground">
            Actual updated components · fixture data · no utility-model calls
          </p>
        </div>
        <Button variant={long ? "default" : "secondary"} onClick={() => setLong((value) => !value)}>
          {long ? "Show typical summaries" : "Stress-test long text"}
        </Button>
      </div>
      <p
        style={{ position: "fixed", left: 56, top: 128 }}
        className="text-label text-muted-foreground"
      >
        SESSION PEEK
      </p>
      <p
        style={{ position: "fixed", left: 464, top: 128 }}
        className="text-label text-muted-foreground"
      >
        TICKET / FOLDER PEEK
      </p>
      <SessionPeekCard
        row={{
          rowId: "chat:summary-fix",
          sessionId: "summary-fix",
          title: "Fix hover summaries",
          ticket,
          kind: "chat",
          state: "working",
          providerId: "openai",
          providerLabel: "OpenAI",
          at: NOW - 120_000,
          unread: true,
          model: { providerId: "openai", modelId: "gpt-5.3-codex", reasoningLevel: "medium" },
          provenance: PERSON_STARTED,
        }}
        ticketPrefix="VC"
        now={NOW}
        content={{
          sessionId: "summary-fix",
          entries: [],
          summary,
          question: null,
          turns: 3,
          turnDepth: 2,
          unreadable: 0,
          lastActivityAt: NOW,
        }}
        loading={false}
        failed={false}
        position={{ left: 56, top: 160, maxHeight: 400 }}
        cardWidth={360}
        pinned={pinned}
        canReply
        onPin={() => setPinned(true)}
        onClose={() => setPinned(false)}
        onOpen={() => {}}
        onViewConversation={() => {}}
        onAnswer={async () => false}
        onSend={async () => false}
      />
      <TicketPeekCard
        ticket={ticket}
        ticketPrefix="VC"
        position={{ left: 464, top: 160, maxHeight: 400 }}
        cardWidth={360}
        onDrill={() => {}}
        onOpenTicket={() => {}}
        sessions={[
          {
            rowId: "chat:summary-fix",
            title: "Fix hover summaries",
            age: "2m",
            summary,
            glyph: (
              <SessionGlyph
                providerId="openai"
                providerLabel="OpenAI"
                kind="chat"
                state="working"
                name="OpenAI"
                size="row"
                surface="popover"
              />
            ),
          },
          {
            rowId: "chat:review",
            title: "Review summary budgeting",
            age: "8m",
            summary:
              "Tool-only activity makes no model calls; repeated hovers reuse cached summaries, and later hovers can refresh after the cooldown. Next: verify behavior with a live utility model.",
            glyph: (
              <SessionGlyph
                providerId="anthropic"
                providerLabel="Anthropic"
                kind="chat"
                state="ready"
                name="Anthropic"
                size="row"
                surface="popover"
              />
            ),
          },
        ]}
      />
      <p
        style={{ position: "fixed", left: 56, top: 592 }}
        className="max-w-content text-ui text-muted-foreground"
      >
        {long
          ? "Scroll inside either card to reach the end. The session header and footer remain fixed."
          : "Summaries are no longer line-clamped. Longer text scrolls inside the card instead of being cut off."}
      </p>
    </main>
  );
}
