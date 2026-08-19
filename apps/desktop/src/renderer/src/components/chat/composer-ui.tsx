/**
 * The Session composer.
 *
 * Three ideas, and the shape follows from them:
 *
 *  1. **Model and effort are peers in the footer, not one inside the other.**
 *     Provider stays a heading inside the model popover, because it is not a
 *     decision you make on its own — you pick a model and the provider follows.
 *     Effort is not that: it is the per-task half of the same sentence where
 *     model is the set-and-forget half, so it sits beside the pill as its own
 *     chip (`composer-effort-ui.tsx`) rather than nested in the popover's
 *     selected row, where it was invisible until opened and outgrew the popover
 *     past four levels. An executor that pins its own model renders no pill at
 *     all rather than a disabled one, on the same rule as the mode segment
 *     below: a control naming models the harness will drop is worse than no
 *     control.
 *  2. **Delivery is session state, not a control.** Idle, ⏎ sends. While a turn
 *     is live the submit glyph becomes Queue, ⏎ queues, ⌘⏎ steers without
 *     interrupting, and ⌫ on an empty box takes the newest queued message back.
 *     Stop turn appears beside submit only while there is something to stop.
 *  3. **What you type can open a list, and the list never takes the cursor.**
 *     `/` and `@`, each at a word boundary, open a picker as a
 *     card above the input (`composer-picker-ui.tsx`), driven entirely from
 *     here: the textarea keeps focus and forwards arrows, ⏎ and Escape to it.
 *     A picker that focused itself would take ⏎ and ⌫ with it, and both already
 *     mean something on this surface.
 *
 * Fully controlled: it owns no session state, so the fixture gallery can put it
 * in any of its four states without a running adapter. The picker keeps that
 * property — the templates and the file index arrive as plain arrays, not as a
 * hook reaching for `window.api`.
 */
import * as React from "react";
import {
  ArrowBendUpLeftIcon,
  ArrowUpIcon,
  CaretUpDownIcon,
  CheckIcon,
  DotsThreeIcon,
  PencilSimpleIcon,
  QueueIcon,
  SquareIcon,
  TrashIcon,
} from "@phosphor-icons/react";

import {
  PromptInput,
  PromptInputBody,
  PromptInputCommand,
  PromptInputCommandEmpty,
  PromptInputCommandGroup,
  PromptInputCommandInput,
  PromptInputCommandItem,
  PromptInputCommandList,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@renderer/components/ui/ai-elements/prompt-input";
import {
  COMPOSER_VERBS,
  expandCommandInvocation,
  visibleModels,
  type HiddenModelRef,
  type ComposerVerb,
  type IndexedFile,
  type ModelAccessModel,
  type ModelAccessProvider,
  type PromptResource,
  type PromptTemplate,
  type SkillReference,
} from "@volli/shared";

import { reclampEffort } from "@renderer/chat/composer-effort";
import type { BlobLinkView } from "@volli/shared";
import type { SessionContextUsage } from "@renderer/chat/context-usage";
import { AttachmentStrip } from "@renderer/components/attachments/attachment-strip";
import { ComposerAttachButton } from "@renderer/components/attachments/composer-attach-button";
import { fileAttachHandlers } from "@renderer/components/attachments/file-drop";
import { COMPOSER_STACK_SHELL } from "@renderer/chat/composer-stack";
import {
  activePickerRow,
  applyPickerRow,
  composerPickerRows,
  composerPickerTarget,
  composerPickerToken,
  movePickerActive,
  type ComposerPickerDismissal,
  type ComposerPickerRow,
  type ComposerPickerState,
} from "@renderer/chat/composer-picker";
import {
  composerIntent,
  takeQueued,
  unqueueLast,
  type ComposerIntent,
  type QueuedMessage,
} from "@renderer/chat/session-model";
import { EffortPill } from "@renderer/components/chat/composer-effort-ui";
import { ContextUsagePill } from "@renderer/components/chat/context-usage-ui";
import { ComposerPicker } from "@renderer/components/chat/composer-picker-ui";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { cn } from "@renderer/lib/utils";

export interface SessionComposerProps {
  value: string;
  onValueChange(value: string): void;
  /** Lets a decision elsewhere in the Session hand the cursor back to the reader. */
  textareaRef?: React.Ref<HTMLTextAreaElement>;
  /** A row action removed its focused control; hand focus to the persistent input. */
  onComposerFocusRequest?(): void;
  models: readonly ComposerModel[];
  selection: ComposerModelSelection;
  /** The Session's provider as the catalog names it — see {@link modelPillLabel}. */
  selectionProviderLabel?: string;
  onSelectionChange(next: ComposerModelSelection): void;
  /** Model policy is immutable during an active turn. */
  modelChoiceDisabled?: boolean;
  /** A turn is live: submit becomes Queue and Stop turn joins it. */
  working: boolean;
  /** Something is attached and a model is chosen. False makes the box inert. */
  ready: boolean;
  queued: readonly QueuedMessage[];
  /** `false` means resident delivery already owns the row; leave its UI untouched. */
  onQueuedChange(next: readonly QueuedMessage[]): boolean | void;
  onSteerQueued(id: string): void;
  /**
   * `resources` is the message-scoped half of the submission: the skill
   * bodies the text's `/slug` references resolved to, delivered beside the
   * text rather than spliced into it. Empty for a message that named none.
   */
  onSubmit(text: string, intent: ComposerIntent, resources?: readonly PromptResource[]): void;
  onStop(): void;
  /** `/` picker rows, and what expands a staged `/name args` on submit. */
  promptTemplates?: readonly PromptTemplate[];
  /** The `/` picker's second supply: skills, delivered as message-scoped RESOURCE blocks. */
  skills?: readonly SkillReference[];
  /** `@` picker rows — the project file index, ranked by the shared grammar. */
  files?: readonly IndexedFile[];
  /** The `@` picker opened; a cache-gated index refresh is worth kicking. */
  onFilePickerOpen?(): void;
  /**
   * An interaction card holds the slot above the composer. The picker stays
   * shut rather than stacking a second card on a pending question — one thing
   * parks here at a time.
   */
  interactionOpen?: boolean;
  /**
   * The question above this composer takes what is typed here as its answer
   * (`chat/interaction.ts`'s `composerAnswerPrompt`).
   *
   * A state of the Session, not a mode of the box: the composer is the same
   * control doing the same thing — one press sends what was written — and what
   * changes is only where the words land. So what changes here is what the box
   * asks for and what the control is called, and nothing about how either one
   * behaves. In particular the box is never disabled and never disables its
   * neighbours: the whole point of answering from here is that a question
   * cannot take the composer away from the person it is asking.
   */
  answering?: boolean;
  /**
   * The Session's context occupancy, or null while nothing has been metered.
   * Settles once per turn, never per frame — the parent memoizes it on the
   * durable transcript, so it cannot switch the memo boundary off.
   */
  contextUsage?: SessionContextUsage | null;
  /**
   * Files attached to the message being written (VC-50). Owned by the parent,
   * because they outlive this box: a queued message releases with exactly what
   * was attached when ⏎ was pressed.
   */
  attachments?: readonly BlobLinkView[];
  /** Something was dropped, pasted or picked. Absent hides the attach affordance entirely. */
  onAttachFiles?(files: readonly File[]): void;
  onRemoveAttachment?(attachment: BlobLinkView): void;
  /**
   * The selected model takes no image input, so the affordance says so rather
   * than letting a picture be attached to a model that cannot see it.
   */
  imagesUnsupported?: boolean;
  className?: string;
}

const NO_TEMPLATES: readonly PromptTemplate[] = [];
const NO_SKILLS: readonly SkillReference[] = [];
const NO_FILES: readonly IndexedFile[] = [];
const NO_ATTACHMENTS: readonly BlobLinkView[] = [];
/**
 * The two verb supplies, both module constants, because the picker's ranking
 * memo takes this as a dependency and a fresh array per render would rank the
 * whole file index again on every keystroke.
 */
const NO_VERBS: readonly ComposerVerb[] = [];

/**
 * MEMOIZED, and this is the boundary that keeps typing off the stream's clock.
 *
 * The composer's parent draws the transcript, so it re-renders on every rAF
 * flush a live turn produces — and until this boundary existed the composer,
 * the model popover and the effort chip were re-rendered with it, once per
 * frame, while someone was typing into them. Nothing about a growing transcript
 * changes anything on this surface: the props here are the draft, the model
 * catalog, the queued strip and a handful of callbacks, and `chat-plane.tsx`
 * holds every one of them at a stable identity for exactly this reason. A prop
 * added here that churns per frame silently switches the boundary off again.
 */
export const SessionComposer = React.memo(function SessionComposer({
  value,
  onValueChange,
  textareaRef,
  onComposerFocusRequest,
  models,
  selection,
  selectionProviderLabel,
  onSelectionChange,
  modelChoiceDisabled = false,
  working,
  ready,
  queued,
  onQueuedChange,
  onSteerQueued,
  onSubmit,
  onStop,
  promptTemplates = NO_TEMPLATES,
  skills = NO_SKILLS,
  files = NO_FILES,
  onFilePickerOpen,
  interactionOpen = false,
  answering = false,
  contextUsage = null,
  attachments = NO_ATTACHMENTS,
  onAttachFiles,
  onRemoveAttachment,
  imagesUnsupported = false,
  className,
}: SessionComposerProps) {
  // An attachment makes an otherwise-empty message a real one (VC-50): a
  // dropped screenshot with no words is a question.
  const canSubmit = ready && (value.trim().length > 0 || attachments.length > 0);
  const effortStops = effortLevels(models, selection);
  // The menu's own event callbacks share this render. Keeping the selected id
  // in their closure lets close distinguish Edit from an ordinary dismissal
  // without adding component state to a fully controlled composer.
  let editedQueueId: string | null = null;

  const send = (intent: ComposerIntent) => {
    if (!canSubmit) return;
    // The one place `/` expansion happens, and the last thing before the
    // existing submit path takes over. Template expansion is what the
    // transcript shows, because it is what was sent — a template invocation is
    // shorthand for its own text. A SKILL reference is not shorthand: the text
    // keeps `/skill` exactly as typed, and the resolved body travels beside it
    // as a typed message part, recorded durably with the message (VC-49).
    // There is still no invented "display text": the record holds both halves
    // of what was actually sent — the words as typed and the resource bytes
    // delivered — so the record and the request cannot disagree.
    const expanded = expandCommandInvocation(value.trim(), promptTemplates, skills);
    onSubmit(expanded.text, intent, expanded.resources);
  };

  // Pulling a row back into the box deliberately drops its resolved skill
  // resources: only text can live in a textarea, and the text still holds
  // `/slug`, so `send` re-resolves it at the next ⏎. That recovery holds only
  // while a skill of that name is still installed — rename or remove it between
  // edit and re-submit and the reference goes out plain, exactly as if the user
  // had typed it fresh against today's skills directory.
  const editQueued = (id: string) => {
    const taken = takeQueued(queued, id);
    if (!taken) return;
    editedQueueId = id;
    if (onQueuedChange(taken.queue) === false) return;
    // Prepending keeps whatever is already typed rather than trading one draft
    // for another — unqueue must never be a way to lose a sentence.
    onValueChange(value.trim().length > 0 ? `${taken.text}\n${value}` : taken.text);
    onComposerFocusRequest?.();
  };

  return (
    <ComposerPickerStack
      value={value}
      onValueChange={onValueChange}
      ready={ready}
      interactionOpen={interactionOpen}
      promptTemplates={promptTemplates}
      skills={skills}
      // Offered only while the Session is idle. A verb RUNS — it is not queued
      // and it does not join a turn in flight — so mid-turn it would be a row
      // naming something the runtime is about to refuse. Typing it anyway
      // still reaches the runtime and still gets that refusal, in words; what
      // the list does not do is invite it.
      verbs={working ? NO_VERBS : COMPOSER_VERBS}
      files={files}
      onFilePickerOpen={onFilePickerOpen}
      textareaRef={textareaRef}
    >
      <PromptInput
        className={cn(
          // `group/composer` is what the footer's resting dim reads: the
          // control row recedes while the composer is unfocused and comes up
          // the moment the caret is in the box. Named, because the picker card
          // and the queued rows are groups' worth of their own.
          "group/composer pointer-events-auto overflow-hidden transition-[color,border-color,box-shadow]",
          COMPOSER_STACK_SHELL,
          className,
        )}
        onSubmit={() => send(composerIntent({ working, steer: false }))}
        // Capture-phase, and that is load-bearing — see `file-drop.ts` for why
        // this composer must take the drop before `PromptInput`'s own listener.
        {...fileAttachHandlers(onAttachFiles)}
      >
        {queued.length > 0 ? (
          // `flex-nowrap`, AND IT IS LOAD-BEARING RATHER THAN TIDY-UP.
          // `PromptInputHeader` is a wrapping ROW — right for the chip strip it
          // was written for — and this call site turns it into a column without
          // retracting the wrap. A wrapping column sizes each flex LINE to its
          // widest item's max-content and then stretches the item to *that*, so
          // a queued row measured 460px inside a 263px composer: the message
          // ran out through the card's right edge and took Steer, Remove and
          // the actions menu with it, off screen and unclickable. Measured at
          // every width the app can hand this box, the first failure was 480px
          // and by 420px all three controls were outside. The row's own
          // `min-w-0 flex-1 truncate` was already right and could do nothing,
          // because nothing was applying any pressure to it.
          <PromptInputHeader className="flex-col flex-nowrap items-stretch gap-1 border-b border-border/70">
            {queued.map((entry) => (
              <div
                key={entry.id}
                role="group"
                aria-label={`Queued message: ${entry.text}`}
                className="flex min-w-0 items-center gap-1 text-ui"
              >
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{entry.text}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {working ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      aria-label={`Steer queued message: ${entry.text}`}
                      onClick={() => {
                        onSteerQueued(entry.id);
                        onComposerFocusRequest?.();
                      }}
                    >
                      <ArrowBendUpLeftIcon className="size-3" />
                      Steer
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove queued message: ${entry.text}`}
                    onClick={() => {
                      if (onQueuedChange(queued.filter((item) => item.id !== entry.id)) === false)
                        return;
                      onComposerFocusRequest?.();
                    }}
                  >
                    <TrashIcon className="size-3" />
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`Queued message actions: ${entry.text}`}
                      >
                        <DotsThreeIcon className="size-3" weight="bold" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      onCloseAutoFocus={(event) => {
                        if (editedQueueId !== entry.id) return;
                        editedQueueId = null;
                        // Edit removes the trigger. Radix must not restore focus
                        // to that vanished node after we focused the composer.
                        event.preventDefault();
                        // And the focus `editQueued` placed did not survive: this
                        // menu is modal, so its FocusScope trapped focus inside
                        // the content and snapped it right back off the textarea.
                        // When the row then unmounted, the browser dropped focus
                        // to <body>. This handler is the first moment after the
                        // trap is gone, so the request lands here or nowhere.
                        onComposerFocusRequest?.();
                      }}
                    >
                      <DropdownMenuItem onSelect={() => editQueued(entry.id)}>
                        <PencilSimpleIcon weight="fill" />
                        Edit message
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </span>
              </div>
            ))}
          </PromptInputHeader>
        ) : null}

        <PromptInputBody>
          {/* Above the text, not below it: the strip is part of the message
              being written, and a person scanning what they are about to send
              reads top to bottom. */}
          <AttachmentStrip
            attachments={attachments}
            {...(onRemoveAttachment === undefined ? {} : { onRemove: onRemoveAttachment })}
            className="px-3 pt-2"
          />
          {/* Reads the caret bindings from the stack above rather than taking
              them as props: the picker card and this input are siblings, one
              thing has to hold the caret between them, and threading it back
              down by hand would make this composer own state it has spent its
              whole life not owning. */}
          <ComposerTextarea
            value={value}
            ready={ready}
            answering={answering}
            onValueChange={onValueChange}
            onSteer={() => send("steer")}
            queued={queued}
            onQueuedChange={onQueuedChange}
          />
        </PromptInputBody>

        {/* THE CHROME RESTS DIM. While the composer is not focused its controls
            sit at 70% and the transcript above owns the eye; the caret landing
            in the box brings them up. This is what earns a permanently visible
            effort control its place in the row — present while you are typing,
            recessive while you are reading — and it is claude.ai's own rule.
            The queued header is deliberately outside it: those rows are the
            reader's own words, not our furniture.

            `has-[[data-state=open]]` is the half `:focus-within` cannot do. A
            Radix popover portals its content out of this form, so opening the
            model list moves focus off the composer entirely and the row would
            dim under the hand that opened it. The trigger stays here and stays
            marked open, which is the fact worth reading.

            AND THE DIM IS THE DIVIDER. There was a `border-t border-border/70`
            here and it is the line the composer is better without. Measured,
            it sat at 47.1% of a 77.65px shell — within three points of dead
            centre — which is a rule declaring two co-equal halves over a box
            whose top half is one line of a message and whose bottom half is our
            furniture. A divider's job is to separate things of DIFFERENT kinds,
            and this pair already differs by the loudest channel a UI has: the
            row below is at 70% ink while the row above is at 100%. Drawing a
            hairline as well says the same thing twice and asserts the wrong
            thing once. ChatGPT and claude.ai both draw no line here.

            Its padding went with it, and not by accident: `[.border-t]:pt-2`
            existed to clear the rule, so removing the class removes the 8px lid
            in the same stroke and the footer falls back to the 4px one
            {@link PromptInputFooter} settles. The seam is 12px of air now — the
            body's own 8px floor plus that 4px — against 8px at the card's outer
            edges, so the widest space in the box is the one between the two
            bands. That is what a lineless composer needs to be true. */}
        <PromptInputFooter
          className={cn(
            "opacity-70 transition-opacity duration-200 ease-out",
            "group-focus-within/composer:opacity-100 has-[[data-state=open]]:opacity-100",
            "motion-reduce:transition-none!",
          )}
        >
          {/* `flex-1`, so the control cluster is the row's elastic half and
              the submit cluster beside it never has to move. Inside it, the
              model NAME is the one thing that gives: it is the long value and
              the only one with anything to lose, where an effort word is three
              to ten characters and truncating it would leave "Extra hi…". Two
              pills where there was one is what made this matter — the row
              stopped having 400px of slack the moment effort joined it.

              EVERY CONTROL IN THIS ROW IS THE LADDER'S 20px RUNG, one step
              below the 24px it used to wear, and one row's worth of comments
              is where that decision belongs rather than at each of the four
              call sites. It is the other half of the answer to a footer that
              outweighed its own subject. Both bands carried 16px of padding,
              so the CONTENT decided which one won: a 24px control row came to
              40.54px against a 20px message line's 36px, and the chrome ended
              up 12.6% taller than the thing it serves and 52% of a 77.65px
              shell. At 20px the band is 32px, the message is the taller object
              by 4px, and the composer collapses to 69px.

              A rung, not a shrink. `xs` is the bottom of the app's own four
              rung pill ladder (20/24/28/32) and it is what the queued rows
              already wear; the composer's resting chrome has no business
              standing taller than the sentence being written into it. What
              does NOT step down is the hierarchy inside the row — submit is
              still the only filled object in it, and fill outranks 4px. */}
          {/* AND IT WRAPS ONCE, AT A POINT THE MODEL PILL CHOOSES. The chat
              pane is genuinely narrow in the app's own default layout — 940px
              window minimum, less the 60px workspace rail, the sidebar panel,
              the framed card's 9px and a ticket's 300px right rail, leaves the
              composer 265px of usable width — and at that width the row had a
              44px submit cluster and a 111px effort chip taking everything, so
              the model name was crushed to 36px and then to 3px. A pill naming
              nothing is not a smaller pill; it is a control that has stopped
              being one.

              So the model NAME still gives first, exactly as the row's own rule
              says, and it stops giving at a floor it can still be read at
              ({@link ModelPill}). Past that floor the pills no longer fit
              beside each other and the effort chip takes its own line rather
              than either of them shrinking into illegibility. ONE break point,
              not reflow: `flex-wrap` here can only ever move the second of two
              chips, and the submit cluster is outside this box, so it does not
              move at all — which is the whole reason the row was built with the
              cluster as the fixed half. */}
          <PromptInputTools className="min-w-0 flex-1 flex-wrap">
            {onAttachFiles === undefined ? null : (
              <ComposerAttachButton
                onFiles={onAttachFiles}
                imagesUnsupported={imagesUnsupported === true}
              />
            )}
            <ModelPill
              models={models}
              selection={selection}
              selectionProviderLabel={selectionProviderLabel}
              disabled={modelChoiceDisabled}
              onChange={onSelectionChange}
            />
            {/* A peer of the model pill, not a property of it. Effort is the
                per-task decision and model is the set-and-forget one, so the
                volatile choice is the one that is readable without opening
                anything. It renders only where there is a choice to make: a
                model with one level has no decision, and a control naming one
                option is worse than no control — the same rule the pill itself
                follows when nothing is pickable. */}
            {effortStops.length > 1 ? (
              <EffortPill
                levels={effortStops}
                value={selection.reasoningLevel}
                disabled={modelChoiceDisabled}
                onChange={(reasoningLevel) => onSelectionChange({ ...selection, reasoningLevel })}
              />
            ) : null}
          </PromptInputTools>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {/* The Session's standing fact, beside the controls that act on the
                turn but before them: it is read, not pressed, most of its life.
                Absent — not zero — until a first reply has been metered. */}
            {contextUsage ? <ContextUsagePill usage={contextUsage} /> : null}
            {working ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Stop turn"
                onClick={onStop}
              >
                {/* One of the few glyphs that keeps its fill: a stop square MEANS
                  solid the way a play triangle does, and hollow it reads as a
                  checkbox. It is also the exception rather than the category —
                  it only exists while a turn is running. */}
                <SquareIcon className="size-3" weight="fill" />
              </Button>
            ) : null}
            {/* Three words for one control, and the third one outranks the
                other two: a turn is live for the whole of a blocked question,
                so "Queue" is what this said while the words being typed were
                the very thing the turn was waiting for — and a queue that
                drains into an idle Session could not have released them until
                after the question they answer had been answered some other
                way. */}
            <PromptInputSubmit
              status="ready"
              size="icon-xs"
              disabled={!canSubmit}
              aria-label={answering ? "Answer" : working ? "Queue" : "Send"}
            >
              {/* 12px, and therefore both `bold`. The house rule is that
                  `bold`'s flat 1.50x is the small-size tier — at ≤12px regular
                  draws lighter than the label beside it — and coverage is
                  scale-invariant, so nothing about a smaller button can be
                  answered by a bigger glyph. Queue was outline at 14px and had
                  no reason to change until the button did. */}
              {working && !answering ? (
                <QueueIcon className="size-3" weight="bold" />
              ) : (
                <ArrowUpIcon className="size-3" weight="bold" />
              )}
            </PromptInputSubmit>
          </div>
        </PromptInputFooter>
      </PromptInput>
    </ComposerPickerStack>
  );
});

/* ------------------------------------------------------------------ picker */

/** The caret bindings the stack owns and the textarea below it consumes. */
interface ComposerCaretBinding {
  ref: React.RefCallback<HTMLTextAreaElement>;
  /** Consumes the picker's keys. `true` means the composer must not act on it. */
  handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): boolean;
  trackCaret(element: HTMLTextAreaElement): void;
}

/**
 * Inert by default, so a textarea rendered outside a stack is a plain textarea
 * rather than a crash. Nothing in the app does that; the Lab could.
 */
const ComposerCaretContext = React.createContext<ComposerCaretBinding>({
  ref: () => undefined,
  handleKeyDown: () => false,
  trackCaret: () => undefined,
});

/**
 * The picker card, the composer under it, and the one piece of state they
 * share.
 *
 * This exists because {@link SessionComposer} is a plain function of its props
 * and stays that way: it renders four states from a fixture gallery with no
 * adapter behind it, and the tests read its element tree directly. A caret is
 * genuinely local view state — the one thing a controlled textarea does not
 * hand back — so it lives here, in the one component that has both the list
 * that reacts to it and the input that produces it beneath it.
 */
function ComposerPickerStack({
  children,
  ...input
}: React.PropsWithChildren<{
  value: string;
  onValueChange(value: string): void;
  ready: boolean;
  interactionOpen: boolean;
  promptTemplates: readonly PromptTemplate[];
  skills: readonly SkillReference[];
  verbs: readonly ComposerVerb[];
  files: readonly IndexedFile[];
  onFilePickerOpen?(): void;
  textareaRef?: React.Ref<HTMLTextAreaElement>;
}>) {
  const picker = useComposerPicker(input);
  return (
    // NORMAL FLOW, and it has to stay that way. `chat-plane.tsx` measures the
    // whole bottom mount with a ResizeObserver and publishes it as
    // `--composer-height`; the transcript pads its bottom by that plus the
    // fade, and the scroll button hangs off it. Because the picker is a
    // *sibling above the input inside that measured box*, opening it grows the
    // box, the feed's clearance grows with it, and the last message rides up —
    // while the composer, being the last child of a bottom-anchored container,
    // does not move at all.
    //
    // An absolutely-positioned or portalled picker would look identical on an
    // empty transcript and then quietly cover the reader's last message on a
    // full one, because it would contribute no height for anything to clear.
    <div data-slot="composer-picker-stack" className="flex flex-col gap-2">
      <ComposerPicker
        mode={picker.state?.mode ?? null}
        rows={picker.rows}
        active={picker.active}
        onActiveChange={picker.setActive}
        onSelect={picker.select}
      />
      <ComposerCaretContext.Provider value={picker.binding}>
        {children}
      </ComposerCaretContext.Provider>
    </div>
  );
}

/** The message box. Its keystrokes belong to three owners, checked in order. */
function ComposerTextarea({
  value,
  ready,
  answering,
  onValueChange,
  onSteer,
  queued,
  onQueuedChange,
}: {
  value: string;
  ready: boolean;
  /** The open question takes these words — see {@link SessionComposerProps.answering}. */
  answering: boolean;
  onValueChange(value: string): void;
  onSteer(): void;
  queued: readonly QueuedMessage[];
  onQueuedChange(next: readonly QueuedMessage[]): boolean | void;
}) {
  const caret = React.useContext(ComposerCaretContext);
  return (
    <PromptInputTextarea
      ref={caret.ref}
      value={value}
      disabled={!ready}
      // A placeholder is not a name — it is gone the moment anyone types —
      // and this is the surface's primary input. Under an open question the
      // name changes with the destination: the words go into that question's
      // answer, and "Message" would be the one word for it that is wrong.
      // `Your answer` is the card's own field asking (`interaction-ui.tsx`),
      // said here because this box IS that field for as long as the question
      // stands — the card does not draw a second one.
      aria-label={answering ? "Answer" : "Message"}
      placeholder={answering ? "Your answer" : "Ask, plan, or implement…"}
      // FOUR LINES AT REST: 8 + (4 × 20) + 8 = 96px, which is `min-h-24`
      // against `text-sm`'s 20px leading and the `py-2` below.
      //
      // This floor was 36px — one line — on the reasoning that
      // `field-sizing-content` grows the box from the first keystroke, so
      // reserving lines nobody had typed was space spent on nothing. True
      // about the pixels and wrong about the box. An input's resting size is
      // the sentence it says it wants, and one line asks for one line: it
      // reads as a search field, and it makes the first thought you have here
      // scroll before the second one arrives. What gets typed into this is a
      // paragraph — ask, plan, or implement — so the floor is the paragraph,
      // and growth past four lines is the exception the auto-grow is for.
      //
      // `py-2` STAYS, and now for its own reason rather than as the pair of a
      // 36px floor: the vendored `py-4` is sized for a box whose whole height
      // is padding plus one line, and at four lines that lid and floor are
      // simply a wide margin above and below a block of text. 8px keeps the
      // first line clear of the top edge without framing the paragraph.
      className="min-h-24 py-2 text-sm"
      onChange={(event) => {
        caret.trackCaret(event.currentTarget);
        onValueChange(event.currentTarget.value);
      }}
      // Both, and both are needed. `onSelect` covers what the mouse does —
      // clicking into an existing `@path`, dragging a selection. `onKeyUp`
      // covers the caret keys, which React's synthetic select event did NOT
      // reliably report here: ←/→/Home/End moved the caret with the picker
      // none the wiser, so clicking back into a ref opened the list and
      // arrowing back into one did not.
      onSelect={(event) => caret.trackCaret(event.currentTarget)}
      onKeyUp={(event) => caret.trackCaret(event.currentTarget)}
      onKeyDown={(event) => {
        // A modified ⏎ is an explicit send; the picker never takes it.
        if (!event.metaKey && !event.ctrlKey && caret.handleKeyDown(event)) return;
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          // Steer bypasses the form entirely, so the enclosing ⏎ handler never
          // sees a keystroke that means something else.
          event.preventDefault();
          onSteer();
          return;
        }
        if (event.key === "Backspace" && event.currentTarget.value === "" && queued.length > 0) {
          event.preventDefault();
          const taken = unqueueLast(queued);
          if (!taken) return;
          if (onQueuedChange(taken.queue) === false) return;
          onValueChange(taken.text);
        }
      }}
    />
  );
}

/** What {@link useComposerPicker} hands the stack's render and its textarea. */
interface ComposerPickerHandle {
  /** The token being completed, for the code that writes over it. */
  state: ComposerPickerState | null;
  /** What the card draws — held apart from the token because it may lag it. */
  rows: readonly ComposerPickerRow[];
  active: string;
  setActive(value: string): void;
  select(row: ComposerPickerRow): void;
  binding: ComposerCaretBinding;
}

/** One array, so a closed picker does not mint a fresh empty one per render. */
const NO_PICKER_ROWS: readonly ComposerPickerRow[] = [];

/**
 * The caret-driven picker, kept out of the composer's render.
 *
 * Three pieces of state, and each earns its place. The **caret** is the one
 * thing a controlled textarea does not hand back on its own, and the whole
 * trigger is a function of it. The **active row** is a highlight, not a
 * document fact. **Dismissal** is what makes Escape mean something durable.
 *
 * What is NOT here is any decision: whether those three add up to an open
 * picker is `composerPickerTarget`'s, in the pure module beside this one, what
 * that token offers is `composerPickerRows`', and so is what a picked row
 * writes. This hook holds state, forwards keys, and decides only one thing the
 * pure module cannot — which of those two answers may lag the keystroke.
 */
function useComposerPicker(input: {
  value: string;
  onValueChange(value: string): void;
  ready: boolean;
  interactionOpen: boolean;
  promptTemplates: readonly PromptTemplate[];
  skills: readonly SkillReference[];
  verbs: readonly ComposerVerb[];
  files: readonly IndexedFile[];
  onFilePickerOpen?(): void;
  textareaRef?: React.Ref<HTMLTextAreaElement>;
}): ComposerPickerHandle {
  const { value, onValueChange, ready, interactionOpen, promptTemplates, skills, verbs, files } =
    input;
  const [caret, setCaret] = React.useState(0);
  const [active, setActive] = React.useState("");
  const [dismissed, setDismissed] = React.useState<ComposerPickerDismissal | null>(null);

  const nodeRef = React.useRef<HTMLTextAreaElement | null>(null);
  // Where the caret must land once React has committed a programmatic edit.
  // Set during the insert, applied in the layout effect below — the DOM caret
  // would otherwise sit at the end of the replaced text, which for an expanded
  // template is hundreds of characters from where the reader is looking.
  const pendingCaret = React.useRef<number | null>(null);

  const forwarded = input.textareaRef;
  const textareaRef = React.useCallback<React.RefCallback<HTMLTextAreaElement>>(
    (node) => {
      nodeRef.current = node;
      if (typeof forwarded === "function") forwarded(node);
      else if (forwarded) forwarded.current = node;
    },
    [forwarded],
  );

  React.useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null) return;
    pendingCaret.current = null;
    const node = nodeRef.current;
    if (node === null) return;
    node.focus();
    node.setSelectionRange(at, at);
  });

  // A dismissal outlives its token only if nothing retires it, and the caret
  // leaving is what retires it. Without this, clearing the box and typing a
  // fresh message whose `@` lands at the same offset would silently inherit an
  // Escape from the message before it.
  const inToken = composerPickerToken({ text: value, caret }) !== null;
  React.useEffect(() => {
    if (!inToken) setDismissed(null);
  }, [inToken]);

  // WHERE THE PICKER WRITES — urgent, and it may never lag the caret. This is a
  // handful of character-class tests, and {@link applyPickerRow} overwrites the
  // `from`/`to` span it names: a span one keystroke behind the text would write
  // the completion over the wrong range and leave what was typed since dangling
  // to the right of it.
  const target = composerPickerTarget({
    text: value,
    caret,
    ready,
    interactionOpen,
    dismissed: inToken ? dismissed : null,
  });
  const mode = target?.mode ?? null;
  const from = target?.from ?? 0;
  const to = target?.to ?? 0;
  const query = target?.query ?? "";

  // WHAT IT OFFERS — deferred, because it is the one expensive thing on this
  // surface. `@` ranks the WHOLE project file index (filter, score, sort, slice
  // — O(n log n) over an unbounded array) and it used to run in the same commit
  // as the controlled textarea's own value update, so on a large repo every
  // keystroke waited on a sort of the repo before the character appeared. The
  // textarea's value stays urgent; the list is allowed to arrive a frame or two
  // later, which is what a list is for.
  //
  // THE MODE IS DELIBERATELY NOT DEFERRED. Only the query is. A deferred mode
  // would make the frame that OPENS the picker rank against `null` — the card
  // would arrive saying "No match" and fill in afterwards, which is worse than
  // arriving late. A mode change is one keystroke (`/`, `@`, or leaving a
  // token) and pays for its ranking on that keystroke alone; a query change is
  // every keystroke after it, and those are the ones that had to stop paying.
  const deferredQuery = React.useDeferredValue(query);
  const rows = React.useMemo(
    () =>
      mode === null
        ? NO_PICKER_ROWS
        : composerPickerRows({
            mode,
            query: deferredQuery,
            templates: promptTemplates,
            skills,
            verbs,
            files,
          }),
    [deferredQuery, files, mode, promptTemplates, skills, verbs],
  );
  // Rebuilt every render on purpose: the token half moves with the caret, so
  // this object is genuinely new whenever it is different, and nothing holds it
  // across renders. The card is handed `mode` and `rows` instead of this —
  // three of these four fields are things it does not draw, and passing them
  // was re-rendering fifty list rows per keystroke to redraw the same fifty.
  const state: ComposerPickerState | null = mode === null ? null : { mode, from, to, query, rows };

  // The open EDGE, not every render: `refresh()` is cache-gated, but calling it
  // on each keystroke would still be a call per keystroke.
  const fileMode = mode === "file";
  const { onFilePickerOpen } = input;
  React.useEffect(() => {
    if (fileMode) onFilePickerOpen?.();
  }, [fileMode, onFilePickerOpen]);

  // Derived rather than reset: a re-ranked list can drop the row the highlight
  // named, and falling back to the first one means ⏎ always has a target
  // without an effect racing the render that changed the list.
  const activeValue = activePickerRow(rows, active)?.value ?? "";

  const select = (row: ComposerPickerRow): void => {
    if (state === null) return;
    const applied = applyPickerRow({ text: value, state, row });
    pendingCaret.current = applied.caret;
    setCaret(applied.caret);
    setDismissed(null);
    onValueChange(applied.text);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (state === null) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      // The app's Esc guard would read this as "leave the surface". Closing a
      // list you opened by typing is not leaving anything.
      event.stopPropagation();
      setDismissed({ mode: state.mode, from: state.from });
      return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive(movePickerActive(rows, activeValue, event.key === "ArrowDown" ? 1 : -1));
      return true;
    }
    // Shift+⏎ is a newline and Tab is not a completion key here — the composer
    // has no other tab stop to compete with, but a Tab that rewrote the box
    // would break the one gesture that reliably leaves a text field.
    if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
      const row = activePickerRow(rows, activeValue);
      if (row === null) return false;
      event.preventDefault();
      select(row);
      return true;
    }
    return false;
  };

  /**
   * ONE BINDING OBJECT FOR THE LIFE OF THE COMPOSER, and it has to be one.
   *
   * This is a CONTEXT VALUE, and a fresh one re-renders every consumer whatever
   * React.memo says — the same fact `ticket-dialog-host.tsx` is built around.
   * It was a new object with two new closures on every render, and the render
   * that matters here is the one nothing else causes: a caret move. Arrowing or
   * clicking through a long draft changes `caret` and nothing else, so
   * `SessionComposer` does not re-render, `children` is the element it already
   * was, and React would bail the whole input subtree out — except that the
   * churning context value dragged the textarea back in with it.
   *
   * Neither handler can be a `useCallback`: both read the token, the rows and
   * the active row, all of which change on the keystroke. So both are held by
   * ref and reached through a stable wrapper — the latest-callback pattern.
   * `select` gets the same treatment for a second reason: it is the picker
   * card's `onSelect`, and the card is memoized on rows that deliberately do
   * not change on most keystrokes.
   *
   * Writing the refs in a layout effect rather than during render is what keeps
   * this correct under concurrent rendering: a render React discards must not
   * leave its handler behind, and both of these run after a commit.
   */
  const latest = React.useRef({ handleKeyDown, select });
  React.useLayoutEffect(() => {
    latest.current = { handleKeyDown, select };
  });
  const forwardKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean =>
      latest.current.handleKeyDown(event),
    [],
  );
  const forwardSelect = React.useCallback((row: ComposerPickerRow): void => {
    latest.current.select(row);
  }, []);
  const trackCaret = React.useCallback((element: HTMLTextAreaElement): void => {
    setCaret(element.selectionStart ?? 0);
  }, []);
  const binding = React.useMemo<ComposerCaretBinding>(
    () => ({ ref: textareaRef, handleKeyDown: forwardKeyDown, trackCaret }),
    [forwardKeyDown, textareaRef, trackCaret],
  );

  return { state, rows, active: activeValue, setActive, select: forwardSelect, binding };
}

/* ------------------------------------------------------------------- model */

/**
 * One model, one caret.
 *
 * Every model here is one the Session could run right now. There is no state on
 * it because a model you cannot send to is not an option in a different colour,
 * it is not an option: the list is filtered before it arrives (see
 * `chat-plane.tsx`), on the same rule the mode segment and the pill itself
 * follow — a control naming something the harness will refuse is worse than no
 * control.
 */
export interface ComposerModel {
  id: string;
  providerId: string;
  providerLabel: string;
  modelId: string;
  label: string;
  reasoningLevels: readonly string[];
}

export interface ComposerModelSelection {
  providerId: string;
  modelId: string;
  reasoningLevel: string;
}

/**
 * The models a picker may offer, out of everything Model Access knows.
 *
 * Two filters and one mapping, in one place because two surfaces now ask the
 * question: this composer, and the New-ticket composer's Create & start row
 * (VC-56). Signed-in models only — Pi's catalog is every provider it knows,
 * around a thousand models against the handful this profile has credentials
 * for, and a picker listing the rest is a picker whose first "GPT-5.6 Luna" is
 * whichever provider sorted first. Then the user's own curation comes off
 * (`visibleModels`): what you toggled out of Model Access is not an option
 * either. Catalog order is preserved throughout — it is the harness's answer to
 * which provider matters, and re-sorting it here would be our opinion.
 */
export function offerableModels(
  models: readonly ModelAccessModel[],
  providers: readonly ModelAccessProvider[],
  hidden: readonly HiddenModelRef[],
): readonly ComposerModel[] {
  return visibleModels(
    models.filter((model) => model.state === "available"),
    hidden,
  ).map((model) => ({
    id: `${model.providerId}/${model.modelId}`,
    providerId: model.providerId,
    providerLabel:
      providers.find((provider) => provider.id === model.providerId)?.label ?? model.providerId,
    modelId: model.modelId,
    label: model.label,
    reasoningLevels: model.reasoningLevels,
  }));
}

/** The selected model's own stop set, or nothing when the list does not hold it. */
function effortLevels(
  models: readonly ComposerModel[],
  selection: ComposerModelSelection,
): readonly string[] {
  return selectedModel(models, selection)?.reasoningLevels ?? [];
}

function selectedModel(
  models: readonly ComposerModel[],
  selection: ComposerModelSelection,
): ComposerModel | undefined {
  return models.find(
    (candidate) =>
      candidate.providerId === selection.providerId && candidate.modelId === selection.modelId,
  );
}

/**
 * `sonnet-4.5`, or `Azure OpenAI · gpt-5.6-luna` where the name alone would not
 * say which model this is.
 *
 * A model name is not unique across providers, and this pill runs into that
 * twice. A selection the list does not hold — the Session is pinned to a
 * provider nobody is signed in to — falls back to its raw id, which is the same
 * id a signed-in provider may also carry; and two listed providers can both
 * ship a model called "GPT-5.6 Luna". Both read as an ordinary pill naming a
 * model that is not the one this Session will send to. Where the name is
 * ambiguous the provider leads it, exactly as Settings' model rows do.
 *
 * The effort level used to ride along as a third term. It does not any more:
 * effort is its own chip beside this one, and a bare level word appended to a
 * model name is read as a claim about the *model* — `gpt-5.6-luna · low` says
 * "a low model" long before it says "thinking set to low". One fact per pill.
 */
export function modelPillLabel(
  models: readonly ComposerModel[],
  selection: ComposerModelSelection,
  /** The Session's provider as the catalog names it, for a model no longer listed. */
  selectionProviderLabel?: string,
): string {
  const model = selectedModel(models, selection);
  const name = model?.label ?? selection.modelId;
  if (!name) return "Model";
  const ambiguous =
    model === undefined ||
    models.some((candidate) => candidate !== model && candidate.label === name);
  return ambiguous
    ? `${model?.providerLabel ?? selectionProviderLabel ?? selection.providerId} · ${name}`
    : name;
}

/**
 * Exported for the New-ticket composer, which picks the model a Ticket Session
 * will be BORN with (VC-56). The two surfaces answer the same question one
 * moment apart — what will this Session run as — so a second pill shaped
 * slightly differently would be the same control drawn twice.
 */
export function ModelPill({
  models,
  selection,
  selectionProviderLabel,
  disabled,
  onChange,
}: {
  models: readonly ComposerModel[];
  selection: ComposerModelSelection;
  selectionProviderLabel?: string;
  disabled: boolean;
  onChange(next: ComposerModelSelection): void;
}) {
  const [open, setOpen] = React.useState(false);
  // First-appearance order: the catalog's own ordering is the harness's answer
  // to "which provider matters", and re-sorting it here would be our opinion.
  const providers = models.reduce<Array<{ id: string; label: string }>>((result, model) => {
    if (!result.some((provider) => provider.id === model.providerId)) {
      result.push({ id: model.providerId, label: model.providerLabel });
    }
    return result;
  }, []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={disabled || models.length === 0}
          // `shrink` against `Button`'s own `shrink-0`: this is the row's give.
          //
          // AND THE BASIS IS WHAT ORDERS THE GIVE AGAINST THE WRAP. In a
          // wrapping row the line breaks on an item's flex BASIS, not on the
          // width it would shrink to — so with `basis-auto` this pill kept its
          // full natural width and the effort chip dropped to a second line the
          // moment the two no longer fitted side by side at full size, which
          // measured as a 24px-taller composer at 420px while there was still
          // room to simply truncate. `basis-22` is the 88px floor (a 56px label
          // plus this button's own 32px of caret and padding), so the line only
          // breaks once the NAME has already given everything it has; `grow`
          // then spends whatever is left on the label, and `max-w-max` stops it
          // spending more than the name is wide — a ghost button stretched to
          // the full row is a hover target the size of the footer.
          className="min-w-0 max-w-max shrink grow basis-22 text-muted-foreground"
        >
          {/* THE GIVE HAS A FLOOR, and 3.5rem is where it is. This is the row's
              elastic member and it should be — a model name is the long value
              and the only one with anything to lose. What it was doing instead
              was losing everything: measured in a 313px chat pane (the app's
              own default at its 940px window minimum) this label came out 36px
              wide, and 3px in the pane one notch narrower. At 3px the pill is a
              caret and a gap, and the one fact it exists to carry is gone.

              56px holds roughly eight characters and an ellipsis at the ui
              size — enough to tell `sonnet-4.5` from `gpt-5.6-luna`, which is
              the question this control answers most of the time. Below it the
              footer wraps instead (see `PromptInputTools` above), so the floor
              is what CHOOSES that break rather than a width that overflows. */}
          <span className="min-w-14 truncate">
            {modelPillLabel(models, selection, selectionProviderLabel)}
          </span>
          <CaretUpDownIcon className="size-3 shrink-0" weight="bold" />
        </Button>
      </PopoverTrigger>
      {/* `w-72`, down from `w-80`: the extra 32px existed to hold the effort
          segment on the selected row, and past four levels it did not hold it
          anyway — the row that exists to name a model truncated the name to
          nothing so the qualifier could fit. Rows are model names now. */}
      <PopoverContent align="start" side="top" className="w-72 p-0">
        <PromptInputCommand>
          <PromptInputCommandInput placeholder="Model" />
          <PromptInputCommandList>
            <PromptInputCommandEmpty>No match</PromptInputCommandEmpty>
            {providers.map((provider) => (
              <PromptInputCommandGroup key={provider.id} heading={provider.label}>
                {models
                  .filter((model) => model.providerId === provider.id)
                  .map((model) => {
                    const selected =
                      model.providerId === selection.providerId &&
                      model.modelId === selection.modelId;
                    return (
                      // A model row, and only a model row. It used to carry the
                      // effort segment on whichever row was selected — up to
                      // seven pressable buttons inside a listbox option, kept
                      // from also picking the row by a `stopPropagation`. Effort
                      // is a chip in the footer now, so the workaround and the
                      // thing it worked around both left together.
                      <PromptInputCommandItem
                        key={model.id}
                        value={`${model.providerId} ${model.modelId} ${model.label}`}
                        onSelect={() => {
                          onChange({
                            ...selection,
                            providerId: model.providerId,
                            modelId: model.modelId,
                            // The stop set changes under the effort chip when
                            // the model does; a level the incoming model cannot
                            // run is rewritten rather than held.
                            reasoningLevel: reclampEffort(
                              model.reasoningLevels,
                              selection.reasoningLevel,
                            ),
                          });
                          setOpen(false);
                        }}
                      >
                        <CheckIcon
                          className={cn("size-3.5 shrink-0", !selected && "invisible")}
                          weight="bold"
                        />
                        <span className="min-w-0 flex-1 truncate">{model.label}</span>
                      </PromptInputCommandItem>
                    );
                  })}
              </PromptInputCommandGroup>
            ))}
          </PromptInputCommandList>
        </PromptInputCommand>
      </PopoverContent>
    </Popover>
  );
}
