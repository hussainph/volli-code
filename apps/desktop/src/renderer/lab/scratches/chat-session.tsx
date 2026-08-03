import * as React from "react";
import {
  CheckCircleIcon,
  ClockIcon,
  CodeIcon,
  TerminalWindowIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import type { SessionAttention, SessionInteractionResolution } from "@volli/shared";
import type { UIMessage } from "ai";

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@ai-elements/conversation";
import { FileMentionProvider } from "@ai-elements/chat-markdown";
import { Message, MessageContent, MessageResponse } from "@ai-elements/message";
import { ReasoningLine } from "@ai-elements/reasoning";
import { AppShell } from "@renderer/components/app-shell";
import { ContentColumn } from "@renderer/components/layout/content-column";
import { SettingsPage } from "@renderer/components/pages/settings-page";
import { RailDrawer } from "@renderer/components/ticket/rail-drawer";
import { TicketTabStrip, type TicketTabDescriptor } from "@renderer/components/ticket/ticket-tabs";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import { useUiStore } from "@renderer/stores/ui";

import {
  groupTurns,
  isAwaitingFirstOutput,
  projectSessionTodos,
  segmentTurn,
  type ChatSegment,
  type SessionTodo,
} from "../chat/activity";
import { ActivityBundle, SessionTodoDock, SessionTodoList } from "../chat/activity-ui";
import { SessionComposer } from "../chat/composer-ui";
import { InteractionCard, InteractionFocusProvider } from "../chat/interaction-ui";
import { useLabSessionController } from "../chat/session-controller";
import {
  enqueueMessage,
  nextRelease,
  type ComposerIntent,
  type QueuedMessage,
} from "../chat/session-model";
import { LabRuntimeCatalogProvider } from "../runtime-catalog-client";
import { appApi, seedApp } from "../seed";

export const title = "Ticket chat · OpenCode";
export const note = "Native OpenCode Session inside the ticket workspace";
export const viewport = "window" as const;
export const seed = seedApp;
export const api = appApi;

const SESSION_TAB_ID = "native-chat";

export default function ChatSessionScratch() {
  return (
    <LabRuntimeCatalogProvider>
      <AppShell mainContent={<LabMainContent />} />
    </LabRuntimeCatalogProvider>
  );
}

/** Keep the prototype Session alive while Settings takes over the canvas. */
function LabMainContent() {
  const settingsOpen = useUiStore((state) => state.settingsOpen);

  return (
    <>
      <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", settingsOpen && "hidden")}>
        <TicketChatWorkspace />
      </div>
      {settingsOpen ? <SettingsPage initialCategoryKey="harness" /> : null}
    </>
  );
}

function TicketChatWorkspace() {
  const session = useLabSessionController();
  const [activeTabId, setActiveTabId] = React.useState(SESSION_TAB_ID);
  const [fileTabs, setFileTabs] = React.useState<TicketTabDescriptor[]>([]);
  const [todos, setTodos] = React.useState<SessionTodo[] | null>(null);
  // The rail's width and collapsed state are app-wide chrome the ChromeBar
  // already owns, so this surface reads them rather than growing a second
  // toggle beside the one in the window's title band.
  const railWidth = useUiStore((state) => state.railWidth);
  const railCollapsed = useUiStore((state) => state.railCollapsed);

  const tabs = React.useMemo<TicketTabDescriptor[]>(
    () => [
      { id: "doc", kind: "body", label: "LAB-14" },
      {
        id: SESSION_TAB_ID,
        kind: "session",
        label: "OpenCode 1",
        // The Session's liveness rides its own tab. The chat plane below has no
        // header of its own: a third chrome band would only repeat this word.
        status: session.lifecycle,
      },
      ...fileTabs,
    ],
    [fileTabs, session.lifecycle],
  );

  // Live todos from the plan activity; clear leftovers when the Session goes
  // idle (OpenCode paradigm — unfinished plans do not reopen later).
  React.useEffect(() => {
    if (session.lifecycle === "idle") {
      setTodos(null);
      return;
    }
    const projected = projectSessionTodos(session.messages);
    if (projected !== null) setTodos(projected.length > 0 ? projected : null);
  }, [session.lifecycle, session.messages]);

  const openFileTab = React.useCallback((path: string) => {
    const id = `file:${path}`;
    setFileTabs((current) => {
      if (current.some((tab) => tab.id === id)) return current;
      const label = path.includes("/") ? (path.split("/").pop() ?? path) : path;
      return [...current, { id, kind: "file", label, relPath: path }];
    });
    setActiveTabId(id);
  }, []);

  const onSession = activeTabId === SESSION_TAB_ID;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TicketTabStrip
        tabs={tabs}
        activeTabId={activeTabId}
        creating={session.lifecycle === "starting"}
        onSelectTab={setActiveTabId}
        onCloseTab={(tab) => {
          if (tab.kind === "file") {
            setFileTabs((current) => current.filter((entry) => entry.id !== tab.id));
            setActiveTabId(SESSION_TAB_ID);
            return;
          }
          setActiveTabId("doc");
        }}
        onRenameSessionTab={() => undefined}
        onNewSession={() => void session.start()}
        canFocusTerminal={false}
        onEnterTerminalFocus={() => undefined}
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {activeTabId === "doc" ? (
            <TicketIntent onOpenSession={() => setActiveTabId(SESSION_TAB_ID)} />
          ) : activeTabId.startsWith("file:") ? (
            <LabFilePreview path={activeTabId.slice("file:".length)} />
          ) : (
            <ChatPlane session={session} todos={todos} onOpenFile={openFileTab} />
          )}
        </main>
        {onSession && !railCollapsed ? (
          <aside
            className="flex shrink-0 flex-col overflow-hidden border-l border-sidebar-border bg-sidebar"
            style={{ width: railWidth }}
          >
            <SessionRail todos={todos} />
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Standing state, consulted rather than monitored — the transcript already
 * holds this turn's narrative. Only what has no other home lives here; changes
 * and files stay in the rail modes that already own them.
 */
function SessionRail({ todos }: { todos: SessionTodo[] | null }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable]">
      <SessionRailDrawer label="Plan" count={todos?.length ?? 0}>
        {todos && todos.length > 0 ? (
          <div className="px-4 pb-3">
            <SessionTodoList todos={todos} />
          </div>
        ) : null}
      </SessionRailDrawer>
      <SessionRailDrawer label="Subagents" count={0} />
      <SessionRailDrawer label="Background processes" count={0} />
    </div>
  );
}

/**
 * Derived open state — a drawer opens because it has something in it, and stays
 * wherever the user last put it after that. No timer, so a click mid-transition
 * wins by construction.
 */
function SessionRailDrawer({
  label,
  count,
  children,
}: React.PropsWithChildren<{ label: string; count: number }>) {
  const [userOpen, setUserOpen] = React.useState<boolean | null>(null);
  const open = userOpen ?? count > 0;
  return (
    <RailDrawer label={label} count={count} open={open} onOpenChange={setUserOpen}>
      {children}
    </RailDrawer>
  );
}

function LabFilePreview({ path }: { path: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pt-8 [scrollbar-gutter:stable]">
      <ContentColumn>
        <h1 className="font-mono text-heading font-semibold">{path}</h1>
      </ContentColumn>
    </div>
  );
}

function TicketIntent({ onOpenSession }: { onOpenSession(): void }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto pt-8 [scrollbar-gutter:stable]">
      <ContentColumn className="pb-16">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">LAB-14</span>
          <span>·</span>
          <span>Doing</span>
        </div>
        <h1 className="mt-3 text-title font-semibold tracking-tight">
          Teach the lab greeting to use a developer’s name
        </h1>
        <div className="mt-6 space-y-4 text-sm leading-6 text-foreground">
          <p>
            The disposable task repository contains a small greeting function and a failing test.
            Update the implementation without changing its public API.
          </p>
          <section className="border-t border-border pt-6">
            <h2 className="text-ui font-semibold">Acceptance</h2>
            <div className="mt-3 space-y-2 text-sm text-muted-foreground">
              <p className="flex items-center gap-2">
                <CheckCircleIcon className="size-4" /> `greeting("Ada")` returns `Hello, Ada!`
              </p>
              <p className="flex items-center gap-2">
                <CheckCircleIcon className="size-4" /> `npm test` passes
              </p>
            </div>
          </section>
        </div>
        <Button className="mt-8" onClick={onOpenSession}>
          <TerminalWindowIcon className="size-4" />
          Open Session
        </Button>
      </ContentColumn>
    </div>
  );
}

function ChatPlane({
  session,
  todos,
  onOpenFile,
}: {
  session: ReturnType<typeof useLabSessionController>;
  todos: SessionTodo[] | null;
  onOpenFile(path: string): void;
}) {
  const [input, setInput] = React.useState("");
  const [queued, setQueued] = React.useState<readonly QueuedMessage[]>([]);
  const [resolving, setResolving] = React.useState(false);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);
  const composerHeight = useMeasuredHeight<HTMLDivElement>();
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const interactionRef = React.useRef<HTMLFormElement>(null);
  const working = session.lifecycle === "working";

  const { submit, selection, liveAttachmentId, interactions, resolveInteraction } = session;
  /**
   * Two questions, and conflating them is what made the composer inert for the
   * whole attach. A model is what you need to *write* a message; a live executor
   * is what you need to *deliver* one. Typing while OpenCode is still coming up
   * is the ordinary case now that opening the Session starts it, so a message
   * written early joins the queue and drains the moment there is somewhere to
   * send it — the same machinery that already holds messages behind a live turn.
   */
  const composable = selection.modelId.length > 0;
  const deliverable = liveAttachmentId !== null && composable;

  const send = React.useCallback(
    (text: string, intent: ComposerIntent) => {
      if (intent === "queue" || !deliverable) {
        setQueued((current) => enqueueMessage(current, { id: nextId(), text }));
        setInput("");
        return;
      }
      void submit(text, intent === "steer" ? "steer" : "queue").then((sent) => {
        if (sent) setInput("");
      });
    },
    [deliverable, submit],
  );

  // A queue drains one message into an idle Session. The released id is latched
  // so a re-render between the state write and the send cannot deliver twice.
  const released = React.useRef<string | null>(null);
  React.useEffect(() => {
    const next = nextRelease(queued, { working, ready: deliverable });
    if (!next || released.current === next.id) return;
    released.current = next.id;
    setQueued((current) => current.filter((entry) => entry.id !== next.id));
    void submit(next.text, "queue");
  }, [deliverable, queued, submit, working]);

  /**
   * One question at a time, oldest first.
   *
   * A harness can have several interactions open at once — a permission raised
   * by a subagent while the parent turn waits on its own. Answering the oldest
   * is what usually clears the rest, and two blocking cards stacked in the
   * composer's slot is two things claiming to be the one thing to do next.
   */
  const pending = interactions[0] ?? null;

  const answer = React.useCallback(
    (interactionId: string, resolution: SessionInteractionResolution) => {
      setResolving(true);
      void resolveInteraction(interactionId, resolution).finally(() => setResolving(false));
    },
    [resolveInteraction],
  );

  const focusInteraction = React.useCallback(() => interactionRef.current?.focus(), []);

  const turnContext: TurnContext = { working, onOpenFile };
  // The precedence the blocker's own doc comment marks: a pending interaction
  // is not a failure, it is the one thing on screen you can act on, and its
  // card carries the answer. Suppressed here rather than inside `sessionBlocker`
  // because this is the one place holding both.
  const blocker = pending ? null : sessionBlocker(session, () => setSettingsOpen(true));

  const planeStyle = { "--composer-height": `${composerHeight.height}px` } as React.CSSProperties;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" style={planeStyle}>
      <FileMentionProvider onOpenFile={onOpenFile}>
        <InteractionFocusProvider focus={pending ? focusInteraction : null}>
          <Conversation className="min-h-0 bg-background">
            {/* Only the part of this that clears the h-16 gradient reads as empty,
              so the honest figure is 4rem of fade plus 8rem of clean background
              — and the composer growing as you type eats into it from below.
              At +2rem the last line sat inside the gradient; at +5rem it had
              16px of real air, which is nothing. */}
            <ConversationContent className="gap-6 px-0 pt-8 pb-[calc(var(--composer-height)+12rem)]">
              {session.messages.length === 0 ? (
                // A mark, and nothing else. Everything that used to stand here was
                // the Session's plumbing wearing a button: a Start control for the
                // thing opening the tab already means, and a models prompt fired
                // by a catalog that had simply not answered yet. What genuinely
                // blocks typing now sits on the composer, where the typing is.
                <ConversationEmptyState className="min-h-80">
                  <div className="flex size-10 items-center justify-center rounded-xl border border-border bg-card shadow-[var(--shadow-raised)]">
                    <CodeIcon className="size-5 text-muted-foreground" />
                  </div>
                </ConversationEmptyState>
              ) : (
                <ContentColumn className={MESSAGE_GAP}>
                  {groupTurns(session.messages).map((turn) => (
                    <ChatTurn key={turn[0]?.id} messages={turn} context={turnContext} />
                  ))}
                  {working && isAwaitingFirstOutput(session.messages) ? (
                    <ReasoningLine verb="Working" meta={null} streaming />
                  ) : null}
                </ContentColumn>
              )}
            </ConversationContent>
            {/* A short fade over the transcript, keyed to the measured composer
              rather than a magic offset that breaks the moment the plan dock
              expands. The old full-height scrim repainted the card rung over
              itself and read as a grey wash.

              It lives inside the Conversation, ahead of the button, so paint
              order is structural: content, then fade, then button. As a later
              sibling of the whole Conversation it painted *over* the button
              and washed its lower half toward the background — which read as
              the button being clipped.

              Tall enough to contain that button, which floats 12px above the
              composer and stands 28px: at h-8 its top sat above the fade, on
              crisp text, and sliced it.

              The bottom 2rem is *solid*, not ramping. A plain linear fade only
              reaches full background on its very last pixel, so a line sitting
              10px above the composer was still ~84% opaque — a legible ghost,
              then hard-cut by the card. Anything within 2rem of the cut is now
              already background, and there is nothing left to slice. */}
            <div className="pointer-events-none absolute inset-x-0 bottom-[var(--composer-height)] h-16 bg-[linear-gradient(to_top,var(--background)_0,var(--background)_2rem,transparent_100%)]" />

            {/* Glass, not a plug. This button only exists while the reader is
              scrolled up, so there is always live text behind it; an opaque
              circle punches a hole in that text.

              An empty transcript never gets one. The empty state is taller than
              the plane once the composer's padding is added, so the scroller is
              legitimately not at its bottom and the button appeared over a
              conversation with nothing in it to jump to. */}
            {session.messages.length > 0 ? (
              <ConversationScrollButton className="bottom-[calc(var(--composer-height)+0.75rem)] bg-background/70 shadow-[var(--shadow-raised)] backdrop-blur-md dark:bg-background/70 dark:hover:bg-muted/70" />
            ) : null}
          </Conversation>
        </InteractionFocusProvider>
      </FileMentionProvider>

      {/* Opaque, because this is the composer's footprint and the transcript
          scrolls the full height of the plane behind it. The card itself has a
          background but the wrapper did not, so the pb-5 strip beneath it — and
          the margins either side — let content scroll through and surface below
          the textbox. The fade above hands off to this; between them the
          transcript ends where the composer begins. */}
      <div
        ref={composerHeight.ref}
        className="pointer-events-none absolute inset-x-0 bottom-0 bg-background pb-5"
      >
        <ContentColumn>
          {/* One bordered thing in the slot. While an interaction is pending the
              turn cannot proceed, so there is nothing to type and no plan
              progress to read here — the composer and the dock stand down, and
              the plan stays where it also lives, in the rail. Stacking the card
              under the dock would put two cards on one rung. */}
          {pending ? (
            <InteractionCard
              // Keyed so a second question opening behind the first mounts its
              // own draft rather than inheriting the answers to another one.
              key={pending.id}
              ref={interactionRef}
              interaction={pending}
              resolving={resolving}
              onResolve={(resolution) => answer(pending.id, resolution)}
              onStop={() => void session.interrupt()}
            />
          ) : (
            <>
              {blocker ? <SessionBlocker blocker={blocker} /> : null}
              {todos && todos.length > 0 && !todosEveryDone(todos) ? (
                <SessionTodoDock todos={todos} />
              ) : null}
              <SessionComposer
                value={input}
                onValueChange={setInput}
                textareaRef={textareaRef}
                models={session.catalog.models}
                agents={session.catalog.agents}
                selection={selection}
                onSelectionChange={session.setSelection}
                working={working}
                ready={composable}
                queued={queued}
                onQueuedChange={setQueued}
                onSubmit={send}
                onStop={() => void session.interrupt()}
              />
            </>
          )}
        </ContentColumn>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- blocked */

interface SessionBlockerAction {
  label: string;
  act(): void;
}

interface SessionBlockerState {
  message: string;
  /** The harness's own wording. It hovers; it is never the headline. */
  detail: string | null;
  tone: "error" | "waiting" | "unconfigured";
  /**
   * Null where nothing on this surface can fix it. A button that cannot help
   * is worse than no button: it spends the reader's one attempt at recovery
   * and then leaves them where they started, doubting the message too.
   */
  action: SessionBlockerAction | null;
}

/**
 * What actually stops you typing, and what to do about it — nothing else.
 *
 * A Session used to compute a running commentary on itself (attaching, ready,
 * receipt codes) that no surface displayed, while the one state worth saying
 * out loud reached the reader as an eight-pixel red dot on a tab and a message
 * stranded in a field. So progress is gone and failure has a home. It sits on
 * the composer rather than in the transcript because it is about whether you
 * can write, not about what happened in the conversation — and a failure that
 * scrolls away with the history is a failure nobody can act on.
 *
 * Three sources, in the order they answer:
 *
 * 1. `session.error` — this surface's own transport. If the stream is gone the
 *    attention we hold is a memory, so it does not get to speak over it.
 * 2. `attention.primary` — the harness stating a state to recover from.
 * 3. `catalogState` — nothing configured yet, which auth would otherwise be
 *    mistaken for, since an unauthenticated provider lists no models either.
 *
 * A pending interaction outranks all three: being asked a question is not a
 * failure and its card carries the answer. That precedence is *not* here —
 * this returns a value, and the call site (`const blocker = sessionBlocker(…)`
 * above the composer) is where the interaction card suppresses it, because
 * that is the one place holding both.
 */
function sessionBlocker(
  session: ReturnType<typeof useLabSessionController>,
  openSettings: () => void,
): SessionBlockerState | null {
  const retry: SessionBlockerAction = { label: "Retry", act: () => void session.recover() };
  const settings: SessionBlockerAction = { label: "Settings", act: openSettings };
  if (session.error !== null) {
    return { message: session.error, detail: null, tone: "error", action: retry };
  }
  const attention = session.attention.primary;
  if (attention) return attentionBlocker(attention, retry, settings);
  // Only a catalog that has actually answered can say a person configured
  // nothing; `loading` looks identical from here and is not a blocked state.
  if (session.catalogState === "empty") {
    return {
      message: "No models configured",
      detail: null,
      tone: "unconfigured",
      action: settings,
    };
  }
  return null;
}

/**
 * One line and at most one action per attention kind.
 *
 * The switch is total over the union and has no `default`: a kind added later
 * has to be answered here, not silently absorbed into whichever branch was
 * cheapest to reach. `noImplicitReturns` turns the omission into a build error.
 *
 * Which kinds earn a button, and why the rest do not:
 *
 * - **Settings** — `auth_required` and `configuration_invalid`. Both are facts
 *   about what is configured, and Settings is where that is changed.
 * - **Retry** — `transport_retrying`, `adapter_disconnected` and
 *   `rate_limited`. The first two are a connection to re-establish, which is
 *   exactly what `recover` does. A rate limit gets one because the wait is the
 *   whole fix; the provider's own time is shown when it sent one, and an absent
 *   one stays absent rather than becoming a guess.
 * - **Nothing** — `context_limit_reached` (compaction does not exist yet, so
 *   the only true answer is a new Session and the reader can already start
 *   one); `quota_exhausted` (a spent allowance is not retryable and no local
 *   setting refills it); `partial_turn_interrupted` (a stopped turn left the
 *   composer usable — resending is typing, not recovering);
 *   `adapter_unrecoverable` (the kind is named for having no recovery, and
 *   `recover` would reattach a stream that was never the problem);
 *   `input_required` and `permission_required` (the answer lives on the
 *   interaction card, which outranks this row entirely).
 *
 * `quota_exhausted`, `configuration_invalid`, `input_required` and
 * `permission_required` are not raised by the OpenCode adapter today — the
 * first two have no member of `session.error` stating them and the last two are
 * not adapter-raisable at all. They are answered anyway, because what this
 * reads is the union, not one adapter's current habits.
 */
function attentionBlocker(
  attention: SessionAttention,
  retry: SessionBlockerAction,
  settings: SessionBlockerAction,
): SessionBlockerState {
  const detail = attention.detail;
  switch (attention.kind) {
    case "auth_required":
      return { message: "Sign-in required", detail, tone: "error", action: settings };
    case "configuration_invalid":
      return { message: "Configuration invalid", detail, tone: "error", action: settings };
    case "transport_retrying":
      return { message: "Reconnecting", detail, tone: "waiting", action: retry };
    case "adapter_disconnected":
      return { message: "Disconnected", detail, tone: "error", action: retry };
    case "rate_limited":
      return {
        message: `Rate limited${untilClause(attention.retryAt)}`,
        detail,
        tone: "waiting",
        action: retry,
      };
    case "quota_exhausted":
      return {
        message: `Quota exhausted${untilClause(attention.resetAt)}`,
        detail,
        tone: "error",
        action: null,
      };
    case "context_limit_reached":
      return { message: "Context limit reached", detail, tone: "error", action: null };
    case "partial_turn_interrupted":
      return { message: "Turn interrupted", detail, tone: "waiting", action: null };
    case "adapter_unrecoverable":
      return { message: "Session stopped", detail, tone: "error", action: null };
    case "input_required":
      return { message: "Waiting for an answer", detail, tone: "waiting", action: null };
    case "permission_required":
      return { message: "Waiting for approval", detail, tone: "waiting", action: null };
  }
}

/** A time the provider stated, or nothing at all. An absent one is not invented. */
function untilClause(instant: number | null): string {
  if (instant === null || !Number.isFinite(instant)) return "";
  const at = new Date(instant).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return ` until ${at}`;
}

function SessionBlocker({ blocker }: { blocker: SessionBlockerState }) {
  return (
    <div
      className={cn(
        "mb-2 flex items-center gap-2 rounded-lg border bg-card px-3 py-1.5 text-xs shadow-[var(--shadow-raised)]",
        blocker.tone === "error" ? "border-destructive/40" : "border-border",
      )}
    >
      {/* A wait is not a failure. Only a transport error could reach this row
          before, so one triangle covered everything it said; a rate limit and a
          reconnect wearing it would read as broken when the state is "not yet". */}
      {blocker.tone === "error" ? (
        <WarningIcon aria-hidden className="size-3.5 shrink-0 text-destructive" weight="fill" />
      ) : null}
      {blocker.tone === "waiting" ? (
        <ClockIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" weight="fill" />
      ) : null}
      <span
        className="min-w-0 flex-1 truncate text-muted-foreground"
        title={blocker.detail === null ? blocker.message : `${blocker.message} — ${blocker.detail}`}
      >
        {blocker.message}
      </span>
      {blocker.action ? (
        <Button size="xs" variant="ghost" className="shrink-0" onClick={blocker.action.act}>
          {blocker.action.label}
        </Button>
      ) : null}
    </div>
  );
}

/** Live height of a node, so a layout can be keyed to it instead of a constant. */
function useMeasuredHeight<T extends HTMLElement>(): {
  ref: React.RefObject<T | null>;
  height: number;
} {
  const ref = React.useRef<T>(null);
  const [height, setHeight] = React.useState(0);

  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // Border box, not `contentRect`: the content box drops the observed
      // node's own padding. The composer carries pb-5, so this under-reported
      // by 20px — and every consumer of it (the transcript's bottom padding,
      // the fade, the jump-to-bottom button) sat 20px too low. The fade's
      // opaque end landed below the composer's hard top edge, which is why a
      // line got cut while still partly visible.
      setHeight(entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { ref, height };
}

/**
 * The gap between every top-level unit in a turn: prose to bundle, bundle to
 * prose, prose to prose. One constant, applied by the container, because the
 * old per-pair rule made the same boundary measure 8, 12 or 16px depending only
 * on which kinds happened to be adjacent. Rows *inside* a bundle have their own,
 * tighter rhythm — that is the only other spacing value in the transcript.
 */
const SEGMENT_GAP = "space-y-3";

/**
 * And the same value between messages, because OpenCode splits one reply into a
 * message per step. A wider gap here would put 24px between two tool bundles and
 * 12px between two others purely on where the harness chose to cut the stream —
 * a seam the reader cannot see and must not feel.
 */
const MESSAGE_GAP = "flex flex-col gap-3";

/**
 * One turn — however many messages the harness split it into.
 *
 * Segmenting per message put a bundle boundary at every step, which is what
 * stacked four `Ran 2 commands` headers where one belonged and left a step that
 * only thought as a bare reasoning row between them.
 */
interface TurnContext {
  working: boolean;
  onOpenFile(path: string): void;
}

function ChatTurn({ messages, context }: { messages: readonly UIMessage[]; context: TurnContext }) {
  const first = messages[0];
  if (!first) return null;
  const role = first.role;
  const segments = role === "assistant" ? segmentTurn(messages) : null;
  // A user message is prose only; the assistant path owns every other shape.
  const prose = messages.flatMap((message) =>
    message.parts.flatMap((part, index) =>
      part.type === "text" ? [{ key: `${message.id}:${index}`, text: part.text }] : [],
    ),
  );

  // Plan-only projections must not leave an empty bubble.
  if (segments && segments.length === 0) return null;

  return (
    <Message from={role} className="max-w-full">
      <MessageContent className="gap-0 group-[.is-user]:rounded-xl group-[.is-user]:bg-muted group-[.is-user]:px-3.5 group-[.is-user]:py-2.5">
        <div className={SEGMENT_GAP}>
          {segments
            ? segments.map((segment) => (
                <div key={segment.key}>{renderSegment(segment, role, context)}</div>
              ))
            : prose.map((entry) => <MessageResponse key={entry.key}>{entry.text}</MessageResponse>)}
        </div>
      </MessageContent>
    </Message>
  );
}

function renderSegment(
  segment: ChatSegment,
  role: UIMessage["role"],
  context: TurnContext,
): React.ReactNode {
  switch (segment.kind) {
    case "text":
      return (
        <MessageResponse isAnimating={context.working && role === "assistant"}>
          {segment.part.text}
        </MessageResponse>
      );
    case "bundle":
      return <ActivityBundle rows={segment.rows} onOpenFile={context.onOpenFile} />;
    default:
      return null;
  }
}

function todosEveryDone(todos: readonly SessionTodo[]): boolean {
  return todos.every((todo) => todo.status === "completed" || todo.status === "cancelled");
}

function nextId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `queued-${Date.now()}-${Math.random()}`;
}
