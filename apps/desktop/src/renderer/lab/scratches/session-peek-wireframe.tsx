/**
 * VC-30 — interactive lab based on hover-peek-wireframe.excalidraw.
 *
 * Hover reads without moving focus. Answer/Send explicitly hold a recipient
 * and reveal the reply form; "pin" is only the controller's internal name.
 * The v1 sketch is retired; the shipped peek lives in components/session-peek.
 *
 * The scratch is self-contained: its controller (timers, wiring),
 * geometry, card and conversation overlay are siblings named
 * `session-peek-wireframe-*`, and the pure reducer next door owns dwell,
 * persistence, send and dismissal rules. They were briefly shared with a
 * sidebar-integration scratch; that scratch was retired once production
 * landed, so they live beside the wireframe again.
 * The conversation overlay reads separate source-message fixtures, never the
 * generated summary. Opening it preserves an unfinished reply and closing it
 * returns focus to the originating card (or row after a completed send).
 *
 * No IPC. Sessions, summaries, conversation, sends and navigation are fixtures.
 * Undo deletes a local fixture delivery; it cannot recall a real command. Its
 * 5-second receipt outlives the card's 2-second confirmation. A real integration
 * still needs freshness, cancellation and delivery guarantees from the runtime.
 */
import * as React from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";

import { PeekConversation } from "./session-peek-wireframe-conversation";
import { usePeekController } from "./session-peek-wireframe-controller";
import {
  SessionPeekCard,
  SessionGlyph,
  STATE_WORD,
  type SessionFixture,
  type FixtureState,
} from "./session-peek-wireframe-card";
import {
  stressCopy,
  CONTENT_LIMITS_NOTE,
  type TextCase,
  type SummaryState,
} from "./session-peek-content";

import { Button } from "@renderer/components/ui/button";
import { ListRow } from "@renderer/components/ui/list-row";
import { Notice } from "@renderer/components/ui/notice";
import {
  Sidebar,
  SidebarGroup,
  SidebarMenu,
  SidebarProvider,
} from "@renderer/components/ui/sidebar";
import { cn } from "@renderer/lib/utils";

import {
  DEFAULT_DWELL,
  DWELL_CHOICES,
  type DwellMs,
  type PeekSurface,
  type PeekTarget,
  type SendOutcome,
} from "./session-peek-wireframe-model";

export const title = "Session peek · Excalidraw v2";
export const note = "Session summaries, answers and a conversation overlay in both sidebars";
export const viewport = "window";

/* ------------------------------------------------------------------ fixtures */

const QUESTION_OPTIONS = [
  { id: "redis", label: "Redis", description: "Fast, adds a dependency" },
  { id: "postgres", label: "Postgres", description: "Slower, no new infra" },
];

/** Variations over the shared per-prompt contract, not a claim about every harness. */
type QuestionCase = "custom" | "choices" | "multiple" | "steps" | "freeform";
const BASE_PROMPT = {
  id: "cache",
  label: "Which cache backend should the indexer use?",
  detail: null,
  options: QUESTION_OPTIONS,
  multiple: false,
  custom: true,
};
const QUESTION_CASES: Record<QuestionCase, SessionFixture["question"]> = {
  custom: { prompts: [BASE_PROMPT] },
  choices: { prompts: [{ ...BASE_PROMPT, custom: false }] },
  multiple: {
    prompts: [
      {
        ...BASE_PROMPT,
        multiple: true,
        custom: false,
        label: "Which backends should we evaluate?",
      },
    ],
  },
  steps: {
    prompts: [
      { ...BASE_PROMPT, custom: false },
      {
        id: "rollout",
        label: "How should we roll this out?",
        detail: "The indexer runs in three regions.",
        options: [
          { id: "staged", label: "Staged rollout", description: "Start with one indexer" },
          { id: "all", label: "All at once", description: "Switch every indexer" },
        ],
        multiple: false,
        custom: true,
      },
    ],
  },
  freeform: {
    prompts: [
      {
        ...BASE_PROMPT,
        id: "approach",
        label: "What approach should we take?",
        options: [],
        custom: true,
      },
    ],
  },
};

const FIXTURES: readonly SessionFixture[] = [
  {
    rowId: "session-1",
    model: {
      providerId: "anthropic",
      providerLabel: "Anthropic",
      modelId: "claude-opus-5",
      label: "Opus 5",
    },
    messages: [
      {
        role: "user",
        text: "Build a preview for sessions in the sidebar. Keep the current workspace open while I check another session.",
      },
      {
        role: "assistant",
        text: "The hover controller now waits until the pointer rests on a row. I moved the close timer onto the shared card so crossing the gap does not dismiss it. Next I am checking the ticket rail so the same card can open on its left side.",
      },
    ],
    sessionTitle: "Session 1",
    sessionId: "ses-7f3a91",
    ticketId: "VC-200",
    ticketTitle: "Hover-peek for sessions in the sidebars",
    ticketStage: "Doing",
    recency: "2m ago",
    state: "active",
    lastActivity:
      "Wired the dwell timer to the Active band and moved the close grace onto the card; now reading how the rail positions its own rows before touching the shared peek.",
    question: null,
    failure: null,
  },
  {
    rowId: "session-2",
    model: {
      providerId: "openai-codex",
      providerLabel: "OpenAI",
      modelId: "gpt-6-sol",
      label: "GPT 6 Sol",
    },
    messages: [
      {
        role: "user",
        text: "Choose a cache backend for the search indexer. Compare operational cost and query latency before adding infrastructure.",
      },
      {
        role: "assistant",
        text: "I traced the indexer read path and compared the two options. Redis would keep frequently read index entries in memory, but we would need another service to deploy, monitor, back up and reconnect to.\n\nPostgres is already deployed. An indexed cache table would be slower on hot reads but fits the existing migration and backup process. I have not added either dependency or changed the schema.",
      },
      {
        role: "assistant",
        text: "Which cache backend should the indexer use?",
      },
    ],
    sessionTitle: "Session 2",
    sessionId: "ses-2c4d08",
    ticketId: "VC-201",
    ticketTitle: "Choose a cache backend for the indexer",
    ticketStage: "Doing",
    recency: "40s ago",
    state: "waiting",
    // Keep the work, summary and pending question about the same decision.
    lastActivity:
      "Compared Redis with the existing Postgres deployment. Redis is faster on hot reads; Postgres avoids a new service. No dependencies or schema changes yet.",
    question: QUESTION_CASES.custom,
    failure: null,
  },
  {
    rowId: "session-3",
    model: {
      providerId: "google",
      providerLabel: "Google",
      modelId: "gemini-2.5-pro",
      label: "Gemini 2.5 Pro",
    },
    messages: [
      {
        role: "user",
        text: "Review stale tickets and report candidates to close. Do not close any tickets yet.",
      },
      {
        role: "assistant",
        text: "Eleven backlog tickets have no comment in the last thirty days. Four have a merged pull request linked in their activity. I recorded the candidates for review and left every ticket unchanged.",
      },
    ],
    sessionTitle: "Session 3",
    sessionId: "ses-91be44",
    ticketId: null,
    ticketTitle: null,
    ticketStage: null,
    recency: "22m ago",
    state: "idle",
    lastActivity:
      "Found eleven stale backlog tickets, including four with merged PRs. Saved the candidates for review; no tickets were closed.",
    question: null,
    failure: null,
  },
  {
    rowId: "session-4",
    model: {
      providerId: "anthropic",
      providerLabel: "Anthropic",
      modelId: "claude-opus-5",
      label: "Opus 5",
    },
    messages: [
      {
        role: "user",
        text: "Investigate why terminal resume loses scrollback. Trace the restore path before editing.",
      },
      {
        role: "assistant",
        text: "The resume seed contains the expected pane identifier. The restored pane is registered before its scrollback offsets are applied. I was comparing the saved offsets with the first viewport resize when the executor connection ended.",
      },
    ],
    sessionTitle: "Session 4",
    sessionId: "ses-55a7c2",
    ticketId: "VC-123",
    ticketTitle: "Terminal resume loses its scrollback",
    ticketStage: "Needs Review",
    recency: "1h ago",
    state: "failed",
    lastActivity:
      "Read the resume seed and the pane registry, then compared both against the recorded scrollback offsets before the turn ended mid-stream with nothing written.",
    question: null,
    failure: "Turn ended without a reply — the executor exited while the model was streaming.",
  },
];

const PROVIDER_MODELS = Object.fromEntries(
  FIXTURES.map((fixture) => [fixture.model.providerId, fixture.model]),
);

/** A ticketless Session's stand-in, matching the sketch's "Board · 22m ago" row. */
const NO_TICKET_SOURCE = "Board";

function rowSubtitle(fixture: SessionFixture): string {
  return `${fixture.ticketId ?? NO_TICKET_SOURCE} · ${fixture.recency}`;
}

/* ------------------------------------------------------------- lab notes */

/** Prototype mechanics and the remaining difference from the sketch. */
const HOVER_MECHANICS: readonly string[] = [
  "opens after ~400 ms, pointer at rest — passing through a row never opens it",
  "cursor can travel row → card; this lab uses a 300 ms grace bridge (the sketch proposes a safe polygon)",
  "Esc · click-away · list scroll also close it",
  "one peek at a time; ~1 s suppression after close",
  "production target: snapshot ≤30 s stale + live status; fixtures here are static",
  "no terminal screenshots or live video",
  "setting: hover peek on/off · compact mode (title + ticket ID + status) for a quieter sidebar",
  "peek never steals focus — the row keeps it",
];

/** Keyboard routes and scope. */
const KEYBOARD_SCOPE: readonly string[] = [
  "J/K or ↑/↓ steps rows; one peek follows focus",
  "keyboard path: focus a row → peek after ~200–300 ms, or press Space to open / pin it",
  "Enter still opens the session — the peek is never the only route to anything",
  "WCAG 1.4.13: dismissable (Esc) · hoverable (bridge) · persistent (never vanishes while you read or type)",
  "the reply field makes it a non-modal dialog (ARIA), not a tooltip",
  "same rows + peek in the right in-ticket sidebar; board tickets reuse it later",
];

/** The sketch's confirmation panel, with this file's answer to its 2s/5s conflict. */
const CONFIRMATION_NOTES: readonly string[] = [
  "sidebar state flips: Waiting for you → Working",
  "peek stays ~2 s with this confirmation, then closes",
  "Undo (5 s) if you misclicked — moved onto a receipt strip so it outlives the peek",
  "retryable send failure keeps the reply and recovery action visible",
  "the answer also shows up in the session transcript",
];

const STILL_TO_DECIDE =
  "Default hover delay (300 / 400 / 500 ms)?  ·  compact vs full as the default  ·  how stale may the summary be (≤30 s?)  ·  same peek on board tickets now or later?  ·  anything different in the right sidebar?";

/* --------------------------------------------------------------- the geometry */

const PEEK_WIDTH = 360;
/* ------------------------------------------------------------------- the row */

type RowDensity = "full" | "compact";

/**
 * One sidebar row, in either list.
 *
 * `data-peek-row` is how the pointer handler resolves a row without wrapping
 * every entry in an extra element — the lists are `<ul>`/`<li>` owned by the
 * sidebar primitive, and a div per row would be invalid markup inside one.
 */
function SessionRow({
  fixture,
  surface,
  density,
  delivered,
  onOpenSession,
}: {
  fixture: SessionFixture;
  surface: PeekSurface;
  density: RowDensity;
  /** A sent answer flips the row, which is the only thing a send changes out here. */
  delivered: boolean;
  onOpenSession: () => void;
}) {
  const state: FixtureState = delivered && fixture.state === "waiting" ? "active" : fixture.state;
  return (
    <li data-peek-row={fixture.rowId} data-peek-surface={surface}>
      <ListRow
        // Click and Enter both land here. The peek is never the only route to a
        // session, and a row that opened nothing would be a lie the pointer tells.
        onActivate={onOpenSession}
        density={density === "full" ? "two-line" : "row"}
        leading={<SessionGlyph fixture={fixture} state={state} />}
        primary={
          <span
            data-session-row-title=""
            className={cn(
              "min-w-0 flex-1 truncate text-ui",
              density === "compact" ? "font-semibold" : "font-medium",
            )}
          >
            {fixture.sessionTitle}
          </span>
        }
        secondary={density === "full" ? rowSubtitle(fixture) : undefined}
        primaryTrailing={
          density === "compact" ? (
            <span className="shrink-0 font-mono text-label tracking-normal text-muted-foreground">
              {fixture.ticketId ?? "Board"}
            </span>
          ) : undefined
        }
      />
    </li>
  );
}

const CAPTION = "text-label text-muted-foreground uppercase";

/* ---------------------------------------------------------------- lab chrome */

/** The lab's own control, drawn so it can never be mistaken for the design. */
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (next: T) => void;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2">
      <span className="text-label text-muted-foreground uppercase">{label}</span>
      <div className="flex flex-wrap gap-1">
        {options.map(([key, name]) => (
          <Button
            key={key}
            type="button"
            size="xs"
            variant={key === value ? "secondary" : "ghost"}
            aria-pressed={key === value}
            disabled={disabled}
            onClick={() => onChange(key)}
          >
            {name}
          </Button>
        ))}
      </div>
    </div>
  );
}

function Bullets({ heading, items }: { heading: string; items: readonly string[] }) {
  return (
    <section className="flex flex-col gap-1.5 rounded-xl border border-dashed border-border p-3">
      <h2 className="text-ui font-medium text-foreground">{heading}</h2>
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <li key={item} className="flex gap-1.5 text-ui text-muted-foreground">
            <span aria-hidden>•</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* --------------------------------------------------------------- the machine */

/* ----------------------------------------------------------------- the stage */

export default function SessionPeekWireframeScratch() {
  const [dwell, setDwell] = React.useState<DwellMs>(DEFAULT_DWELL);
  const [density, setDensity] = React.useState<RowDensity>("full");
  const [hoverEnabled, setHoverEnabled] = React.useState(true);
  const [outcome, setOutcome] = React.useState<SendOutcome>("success");
  const [textCase, setTextCase] = React.useState<TextCase>("normal");
  const [summaryState, setSummaryState] = React.useState<SummaryState>("ready");
  const [questionCase, setQuestionCase] = React.useState<QuestionCase>("custom");
  const [cardWidth, setCardWidth] = React.useState(PEEK_WIDTH);
  const [provider, setProvider] = React.useState("mixed");
  const fixtures = React.useMemo(
    () =>
      FIXTURES.map((fixture) =>
        stressCopy(
          {
            ...fixture,
            model: PROVIDER_MODELS[provider] ?? fixture.model,
            question:
              fixture.rowId === "session-2" ? QUESTION_CASES[questionCase] : fixture.question,
          },
          textCase,
        ),
      ),
    [textCase, provider, questionCase],
  );
  const fixtureByRow = React.useMemo(
    () => new Map(fixtures.map((fixture) => [fixture.rowId, fixture])),
    [fixtures],
  );

  const peek = usePeekController({ dwell, hoverEnabled, outcome, cardWidth });
  const { state, dispatch, cardRef, position, looking, receipt, undoLeft, rowProps } = peek;
  const shown = state.shown;
  const shownFixture = shown === null ? null : (fixtureByRow.get(shown.rowId) ?? null);
  const lookingFixture = looking === null ? null : (fixtureByRow.get(looking) ?? null);

  const deliveredFor = (rowId: string) => state.delivered[rowId] !== undefined;
  const previewFixture = shownFixture ?? fixtures[1]!;

  return (
    <div className="flex h-svh w-full flex-col overflow-y-auto bg-background text-foreground lg:flex-row lg:overflow-hidden">
      {/* ------------------------------------------------- 1 · left nav sidebar */}
      <SidebarProvider
        className="min-h-0 w-full shrink-0 lg:w-fit"
        style={{ "--sidebar-width": "280px" } as React.CSSProperties}
      >
        <Sidebar
          collapsible="none"
          className="w-full border-r border-border py-2 lg:w-(--sidebar-width)"
        >
          <SidebarGroup className="gap-1 py-0">
            <p className={cn(CAPTION, "px-2 py-1")}>Left nav sidebar</p>
            {/* The scroll container is the list, because a list scroll is one of
                the three gestures that close an unpinned peek. */}
            <div className="max-h-[320px] overflow-y-auto" onScroll={peek.onListScroll}>
              <SidebarMenu {...rowProps("nav")}>
                {fixtures.map((fixture) => (
                  <SessionRow
                    key={fixture.rowId}
                    fixture={fixture}
                    surface="nav"
                    density={density}
                    delivered={deliveredFor(fixture.rowId)}
                    onOpenSession={() => dispatch({ type: "open-session", rowId: fixture.rowId })}
                  />
                ))}
              </SidebarMenu>
            </div>
          </SidebarGroup>
        </Sidebar>
      </SidebarProvider>

      {/* ------------------------------------------------------ the middle: notes */}
      <div className="min-w-0 shrink-0 p-4 lg:flex-1 lg:overflow-y-auto lg:p-6">
        <div className="flex max-w-[760px] flex-col gap-4">
          <header className="flex flex-col gap-1">
            <h1 className="text-heading text-foreground">Session peek</h1>
            <p className="text-ui text-muted-foreground">
              Lab translation of <span className="font-mono">hover-peek-wireframe.excalidraw</span>.
              Four fixture sessions, no backend: sending, opening a session, the badge flip and the
              transcript line below are all simulations, and Undo removes a fixture entry rather
              than recalling anything. The shipped peek lives in
              <span className="font-mono"> components/session-peek</span>.
            </p>
          </header>

          <div
            data-lab-controls=""
            className="flex flex-col gap-4 rounded-xl border border-border p-4"
          >
            <h2 className="text-ui font-medium">Test cases</h2>
            <div className="flex flex-wrap items-center gap-4">
              <Choice<`${DwellMs}`>
                label="Dwell"
                value={`${dwell}`}
                options={DWELL_CHOICES.map((ms) => [`${ms}`, `${ms}ms`] as const)}
                onChange={(next) => setDwell(Number(next) as DwellMs)}
              />
              <Choice<RowDensity>
                label="Rows"
                value={density}
                options={[
                  ["full", "full"],
                  ["compact", "compact"],
                ]}
                onChange={setDensity}
              />
              <Choice<"on" | "off">
                label="Hover"
                value={hoverEnabled ? "on" : "off"}
                options={[
                  ["on", "on"],
                  ["off", "off (keyboard)"],
                ]}
                onChange={(next) => {
                  peek.clearDwell();
                  setHoverEnabled(next === "on");
                  if (next === "off") peek.disableHover();
                }}
              />
              <Choice<SendOutcome>
                label="Send"
                value={outcome}
                options={[
                  ["success", "succeeds"],
                  ["failure", "fails"],
                ]}
                onChange={setOutcome}
              />
              <Choice<TextCase>
                label="Text"
                value={textCase}
                options={[
                  ["normal", "normal"],
                  ["long", "long"],
                  ["extreme", "extreme"],
                  ["unbroken", "unbroken"],
                ]}
                onChange={setTextCase}
              />
              <Choice<QuestionCase>
                label="Question"
                value={questionCase}
                disabled={state.send.kind === "sending" || state.send.kind === "sent"}
                options={[
                  ["custom", "custom"],
                  ["choices", "choices only"],
                  ["multiple", "multiple"],
                  ["steps", "two steps"],
                  ["freeform", "freeform"],
                ]}
                onChange={(next) => {
                  dispatch({ type: "fixture-question-changed" });
                  setQuestionCase(next);
                }}
              />
              <Choice<SummaryState>
                label="Summary"
                value={summaryState}
                options={[
                  ["ready", "ready"],
                  ["loading", "loading"],
                  ["unavailable", "unavailable"],
                ]}
                onChange={setSummaryState}
              />
              <Choice<"280" | "360" | "420">
                label="Card"
                value={`${cardWidth}` as "280" | "360" | "420"}
                options={[
                  ["280", "280px"],
                  ["360", "360px"],
                  ["420", "420px"],
                ]}
                onChange={(value) => setCardWidth(Number(value))}
              />
              <Choice<string>
                label="Provider"
                value={provider}
                options={[
                  ["mixed", "mixed"],
                  ["anthropic", "Anthropic"],
                  ["openai-codex", "OpenAI"],
                  ["google", "Google"],
                ]}
                onChange={setProvider}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {fixtures.map((fixture) => (
                <Button
                  key={fixture.rowId}
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    const target: PeekTarget = { rowId: fixture.rowId, surface: "nav" };
                    dispatch({ type: "hover-row", target });
                    dispatch({ type: "open-now", target, now: Date.now() });
                  }}
                >
                  {STATE_WORD[fixture.state]}
                </Button>
              ))}
            </div>
            <p className="text-ui text-muted-foreground tabular-nums" data-text-lengths="">
              Session {previewFixture.sessionTitle.length} · ticket{" "}
              {previewFixture.ticketTitle?.length ?? 0} · summary{" "}
              {previewFixture.lastActivity.length} · question{" "}
              {previewFixture.question?.prompts[0]?.label.length ?? 0} chars
            </p>
            <p className="text-ui text-muted-foreground">{CONTENT_LIMITS_NOTE}</p>
          </div>

          <details className="text-ui">
            <summary className="cursor-pointer text-muted-foreground">Interaction notes</summary>
            <div className="flex flex-col gap-2 pt-2">
              <Bullets heading="Hover mechanics" items={HOVER_MECHANICS} />
              <Bullets heading="Sweep, keyboard & scope" items={KEYBOARD_SCOPE} />
              <Bullets heading="After a send (simulated)" items={CONFIRMATION_NOTES} />
            </div>
          </details>

          <section className="flex flex-col gap-2 rounded-xl border border-border p-3">
            <h2 className="text-ui font-medium text-foreground">Session transcript (lab mock)</h2>
            <p className="text-ui text-muted-foreground">
              Written only by a Send — hovering, pinning, selecting an option and typing all leave
              this empty.
            </p>
            {Object.keys(state.delivered).length === 0 ? (
              <p className="text-ui text-muted-foreground">Nothing delivered yet.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {Object.entries(state.delivered).map(([rowId, entry]) => (
                  <li key={rowId} className="flex gap-1.5 text-ui text-foreground">
                    <span className="font-mono text-muted-foreground">
                      {fixtureByRow.get(rowId)?.sessionTitle ?? rowId}
                    </span>
                    <span>→ “{entry.answer}”</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="flex flex-col gap-1.5 rounded-xl border border-dashed border-border p-3">
            <h2 className="text-ui font-medium text-foreground">Still to decide</h2>
            <p className="text-ui text-muted-foreground">{STILL_TO_DECIDE}</p>
          </section>
        </div>
      </div>

      {/* --------------------------------------- the right in-ticket rail */}
      {/* Same rows, same peek, opening the other way — the sketch's "same rows +
          peek in the right in-ticket sidebar". */}
      <aside className="w-full shrink-0 border-l border-border p-2 lg:w-[280px]">
        <p className={cn(CAPTION, "px-2 py-1")}>Right rail · state gallery</p>
        <div className="max-h-[320px] overflow-y-auto" onScroll={peek.onListScroll}>
          <ul className="flex flex-col gap-1" {...rowProps("rail")}>
            {fixtures.map((fixture) => (
              <SessionRow
                key={fixture.rowId}
                fixture={fixture}
                surface="rail"
                density={density}
                delivered={deliveredFor(fixture.rowId)}
                onOpenSession={() => dispatch({ type: "open-session", rowId: fixture.rowId })}
              />
            ))}
          </ul>
        </div>
      </aside>

      {/* ----------------------------------------------------------- the peek */}
      {shown !== null && shownFixture !== null && position !== null && looking === null ? (
        <SessionPeekCard
          ref={cardRef}
          fixture={shownFixture}
          state={state}
          position={position}
          width={cardWidth}
          summaryState={summaryState}
          dispatch={dispatch}
          delivered={deliveredFor(shownFixture.rowId)}
          onPin={() => peek.pin(shown)}
          onOpen={() => dispatch({ type: "open-session", rowId: shownFixture.rowId })}
          onLook={() => peek.look(shownFixture.rowId)}
          onClose={() => dispatch({ type: "escape", now: Date.now() })}
          {...peek.cardProps}
        />
      ) : null}

      <PeekConversation
        fixture={lookingFixture}
        answer={lookingFixture === null ? undefined : state.delivered[lookingFixture.rowId]?.answer}
        outcome={outcome}
        onClose={peek.closeLook}
        onOpen={() => {
          if (lookingFixture === null) return;
          dispatch({ type: "open-session", rowId: lookingFixture.rowId });
          peek.closeLook();
        }}
        returnFocus={peek.lookReturn}
      />

      {/* ------------------------------------------------- the Undo receipt */}
      {/* Off the peek on purpose: the peek closes at ~2s and this holds the full
          5s window the sketch promises. It is also where the honest label about
          Undo belongs — nothing was sent, so nothing is being recalled. */}
      {receipt === null ? null : (
        <div
          role="status"
          className="fixed right-4 bottom-14 z-[70] w-[360px] max-w-[calc(100vw-32px)]"
        >
          <Notice
            tone="neutral"
            icon={CheckCircleIcon}
            layout="stack"
            title={`Sent to ${FIXTURES.find((fixture) => fixture.rowId === receipt.rowId)?.sessionTitle ?? receipt.rowId}`}
            detail={`Simulation · ${undoLeft}s to undo`}
            actions={
              <Button type="button" size="sm" variant="secondary" onClick={peek.undo}>
                Undo
              </Button>
            }
          />
        </div>
      )}

      {/* ------------------------------------- "Open session" is a simulation */}
      {state.opened === null ? null : (
        <div className="fixed top-3 left-1/2 z-[70] -translate-x-1/2">
          <Notice
            tone="neutral"
            icon={ArrowSquareOutIcon}
            title={`Lab: would open ${fixtureByRow.get(state.opened)?.sessionTitle ?? state.opened}`}
            detail="No navigation here — the scratch has no session to open."
          />
        </div>
      )}
    </div>
  );
}
