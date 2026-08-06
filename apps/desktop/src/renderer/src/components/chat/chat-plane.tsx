/**
 * One chat Session, drawn.
 *
 * The transcript, the composer, and the one row that says why you cannot type.
 * There is no header: the tab already names the Session and carries its liveness
 * dot, and a second band here would repeat it.
 *
 * Nothing about the Session lives in this component. The stream, the fold, the
 * queue and the lifecycle belong to the resident client (`chat/client.ts`) and
 * the store beside it, both of which outlive every mount — so a chat left for
 * the board keeps folding and releases its queued message whether or not this is
 * on screen. Nor does the half-typed message: it is part of the Session too, so
 * it lives in `stores/chat-drafts.ts` and survives both a tab switch and a
 * relaunch. What is local is what should be: the measured composer height, and
 * which cards have a decision in flight.
 */
import * as React from "react";
import { CodeIcon } from "@phosphor-icons/react/dist/csr/Code";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import type {
  RuntimeCatalogChoices,
  RuntimeSelection,
  SessionAttentionProjection,
  SessionInteraction,
} from "@volli/shared";
import { errorMessage } from "@volli/shared";
import type { DynamicToolUIPart, UIMessage } from "ai";

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@ai-elements/conversation";
import { FileMentionProvider } from "@ai-elements/chat-markdown";
import { Message, MessageContent } from "@ai-elements/message";
import { ReasoningLine } from "@ai-elements/reasoning";
import {
  approvalId,
  gatedApprovalIds,
  groupTurns,
  isAwaitingFirstOutput,
  projectSessionTodos,
  segmentTurn,
  type ChatSegment,
  type SessionTodo,
} from "@renderer/chat/activity";
import { DEFAULT_CHAT_EXECUTOR, EMPTY_CHAT_SELECTION, isDeliverable } from "@renderer/chat/client";
import {
  footInteraction,
  interactionForApproval,
  readInteractionResolutionMessage,
  type InteractionSubmission,
} from "@renderer/chat/interaction";
import {
  resolveRuntimeSelection,
  type ComposerIntent,
  type QueuedMessage,
} from "@renderer/chat/session-model";
import {
  useSessionController,
  type ChatSessionsStore,
} from "@renderer/chat/use-session-controller";
import { ActivityBundle, SessionTodoDock, ToolRow } from "@renderer/components/chat/activity-ui";
import {
  answerInteraction,
  holdList,
  messageRoute,
  resolvingWith,
  sameInteractionId,
  sameMessages,
  sameSelection,
  sameTodos,
  sessionBlocker,
  todosSettled,
  withdrawInteraction,
  type CatalogState,
  type SessionBlockerActs,
  type SessionBlockerState,
} from "@renderer/components/chat/chat-plane-model";
import { SessionComposer } from "@renderer/components/chat/composer-ui";
import { InteractionCard, InteractionReceiptLine } from "@renderer/components/chat/interaction-ui";
import { GuardedResponse } from "@renderer/components/chat/markdown-boundary";
import { ContentColumn } from "@renderer/components/layout/content-column";
import { Button } from "@renderer/components/ui/button";
import { useRuntimeCatalogClient } from "@renderer/lib/runtime-catalog-client";
import { cn } from "@renderer/lib/utils";
import { useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { useUiStore } from "@renderer/stores/ui";

/**
 * Which harness answers "what models can I pick". Not the Session's own
 * executor: a scripted lab profile attaches under an adapter of its own and has
 * no catalog, and the pick a person makes is about the provider behind it.
 */
const CATALOG_ADAPTER_ID = DEFAULT_CHAT_EXECUTOR.adapterId;

const NO_MESSAGES: readonly UIMessage[] = [];
const NO_INTERACTIONS: readonly SessionInteraction[] = [];
const NO_QUEUE: readonly QueuedMessage[] = [];
const EMPTY_CATALOG: RuntimeCatalogChoices = { providers: [], models: [], agents: [] };
const EMPTY_ATTENTION: SessionAttentionProjection = { active: [], primary: null };
const EMPTY_OPENED: ReadonlyMap<string, SessionInteraction> = new Map();
const EMPTY_RESOLVING: ReadonlySet<string> = new Set();

export interface ChatPlaneProps {
  sessionId: string;
  onOpenFile(path: string): void;
  /** The UI lab's own store, which owns its own transport. Omitted in the app. */
  store?: ChatSessionsStore;
}

export function ChatPlane({ sessionId, onOpenFile, store }: ChatPlaneProps) {
  const controller = useSessionController(sessionId, store);
  const { enqueue, dequeue, cancelInteraction, interrupt, recover, resolveInteraction, submit } =
    controller;
  const setSelection = controller.setSelection;
  const slice = controller.session;

  // The half-typed message is part of the Session, not this view: it has to
  // survive both a tab switch (this component unmounts) and a relaunch, so it
  // lives in the chat-drafts store rather than local state (see stores/chat-drafts.ts).
  const input = useChatDraftsStore((state) => state.drafts[sessionId]?.text ?? "");
  const setDraft = useChatDraftsStore((state) => state.setDraft);
  const clearSentDraft = useChatDraftsStore((state) => state.clearSentDraft);
  const onInputChange = React.useCallback(
    (text: string) => setDraft(sessionId, text),
    [sessionId, setDraft],
  );
  // Per interaction, not per surface: a harness can have several cards open at
  // once, and one boolean disables every other card's controls while one of
  // them is in flight.
  const [resolving, setResolving] = React.useState<ReadonlySet<string>>(EMPTY_RESOLVING);
  const [todos, setTodos] = React.useState<SessionTodo[] | null>(null);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);
  const composerHeight = useMeasuredHeight<HTMLDivElement>();
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  const messages = slice?.transcript.messages ?? NO_MESSAGES;
  const queue = slice?.queue ?? NO_QUEUE;
  const selection = slice?.selection ?? EMPTY_CHAT_SELECTION;
  const working = slice?.lifecycle === "working";
  const liveExecutorId = slice?.projection?.liveExecutor?.id ?? null;
  const deliverable = slice !== undefined && isDeliverable(slice);
  // A model is what you need to *write* a message; a live executor is what you
  // need to *deliver* one. Anything written before both hold joins the queue.
  const composable = selection.modelId.length > 0;

  const { catalog, catalogState, catalogError } = useRuntimeCatalog(
    liveExecutorId,
    selection,
    setSelection,
  );

  // The projection is replaced wholesale on every refresh, so its open
  // interactions arrive as new objects saying the same thing. An interaction is
  // written once, at `interaction.opened`, and leaves the list only when it is
  // resolved or cancelled — so the id is the whole of its identity here.
  const interactions = useStableList(
    slice?.projection?.interactions.active ?? NO_INTERACTIONS,
    sameInteractionId,
  );

  // Live todos from the plan activity. Held by value: the plan is re-projected
  // from scratch on every frame batch and is almost always the same plan, but a
  // fresh array of identical rows still fails React's bail-out.
  React.useEffect(() => {
    const projected = projectSessionTodos(messages);
    if (projected === null) return;
    const next = projected.length > 0 ? projected : null;
    setTodos((current) => (sameTodos(current, next) ? current : next));
  }, [messages]);

  /**
   * The one road out of this surface for anything a person typed.
   *
   * Resolves true when the words are safe — delivered, or held in the queue
   * because there was nowhere to send them yet. A redirection typed on a card
   * takes the same road, so it is never dropped while the executor is coming up.
   */
  const deliver = React.useCallback(
    async (text: string, intent: ComposerIntent): Promise<boolean> => {
      if (messageRoute(intent, deliverable) === "hold") {
        enqueue({ id: nextId(), text });
        return true;
      }
      return submit(text, intent === "steer" ? "steer" : "queue");
    },
    [deliverable, enqueue, submit],
  );

  const send = React.useCallback(
    (text: string, intent: ComposerIntent) => {
      // Capture the draft revision at submit. Text alone is not enough: if the
      // user clears and retypes the same words while delivery is in flight,
      // that is a new draft with a new `touchedAt` and must survive.
      const revision = useChatDraftsStore.getState().drafts[sessionId]?.touchedAt;
      void deliver(text, intent).then((kept) => {
        if (kept && revision !== undefined) clearSentDraft(sessionId, text, revision);
      });
    },
    [clearSentDraft, deliver, sessionId],
  );

  // The composer only ever takes messages OUT of the queue — editing one puts
  // its words back in the box, removing one drops it — so the whole of this is
  // which ids it stopped naming.
  const onQueuedChange = React.useCallback(
    (next: readonly QueuedMessage[]) => {
      const kept = new Set(next.map((entry) => entry.id));
      for (const entry of queue) if (!kept.has(entry.id)) dequeue(entry.id);
    },
    [dequeue, queue],
  );

  /**
   * Which decisions the transcript is already showing, and which one is left for
   * the foot.
   *
   * A gated call carries its own card on its own row, where the command and its
   * detail are. What has no row to stand on — a question, a permission the
   * harness raised without a call — lands in the composer's slot, oldest first:
   * two blocking cards stacked there are two things each claiming to be the one
   * thing to do next.
   *
   * Asked only while something is waiting to be asked. `gatedApprovalIds` walks
   * every part of every message and the list is replaced on every batch, so a
   * memo on it misses every time; what it answers is only read in a blocked
   * state, and a blocked Session is not streaming anything to compete with.
   */
  const pending =
    interactions.length > 0 ? footInteraction(interactions, gatedApprovalIds(messages)) : null;

  // The landing travels back to the card. A decision the harness never heard has
  // to say so where it was taken — the card is the only thing on screen at that
  // moment, and it is the thing that looks answerable until it is told.
  const answer = React.useCallback(
    (interactionId: string, submission: InteractionSubmission): Promise<boolean> =>
      answerInteraction(interactionId, submission, {
        resolve: resolveInteraction,
        // Sent, never steered: the redirection is the next thing said, not an
        // interruption of a turn that is already stopping to be told.
        deliver: (message) => void deliver(message, "send"),
        resolving: (id, active) => setResolving((current) => resolvingWith(current, id, active)),
      }),
    [deliver, resolveInteraction],
  );

  const withdraw = React.useCallback(
    (interactionId: string) => {
      void withdrawInteraction(interactionId, {
        interrupt,
        cancel: cancelInteraction,
        resolving: (id, active) => setResolving((current) => resolvingWith(current, id, active)),
      });
    },
    [cancelInteraction, interrupt],
  );

  /**
   * One object, and it has to keep its identity between ticks.
   *
   * Every turn on screen takes this, so a fresh literal per render is a fresh
   * prop for a thousand rows and defeats {@link ChatTurn}'s memo outright.
   *
   * `working` is deliberately not a member. It flips at the start and end of
   * every turn, and carrying it here changes this object twice a turn — which
   * makes `isAnimating` change under every settled turn and re-parses markdown
   * that has not moved in an hour. Only the live turn can animate, so only the
   * live turn is told about it.
   */
  const turnContext = React.useMemo<TurnContext>(
    () => ({
      onOpenFile,
      interactions: slice?.transcript.openedInteractions ?? EMPTY_OPENED,
      open: interactions,
      resolving,
      onResolve: answer,
    }),
    [answer, interactions, onOpenFile, resolving, slice?.transcript.openedInteractions],
  );

  // Grouping is O(messages), so it is memoized and then held per turn: a turn
  // nothing happened in keeps the array it had, which is what lets its rows
  // stand while the live tail repaints.
  const turns = useStableList(
    React.useMemo(() => groupTurns(messages), [messages]),
    sameMessages,
  );

  const blockerActs = React.useMemo<SessionBlockerActs>(
    () => ({
      recover: () => void recover(),
      openSettings: () => setSettingsOpen(true),
    }),
    [recover, setSettingsOpen],
  );
  const blocker = sessionBlocker(
    {
      sessionError: slice?.sessionError ?? null,
      attention: slice?.projection?.attention ?? EMPTY_ATTENTION,
      catalogState,
      catalogError,
    },
    blockerActs,
    interactions.length > 0,
  );

  const planeStyle = { "--composer-height": `${composerHeight.height}px` } as React.CSSProperties;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" style={planeStyle}>
      <FileMentionProvider onOpenFile={onOpenFile}>
        <Conversation className="min-h-0 bg-background">
          {/* The bottom padding clears the composer plus the h-16 gradient over
              it, with enough left that the last line lands on clean background
              rather than inside the fade. */}
          <ConversationContent className="gap-6 px-0 pt-8 pb-[calc(var(--composer-height)+12rem)]">
            {messages.length === 0 ? (
              // A mark, and nothing else. What blocks typing sits on the
              // composer, where the typing is.
              <ConversationEmptyState className="min-h-80">
                <div className="flex size-10 items-center justify-center rounded-xl border border-border bg-card shadow-[var(--shadow-raised)]">
                  <CodeIcon className="size-5 text-muted-foreground" />
                </div>
              </ConversationEmptyState>
            ) : (
              <ContentColumn className={MESSAGE_GAP}>
                {turns.map((turn, index) => (
                  <ChatTurn
                    key={turn[0]?.id}
                    messages={turn}
                    context={turnContext}
                    live={working && index === turns.length - 1}
                  />
                ))}
                {working && isAwaitingFirstOutput(messages) ? (
                  <ReasoningLine verb="Working" meta={null} streaming />
                ) : null}
              </ContentColumn>
            )}
          </ConversationContent>
          {/* A short fade keyed to the measured composer. It lives inside the
              Conversation, ahead of the button, so paint order is structural:
              content, then fade, then button. Its bottom 2rem is solid, not
              ramping — a plain linear fade only reaches full background on its
              last pixel, which left a legible ghost hard-cut by the card. */}
          <div className="pointer-events-none absolute inset-x-0 bottom-[var(--composer-height)] h-16 bg-[linear-gradient(to_top,var(--background)_0,var(--background)_2rem,transparent_100%)]" />

          {/* Glass, not a plug: this button only exists while the reader is
              scrolled up, so there is always live text behind it. An empty
              transcript never gets one — the empty state is taller than the
              plane, so the scroller is legitimately not at its bottom. */}
          {messages.length > 0 ? (
            <ConversationScrollButton className="bottom-[calc(var(--composer-height)+0.75rem)] bg-background/70 shadow-[var(--shadow-raised)] backdrop-blur-md dark:bg-background/70 dark:hover:bg-muted/70" />
          ) : null}
        </Conversation>
      </FileMentionProvider>

      {/* Opaque, because the transcript scrolls the full height of the plane
          behind it. The fade above hands off to this; between them the
          transcript ends where the composer begins. */}
      <div
        ref={composerHeight.ref}
        className="pointer-events-none absolute inset-x-0 bottom-0 bg-background pb-5"
      >
        <ContentColumn>
          {/* Above whatever the slot holds, card included. A card answers the
              question it was asked; it does not answer a failure — and the
              failure most worth seeing here is the decision that never reached
              the harness, which leaves the card looking answerable. */}
          {blocker ? <SessionBlocker blocker={blocker} /> : null}
          {/* One bordered thing in the slot, and only for an interaction no row
              can hold. While one stands here the turn cannot proceed, so the
              composer and the dock stand down; the plan stays in the rail. A
              card on a *row* displaces none of this. */}
          {pending ? (
            <InteractionCard
              // Keyed so a second question opening behind the first mounts its
              // own draft rather than inheriting another one's answers.
              key={pending.id}
              interaction={pending}
              resolving={resolving.has(pending.id)}
              autoFocus
              className="mb-2"
              onResolve={(submission) => answer(pending.id, submission)}
              // Stop ends the turn; the question outlives it. Cancelling is what
              // gives the composer back.
              onStop={() => withdraw(pending.id)}
            />
          ) : (
            <>
              {todos && todos.length > 0 && !todosSettled(todos) ? (
                <SessionTodoDock todos={todos} />
              ) : null}
              <SessionComposer
                value={input}
                onValueChange={onInputChange}
                textareaRef={textareaRef}
                models={catalog.models}
                agents={catalog.agents}
                selection={selection}
                onSelectionChange={setSelection}
                working={working}
                ready={composable}
                queued={queue}
                onQueuedChange={onQueuedChange}
                onSubmit={send}
                onStop={() => void interrupt()}
              />
            </>
          )}
        </ContentColumn>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- catalog */

/**
 * Which models a person can pick, and the one they have.
 *
 * Only a running harness can answer the first, so the ask is repeated when an
 * executor appears: opening a Session starts one, and the first ask races that
 * attach and loses — an empty answer arriving as the confident claim that
 * nothing is configured. It is repeated again when a runtime preference is
 * saved, which is the other way the answer legitimately changes.
 *
 * The selection lives in the Session's slice, not here: it is a choice about
 * this Session and it has to outlive the view. The current one is read through
 * a ref so re-resolving does not depend on the value it is about to write.
 */
function useRuntimeCatalog(
  liveExecutorId: string | null,
  selection: RuntimeSelection,
  setSelection: (next: RuntimeSelection) => void,
): { catalog: RuntimeCatalogChoices; catalogState: CatalogState; catalogError: string | null } {
  const runtimeCatalog = useRuntimeCatalogClient();
  const [catalog, setCatalog] = React.useState<RuntimeCatalogChoices>(EMPTY_CATALOG);
  const [catalogState, setCatalogState] = React.useState<CatalogState>("loading");
  const [catalogError, setCatalogError] = React.useState<string | null>(null);
  const held = React.useRef(selection);
  held.current = selection;

  const preferenceRevision = runtimeCatalog?.preferenceRevision ?? 0;
  const resolve = runtimeCatalog?.resolve;

  React.useEffect(() => {
    if (resolve === undefined) return;
    let active = true;
    void resolve({ adapterId: CATALOG_ADAPTER_ID })
      .then((resolved) => {
        if (!active) return;
        setCatalog(resolved.catalog);
        setCatalogError(null);
        setCatalogState(resolved.catalog.models.length > 0 ? "ready" : "empty");
        const next = resolveRuntimeSelection(
          resolved.catalog,
          held.current.modelId ? held.current : resolved.selection,
        );
        if (!sameSelection(next, held.current)) setSelection(next);
      })
      .catch((unresolved: unknown) => {
        if (!active) return;
        // The last known catalog stays on screen. A refresh that fails is not
        // evidence that the models a person already picked have gone away, and
        // blanking the picker would take away the one control still usable.
        setCatalogState("error");
        setCatalogError(errorMessage(unresolved));
      });
    return () => {
      active = false;
    };
  }, [liveExecutorId, preferenceRevision, resolve, setSelection]);

  return { catalog, catalogState, catalogError };
}

/* ---------------------------------------------------------------- blocked */

function SessionBlocker({ blocker }: { blocker: SessionBlockerState }) {
  return (
    <div
      className={cn(
        "mb-2 flex items-center gap-2 rounded-lg border bg-card px-3 py-1.5 text-xs shadow-[var(--shadow-raised)]",
        blocker.tone === "error" ? "border-destructive/40" : "border-border",
      )}
    >
      {/* A wait is not a failure: a rate limit or a reconnect wearing the
          triangle would read as broken when the state is "not yet". */}
      {blocker.tone === "error" ? (
        <WarningIcon aria-hidden className="size-3.5 shrink-0 text-destructive" weight="fill" />
      ) : null}
      {blocker.tone === "waiting" ? (
        <ClockIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" weight="fill" />
      ) : null}
      <div className="min-w-0 flex-1">
        {/* Both lines are clipped by CSS, so both keep the hover that is the
            only way to read the rest of one. A headline is not automatically
            short: `sessionError` is a transport failure's own words. */}
        <p className="truncate text-muted-foreground" title={blocker.message}>
          {blocker.message}
        </p>
        {/* The cause, under the headline it qualifies. "Session stopped" alone
            names the state and not one thing about why, and the harness's own
            wording is the only place the reason is ever written down — so it is
            read on sight, not hidden behind a hover a pointer has to find.
            Empty counts as absent: an error carrying no text would otherwise
            draw a blank line under the headline. */}
        {blocker.detail ? (
          <p className="truncate text-muted-foreground/70" title={blocker.detail}>
            {blocker.detail}
          </p>
        ) : null}
      </div>
      {blocker.action ? (
        <Button size="xs" variant="ghost" className="shrink-0" onClick={blocker.action.act}>
          {blocker.action.label}
        </Button>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- the turn */

/**
 * The gap between every top-level unit in a turn: prose to bundle, bundle to
 * prose, prose to prose. One constant, applied by the container, because a
 * per-pair rule makes the same boundary measure 8, 12 or 16px depending only on
 * which kinds happen to be adjacent. Rows *inside* a bundle have their own,
 * tighter rhythm — that is the only other spacing value in the transcript.
 */
const SEGMENT_GAP = "space-y-3";

/**
 * And the same value between messages, because a harness splits one reply into a
 * message per step. A wider gap here would put 24px between two tool bundles and
 * 12px between two others purely on where the stream was cut — a seam the reader
 * cannot see and must not feel.
 */
const MESSAGE_GAP = "flex flex-col gap-3";

export interface TurnContext {
  onOpenFile(path: string): void;
  /** Every interaction opened this Session, for the receipts they left behind. */
  interactions: ReadonlyMap<string, SessionInteraction>;
  /** The ones still open, so a gated row can draw the card it is waiting on. */
  open: readonly SessionInteraction[];
  /** The ids with a decision in flight — one card in flight is not all of them. */
  resolving: ReadonlySet<string>;
  onResolve(interactionId: string, submission: InteractionSubmission): Promise<boolean>;
}

/**
 * One turn — however many messages the harness split it into. Segmenting per
 * message would put a bundle boundary at every step, stacking four `Ran 2
 * commands` headers where one belongs.
 *
 * Memoized on identity, which is exact rather than approximate here: a turn
 * holding the same messages and the same context has nothing new to draw. The
 * row presenters parse diffs, grep output and file contents on each render, so
 * without this a single streamed token is the whole frame budget.
 */
export const ChatTurn = React.memo(function ChatTurn({
  messages,
  context,
  live,
}: {
  messages: readonly UIMessage[];
  context: TurnContext;
  /** This turn is the one the harness is still writing into. Only it animates. */
  live: boolean;
}) {
  const first = messages[0] ?? null;
  const role = first?.role ?? null;

  // A receipt lands where it happened. Answering an interaction commits a
  // durable message at that point in the conversation, so the transcript draws
  // it there — whether or not a tool row was ever correlated to the question. An
  // interaction the log has no record of opening draws nothing rather than an id.
  const answered = React.useMemo(
    () => (first !== null && role === "user" ? readInteractionResolutionMessage(first) : null),
    [first, role],
  );
  const segments = React.useMemo(
    () => (role === "assistant" ? segmentTurn(messages) : null),
    [messages, role],
  );
  // A user message is prose only; the assistant path owns every other shape.
  const prose = React.useMemo<readonly { key: string; text: string }[]>(
    () =>
      role === "assistant"
        ? []
        : messages.flatMap((message) =>
            message.parts.flatMap((part, index) =>
              part.type === "text" ? [{ key: `${message.id}:${index}`, text: part.text }] : [],
            ),
          ),
    [messages, role],
  );

  if (first === null || role === null) return null;

  if (answered) {
    const interaction = context.interactions.get(answered.interactionId);
    return interaction ? (
      <InteractionReceiptLine interaction={interaction} resolution={answered.resolution} />
    ) : null;
  }

  // Plan-only projections must not leave an empty bubble.
  if (segments && segments.length === 0) return null;

  return (
    <Message from={role} className="max-w-full">
      <MessageContent className="gap-0 group-[.is-user]:rounded-xl group-[.is-user]:bg-muted group-[.is-user]:px-3.5 group-[.is-user]:py-2.5">
        <div className={SEGMENT_GAP}>
          {segments
            ? segments.map((segment) => (
                <div key={segment.key}>{renderSegment(segment, role, context, live)}</div>
              ))
            : prose.map((entry) => <GuardedResponse key={entry.key}>{entry.text}</GuardedResponse>)}
        </div>
      </MessageContent>
    </Message>
  );
});

function renderSegment(
  segment: ChatSegment,
  role: UIMessage["role"],
  context: TurnContext,
  live: boolean,
): React.ReactNode {
  switch (segment.kind) {
    case "text":
      return (
        <GuardedResponse isAnimating={live && role === "assistant"}>
          {segment.part.text}
        </GuardedResponse>
      );
    case "bundle":
      return <ActivityBundle rows={segment.rows} onOpenFile={context.onOpenFile} />;
    case "attention":
      return <GatedCall part={segment.part} context={context} />;
    default:
      return null;
  }
}

/**
 * A call and the decision it is waiting on, in the one place both belong.
 *
 * The row is the ordinary row — same glyph, same verb, same mono object, same
 * disclosure onto the input it is about to run — so the command and its detail
 * stay readable while the question sits under them. The card is the real
 * interaction, not a summary of it.
 *
 * No card when nothing correlates: a gate we cannot pair with a question must
 * not invent one, and `footInteraction` draws it at the foot instead.
 */
function GatedCall({ part, context }: { part: DynamicToolUIPart; context: TurnContext }) {
  const interaction = interactionForApproval(context.open, approvalId(part));
  return (
    <div className="space-y-0.5">
      <ToolRow part={part} onOpenFile={context.onOpenFile} />
      {interaction ? (
        <InteractionCard
          key={interaction.id}
          interaction={interaction}
          resolving={context.resolving.has(interaction.id)}
          onResolve={(submission) => context.onResolve(interaction.id, submission)}
        />
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- measured */

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
      // Border box, not `contentRect`: the content box drops the observed node's
      // own padding, and every consumer of this height would sit that far too
      // low — including the fade, whose opaque end would land below the
      // composer's hard top edge and slice a partly-visible line.
      setHeight(entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { ref, height };
}

/**
 * The previous list, with everything unchanged put back — see {@link holdList}.
 *
 * Written during render on purpose, and safe: `same` is content equality, so the
 * value kept by a render React later discards is never a different answer to the
 * one the retained render would have given.
 */
function useStableList<T>(
  items: readonly T[],
  same: (previous: T, next: T) => boolean,
): readonly T[] {
  const held = React.useRef<readonly T[]>(items);
  if (held.current !== items) held.current = holdList(held.current, items, same);
  return held.current;
}

function nextId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `queued-${Date.now()}-${Math.random()}`;
}
