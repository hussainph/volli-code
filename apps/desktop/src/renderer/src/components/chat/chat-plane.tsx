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
  ModelAccessModel,
  ModelAccessProvider,
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
} from "@renderer/components/ui/ai-elements/conversation";
import { FileMentionProvider } from "@renderer/components/ui/ai-elements/chat-markdown";
import { Message, MessageContent } from "@renderer/components/ui/ai-elements/message";
import { ReasoningLine } from "@renderer/components/ui/ai-elements/reasoning";
import {
  gatedToolCallId,
  gatedToolCallIds,
  groupTurns,
  isAwaitingFirstOutput,
  segmentTurn,
  type ChatSegment,
} from "@renderer/chat/activity";
import { isDeliverable, type MessageDelivery } from "@renderer/chat/client";
import {
  footInteraction,
  interactionForApproval,
  readInteractionResolutionMessage,
  type InteractionSubmission,
} from "@renderer/chat/interaction";
import { type ComposerIntent, type QueuedMessage } from "@renderer/chat/session-model";
import {
  useSessionController,
  type ChatSessionsStore,
} from "@renderer/chat/use-session-controller";
import { ActivityBundle, ToolRow } from "@renderer/components/chat/activity-ui";
import {
  answerInteraction,
  composerModelSelection,
  coordinateQueuedMutation,
  coordinateQueuedSteerStart,
  dispatchHeldMessage,
  hasReconciledSessionSnapshot,
  heldStrip,
  holdList,
  messageRoute,
  resolvingWith,
  sameInteractionId,
  sameMessages,
  sameQueuedMessage,
  sessionBlocker,
  sessionModelStanding,
  steerRollbackState,
  steerQueuedMessage,
  settledHeldIds,
  withdrawInteraction,
  type CatalogState,
  type SessionBlockerActs,
  type SessionBlockerState,
} from "@renderer/components/chat/chat-plane-model";
import {
  SessionComposer,
  type ComposerModel,
  type ComposerModelSelection,
} from "@renderer/components/chat/composer-ui";
import {
  ComposerInteractionStack,
  InteractionCard,
  InteractionReceiptLine,
} from "@renderer/components/chat/interaction-ui";
import { GuardedResponse } from "@renderer/components/chat/markdown-boundary";
import { ContentColumn } from "@renderer/components/layout/content-column";
import { Button } from "@renderer/components/ui/button";
import { EMPTY_PAGE } from "@renderer/components/ui/empty-classes";
import { useFileIndex } from "@renderer/hooks/use-file-index";
import { useMeasuredHeight } from "@renderer/hooks/use-measured-height";
import { usePromptTemplates } from "@renderer/hooks/use-prompt-templates";
import { flushPendingAppStateKey } from "@renderer/lib/app-state-storage";
import { useModelAccessClient } from "@renderer/lib/model-access-client";
import { cn } from "@renderer/lib/utils";
import {
  CHAT_DRAFTS_APP_STATE_KEY,
  useChatDraftsStore,
  type HeldMessage,
} from "@renderer/stores/chat-drafts";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useUiStore } from "@renderer/stores/ui";

const NO_INTERACTIONS: readonly SessionInteraction[] = [];
const NO_QUEUE: readonly QueuedMessage[] = [];
const NO_HELD: readonly HeldMessage[] = [];
const NO_MODELS: readonly ModelAccessModel[] = [];
const EMPTY_MODEL_SELECTION: ComposerModelSelection = {
  providerId: "",
  modelId: "",
  reasoningLevel: "",
};
const EMPTY_ATTENTION: SessionAttentionProjection = { active: [], primary: null };
const EMPTY_RESOLVING: ReadonlySet<string> = new Set();

export interface ChatPlaneProps {
  sessionId: string;
  /** Project scope for Model Access and file navigation. */
  projectId: string;
  onOpenFile(path: string): void;
  /** The UI lab's own store, which owns its own transport. Omitted in the app. */
  store?: ChatSessionsStore;
}

export function ChatPlane({ sessionId, projectId, onOpenFile, store }: ChatPlaneProps) {
  const controller = useSessionController(sessionId, store);
  const sessionsStore = store ?? useChatSessionsStore;
  const {
    claimQueued,
    dequeueClaimed,
    enqueue,
    cancelInteraction,
    interrupt,
    recover,
    retryRuntime,
    releaseQueuedClaim,
    resolveInteraction,
    selectModel,
    submit,
  } = controller;
  const session = controller.session;

  // The half-typed message is part of the Session, not this view: it has to
  // survive both a tab switch (this component unmounts) and a relaunch, so it
  // lives in the chat-drafts store rather than local state (see stores/chat-drafts.ts).
  const input = useChatDraftsStore((state) => state.drafts[sessionId]?.text ?? "");
  const held = useChatDraftsStore((state) => state.drafts[sessionId]?.held ?? NO_HELD);
  const setDraft = useChatDraftsStore((state) => state.setDraft);
  const holdMessage = useChatDraftsStore((state) => state.holdMessage);
  const beginQueuedSteer = useChatDraftsStore((state) => state.beginQueuedSteer);
  const markHeld = useChatDraftsStore((state) => state.markHeld);
  const dropHeld = useChatDraftsStore((state) => state.dropHeld);
  const onInputChange = React.useCallback(
    (text: string) => setDraft(sessionId, text),
    [sessionId, setDraft],
  );
  // Per interaction, not per surface: a harness can have several cards open at
  // once, and one boolean disables every other card's controls while one of
  // them is in flight.
  const [resolving, setResolving] = React.useState<ReadonlySet<string>>(EMPTY_RESOLVING);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);
  const composerHeight = useMeasuredHeight<HTMLDivElement>();
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const steeringQueued = React.useRef(new Set<string>());
  // Two one-line callbacks that were inline literals, and inline is what they
  // could not be: they are props of a memoized composer, so a fresh closure per
  // render re-renders the whole box once per streamed frame.
  const focusComposer = React.useCallback(() => textareaRef.current?.focus(), []);

  const { messages, queue, working, deliverable, projection } = session;
  const modelSelection = projection?.modelSelection ?? null;
  const selection: ComposerModelSelection = modelSelection ?? EMPTY_MODEL_SELECTION;
  const liveExecutorId = projection?.liveExecutor?.id ?? null;
  const { models, providers, catalogState, catalogError } = useModelAccess(projection !== null);
  // A durable model is not enough to type: the row that says this Session is
  // pinned to something nobody can run waits on the catalog, and until the
  // catalog answers there is nothing to say it with. A box that takes a message
  // in that window spends it before the warning it was owed — which is the one
  // thing knowing the model early was for.
  const composable = modelSelection !== null && catalogState !== "loading";
  // Signed-in models only. Pi's catalog is every provider it knows — around a
  // thousand models against the handful this profile has credentials for — and
  // a picker that lists the rest is a picker whose first "GPT-5.6 Luna" is
  // whichever provider sorted first. What you cannot send to is not an option.
  const composerModels = React.useMemo(
    () =>
      models
        .filter((model) => model.state === "available")
        .map((model) => composerModel(model, providers)),
    [models, providers],
  );
  const sessionModel = React.useMemo(
    () => sessionModelStanding(modelSelection, models, providers),
    [modelSelection, models, providers],
  );
  const changeModel = React.useCallback(
    (next: ComposerModelSelection) => {
      const nextSelection = composerModelSelection(next);
      if (nextSelection !== null) void selectModel(nextSelection);
    },
    [selectModel],
  );

  // The projection is replaced wholesale on every refresh, so its open
  // interactions arrive as new objects saying the same thing. An interaction is
  // written once, at `interaction.opened`, and leaves the list only when it is
  // resolved or cancelled — so the id is the whole of its identity here.
  const interactions = useStableList(
    projection?.interactions.active ?? NO_INTERACTIONS,
    sameInteractionId,
  );

  /**
   * The one road out of this surface for anything a person typed.
   *
   * Says what became of the words, which is not the same question as whether
   * they arrived: `held` means the Session's queue has them and nothing durable
   * does. A redirection typed on a card takes the same road, so it is never
   * dropped while the executor is coming up.
   */
  const deliver = React.useCallback(
    async (message: QueuedMessage, intent: ComposerIntent): Promise<MessageDelivery | "held"> => {
      if (messageRoute(intent, deliverable) === "hold") {
        enqueue(message);
        return "held";
      }
      return submit(message, intent === "steer" ? "steer" : "queue");
    },
    [deliverable, enqueue, submit],
  );

  /**
   * The box empties on dispatch — but it is never the last thing holding the
   * message.
   *
   * Pi answers a `message.submit` when the whole TURN has ended — the runtime
   * awaits `agent.prompt` — so "clear once it lands" means the words you sent
   * sit in the composer for the length of the reply, then vanish. Sending is
   * the moment the message stopped being a draft. What it is not is the moment
   * anything accepted it: until then the only copy would be a closure variable
   * in a pending `.then`, and a reload — HMR, ⌘R, a renderer crash — would take
   * it with no trace. So the words move from the box to the persisted held list
   * in one write, and leave it only for something that outlives this window: a
   * delivered turn, or a ledger that already records the intent.
   */
  const send = React.useCallback(
    (text: string, intent: ComposerIntent) => {
      const message = { id: nextId(), text };
      holdMessage(sessionId, message);
      void dispatchHeldMessage({
        persist: () => flushPendingAppStateKey(CHAT_DRAFTS_APP_STATE_KEY),
        deliver: () => deliver(message, intent),
        finish: async (outcome) => {
          if (outcome === "held") markHeld(sessionId, message.id, "queued");
          // `recorded` is the message the runtime committed before the executor
          // refused it: it is in the ledger and on screen in the transcript, so
          // handing it back would be inviting a second copy of it. The blocker
          // row owns that recovery.
          else if (outcome === "refused") markHeld(sessionId, message.id, "unsent");
          else dropHeld(sessionId, message.id);
          await flushPendingAppStateKey(CHAT_DRAFTS_APP_STATE_KEY);
        },
      });
    },
    [deliver, dropHeld, holdMessage, markHeld, sessionId],
  );

  // What the Session is holding for you, from the two records that say it — see
  // `heldStrip`. One row per message, whichever of them names it.
  const durableMessageIds = React.useMemo(
    () => new Set(messages.map((message) => message.id)),
    [messages],
  );
  // Held to its identity, and that is what keeps the composer out of the
  // stream's frame budget. `durableMessageIds` is a fresh Set on every flush of
  // a live turn, so this memo re-runs once per frame and `heldStrip` mints a
  // fresh row object for every held message — a new array, saying exactly what
  // the old one said, straight into `SessionComposer`'s memo. Rows compare by
  // content, so an unchanged strip stays the array it was.
  const strip = useStableList(
    React.useMemo(
      () => heldStrip(held, queue, durableMessageIds, hasReconciledSessionSnapshot(projection)),
      [durableMessageIds, held, projection, queue],
    ),
    sameQueuedMessage,
  );

  // The composer only ever takes messages OUT of the strip — editing one puts
  // its words back in the box, removing one drops it — so the whole of this is
  // which ids it stopped naming. Both records are told; neither minds an id it
  // never had.
  const onQueuedChange = React.useCallback(
    (next: readonly QueuedMessage[]) => {
      const kept = new Set(next.map((entry) => entry.id));
      const removed = strip.filter((entry) => !kept.has(entry.id));
      if (removed.length === 0) return true;
      if (removed.length !== 1) return false;
      const entry = removed[0]!;
      const current = sessionsStore.getState().sessions[sessionId];
      const queueBacked = current?.queue.some((queued) => queued.id === entry.id) ?? false;
      return coordinateQueuedMutation({
        queueBacked,
        claim: () => claimQueued(entry.id),
        consumeClaim: () => dequeueClaimed(entry.id),
        releaseClaim: () => releaseQueuedClaim(entry.id),
        dropHeld: () => dropHeld(sessionId, entry.id),
      });
    },
    [claimQueued, dequeueClaimed, dropHeld, releaseQueuedClaim, sessionId, sessionsStore, strip],
  );

  const onSteerQueued = React.useCallback(
    (id: string) => {
      void steerQueuedMessage(id, steeringQueued.current, {
        read: () => {
          const current = sessionsStore.getState().sessions[sessionId];
          return {
            held: useChatDraftsStore.getState().drafts[sessionId]?.held ?? NO_HELD,
            queue: current?.queue ?? NO_QUEUE,
            steerable: current?.lifecycle === "working" && isDeliverable(current),
          };
        },
        start: async (visible, targetId) => {
          const before = sessionsStore.getState().sessions[sessionId];
          const targetedTurnEpoch = before?.transcript.turnEpoch;
          const queueBacked = before?.queue.some((entry) => entry.id === targetId) ?? false;
          const heldBefore = useChatDraftsStore
            .getState()
            .drafts[sessionId]?.held.find((entry) => entry.id === targetId);
          const restoreState = steerRollbackState(queueBacked, heldBefore?.state);
          return coordinateQueuedSteerStart(targetedTurnEpoch, {
            queueBacked,
            claim: () => claimQueued(targetId),
            persist: async () => {
              // The claim freezes the entire ordered resident queue. Its
              // selected row and visible neighbors become durable first.
              beginQueuedSteer(sessionId, visible, targetId);
              return flushPendingAppStateKey(CHAT_DRAFTS_APP_STATE_KEY);
            },
            current: () => {
              const current = sessionsStore.getState().sessions[sessionId];
              return current === undefined
                ? undefined
                : {
                    turnEpoch: current.transcript.turnEpoch,
                    working: current.lifecycle === "working",
                    deliverable: isDeliverable(current),
                  };
            },
            consumeClaim: () => dequeueClaimed(targetId),
            restore: async () => {
              markHeld(sessionId, targetId, restoreState);
              await flushPendingAppStateKey(CHAT_DRAFTS_APP_STATE_KEY);
            },
            releaseClaim: () => releaseQueuedClaim(targetId),
          });
        },
        submit: (message, delivery) => submit(message, delivery),
        finish: async (messageId, outcome) => {
          if (outcome === "refused") markHeld(sessionId, messageId, "unsent");
          else dropHeld(sessionId, messageId);
          await flushPendingAppStateKey(CHAT_DRAFTS_APP_STATE_KEY);
        },
      });
    },
    [
      beginQueuedSteer,
      claimQueued,
      dequeueClaimed,
      dropHeld,
      markHeld,
      releaseQueuedClaim,
      sessionId,
      sessionsStore,
      submit,
    ],
  );

  // The release queue is renderer memory and the held copy is what outlives it,
  // so the copy is retired by the queue letting go: a released message is one
  // the runtime now owns. Nothing else can say it — the drain runs in the
  // resident client, which has no view and no drafts.
  React.useEffect(() => {
    for (const id of settledHeldIds(held, queue, durableMessageIds)) dropHeld(sessionId, id);
  }, [dropHeld, durableMessageIds, held, queue, sessionId]);

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
   * Asked only while something is waiting to be asked. `gatedToolCallIds` walks
   * every part of every message and the list is replaced on every batch, so a
   * memo on it misses every time; what it answers is only read in a blocked
   * state, and a blocked Session is not streaming anything to compete with.
   */
  const pending =
    interactions.length > 0 ? footInteraction(interactions, gatedToolCallIds(messages)) : null;

  // What the composer's two caret-driven pickers rank over. Both are
  // project-scoped: the file index is the one the editor's `@` already uses,
  // and the templates are `.volli/commands/` over the global tier.
  const fileIndex = useFileIndex(projectId);
  const files = fileIndex.getIndex();
  const promptTemplates = usePromptTemplates(projectId);

  // The landing travels back to the card. A decision the harness never heard has
  // to say so where it was taken — the card is the only thing on screen at that
  // moment, and it is the thing that looks answerable until it is told.
  const answer = React.useCallback(
    (interactionId: string, submission: InteractionSubmission): Promise<boolean> =>
      answerInteraction(interactionId, submission, {
        resolve: resolveInteraction,
        // Sent, never steered: the redirection is the next thing said, not an
        // interruption of a turn that is already stopping to be told.
        deliver: (message) => send(message, "send"),
        resolving: (id, active) => setResolving((current) => resolvingWith(current, id, active)),
      }),
    [resolveInteraction, send],
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
      interactions: session.openedInteractions,
      open: interactions,
      resolving,
      onResolve: answer,
    }),
    [answer, interactions, onOpenFile, resolving, session.openedInteractions],
  );

  // Grouping is O(messages), so it is memoized and then held per turn: a turn
  // nothing happened in keeps the array it had, which is what lets its rows
  // stand while the live tail repaints.
  const turns = useStableList(
    React.useMemo(() => groupTurns(messages), [messages]),
    sameMessages,
  );

  const stopTurn = React.useCallback(() => void interrupt(), [interrupt]);

  const blockerActs = React.useMemo<SessionBlockerActs>(
    () => ({
      recover: () => void recover(),
      // A failed initial Pi attach has no live binding to continue; Retry is a
      // fresh attach there. Once Pi is live, it is the exact failed run.
      retryRuntime: () => void (liveExecutorId === null ? recover() : retryRuntime()),
      // Straight to the category Model Access lives in. The blocker names a
      // provider that needs signing in, and landing on General would make the
      // user go find it — a short trip, but one this row already knows the
      // answer to.
      openSettings: () => setSettingsOpen(true, "agent"),
    }),
    [liveExecutorId, recover, retryRuntime, setSettingsOpen],
  );
  const blocker = sessionBlocker(
    {
      sessionError: session.sessionError,
      attention: projection?.attention ?? EMPTY_ATTENTION,
      catalogState,
      catalogError,
      sessionModel,
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
          <ConversationContent className="gap-4 px-0 pt-5 pb-[calc(var(--composer-height)+12rem)]">
            {messages.length === 0 ? (
              // A mark, and nothing else. What blocks typing sits on the
              // composer, where the typing is.
              <ConversationEmptyState className={cn(EMPTY_PAGE, "min-h-80")}>
                <div className="flex size-10 items-center justify-center rounded-xl border border-border bg-card shadow-raised">
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
            <ConversationScrollButton className="bottom-[calc(var(--composer-height)+0.75rem)] bg-background/70 shadow-raised backdrop-blur-md dark:hover:bg-muted/70" />
          ) : null}
        </Conversation>
      </FileMentionProvider>

      {/* Opaque, because the transcript scrolls the full height of the plane
          behind it. The fade above hands off to this; between them the
          transcript ends where the composer begins. */}
      <div
        ref={composerHeight.ref}
        className="pointer-events-none absolute inset-x-0 bottom-0 bg-background pb-4"
      >
        <ContentColumn>
          {/* Above whatever the slot holds, card included. A card answers the
              question it was asked; it does not answer a failure — and the
              failure most worth seeing here is the decision that never reached
              the harness, which leaves the card looking answerable. */}
          {blocker ? <SessionBlocker blocker={blocker} /> : null}
          {/* Overlay on the composer, never in its place. Ask-user cards (and
              later plans / subagent activity) stack above the input so a
              follow-up can still be typed while the card waits. */}
          <ComposerInteractionStack
            interaction={pending}
            resolving={pending ? resolving.has(pending.id) : false}
            onResolve={answer}
            // Request withdrawal cancels the durable interaction. The
            // composer separately owns turn-only interrupt.
            onWithdraw={withdraw}
          >
            <SessionComposer
              value={input}
              onValueChange={onInputChange}
              textareaRef={textareaRef}
              onComposerFocusRequest={focusComposer}
              // The two caret-driven pickers' supply. Both are project-scoped
              // reads, handed in as plain arrays so the composer stays a
              // controlled view the Lab can mount without a bridge.
              promptTemplates={promptTemplates}
              files={files}
              onFilePickerOpen={fileIndex.refresh}
              // One thing parks above the composer at a time; a pending
              // question outranks a list you can reopen by typing.
              interactionOpen={pending !== null}
              models={composerModels}
              selection={selection}
              selectionProviderLabel={sessionModel?.providerLabel}
              onSelectionChange={changeModel}
              modelChoiceDisabled={working}
              working={working}
              ready={composable}
              queued={strip}
              onQueuedChange={onQueuedChange}
              onSteerQueued={onSteerQueued}
              onSubmit={send}
              onStop={stopTurn}
            />
          </ComposerInteractionStack>
        </ContentColumn>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ model access */

function useModelAccess(active: boolean): {
  models: readonly ModelAccessModel[];
  providers: readonly ModelAccessProvider[];
  catalogState: CatalogState;
  catalogError: string | null;
} {
  const modelAccess = useModelAccessClient();
  const [models, setModels] = React.useState<readonly ModelAccessModel[]>(NO_MODELS);
  const [providers, setProviders] = React.useState<readonly ModelAccessProvider[]>([]);
  const [catalogState, setCatalogState] = React.useState<CatalogState>("loading");
  const [catalogError, setCatalogError] = React.useState<string | null>(null);
  const inspect = modelAccess?.inspect;
  const revision = modelAccess?.revision ?? 0;

  React.useEffect(() => {
    if (!active) return;
    setCatalogState("loading");
    setCatalogError(null);
    if (inspect === undefined) {
      setModels(NO_MODELS);
      setProviders([]);
      setCatalogState("error");
      setCatalogError("Model Access is unavailable");
      return;
    }
    let current = true;
    void inspect({})
      .then((access) => {
        if (!current) return;
        setModels(access.models);
        setProviders(access.providers);
        setCatalogError(null);
        setCatalogState(
          access.models.some((model) => model.state === "available") ? "ready" : "empty",
        );
      })
      .catch((failure: unknown) => {
        if (!current) return;
        setCatalogState("error");
        setCatalogError(errorMessage(failure));
      });
    return () => {
      current = false;
    };
  }, [active, inspect, revision]);

  return active
    ? { models, providers, catalogState, catalogError }
    : { models: NO_MODELS, providers: [], catalogState: "pinned", catalogError: null };
}

function composerModel(
  model: ModelAccessModel,
  providers: readonly ModelAccessProvider[],
): ComposerModel {
  return {
    id: `${model.providerId}/${model.modelId}`,
    providerId: model.providerId,
    providerLabel:
      providers.find((provider) => provider.id === model.providerId)?.label ?? model.providerId,
    modelId: model.modelId,
    label: model.label,
    reasoningLevels: model.reasoningLevels,
  };
}

/* ---------------------------------------------------------------- blocked */

function SessionBlocker({ blocker }: { blocker: SessionBlockerState }) {
  return (
    <div
      className={cn(
        "mb-2 flex items-center gap-2 rounded-lg border bg-card px-4 py-1 text-ui shadow-raised",
        blocker.tone === "error" ? "border-destructive/30" : "border-border",
      )}
    >
      {/* A wait is not a failure: a rate limit or a reconnect wearing the
          triangle would read as broken when the state is "not yet". */}
      {blocker.tone === "error" ? (
        <WarningIcon aria-hidden className="size-3.5 shrink-0 text-destructive" weight="fill" />
      ) : null}
      {blocker.tone === "waiting" ? (
        <ClockIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
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
      {blocker.secondaryAction ? (
        <Button
          size="xs"
          variant="ghost"
          className="shrink-0"
          onClick={blocker.secondaryAction.act}
        >
          {blocker.secondaryAction.label}
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
const SEGMENT_GAP = "space-y-4";

/**
 * And the same value between messages, because a harness splits one reply into a
 * message per step. A wider gap here would put 24px between two tool bundles and
 * 12px between two others purely on where the stream was cut — a seam the reader
 * cannot see and must not feel.
 */
const MESSAGE_GAP = "flex flex-col gap-4";

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
      <MessageContent className="gap-0 group-[.is-user]:rounded-xl group-[.is-user]:bg-muted group-[.is-user]:px-4 group-[.is-user]:py-2">
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
  const interaction = interactionForApproval(context.open, gatedToolCallId(part));
  return (
    <div className="space-y-1">
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
