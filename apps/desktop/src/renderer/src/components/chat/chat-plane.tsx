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
import { toast } from "sonner";

import { toastError } from "@renderer/lib/toast";
import type { BlobLinkView } from "@volli/shared";
import { BookOpenIcon } from "@phosphor-icons/react/dist/csr/BookOpen";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { XCircleIcon } from "@phosphor-icons/react/dist/csr/XCircle";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import type {
  HiddenModelRef,
  ModelAccessModel,
  ModelAccessProvider,
  SessionAttentionProjection,
  RendererSessionInteraction,
} from "@volli/shared";
import {
  errorMessage,
  offeredComposerVerbs,
  readSkillResources,
  type ComposerVerbMoment,
  type ComposerVerbName,
  type PromptResource,
} from "@volli/shared";
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
import { ThinkingOrbs } from "@renderer/components/ui/thinking-orbs";
import {
  gatedToolCallId,
  gatedToolCallIds,
  groupTurns,
  isAwaitingFirstOutput,
  segmentTurn,
  type ChatSegment,
} from "@renderer/chat/activity";
import { isDeliverable, type MessageDelivery } from "@renderer/chat/client";
import { weaveCompactionBoundaries } from "@renderer/chat/compaction-boundary";
import { sessionContextUsage } from "@renderer/chat/context-usage";
import {
  composerAnswerPrompt,
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
import { ActivityBundle, ToolRow, copyText } from "@renderer/components/chat/activity-ui";
import {
  CompactionBoundary,
  CompactionProgress,
} from "@renderer/components/chat/compaction-boundary-ui";
import {
  answerInteraction,
  composerModelSelection,
  composerPress,
  coordinateQueuedMutation,
  coordinateQueuedSteerStart,
  detachableRowAttachments,
  dispatchHeldMessage,
  hasReconciledSessionSnapshot,
  heldStrip,
  holdList,
  lastAssistantText,
  messageCopyText,
  messageRoute,
  resolvingWith,
  restoreStripAttachments,
  sameInteractionId,
  sameMessages,
  sameQueuedMessage,
  sessionBlocker,
  sessionModelStanding,
  visibleBlocker,
  steerRollbackState,
  steerQueuedMessage,
  settledHeldIds,
  withdrawInteraction,
  type ComposerVerbPress,
  type CatalogState,
  type HeldDispatchOutcome,
  type SessionBlockerActs,
  type SessionBlockerState,
  type SignInProviderOption,
} from "@renderer/components/chat/chat-plane-model";
import {
  offerableModels,
  SessionComposer,
  type ComposerModelSelection,
} from "@renderer/components/chat/composer-ui";
import {
  ComposerInteractionStack,
  InteractionCard,
  InteractionReceiptLine,
} from "@renderer/components/chat/interaction-ui";
import { GuardedResponse } from "@renderer/components/chat/markdown-boundary";
import { ChatEmptyState } from "@renderer/components/chat/empty/chat-empty-state";
import { ContentColumn } from "@renderer/components/layout/content-column";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
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
import { useAttachments } from "@renderer/hooks/use-attachments";
import { AttachmentStrip } from "@renderer/components/attachments/attachment-strip";
import { transcriptAttachments } from "@renderer/components/attachments/attachment-model";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useUiStore } from "@renderer/stores/ui";

const NO_INTERACTIONS: readonly RendererSessionInteraction[] = [];
const NO_QUEUE: readonly QueuedMessage[] = [];
const NO_HELD: readonly HeldMessage[] = [];
const NO_MODELS: readonly ModelAccessModel[] = [];
const NO_HIDDEN: readonly HiddenModelRef[] = [];
const EMPTY_MODEL_SELECTION: ComposerModelSelection = {
  providerId: "",
  modelId: "",
  reasoningLevel: "",
};
const EMPTY_ATTENTION: SessionAttentionProjection = { active: [], primary: null };
const EMPTY_RESOLVING: ReadonlySet<string> = new Set();

/**
 * The transcript's dissolve into the composer — 64px of ramp above an opaque bar.
 *
 * Something has to sit here: the scroller runs the full height of the plane and
 * the composer is opaque, so without a ramp a line scrolling under it is cut by
 * a straight horizontal edge, mid-glyph, with nothing to say it was scrolling
 * rather than broken. That is the same cut `sidebar-scroll.tsx` softens at the
 * nav and the footer.
 *
 * WHAT THE SHAPE IS FOR, and why it is not a plain linear ramp. Alpha has to
 * reach 1 BEFORE the seam: a linear fade is still ~2% short one pixel above the
 * composer, so the last of the ink survives to the seam and is then hard-cut by
 * an opaque edge — the ghost this gradient has always been trying to avoid. The
 * first fix for that was a flat 2rem of solid background at the bottom, which
 * bought a clean seam by DELETING a whole line: text did not fade out, it hit
 * an invisible wall 32px above the composer and vanished, leaving a stripe of
 * half-glyphs at the wall and dead paper below it.
 *
 * So the ramp is EASED instead of flattened. Stops are sampled from smootherstep
 * — S(x) = 6x⁵ − 15x⁴ + 10x³, alpha = 1 − S, over the band above the seam — so
 * the curve is flat at both ends and steep in the middle: opaque with margin at
 * the seam, imperceptible at the top edge where the fade begins, and dissolving
 * fastest in between. Full background is reached 5px above the composer rather
 * than 32, which is the whole gain: three lines dissolve where one used to be
 * erased. The percentages are samples of that curve, not picks off the alpha
 * ladder in docs/DESIGN.md — changing one in isolation puts a kink in a curve.
 */
const COMPOSER_SCRIM = [
  "linear-gradient(to top",
  "var(--background) 0 8%",
  "color-mix(in oklab, var(--background) 95%, transparent) 25%",
  "color-mix(in oklab, var(--background) 77%, transparent) 40%",
  "color-mix(in oklab, var(--background) 48%, transparent) 55%",
  "color-mix(in oklab, var(--background) 20%, transparent) 70%",
  "color-mix(in oklab, var(--background) 3%, transparent) 85%",
  "transparent 100%)",
].join(",");

export interface ChatPlaneProps {
  sessionId: string;
  /** Project scope for Model Access and file navigation. */
  projectId: string;
  /**
   * The ticket that owns this Session, or `null` for one of the project's own.
   *
   * The Session's SCOPE, handed down rather than looked up: both hosts already
   * know it (Home's is ticketless by construction, a ticket workspace's is the
   * ticket it is drawing), and the empty state needs it to know which venue the
   * Session stands in and which drawings that scope can offer.
   */
  ticketId: string | null;
  onOpenFile(path: string): void;
  /** The UI lab's own store, which owns its own transport. Omitted in the app. */
  store?: ChatSessionsStore;
}

export function ChatPlane({ sessionId, projectId, ticketId, onOpenFile, store }: ChatPlaneProps) {
  const controller = useSessionController(sessionId, store);
  const sessionsStore = store ?? useChatSessionsStore;
  const {
    claimQueued,
    compactContext,
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
    dismissError,
  } = controller;
  const session = controller.session;

  // The half-typed message is part of the Session, not this view: it has to
  // survive both a tab switch (this component unmounts) and a relaunch, so it
  // lives in the chat-drafts store rather than local state (see stores/chat-drafts.ts).
  const input = useChatDraftsStore((state) => state.drafts[sessionId]?.text ?? "");
  const held = useChatDraftsStore((state) => state.drafts[sessionId]?.held ?? NO_HELD);
  const setDraft = useChatDraftsStore((state) => state.setDraft);
  const setDraftAttachments = useChatDraftsStore((state) => state.setDraftAttachments);
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
  // A dismiss is a view choice, never a Session mutation. It lasts only while
  // this exact error remains current; a cleared or changed error earns its row
  // back without requiring a retry just to make it visible again.
  const [dismissedBlockerKey, setDismissedBlockerKey] = React.useState<string | null>(null);
  const setSettingsOpen = useUiStore((state) => state.setSettingsOpen);
  const composerHeight = useMeasuredHeight<HTMLDivElement>();
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const steeringQueued = React.useRef(new Set<string>());
  // Two one-line callbacks that were inline literals, and inline is what they
  // could not be: they are props of a memoized composer, so a fresh closure per
  // render re-renders the whole box once per streamed frame.
  const focusComposer = React.useCallback(() => textareaRef.current?.focus(), []);

  const { messages, durableMessages, queue, working, deliverable, projection, liveCompaction } =
    session;
  const modelSelection = projection?.modelSelection ?? null;
  const selection: ComposerModelSelection = modelSelection ?? EMPTY_MODEL_SELECTION;
  const liveExecutorId = projection?.liveExecutor?.id ?? null;
  const { models, providers, hidden, catalogState, catalogError } = useModelAccess(
    projection !== null,
  );
  // A durable model is not enough to type: the row that says this Session is
  // pinned to something nobody can run waits on the catalog, and until the
  // catalog answers there is nothing to say it with. A box that takes a message
  // in that window spends it before the warning it was owed — which is the one
  // thing knowing the model early was for.
  const composable = modelSelection !== null && catalogState !== "loading";
  // What this picker may offer (VC-53), decided in one place because the
  // New-ticket composer asks the same question — see `offerableModels`.
  const composerModels = React.useMemo(
    () => offerableModels(models, providers, hidden),
    [hidden, models, providers],
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

  /**
   * Whether the Session's model can read images (VC-50) — the same catalog the
   * picker uses. Unknown reads as supported: the affordance's job is to warn,
   * not to lock, and a wrong warning on a model that can see is worse than
   * none.
   */
  const imagesUnsupported = React.useMemo(() => {
    if (modelSelection === null) return false;
    const model = models.find(
      (candidate) =>
        candidate.providerId === modelSelection.providerId &&
        candidate.modelId === modelSelection.modelId,
    );
    return model !== undefined && !model.acceptsImageInput;
  }, [modelSelection, models]);

  // The window belongs to the Session's model, read from the same catalog the
  // picker uses; null while the catalog has not answered or does not know.
  const contextWindow = React.useMemo(() => {
    if (modelSelection === null) return null;
    const model = models.find(
      (candidate) =>
        candidate.providerId === modelSelection.providerId &&
        candidate.modelId === modelSelection.modelId,
    );
    return model?.contextWindow ?? null;
  }, [models, modelSelection]);
  // Memoized on the durable transcript, deliberately not on `messages`: the
  // live overlay replaces `messages` every frame of a streamed turn, and this
  // object is a prop of the memoized composer. Usage only moves when a reply
  // settles, so this recomputes exactly then.
  const contextUsage = React.useMemo(
    () => sessionContextUsage(durableMessages, contextWindow),
    [contextWindow, durableMessages],
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
   * words.
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
   *
   * Written as a road the caller supplies, because the composer now has two:
   * the message ({@link send}) and the answer to an open question
   * ({@link answerTyped}). Everything around the road — the durable copy before
   * delivery, and which outcome hands the words back — is the same promise for
   * both, and it is not a promise either caller should be able to keep
   * differently. A refused answer lands where a refused message lands: back in
   * the strip under the composer, as words nothing took.
   */
  /**
   * Files attached to the message being written (VC-50).
   *
   * Owned here rather than in the composer because they belong to the message,
   * not to the box: they have to survive the composer's memo, ride the queued
   * copy, and be readable by {@link send} at the moment ⏎ is pressed.
   *
   * And they are part of the Session's DRAFT (VC-137), which is why every strip
   * change writes through to the chat-drafts store and the strip is seeded
   * from it on mount: the words survive a tab switch and a relaunch, and the
   * files beside them must survive exactly the same events. The links live in
   * main, owned by the Session — so the bytes survive boot collection too, and
   * the strip's thumbs still render after a relaunch.
   *
   * A repository file resolves to an `@` reference instead of a copy, and that
   * reference is appended to the draft — the same text the `@` picker would
   * have inserted, so both routes to a repository file end in one thing.
   */
  const {
    attachments,
    attachFiles,
    remove: removeAttachment,
    clear: clearAttachments,
    reset: resetAttachments,
  } = useAttachments({
    owner: { sessionId },
    onRefInsert: (relPath) => {
      // `useAttachments` re-reads its callbacks every render, so `input` here
      // is the draft as it stands, not as it stood when the drop began.
      setDraft(sessionId, input.length === 0 ? `@${relPath} ` : `${input} @${relPath} `);
    },
    onError: (message) => toast.error(message),
    onChange: (next) => setDraftAttachments(sessionId, next),
  });
  // Read at submit rather than closed over, so `send` keeps its identity while
  // the strip changes underneath it.
  const attachmentsRef = React.useRef(attachments);
  attachmentsRef.current = attachments;
  // Seed the strip from the persisted draft, once per Session. The pane is
  // keyed by sessionId at every call site, so a remount is a new Session's
  // plane — but the ref guard keeps a same-key remount (React strict-mode
  // double effects, or a future call site without a key) from wiping a strip
  // that changed between the first seed and now.
  const seededSession = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (seededSession.current === sessionId) return;
    seededSession.current = sessionId;
    const persisted = useChatDraftsStore.getState().drafts[sessionId]?.attachments ?? [];
    if (persisted.length > 0) resetAttachments(persisted);
  }, [resetAttachments, sessionId]);
  /**
   * A pulled-back row's files rejoin the strip (VC-137) — the merge rule and
   * the links it strands both live in `restoreStripAttachments`.
   *
   * `attachmentsRef` is written here rather than left to the next render: the
   * composer calls this and then `onQueuedChange` in the same tick, and the
   * removal path reads the ref to know which files came BACK rather than went
   * away — a stale ref there would detach the links it is deciding to keep.
   */
  const restoreAttachments = React.useCallback(
    (incoming: readonly BlobLinkView[]) => {
      const { strip, detach } = restoreStripAttachments(attachmentsRef.current, incoming);
      for (const shadowed of detach) void removeAttachment(shadowed);
      attachmentsRef.current = strip;
      resetAttachments(strip);
    },
    [removeAttachment, resetAttachments],
  );

  const dispatch = React.useCallback(
    (
      text: string,
      road: (message: QueuedMessage) => Promise<HeldDispatchOutcome>,
      resources?: readonly PromptResource[],
      attached?: readonly BlobLinkView[],
    ) => {
      // Resources ride the message object itself — through hold, queue and
      // steer — so a copy released later delivers exactly what `/skill`
      // resolved to when ⏎ was pressed, not whatever the file says by then.
      // Attachments ride it for the same reason (VC-50).
      const message: QueuedMessage = {
        id: nextId(),
        text,
        ...(resources !== undefined && resources.length > 0 ? { resources } : {}),
        ...(attached !== undefined && attached.length > 0 ? { attachments: attached } : {}),
      };
      holdMessage(sessionId, message);
      void dispatchHeldMessage({
        persist: () => flushPendingAppStateKey(CHAT_DRAFTS_APP_STATE_KEY),
        deliver: () => road(message),
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
    [dropHeld, holdMessage, markHeld, sessionId],
  );

  const send = React.useCallback(
    (text: string, intent: ComposerIntent, resources?: readonly PromptResource[]) => {
      // The strip's durable copy empties BEFORE the hold, so the one flush
      // `dispatchHeldMessage` performs carries both halves of the same
      // transition — the message leaving the box WITH its files, and the box
      // no longer holding them — in a single durable write window.
      if (attachmentsRef.current.length > 0) setDraftAttachments(sessionId, []);
      dispatch(text, (message) => deliver(message, intent), resources, attachmentsRef.current);
      // The strip belongs to the message that just left, not to the box. It is
      // cleared rather than detached: the links stay, because the message the
      // agent received refers to them.
      clearAttachments();
    },
    [clearAttachments, deliver, dispatch, sessionId, setDraftAttachments],
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
      const gone = coordinateQueuedMutation({
        queueBacked,
        claim: () => claimQueued(entry.id),
        consumeClaim: () => dequeueClaimed(entry.id),
        releaseClaim: () => releaseQueuedClaim(entry.id),
        dropHeld: () => dropHeld(sessionId, entry.id),
      });
      if (!gone) return false;
      // A removed row's files lose their links too (VC-137) — which of them,
      // and why an edited row's do not, is `detachableRowAttachments`.
      for (const attachment of detachableRowAttachments(
        entry.attachments,
        attachmentsRef.current,
      )) {
        void removeAttachment(attachment);
      }
      return true;
    },
    [
      claimQueued,
      dequeueClaimed,
      dropHeld,
      removeAttachment,
      releaseQueuedClaim,
      sessionId,
      sessionsStore,
      strip,
    ],
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
  /**
   * The question the composer's own words answer, held where a stable callback
   * can read it.
   *
   * A ref rather than a dependency, and written during render like
   * {@link useStableList}'s: `onSubmit` is a prop of the memoized composer, so a
   * callback that closed over `pending` would be a new function on every frame
   * of every streamed turn and switch that memo boundary off — for a value that
   * is only ever read inside a press, at which point the current render's is the
   * only correct one anyway.
   */
  const pendingRef = React.useRef<RendererSessionInteraction | null>(pending);
  pendingRef.current = pending;
  const answering = pending !== null && composerAnswerPrompt(pending) !== null;

  // The Session's most recent reply — what `/copy` copies. Held in a ref as
  // well as a value for the same reason `pendingRef` above is: `onSubmit` is a
  // prop of the memoized composer, so the press must read the latest text
  // without the handler re-creating itself once per streamed frame.
  const lastReply = React.useMemo(() => lastAssistantText(messages), [messages]);
  const lastReplyRef = React.useRef<string | null>(lastReply);
  lastReplyRef.current = lastReply;
  // The facts every verb's offer rule reads, gathered once (`ComposerVerbMoment`).
  //
  // Memoized on the four booleans rather than on their sources, because the
  // sources move far more often than the answers do: a streaming transcript
  // re-renders this plane every frame, and re-ranking the picker each time
  // would put a sort of the whole file index on the stream's clock. The
  // booleans change only at turn boundaries — `hasReply` goes false again
  // whenever a new user message is the newest row, and true when that turn
  // speaks — which is a handful of changes per turn instead of hundreds.
  const verbMoment = React.useMemo<ComposerVerbMoment>(
    () => ({
      working,
      hasReply: lastReply !== null,
      hasModels: composerModels.length > 0,
      hasProject: projectId !== null,
    }),
    [composerModels.length, lastReply, projectId, working],
  );
  // Read by the press, which must judge the moment it happens in rather than
  // the one the handler was built in.
  const verbMomentRef = React.useRef(verbMoment);
  verbMomentRef.current = verbMoment;
  const verbSupply = React.useMemo(() => offeredComposerVerbs(verbMoment), [verbMoment]);
  // `/model`'s target: the pill's own list, opened by typing instead of
  // clicking. Lives here because the press that opens it is decided here.
  const [modelPickerOpen, setModelPickerOpen] = React.useState(false);

  // What the composer's two caret-driven pickers rank over. All of it is
  // project-scoped: the file index is the one the editor's `@` already uses,
  // the templates are `.volli/commands/` over the global tier, and the skills
  // are `.agents/skills/` — explicit `/` references, never ambient injection.
  const fileIndex = useFileIndex(projectId);
  const files = fileIndex.getIndex();
  const {
    templates: promptTemplates,
    skills,
    reload: reloadPromptSupply,
  } = usePromptTemplates(projectId);

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

  /**
   * The other thing one press of the composer can be: the answer to the
   * question standing above it.
   *
   * It takes {@link dispatch}'s road rather than calling `answer` directly, so
   * words typed into the composer are durable before they are delivered and
   * come back to the reader if nothing took them — the same promise the box has
   * always made about a message, kept for the thing that is not one. A refused
   * answer becomes an unsent row under the composer, and the question is still
   * open above it: pressing send again is the retry.
   */
  const answerTyped = React.useCallback(
    (interactionId: string, submission: InteractionSubmission, text: string) => {
      dispatch(text, async () =>
        (await answer(interactionId, submission)) ? "delivered" : "refused",
      );
    },
    [answer, dispatch],
  );

  /**
   * What each verb DOES, keyed by name.
   *
   * A `Record` on the closed {@link ComposerVerbName} rather than a switch:
   * add a verb and this table fails to compile, naming the one with no act.
   * The switch it replaced could not do that — it sat in a void-returning
   * callback, where TypeScript asks nothing of a missing arm, so a new verb
   * would have been offered by the picker and then quietly done nothing.
   *
   * The return value answers one question: did it happen? `void` means yes,
   * with nothing further to say. A promise resolving `false` is a refusal that
   * only became knowable after the press — the clipboard saying no, the
   * runtime declining a compaction only it can judge — and it is what
   * {@link verbPress} restores the draft on. Each act owns its own words:
   * whether a particular thing succeeded is not a sentence this table can
   * write for all six.
   */
  const verbActs = React.useMemo<
    Record<ComposerVerbName, (instructions: string | null) => void | Promise<boolean>>
  >(
    () => ({
      // The runtime performs this one, and it alone can see the refusal that
      // is not a failure: a history with nothing left to summarize.
      compact: (instructions) => compactContext(instructions),
      copy: () => {
        const text = lastReplyRef.current;
        // Unreachable: `COPY_VERB.refusal` already required a settled reply,
        // and the press checks it before reaching this table.
        if (text === null) return;
        return navigator.clipboard.writeText(text).then(
          () => {
            toast.success("Copied last reply");
            return true;
          },
          () => {
            toastError("Couldn't copy — the clipboard refused");
            return false;
          },
        );
      },
      // The pill's own list, opened by typing instead of clicking.
      model: () => setModelPickerOpen(true),
      // The refresh reports itself: re-reading two directories is a round trip
      // that can fail, and a toast fired beside the request rather than after
      // its answer would be claiming a refresh that had not happened yet — or
      // one that never did.
      reload: () =>
        reloadPromptSupply().then((refreshed) => {
          if (refreshed) toast.success("Commands and skills refreshed");
          return refreshed;
        }),
      settings: () => setSettingsOpen(true),
      // Volli's credentials live in Model Access, not in a verb — the verb is
      // the door, the page is the room.
      login: () => setSettingsOpen(true, "model-access"),
    }),
    [compactContext, reloadPromptSupply, setSettingsOpen],
  );

  /**
   * One verb press, and the contract all six keep.
   *
   * Every verb press lands here and none of them sends a message, which is the
   * whole difference from the fallback arm. Three rules, in the order they are
   * checked:
   *
   * **A refusal the press can see never takes the words.** Trailing words a
   * verb does not read, or a moment the verb cannot act in, leave the draft
   * exactly where it is and say why in a toast. Never a silent red line.
   *
   * **The moment is judged by the verb.** `verb.refusal` is the same function
   * `offeredComposerVerbs` filtered the picker with, so a verb the list did
   * not offer is a verb this refuses, in the words that row's absence meant.
   * What the picker offers and what a press performs cannot disagree, because
   * they are not two rules that agree — they are one function asked twice.
   *
   * **An act that runs takes the words with it, and hands them back if it did
   * not happen.** They stopped being a draft the moment the act began. A
   * refusal only knowable afterwards restores them — asynchronously, and only
   * over an empty box, so a reader who started typing again is never
   * overwritten. Every verb keeps this, not just the two that used to.
   */
  const verbPress = React.useCallback(
    (press: ComposerVerbPress) => {
      const { verb, instructions } = press;
      if (instructions !== null && !verb.takesInstructions) {
        // The words stay put rather than clearing first: this press never
        // happened, and the toast is the sentence that says why.
        toastError(`/${verb.name} takes no instructions`);
        return;
      }
      const refusal = verb.refusal(verbMomentRef.current);
      if (refusal !== null) {
        toastError(refusal);
        return;
      }
      const typed = useChatDraftsStore.getState().drafts[sessionId]?.text ?? "";
      setDraft(sessionId, "");
      const act = verbActs[verb.name](instructions);
      if (act === undefined) return;
      void act.then((happened) => {
        if (happened) return;
        if ((useChatDraftsStore.getState().drafts[sessionId]?.text ?? "") === "") {
          setDraft(sessionId, typed);
        }
      });
    },
    [sessionId, setDraft, verbActs],
  );

  /**
   * One press of the composer, and the one place it is decided what that press
   * was.
   *
   * The rules are `composerAnswer`'s and `composer-verb.ts`'s and the reasons
   * are there; the order between them is `composerPress`'s. What is here is
   * the fallback, and it is the one that used to be the only behaviour: a
   * message, which while a turn is live joins the release queue. That is right
   * for words typed alongside a running turn and was a dead end for words typed
   * at a blocked one — the queue drains into an idle Session, and a Session
   * waiting on a question never becomes idle on its own.
   */
  const submitComposer = React.useCallback(
    (text: string, intent: ComposerIntent) => {
      const press = composerPress(pendingRef.current, text);
      if (press.kind === "answer") answerTyped(press.interactionId, press.submission, text);
      else if (press.kind === "verb") verbPress(press);
      else send(text, intent);
    },
    [answerTyped, send, verbPress],
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
  // The turns with the Session's compaction boundaries laid between them. Both
  // inputs are held to their identity — the turn list by `useStableList`, the
  // compactions by the fold that only replaces the array when one lands — so
  // this recomputes when the conversation moves and not once per frame.
  const rows = React.useMemo(
    () => weaveCompactionBoundaries(turns, session.compactions),
    [session.compactions, turns],
  );
  // Identity, not an index. A boundary between the turns means a turn's place in
  // `rows` is no longer its place in `turns` — and the last ROW can be a
  // boundary, which would leave the turn still being written with nothing
  // saying so.
  const liveTurn = working ? (turns.at(-1) ?? null) : null;

  const stopTurn = React.useCallback(() => void interrupt(), [interrupt]);
  const dismissBlocker = React.useCallback((dismissKey: string) => {
    setDismissedBlockerKey(dismissKey);
  }, []);

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
      openSettings: () => setSettingsOpen(true, "model-access"),
      // And when the row knows WHICH provider, straight to its sign-in: the
      // pane auto-starts (or offers) that provider's flow on arrival.
      signIn: (providerId) => setSettingsOpen(true, "model-access", providerId),
      dismissError: () => dismissError(),
      dismiss: dismissBlocker,
    }),
    [dismissBlocker, dismissError, liveExecutorId, recover, retryRuntime, setSettingsOpen],
  );
  // The providers a first-run "Sign in" can offer — the ones with an in-app
  // flow, in the same reachable-first order the Accounts list uses.
  const signInProviders = React.useMemo<readonly SignInProviderOption[]>(
    () =>
      providers
        .filter((provider) => provider.signIn.length > 0)
        .toSorted((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
        .map((provider) => ({ id: provider.id, label: provider.label })),
    [providers],
  );
  const candidateBlocker = sessionBlocker(
    {
      sessionError: session.sessionError,
      attention: projection?.attention ?? EMPTY_ATTENTION,
      catalogState,
      catalogError,
      sessionModel,
      signInProviders,
    },
    blockerActs,
    interactions.length > 0,
  );
  const blockerPresentation = visibleBlocker(candidateBlocker, dismissedBlockerKey);
  React.useEffect(() => {
    if (blockerPresentation.dismissedKey !== dismissedBlockerKey) {
      setDismissedBlockerKey(blockerPresentation.dismissedKey);
    }
  }, [blockerPresentation.dismissedKey, dismissedBlockerKey]);
  const blocker = blockerPresentation.blocker;

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
              // Where this Session runs, drawn (VC-55). It replaces the bare
              // mark that stood here — see `empty/chat-empty-state.tsx` for why
              // that reversal is deliberate. What blocks TYPING still sits on
              // the composer, where the typing is.
              <ConversationEmptyState className={cn(EMPTY_PAGE, "min-h-80")}>
                <ChatEmptyState projectId={projectId} ticketId={ticketId} />
              </ConversationEmptyState>
            ) : (
              <ContentColumn className={MESSAGE_GAP}>
                {rows.map((row) =>
                  row.kind === "compaction" ? (
                    <CompactionBoundary
                      key={`compaction:${row.compaction.sequence}`}
                      compaction={row.compaction}
                    />
                  ) : (
                    <ChatTurn
                      key={row.messages[0]?.id}
                      messages={row.messages}
                      context={turnContext}
                      live={row.messages === liveTurn}
                    />
                  ),
                )}
                {liveCompaction ? <CompactionProgress compaction={liveCompaction} /> : null}
                {working ? <TurnRunningMark narrated={!isAwaitingFirstOutput(messages)} /> : null}
              </ContentColumn>
            )}
          </ConversationContent>
          {/* A short fade keyed to the measured composer — see {@link COMPOSER_SCRIM}
              for the curve. It lives inside the Conversation, ahead of the
              button, so paint order is structural: content, then fade, then
              button. */}
          <div
            className="pointer-events-none absolute inset-x-0 bottom-[var(--composer-height)] h-16"
            style={{ backgroundImage: COMPOSER_SCRIM }}
          />

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
              // The two caret-driven pickers' supply. All project-scoped
              // reads, handed in as plain arrays so the composer stays a
              // controlled view the Lab can mount without a bridge.
              promptTemplates={promptTemplates}
              skills={skills}
              verbs={verbSupply}
              modelPickerOpen={modelPickerOpen}
              onModelPickerOpenChange={setModelPickerOpen}
              files={files}
              onFilePickerOpen={fileIndex.refresh}
              // One thing parks above the composer at a time; a pending
              // question outranks a list you can reopen by typing.
              interactionOpen={pending !== null}
              // What this box's words will do, not where the answer belongs.
              // The card above keeps its own field and is the affordance; this
              // is the fallback that stops a question standing over the
              // composer from making it a dead end (VC-68). It changes the
              // placeholder and the control's name, never the behaviour.
              answering={answering}
              models={composerModels}
              selection={selection}
              selectionProviderLabel={sessionModel?.providerLabel}
              onSelectionChange={changeModel}
              modelChoiceDisabled={working}
              working={working}
              ready={composable}
              contextUsage={contextUsage}
              queued={strip}
              onQueuedChange={onQueuedChange}
              onSteerQueued={onSteerQueued}
              onSubmit={submitComposer}
              onStop={stopTurn}
              attachments={attachments}
              onAttachFiles={(picked) => void attachFiles(picked)}
              onRemoveAttachment={(attachment) => void removeAttachment(attachment)}
              onRestoreAttachments={restoreAttachments}
              imagesUnsupported={imagesUnsupported}
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
  hidden: readonly HiddenModelRef[];
  catalogState: CatalogState;
  catalogError: string | null;
} {
  const modelAccess = useModelAccessClient();
  const [models, setModels] = React.useState<readonly ModelAccessModel[]>(NO_MODELS);
  const [providers, setProviders] = React.useState<readonly ModelAccessProvider[]>([]);
  const [hidden, setHidden] = React.useState<readonly HiddenModelRef[]>(NO_HIDDEN);
  const [catalogState, setCatalogState] = React.useState<CatalogState>("loading");
  const [catalogError, setCatalogError] = React.useState<string | null>(null);
  const inspect = modelAccess?.inspect;
  const hiddenModels = modelAccess?.hiddenModels;
  const revision = modelAccess?.revision ?? 0;

  React.useEffect(() => {
    if (!active) return;
    setCatalogState("loading");
    setCatalogError(null);
    if (inspect === undefined || hiddenModels === undefined) {
      setModels(NO_MODELS);
      setProviders([]);
      setHidden(NO_HIDDEN);
      setCatalogState("error");
      setCatalogError("Model Access is unavailable");
      return;
    }
    let current = true;
    void Promise.all([inspect({}), hiddenModels()])
      .then(([access, curated]) => {
        if (!current) return;
        setModels(access.models);
        setProviders(access.providers);
        setHidden(curated);
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
  }, [active, hiddenModels, inspect, revision]);

  return active
    ? { models, providers, hidden, catalogState, catalogError }
    : {
        models: NO_MODELS,
        providers: [],
        hidden: NO_HIDDEN,
        catalogState: "pinned",
        catalogError: null,
      };
}

/* ---------------------------------------------------------------- running */

/**
 * The one thing on screen that says the turn is not over.
 *
 * It lives for the WHOLE turn now, not just the gap before the first token.
 * That gap was the only moment the transcript could not speak for itself, so it
 * was the only moment this was drawn — and every moment after it looked exactly
 * like a finished reply: settled prose, a collapsed bundle, nothing moving. A
 * reader could not tell a turn that had ended from one that was two tool calls
 * from ending, which is what the first external user described as disorienting.
 * The mark is mounted by `working` and unmounted by it, so the stop token that
 * ends the turn is the same event that takes it off screen; there is no timer
 * and no second source of truth to disagree with the lifecycle.
 *
 * TWO DRESSES, because the transcript's own voice is the better one wherever it
 * has something to say. Before the first output there is nothing else on
 * screen, so the mark says the word; once a bundle above it is reporting
 * `Running 2 commands…` the word would be the same sentence twice at two
 * indents, and the orbs alone carry the fact that neither of them has stopped.
 *
 * The words are said once, `sr-only`, inside the live region — so the dress
 * swap mid-turn is silent (the orbs are `aria-hidden`) and a screen reader
 * hears "Working" at the start of a turn rather than at every step of it.
 *
 * Memoized on one boolean, which is the whole of its props: this sits in the
 * plane's own render, and the plane renders on every streamed frame of the very
 * turn the mark is reporting. `narrated` flips once per turn.
 */
export const TurnRunningMark = React.memo(function TurnRunningMark({
  narrated,
}: {
  /**
   * The transcript is already reporting this turn's work, so the mark drops
   * its own word and keeps only the orbs.
   */
  narrated: boolean;
}) {
  return (
    <div role="status" className="flex min-w-0 flex-col">
      <span className="sr-only">Working</span>
      <div aria-hidden className="flex min-w-0">
        {narrated ? (
          // `py-1` is the row padding {@link ReasoningLine} carries, so the
          // orbs sit on the same rhythm as the line they stand in for and the
          // tail does not jump when the dress changes.
          <ThinkingOrbs className="py-1 text-primary" />
        ) : (
          <ReasoningLine verb="Working" meta={null} streaming />
        )}
      </div>
    </div>
  );
});

/* ---------------------------------------------------------------- blocked */

export function SessionBlocker({ blocker }: { blocker: SessionBlockerState }) {
  return (
    // The composer overlay ignores hits so its empty padding does not cover the
    // transcript. This row carries recovery controls, so it must opt back in.
    <div
      className={cn(
        "pointer-events-auto mb-2 flex items-center gap-2 rounded-lg border bg-card px-4 py-1 text-ui shadow-raised",
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
      {/* The first-run provider menu, ahead of the plain action: choosing who
          to sign in to IS the recovery, and Settings beside it stays the
          long way around for everything else the pane holds. */}
      {blocker.signInMenu ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="xs" variant="secondary" className="shrink-0">
              {blocker.signInMenu.label}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
            {blocker.signInMenu.options.map((option) => (
              <DropdownMenuItem
                key={option.id}
                onSelect={() => blocker.signInMenu?.choose(option.id)}
              >
                {option.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
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
      {/* Every error can be retired locally without claiming its recovery has
          happened. An icon, not a labeled button: it competes with nothing,
          and the row's words are the recovery's business, not its. */}
      {blocker.dismiss ? (
        <Button
          size="icon-xs"
          variant="ghost"
          className="shrink-0"
          aria-label={blocker.dismiss.label}
          onClick={blocker.dismiss.act}
        >
          <XIcon aria-hidden className="size-3" />
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
 * And a wider beat between turns. Every boundary at this level is between two
 * utterances — `groupTurns` collapses a harness's message-per-step splits into
 * one turn, so the wider gap can never land on an invisible seam the way it
 * once could between two tool bundles. 16px inside a reply, 24px between
 * speakers is what gives the feed its paragraph structure: a turn holds
 * together, and the hand-off to the other voice reads as a break.
 */
const MESSAGE_GAP = "flex flex-col gap-6";

export interface TurnContext {
  onOpenFile(path: string): void;
  /** Every interaction opened this Session, for the receipts they left behind. */
  interactions: ReadonlyMap<string, RendererSessionInteraction>;
  /** The ones still open, so a gated row can draw the card it is waiting on. */
  open: readonly RendererSessionInteraction[];
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
  // A user message is prose and attachment thumbs; the assistant path owns
  // every other shape. Whitespace-only text parts are dropped rather than
  // drawn: an attachment-only message still carries the empty text part the
  // composer always writes, and rendering it would open a blank line above
  // the thumbs it was sent with.
  const prose = React.useMemo<readonly { key: string; text: string }[]>(
    () =>
      role === "assistant"
        ? []
        : messages.flatMap((message) =>
            message.parts.flatMap((part, index) =>
              part.type === "text" && part.text.trim().length > 0
                ? [{ key: `${message.id}:${index}`, text: part.text }]
                : [],
            ),
          ),
    [messages, role],
  );
  // The files this turn was sent with (VC-50), drawn from the message parts
  // alone — no fetch, so the thumbs survive the attachment rows being removed
  // later. Read-only: a sent message is a record, not an editable strip.
  const attachedFiles = React.useMemo(
    () =>
      role === "user" ? messages.flatMap((message) => transcriptAttachments(message.parts)) : [],
    [messages, role],
  );
  const copyableText = React.useMemo(() => messageCopyText(messages), [messages]);
  // The visible receipt of a message-scoped skill delivery (VC-49): the text
  // above keeps `/skill` exactly as typed, and this chip row is what says the
  // body actually rode along — the compact reference, never the fifteen
  // kilobytes it stands for.
  const skillChips = React.useMemo<readonly string[]>(
    () =>
      role === "user"
        ? messages.flatMap((message) => readSkillResources(message.parts).map(({ name }) => name))
        : [],
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
    <Message from={role} className="relative max-w-full">
      <MessageContent className="gap-0 group-[.is-user]:rounded-xl group-[.is-user]:bg-muted group-[.is-user]:px-4 group-[.is-user]:py-2">
        {/* Thumbs above the words, matching the composer the message left from. */}
        {attachedFiles.length > 0 ? (
          <AttachmentStrip
            attachments={attachedFiles}
            {...(prose.length > 0 ? { className: "pb-3" } : {})}
          />
        ) : null}
        <div className={SEGMENT_GAP}>
          {segments
            ? segments.map((segment) => (
                <div key={segment.key}>{renderSegment(segment, role, context, live)}</div>
              ))
            : prose.map((entry) => <GuardedResponse key={entry.key}>{entry.text}</GuardedResponse>)}
        </div>
        {skillChips.length > 0 ? (
          // A skill name is a mono outline Badge behind a book icon, wherever
          // it appears. This is the only place the transcript says one: the
          // attach-time "Started with" row was noise and is gone (VC-71), so
          // the names surface where they were actually delivered.
          <div
            className="flex flex-wrap items-center gap-1.5 pt-2 text-ui text-muted-foreground"
            aria-label="Skills delivered with this message"
          >
            <BookOpenIcon aria-hidden className="size-3.5 shrink-0" />
            {skillChips.map((name) => (
              <Badge key={name} variant="outline" className="font-mono">
                {name}
              </Badge>
            ))}
          </div>
        ) : null}
      </MessageContent>
      {copyableText !== null ? <MessageCopyAction text={copyableText} from={role} /> : null}
    </Message>
  );
});

/** The feed-wide copy verdict holds long enough to be read, then returns to rest. */
const COPY_FEEDBACK_MS = 1200;

/**
 * Copy is a hover/focus action in the message's outside gutter.
 *
 * The message remains the reading target; the action occupies no resting space
 * and never competes with the prose for a line. User bubbles expose it on their
 * leading side and assistant turns on their trailing side, so the control stays
 * outside the message surface at either edge of the feed.
 */
function MessageCopyAction({ text, from }: { text: string; from: UIMessage["role"] }) {
  const [copyState, setCopyState] = React.useState<"idle" | "copied" | "failed">("idle");
  React.useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copyState]);
  const CopyStateIcon =
    copyState === "copied" ? CheckCircleIcon : copyState === "failed" ? XCircleIcon : CopyIcon;

  return (
    <span
      className={cn(
        "pointer-events-none absolute top-0 flex opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
        from === "user" ? "right-[calc(100%+0.25rem)]" : "left-[calc(100%+0.25rem)]",
      )}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={
          copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"
        }
        onClick={() => void copyText(text).then(setCopyState)}
      >
        <CopyStateIcon className={cn("size-3", copyState === "failed" && "text-destructive")} />
      </Button>
    </span>
  );
}

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
