/**
 * The Session composer.
 *
 * Three ideas, and the shape follows from them:
 *
 *  1. **Model and effort are peers until width makes two controls costlier than
 *     the distinction.** Provider stays a heading inside the model popover,
 *     because it is not a decision you make on its own — you pick a model and
 *     the provider follows. Effort is the per-task half of the same sentence;
 *     at ordinary widths it sits beside the model as its own chip
 *     (`composer-effort-ui.tsx`). Below 24rem the model face names both values
 *     and its popover adds the same effort slider, leaving one configuration
 *     control rather than wrapping two; below 18rem even the printed value goes
 *     and the face keeps the model, because past that point the word is paid
 *     for out of the model name's own give — the measurements are in
 *     `globals.css` beside the rule. The value is never lost, only unprinted:
 *     the trigger's accessible name and the slider under it still carry it. An
 *     executor that pins its own model
 *     renders no pill at all rather than a disabled one, on the same rule as
 *     the mode segment below: a control naming models the harness will drop is
 *     worse than no control.
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
  StopIcon,
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
  acceptsImageInputIn,
  AGENT_MODEL_TIERS,
  DEFAULT_MODEL_PICKER_VIEW,
  errorMessage,
  expandCommandInvocation,
  isModelHidden,
  modelTierRow,
  offeredComposerVerbs,
  resolveModelTier,
  visibleModels,
  type AgentModelTier,
  type HiddenModelRef,
  type ComposerVerb,
  type IndexedFile,
  type ModelAccessDefaults,
  type ModelAccessModel,
  type ModelAccessProvider,
  type ModelPickerView,
  type PromptResource,
  type PromptTemplate,
  type SkillReference,
} from "@volli/shared";

import {
  composerIntent,
  effortLabel,
  reclampEffort,
  takeQueued,
  unqueueLast,
  type ComposerIntent,
  type QueuedMessage,
  type SessionContextUsage,
  type TakenQueued,
} from "@volli/session-presentation";
import type { BlobLinkView } from "@volli/shared";
import {
  AttachmentStrip,
  AttachmentThumbRow,
} from "@renderer/components/attachments/attachment-strip";
import { fileAttachHandlers } from "@renderer/components/attachments/file-drop";
import {
  activePickerRow,
  applyPickerRow,
  composerPickerRows,
  composerPickerTarget,
  composerPickerToken,
  insertPickerTrigger,
  movePickerActive,
  type ComposerPickerDismissal,
  type ComposerPickerRow,
  type ComposerPickerState,
} from "@renderer/chat/composer-picker";
import { ComposerAddMenu } from "@renderer/components/chat/composer-add-menu";
import {
  ComposerCaretContext,
  useComposerCaretBinding,
  type ComposerCaretBinding,
} from "@renderer/components/chat/composer-caret";
import {
  COMPOSER_CONFIG_CHIP,
  COMPOSER_CONTROL_SIZE,
  PROMPT_SURFACE,
  COMPOSER_GLYPH_WEIGHT,
  COMPOSER_PRIMARY_SIZE,
} from "@renderer/components/chat/composer-chrome";
import { EffortPill, EffortSlider } from "@renderer/components/chat/composer-effort-ui";
import { ContextUsagePill } from "@renderer/components/chat/context-usage-ui";
import { ComposerPicker } from "@renderer/components/chat/composer-picker-ui";
import { ModelMark, ModelName } from "@renderer/components/models/model-identity";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@renderer/components/ui/tooltip";
import { Segmented } from "@renderer/components/ui/segmented";
import { useModelAccessClient } from "@renderer/lib/model-access-client";
import { toastError } from "@renderer/lib/toast";
import { cn } from "@renderer/lib/utils";

export interface SessionComposerProps {
  value: string;
  onValueChange(value: string): void;
  /** Lets a decision elsewhere in the Session hand the cursor back to the reader. */
  textareaRef?: React.Ref<HTMLTextAreaElement>;
  /** A row action removed its focused control; hand focus to the persistent input. */
  onComposerFocusRequest?(): void;
  models: readonly ComposerModel[];
  /** The user's tier table, which gives the pill its Defaults view (VC-259). */
  tiers?: readonly ComposerTierRow[];
  selection: ComposerModelSelection;
  /** The Session's provider as the catalog names it — see {@link modelPillLabel}. */
  selectionProviderLabel?: string;
  /**
   * The tier's label where the Session's model was resolved from a named
   * tier (VC-259) — "Fast" — and null where it was chosen by exact id. Read
   * beside the model, never in place of it: the pill's fact is still the
   * model this Session sends to.
   */
  selectionTier?: string | null;
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
  /**
   * The verbs the `/` picker offers — the actions that run instead of
   * sending. Caller's supply, because the offer rule reads Session facts this
   * box does not have (whether a turn is live is here as `working`; whether
   * there is a reply to copy is not). The fallback when absent is the same
   * rule with no reply behind it, so a caller that passes nothing still gets
   * an honest list rather than every verb regardless of state.
   */
  verbs?: readonly ComposerVerb[];
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
   * A queued row came back for editing, and its files return with it (VC-137).
   * The parent owns the strip, so the row's attachments hand back through
   * here rather than the box minting a second copy of them.
   */
  onRestoreAttachments?(attachments: readonly BlobLinkView[]): void;
  /**
   * The selected model takes no image input, so the affordance says so rather
   * than letting a picture be attached to a model that cannot see it.
   */
  imagesUnsupported?: boolean;
  /**
   * The model picker's open state, when a caller needs to open it from
   * elsewhere — `/model`'s press is the one there is. Optional and
   * uncontrolled by default, so a composer that never opens it by typing
   * keeps its own state exactly as before.
   */
  modelPickerOpen?: boolean;
  /** The other half of a controlled model picker — the popover's own close travels back through here. */
  onModelPickerOpenChange?(open: boolean): void;
  className?: string;
}

const NO_TEMPLATES: readonly PromptTemplate[] = [];
const NO_SKILLS: readonly SkillReference[] = [];
const NO_FILES: readonly IndexedFile[] = [];
const NO_ATTACHMENTS: readonly BlobLinkView[] = [];
/**
 * The fallback verb supplies, precomputed for the four combinations of the two
 * facts this box holds by itself.
 *
 * Module scope rather than a `useMemo`, for two independent reasons: the
 * picker's ranking memo takes `verbs` as a dependency, so a fresh array per
 * render would re-rank the whole file index on every keystroke; and this
 * component's body must stay hook-free, because the tests call it directly to
 * read the tree it returns (`SessionComposer.type`).
 *
 * Only what this box can see is claimed — `hasReply` and `hasProject` read
 * false, so the honest consequence is a shorter list rather than a row that
 * would refuse the press. The plane passes its own supply, where all four
 * facts are real; this is for the caller that has no Session behind it.
 */
const FALLBACK_VERBS = {
  idle: {
    withModels: offeredComposerVerbs({
      working: false,
      hasReply: false,
      hasModels: true,
      hasProject: false,
    }),
    none: offeredComposerVerbs({
      working: false,
      hasReply: false,
      hasModels: false,
      hasProject: false,
    }),
  },
  working: {
    withModels: offeredComposerVerbs({
      working: true,
      hasReply: false,
      hasModels: true,
      hasProject: false,
    }),
    none: offeredComposerVerbs({
      working: true,
      hasReply: false,
      hasModels: false,
      hasProject: false,
    }),
  },
} as const;

function fallbackVerbs(working: boolean, hasModels: boolean): readonly ComposerVerb[] {
  return FALLBACK_VERBS[working ? "working" : "idle"][hasModels ? "withModels" : "none"];
}

/**
 * One row out of the queue and back into the box, in the ONE order that keeps
 * its files (VC-137).
 *
 * The attachments rejoin the strip BEFORE the row leaves the queue, because
 * the plane reads the strip to tell "this row came back" (keep its links) from
 * "this row was deleted" (detach them) — see `detachableRowAttachments`.
 * Restoring after the removal would read as a delete and drop the very links
 * the edit needs.
 *
 * Both ways back — the row's Edit action and `⌫` on an empty box — go through
 * here rather than each spelling the order out, because two copies of an
 * order-critical rule is one copy too many for the next person to reorder.
 *
 * `false` when the queue refused the change, so the caller leaves the text be.
 */
function takeRowBack(
  taken: TakenQueued,
  onRestoreAttachments: ((attachments: readonly BlobLinkView[]) => void) | undefined,
  onQueuedChange: (next: readonly QueuedMessage[]) => boolean | void,
): boolean {
  if (taken.attachments !== undefined && taken.attachments.length > 0) {
    onRestoreAttachments?.(taken.attachments);
  }
  return onQueuedChange(taken.queue) !== false;
}

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
  tiers,
  selection,
  selectionProviderLabel,
  selectionTier = null,
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
  verbs,
  files = NO_FILES,
  onFilePickerOpen,
  interactionOpen = false,
  contextUsage = null,
  attachments = NO_ATTACHMENTS,
  onAttachFiles,
  onRemoveAttachment,
  onRestoreAttachments,
  imagesUnsupported = false,
  modelPickerOpen,
  onModelPickerOpenChange,
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
  //
  // The FILES are the opposite: text cannot carry them, so they go back to
  // the strip (VC-137) — unqueue must never be a way to lose a screenshot the
  // message still needs, and ⏎ will carry them again exactly as before. Both
  // ways back share that order through {@link takeRowBack}.
  const editQueued = (id: string) => {
    const taken = takeQueued(queued, id);
    if (!taken) return;
    editedQueueId = id;
    if (!takeRowBack(taken, onRestoreAttachments, onQueuedChange)) return;
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
      // The caller's supply, or the same offer rule with no reply behind it.
      // A verb RUNS — it is not queued and does not join a turn in flight —
      // so the verbs a live turn would refuse are already out of whichever
      // list this is, decided by `offeredComposerVerbs` beside the rule
      // itself. Typing one anyway still reaches the press, which hands the
      // words back in words, exactly as a runtime refusal does.
      verbs={verbs ?? fallbackVerbs(working, models.length > 0)}
      files={files}
      onFilePickerOpen={onFilePickerOpen}
      textareaRef={textareaRef}
    >
      <PromptInput
        data-composer-container=""
        className={cn(
          // `group/composer` names the box for anything inside that reads
          // its state; the picker card and the queued rows are groups' worth
          // of their own. `@container/composer` is what the footer's controls
          // measure themselves against (VC-335): the app's own narrowest chat
          // pane is 265px and a split can be narrower, and a control that
          // drops a word must drop it for the BOX's width, not the window's —
          // the tab strip's own rule.
          "group/composer @container/composer pointer-events-auto overflow-hidden transition-[color,border-color,box-shadow]",
          PROMPT_SURFACE,
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
                {/* The files ride the queued row through hold, queue and steer
                    (VC-137) but were never drawn, so a queued message with
                    three screenshots looked exactly like one with none
                    (VC-273). */}
                <AttachmentThumbRow attachments={entry.attachments ?? []} />
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
                      <span className="composer-steer-label">Steer</span>
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
              reads top to bottom.

              `w-full`, AND IT IS LOAD-BEARING. `PromptInputBody` is
              `display:contents`, so this strip is a flex CHILD of the vendored
              `InputGroup` — which is `items-center` and flips to a COLUMN
              once the footer's block-end addon mounts. In a column, `center`
              is the CROSS axis: a shrink-to-fit strip sat mid-composer with
              its one thumbnail floating over the textarea's centre while
              everything around it ran edge to edge (VC-137). `w-full` is the
              same rule the textarea below already follows. */}
          <AttachmentStrip
            attachments={attachments}
            {...(onRemoveAttachment === undefined ? {} : { onRemove: onRemoveAttachment })}
            // `px-4`: the tiles' left edge is the text's left edge, one inset
            // for everything the message is made of. It was `px-3`, a value
            // off the spacing ladder that put the first tile 4px left of the
            // first letter.
            className="w-full px-4 pt-2"
          />
          {/* Reads the caret bindings from the stack above rather than taking
              them as props: the picker card and this input are siblings, one
              thing has to hold the caret between them, and threading it back
              down by hand would make this composer own state it has spent its
              whole life not owning. */}
          <ComposerTextarea
            value={value}
            ready={ready}
            onValueChange={onValueChange}
            onSteer={() => send("steer")}
            queued={queued}
            onQueuedChange={onQueuedChange}
            onRestoreAttachments={onRestoreAttachments}
          />
        </PromptInputBody>

        {/* The tinted tray separates settings from the writing sheet. */}
        <PromptInputFooter>
          {/* Keep Add outside the wrapping settings: at 265px a live turn
              must not orphan it above the model and effort. The primary
              cluster stays fixed while the settings give in width, then wrap. */}
          <ComposerAddMenu
            {...(onAttachFiles === undefined ? {} : { onFiles: onAttachFiles })}
            imagesUnsupported={imagesUnsupported === true}
          />
          <PromptInputTools
            className={cn("min-w-0 flex-1 flex-wrap", working && "composer-live-config")}
          >
            <ModelPill
              models={models}
              tiers={tiers}
              selection={selection}
              selectionProviderLabel={selectionProviderLabel}
              selectionTier={selectionTier}
              disabled={modelChoiceDisabled}
              onChange={onSelectionChange}
              open={modelPickerOpen}
              onOpenChange={onModelPickerOpenChange}
              compactEffort={
                effortStops.length > 1
                  ? {
                      levels: effortStops,
                      value: selection.reasoningLevel,
                      onChange: (reasoningLevel) =>
                        onSelectionChange({ ...selection, reasoningLevel }),
                    }
                  : undefined
              }
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
                className="composer-separate-effort"
              />
            ) : null}
          </PromptInputTools>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {/* The Session's standing fact, beside the controls that act on the
                turn but before them: it is read, not pressed, most of its life.
                Absent — not zero — until a first reply has been metered. */}
            {contextUsage ? <ContextUsagePill usage={contextUsage} /> : null}
            {/* THE TURN'S TWO CONTROLS, AND BOTH ARE OBJECTS. Stop was a 20px
                ghost with a 12px square in it, beside a 20px filled Queue —
                the one control that ends a run drew like a hover affordance.
                It is `outline` at the primary's own rung: a real button with
                an edge, plainly the other of a pair, and plainly not the one
                that sends. Outline rather than the muted fill because on the
                dark canvases `--muted` is two steps off `--card` and a muted
                disc on the card simply vanished; the hairline is what holds it
                as a shape. Not destructive red, though T3 Code draws it so —
                ending a turn is an outcome the person chose, not an error, and
                this app keeps red for the latter. */}
            {working ? (
              <ComposerHint label="Stop turn">
                <Button
                  type="button"
                  variant="outline"
                  size={COMPOSER_PRIMARY_SIZE}
                  aria-label="Stop turn"
                  onClick={onStop}
                >
                  {/* One of the few glyphs that keeps its fill: a stop square
                      MEANS solid the way a play triangle does, and hollow it
                      reads as a checkbox. It is also the exception rather than
                      the category — it only exists while a turn is running. */}
                  <StopIcon weight="fill" />
                </Button>
              </ComposerHint>
            ) : null}
            {/* Two words for one control, and the turn decides which. This box
                sends messages and nothing else: a question standing above it is
                answered on its own card, through its own control (VC-289), so
                there is no third state in which this press means something else
                to something else.

                THE CHORDS LIVE ON THE HOVER. ⏎ sends, ⇧⏎ breaks a line, and
                while a turn is live ⏎ queues and ⌘⏎ steers — four keystrokes
                nothing on this surface named. A persistent hint line under the
                box is the field's other answer (omp-desktop) and it is copy
                under a control, which this app does not do; a tooltip on the
                control the chord replaces is the menus' own idiom for the same
                fact. */}
            <ComposerHint label={working ? "Queue ⏎ · Steer ⌘⏎" : "Send ⏎ · New line ⇧⏎"}>
              <PromptInputSubmit
                status="ready"
                className="prompt-primary rounded-control"
                size={COMPOSER_PRIMARY_SIZE}
                disabled={!canSubmit}
                aria-label={working ? "Queue" : "Send"}
                aria-keyshortcuts="Enter"
              >
                {/* `bold`, both: at 16px a regular arrow is a hairline on a
                    filled disc, and coverage is scale-invariant, so the weight
                    step is the only thing that fixes it. */}
                {working ? (
                  <QueueIcon weight={COMPOSER_GLYPH_WEIGHT} />
                ) : (
                  <ArrowUpIcon weight={COMPOSER_GLYPH_WEIGHT} />
                )}
              </PromptInputSubmit>
            </ComposerHint>
          </div>
        </PromptInputFooter>
      </PromptInput>
    </ComposerPickerStack>
  );
});

/**
 * A chord on hover, for the two controls whose keystroke nothing else names.
 *
 * `span` wrapper rather than the button itself, for the reason the New-ticket
 * footer's pair spells out: a disabled `Button` dispatches no pointer events,
 * and Send is disabled exactly while a first-timer is reading the row with
 * nothing typed yet. Its own provider, because this composer is drawn by the
 * fixture gallery and the lab outside the app shell that mounts the app-wide
 * one, and a Radix tooltip with none above it throws rather than degrading.
 */
function ComposerHint({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{children}</span>
        </TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/* ------------------------------------------------------------------ picker */

/**
 * Re-exported for the surfaces that learned the binding here (the Automation
 * editor); the contract itself lives in `composer-caret.ts` so the composer's
 * chrome can read it without importing this module.
 */
export { useComposerCaretBinding, type ComposerCaretBinding };

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
 *
 * Normal flow remains the default because chat measures this whole stack for
 * transcript clearance. Compact editors can opt into `overlay`: the card then
 * covers the top of their textarea without making the stack taller.
 */
export function ComposerPickerStack({
  children,
  layout = "flow",
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
  /** `flow` reserves height above the input; `overlay` covers it in place. */
  layout?: "flow" | "overlay";
}>) {
  const picker = useComposerPicker(input);
  const card = (
    <ComposerPicker
      mode={picker.state?.mode ?? null}
      rows={picker.rows}
      active={picker.active}
      onActiveChange={picker.setActive}
      onSelect={picker.select}
    />
  );

  return (
    // NORMAL FLOW BY DEFAULT, and it has to stay that way for chat.
    // `chat-plane.tsx` measures the whole bottom mount with a ResizeObserver
    // and publishes it as `--composer-height`; the transcript pads its bottom
    // by that plus the fade, and the scroll button hangs off it. Because the
    // picker is a sibling above the input inside that measured box, opening it
    // grows the feed's clearance instead of covering its last message.
    //
    // Overlay is deliberately opt-in for bounded editors whose textarea is the
    // space the suggestions may cover. The absolute layer contributes no flow
    // height and starts below the first input line, so the slash/caret that
    // opened it stays visible. Both inline insets pin its width to this relative
    // stack, while `min-w-0` lets a grid or flex parent shrink it below a long
    // row's intrinsic width. The layer itself ignores pointers so an
    // empty/animating edge never blocks the textarea; the card remains
    // `pointer-events-auto`, labelled by mode, and keyboard-driven from the
    // focused textarea.
    <div
      data-slot="composer-picker-stack"
      className={layout === "overlay" ? "relative flex min-w-0 flex-col" : "flex flex-col gap-2"}
    >
      {layout === "overlay" ? (
        <div
          data-slot="composer-picker-overlay"
          className="pointer-events-none absolute inset-x-0 top-10 z-10 min-w-0 max-w-full"
        >
          {card}
        </div>
      ) : (
        card
      )}
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
  onValueChange,
  onSteer,
  queued,
  onQueuedChange,
  onRestoreAttachments,
}: {
  value: string;
  ready: boolean;
  onValueChange(value: string): void;
  onSteer(): void;
  queued: readonly QueuedMessage[];
  onQueuedChange(next: readonly QueuedMessage[]): boolean | void;
  /** The row's files return to the strip — see {@link SessionComposerProps.onRestoreAttachments}. */
  onRestoreAttachments?(attachments: readonly BlobLinkView[]): void;
}) {
  const caret = React.useContext(ComposerCaretContext);
  return (
    <PromptInputTextarea
      ref={caret.ref}
      value={value}
      disabled={!ready}
      // A placeholder is not a name — it is gone the moment anyone types — and
      // this is the surface's primary input. It is a MESSAGE box, and it stays
      // one while a question waits above it (VC-289): renaming it Answer gave
      // one question two live fields and two submit paths, and the composer's
      // path could not see the card's in-flight state, so the same question
      // could be answered twice. The card owns its answer; this owns messages,
      // and a draft typed here is never taken for one.
      aria-label="Message"
      aria-keyshortcuts="Enter Shift+Enter Meta+Enter Control+Enter"
      placeholder="Ask, plan, or implement…"
      // A writing sheet, not a search field: 16px insets with room for a
      // short paragraph. Content still grows to the existing scroll ceiling.
      className="min-h-20 py-4 text-sm"
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
          if (!takeRowBack(taken, onRestoreAttachments, onQueuedChange)) return;
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

  // The `+` menu's two picker rows (VC-335): type the trigger where the caret
  // is, and let the same token grammar open the same list. The DOM's own
  // selection is read rather than the tracked `caret`, because the menu was
  // opened by a pointer and the tracked value can be a keystroke behind a
  // click-placed selection; the tracked one is then brought up to date so the
  // target is computed on this commit. `pendingCaret` parks the caret after
  // the trigger and focuses the box in the layout effect above, exactly as a
  // pick does — which matters, because the menu's own close would otherwise
  // hand focus back to the `+`.
  const insert = (trigger: "/" | "@"): void => {
    const node = nodeRef.current;
    const start = node?.selectionStart ?? caret;
    const end = node?.selectionEnd ?? start;
    const applied = insertPickerTrigger({ text: value, from: start, to: end, trigger });
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
  const latest = React.useRef({ handleKeyDown, select, insert });
  React.useLayoutEffect(() => {
    latest.current = { handleKeyDown, select, insert };
  });
  const forwardKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean =>
      latest.current.handleKeyDown(event),
    [],
  );
  const forwardSelect = React.useCallback((row: ComposerPickerRow): void => {
    latest.current.select(row);
  }, []);
  const forwardInsert = React.useCallback((trigger: "/" | "@"): void => {
    latest.current.insert(trigger);
  }, []);
  const trackCaret = React.useCallback((element: HTMLTextAreaElement): void => {
    setCaret(element.selectionStart ?? 0);
  }, []);
  const focus = React.useCallback((): void => {
    nodeRef.current?.focus();
  }, []);
  const binding = React.useMemo<ComposerCaretBinding>(
    () => ({
      ref: textareaRef,
      handleKeyDown: forwardKeyDown,
      trackCaret,
      insert: forwardInsert,
      focus,
    }),
    [focus, forwardInsert, forwardKeyDown, textareaRef, trackCaret],
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

/**
 * Why a tier row cannot be picked, or `ready` when it can.
 *
 * Four ways a tier fails to name a model this Session could run right now,
 * told apart because each sends the person somewhere different: `unset` is a
 * Settings row to fill, `hidden` a Settings toggle to flip, `signed-out` a
 * provider to sign in to, and `unavailable` a model the catalog no longer
 * lists. The row still shows in every case — the table is the user's own
 * configuration, and a row that vanished would read as a tier that does not
 * exist rather than one that needs attention.
 */
export type ComposerTierState = "ready" | "unset" | "hidden" | "signed-out" | "unavailable";

/** One tier as the picker's Defaults view draws it (VC-259). */
export interface ComposerTierRow {
  tier: AgentModelTier;
  /** The Settings row's label — "Fast", "Ticket Sessions". */
  label: string;
  state: ComposerTierState;
  /**
   * The model the tier resolves to, or null when nothing on its ladder is
   * set. Present for every non-`unset` state so a signed-out or hidden row can
   * still name what it would have run.
   */
  model: {
    providerId: string;
    providerLabel: string;
    modelId: string;
    label: string;
  } | null;
  /** The tier's stored reasoning level, riding beside its model. */
  reasoningLevel: string | null;
}

/**
 * The tier table as a picker offers it: each agent-facing tier, the model it
 * resolves to today, and whether that model is one this picker could pin.
 *
 * Resolution is the shared walk (`resolveModelTier`), with the catalog's
 * image predicate so the Visual row is honest about a Ticket fallback that
 * cannot see. What this adds is the picker's own question — could a person
 * pick this right now? — answered against the SAME two filters
 * {@link offerableModels} applies: the catalog's availability, then the
 * user's curation. Utility is not here: nobody starts a Session on it.
 */
export function composerTierRows(
  defaults: ModelAccessDefaults,
  models: readonly ModelAccessModel[],
  providers: readonly ModelAccessProvider[],
  hidden: readonly HiddenModelRef[],
): readonly ComposerTierRow[] {
  const sees = acceptsImageInputIn(models);
  return AGENT_MODEL_TIERS.map((tier) => {
    const { label } = modelTierRow(tier);
    const resolved = resolveModelTier(defaults, tier, sees);
    if (resolved === null) {
      return { tier, label, state: "unset", model: null, reasoningLevel: null };
    }
    const { selection } = resolved;
    const listed = models.find(
      (model) => model.providerId === selection.providerId && model.modelId === selection.modelId,
    );
    const state: ComposerTierState =
      listed === undefined || listed.state === "unavailable"
        ? "unavailable"
        : listed.state === "authentication-required"
          ? "signed-out"
          : isModelHidden(hidden, selection)
            ? "hidden"
            : "ready";
    return {
      tier,
      label,
      state,
      model: {
        providerId: selection.providerId,
        providerLabel:
          providers.find((provider) => provider.id === selection.providerId)?.label ??
          selection.providerId,
        modelId: selection.modelId,
        label: listed?.label ?? selection.modelId,
      },
      reasoningLevel: selection.reasoningLevel,
    };
  });
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
 * The whole of what this Session will send to: `Fast · sonnet-4.5 · Anthropic`.
 *
 * {@link modelPillLabel} is the pill's *drawing* and answers a different
 * question — what is the shortest thing that still tells this model from its
 * neighbours — which is why it says the provider only where the name alone
 * would be ambiguous, and why the label it returns is then capped at 56px and
 * truncated. Both of those are right for a chip on a row that has to survive a
 * 313px composer.
 *
 * What they left unanswered is this one (VC-288): at 150% zoom in a split the
 * pill draws eight characters, and the tier, the provider and the rest of the
 * name were unreachable without opening the list and changing the selection to
 * find out what it had been. So the identity is composed once, in full, and
 * spent in the three places a truncated pill cannot reach — the accessible
 * name, the pointer's `title`, and the line the open list stands on.
 *
 * The provider is ALWAYS said here, ambiguity or not. "Which model" is what the
 * pill answers; "which account is about to be billed for it" is what this one
 * does, and a name that happens to be unique among today's signed-in providers
 * is not an answer to that.
 */
export function modelIdentityLabel(
  models: readonly ComposerModel[],
  selection: ComposerModelSelection,
  /**
   * What the CALLER knows that the catalog does not: the tier a Session was
   * started from, and the provider's label for a model the catalog no longer
   * lists. Both are facts about this selection that cannot be looked up.
   */
  known: {
    /** The tier the selection resolved from, as its label (VC-259). */
    tier?: string | null;
    /** The Session's provider as the catalog names it, for a model no longer listed. */
    providerLabel?: string;
  } = {},
): string {
  const model = selectedModel(models, selection);
  const name = model?.label ?? selection.modelId;
  if (!name) return "Model";
  const provider = model?.providerLabel ?? known.providerLabel ?? selection.providerId;
  return [known.tier ?? null, name, provider || null].filter((term) => term !== null).join(" · ");
}

/**
 * Which list the pill opens on, remembered per profile (VC-259).
 *
 * Read once from Model Access on mount and written through on every change;
 * the local word is the one the pill draws, so a toggle never waits on the
 * round trip. Without a client — the fixture gallery, a test — the pill opens
 * on every model and remembers nothing, which is what it did before the
 * Defaults view existed.
 *
 * A failed write is surfaced and the view is kept: the person asked for the
 * other list and got it; what failed is only the memory of it.
 */
function useModelPickerView(
  /** Whether this pill has a table to show at all; without one nothing is read. */
  enabled: boolean,
): [ModelPickerView, (view: ModelPickerView) => void] {
  const client = useModelAccessClient();
  const [view, setView] = React.useState<ModelPickerView>(DEFAULT_MODEL_PICKER_VIEW);
  const read = enabled ? client?.pickerView : undefined;
  React.useEffect(() => {
    if (read === undefined) return;
    let current = true;
    read()
      .then((stored) => {
        if (current) setView(stored);
      })
      // A preference that could not be read is the default, not an error a
      // person can act on — the pill still opens, on every model.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [read]);
  const change = React.useCallback(
    (next: ModelPickerView) => {
      setView(next);
      client?.setPickerView(next).catch((error: unknown) => {
        toastError(`Couldn't remember the model list: ${errorMessage(error)}`);
      });
    },
    [client],
  );
  return [view, change];
}

const PICKER_VIEWS: readonly { key: ModelPickerView; label: string }[] = [
  { key: "all", label: "All models" },
  { key: "defaults", label: "Defaults" },
];

/** What a tier row says in place of a model it cannot offer. */
const TIER_STATE_LABEL: Record<Exclude<ComposerTierState, "ready">, string> = {
  unset: "unset",
  hidden: "hidden",
  "signed-out": "signed out",
  unavailable: "not available",
};

/**
 * Exported for the New-ticket composer, which picks the model a Ticket Session
 * will be BORN with (VC-56). The two surfaces answer the same question one
 * moment apart — what will this Session run as — so a second pill shaped
 * slightly differently would be the same control drawn twice.
 *
 * `tiers` is the user's own tier table (VC-259), and its presence is what
 * draws the All models / Defaults toggle at the top of the list. A caller
 * without one — the Automation run override, which pins for one Run — gets
 * the plain list. Picking a tier row pins the exact model and level it
 * resolved to, through the same `onChange` a model row calls: the Session is
 * pinned to a model, never to a tier name, so a later Settings change does
 * not move a running Session.
 */
/**
 * `shrink` against `Button`'s own `shrink-0`: this is the row's give.
 *
 * AND THE BASIS IS WHAT ORDERS THE GIVE AGAINST THE WRAP. In a wrapping row the
 * line breaks on an item's flex BASIS, not on the width it would shrink to — so
 * with `basis-auto` this pill kept its full natural width and the effort chip
 * dropped to a second line the moment the two no longer fitted side by side at
 * full size, which measured as a 24px-taller composer at 420px while there was
 * still room to simply truncate. `basis-29` is the 116px floor (a 56px label,
 * the 14px mark and its 6px gap, plus this button's own 40px of caret, gap
 * and padding at the `sm` rung), so the line only breaks once the NAME has already given everything
 * it has; `grow` then spends whatever is left on the label, and `max-w-max`
 * stops it spending more than the name is wide — a ghost button stretched to
 * the full row is a hover target the size of the footer.
 *
 * Named because the pill has two drawings now — the chooser and the frozen
 * reveal — and a row whose give depended on which one is up would re-lay the
 * composer every time a turn started.
 */
const MODEL_PILL_GIVE = "min-w-0 max-w-max shrink grow basis-29";

/**
 * What the pill DRAWS, in either state: the mark, the name that gives, and the
 * caret. Extracted so the frozen reveal and the chooser cannot drift apart —
 * they are one control in two conditions, not two controls.
 */
function ModelPillFace({
  models,
  selection,
  selectionTier,
  selectionProviderLabel,
  compactEffortValue,
}: {
  models: readonly ComposerModel[];
  selection: ComposerModelSelection;
  selectionTier: string | null;
  selectionProviderLabel?: string;
  /** Present only where this face can become the narrow combined control. */
  compactEffortValue?: string;
}) {
  return (
    <>
      {/* The mark leads the name: a family the eye catches before the word is
          read, and the one thing that survives the label truncating to eight
          characters. A selection the list no longer holds still gets one, read
          off its id — the mark is about WHAT the model is, and that is known
          even when the account that served it is gone. */}
      <ModelMark
        model={
          selectedModel(models, selection) ?? {
            providerId: selection.providerId,
            modelId: selection.modelId,
            label: selection.modelId,
          }
        }
        providerLabel={
          selectedModel(models, selection)?.providerLabel ??
          selectionProviderLabel ??
          selection.providerId
        }
      />
      {/* THE GIVE HAS A FLOOR, and 3.5rem is where it is. This is the row's
          elastic member and it should be — a model name is the long value and
          the only one with anything to lose. What it was doing instead was
          losing everything: measured in a 313px chat pane (the app's own
          default at its 940px window minimum) this label came out 36px wide,
          and 3px in the pane one notch narrower. At 3px the pill is a caret and
          a gap, and the one fact it exists to carry is gone.

          56px holds roughly eight characters and an ellipsis at the ui size —
          enough to tell `sonnet-4.5` from `gpt-5.6-luna`, which is the question
          this control answers most of the time. Below it the footer wraps
          instead (see `PromptInputTools` above), so the floor is what CHOOSES
          that break rather than a width that overflows.

          TIER AND MODEL TRUNCATE SEPARATELY, AND THE ORDER MATTERS. They read
          as one run — "Fast · Claude Haiku 4.5" — but they were one *element*,
          so the ellipsis ate from the right and the qualifier outlived the
          thing it qualifies: at the narrowest pane the pill said
          "Ticket Sess… · High" and never named the model at all. That inverts
          the pill's whole reason to exist exactly where space is scarce. Two
          spans in the same flex run fix the priority without changing the
          reading: the tier carries a large shrink factor so it absorbs
          essentially all of the squeeze and truncates to nothing first, while
          the model keeps the 56px floor and only begins to give once the tier
          has none left to give. */}
      <span className="composer-model-name flex min-w-14 items-baseline overflow-hidden">
        {/* The tier leads the model where a start named one (VC-259): "Fast ·
            Claude Haiku 4.5". It is a qualifier in the muted ink, in the same
            "term · name" grammar the provider already uses for an ambiguous
            name. A model picked by hand after that start carries no tier,
            because the projection clears it with the pick. */}
        {selectionTier !== null ? (
          <span
            className="min-w-0 shrink-[999] truncate text-muted-foreground"
            data-testid="model-pill-tier"
          >
            {selectionTier} ·{" "}
          </span>
        ) : null}
        <span className="min-w-14 truncate" data-testid="model-pill-name">
          {modelPillLabel(models, selection, selectionProviderLabel)}
        </span>
      </span>
      {compactEffortValue === undefined ? null : (
        // Container CSS reveals this value only after the separate effort pill
        // has left the row. `aria-hidden` because the button's full accessible
        // name is composed independently of what this truncated face can draw.
        <span aria-hidden className="composer-merged-effort-label hidden shrink-0">
          · {effortLabel(compactEffortValue)}
        </span>
      )}
      <CaretUpDownIcon className="shrink-0" weight={COMPOSER_GLYPH_WEIGHT} />
    </>
  );
}

interface CompactEffortControl {
  levels: readonly string[];
  value: string;
  onChange(level: string): void;
}

/** Keep the JS branch in lockstep with globals.css's 23.999rem container query. */
const COMPACT_COMPOSER_WIDTH_PX = 384;
/**
 * And with the 39.999rem one beside it, for a tray whose commits are three
 * words wide instead of one send key (VC-382). `globals.css` carries the
 * measurements; a surface asks for this number by marking its container
 * `data-composer-container="commit-tray"`.
 */
const COMPACT_COMMIT_TRAY_WIDTH_PX = 640;

/** Which of the two thresholds a marked container has asked for. */
function compactWidthFor(container: HTMLElement): number {
  return container.dataset.composerContainer === "commit-tray"
    ? COMPACT_COMMIT_TRAY_WIDTH_PX
    : COMPACT_COMPOSER_WIDTH_PX;
}

/**
 * Radix portals the model popover to `body`, outside the composer's CSS
 * container. The trigger face and the separate effort pill can respond with
 * container CSS, but the portalled slider needs the same answer in React.
 * Observe the nearest marked prompt container so resizing a split updates an
 * already-open picker on chat, New ticket, and one-off Automation runs.
 */
function useCompactComposer(
  anchor: React.RefObject<HTMLButtonElement | null>,
  enabled: boolean,
): boolean {
  const [compact, setCompact] = React.useState(false);

  React.useLayoutEffect(() => {
    if (!enabled) {
      setCompact(false);
      return;
    }
    const container = anchor.current?.closest<HTMLElement>("[data-composer-container]");
    if (container === undefined || container === null) return;
    const threshold = compactWidthFor(container);
    // Container queries read the content box. These marked containers have no
    // padding, so clientWidth is the same box; getBoundingClientRect includes
    // the 1px prompt border and creates a two-pixel state where CSS and React
    // disagree about whether the merged slider exists.
    const measure = () => setCompact(container.clientWidth < threshold);
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [anchor, enabled]);

  return compact;
}

export function ModelPill({
  models,
  tiers,
  selection,
  selectionProviderLabel,
  selectionTier = null,
  disabled,
  onChange,
  open: openProp,
  onOpenChange,
  compactEffort,
}: {
  models: readonly ComposerModel[];
  tiers?: readonly ComposerTierRow[];
  selection: ComposerModelSelection;
  selectionProviderLabel?: string;
  /** The tier the selection resolved from, as its label, or null — see {@link SessionComposerProps}. */
  selectionTier?: string | null;
  disabled: boolean;
  onChange(next: ComposerModelSelection): void;
  /** Controlled open, for the caller that opens this list by typing (`/model`). */
  open?: boolean;
  onOpenChange?(open: boolean): void;
  /** At a sub-24rem Session composer, fold this slider into the model control. */
  compactEffort?: CompactEffortControl;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const compact = useCompactComposer(triggerRef, compactEffort !== undefined);
  const compactEffortRailRef = React.useRef<HTMLDivElement>(null);
  // The toggle exists only where there is a table to show; without one the
  // list is every model and the remembered word is never even read.
  const [view, setView] = useModelPickerView(tiers !== undefined);
  const showDefaults = tiers !== undefined && view === "defaults";
  const tierModels = React.useMemo(
    () => (tiers ?? []).flatMap((row) => (row.model === null ? [] : [row.model])),
    [tiers],
  );
  // Controlled when `open` is present, uncontrolled otherwise — the ordinary
  // Radix shape, so a caller that never types `/model` notices nothing. The
  // internal state stays the uncontrolled half and is written either way:
  // a popover that closes itself while controlled must not leave the local
  // half stuck open for the next uncontrolled mount.
  const setOpen = (next: boolean) => {
    setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const open = openProp ?? uncontrolledOpen;
  // First-appearance order: the catalog's own ordering is the harness's answer
  // to "which provider matters", and re-sorting it here would be our opinion.
  const providers = models.reduce<Array<{ id: string; label: string }>>((result, model) => {
    if (!result.some((provider) => provider.id === model.providerId)) {
      result.push({ id: model.providerId, label: model.providerLabel });
    }
    return result;
  }, []);
  // Composed once and spent four times — the pill's name, its `title`, the line
  // the open list leads with, and the bubble a frozen pill reveals — so no two
  // of them can disagree about one selection.
  const identity = modelIdentityLabel(models, selection, {
    tier: selectionTier,
    providerLabel: selectionProviderLabel,
  });
  const controlLabel =
    compact && compactEffort !== undefined
      ? `Model and effort: ${identity} · ${effortLabel(compactEffort.value)}`
      : `Model: ${identity}`;
  // Nothing can be CHOSEN here right now: a turn is working, or the catalog
  // offers nothing to switch to.
  const frozen = disabled || models.length === 0;

  // READING IS NOT CHOOSING (VC-288 review). `disabled` took the pill out of
  // the tab order, and the enabled pill's reveal is the list it opens — so in
  // the one state a person is most likely to ask what they are talking to,
  // mid-turn, the answer was a `title` and nothing else. A frozen pill draws
  // the same face and becomes what it actually is: a value, focusable, saying
  // the whole identity on hover and on focus alike. `aria-disabled` rather than
  // `disabled` is what keeps it reachable while still telling AT that a press
  // will not choose anything.
  if (frozen) {
    return (
      // Its own provider, for the reason `ui/tab-strip.tsx` mounts one: the pill
      // is drawn by four surfaces and by a good deal of the test suite, some of
      // them outside the app shell that owns the app-wide provider, and a Radix
      // tooltip with none above it throws rather than degrading.
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              ref={triggerRef}
              type="button"
              size={COMPOSER_CONTROL_SIZE}
              variant="ghost"
              data-testid="model-pill"
              aria-disabled
              aria-label={controlLabel}
              className={cn(
                MODEL_PILL_GIVE,
                COMPOSER_CONFIG_CHIP,
                "text-muted-foreground opacity-50",
              )}
            >
              <ModelPillFace
                models={models}
                selection={selection}
                selectionTier={selectionTier}
                selectionProviderLabel={selectionProviderLabel}
                compactEffortValue={compactEffort?.value}
              />
            </Button>
          </TooltipTrigger>
          {/* Wrapping, and wide enough for a real name: the bubble is the
              reveal, and a reveal that truncates is the thing it was opened to
              escape. */}
          <TooltipContent side="top" className="max-w-72 text-wrap">
            {identity}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          size={COMPOSER_CONTROL_SIZE}
          variant="ghost"
          data-testid="model-pill"
          // THE NAME IS THE WHOLE FACT, EVEN WHERE THE DRAWING IS EIGHT
          // CHARACTERS (VC-288). The label below truncates by design; what
          // must not truncate with it is the answer to "what am I sending
          // to". `aria-label` is that answer for anything reading the control
          // rather than looking at it, and `title` is the pointer's half.
          // Neither is the reveal on its own — a `title` is unreachable from a
          // keyboard, and a name is not readable — which is why the list this
          // pill opens leads with the same string, in ink, one press away.
          aria-label={controlLabel}
          title={
            compact && compactEffort !== undefined
              ? `${identity} · ${effortLabel(compactEffort.value)} effort`
              : identity
          }
          className={cn(MODEL_PILL_GIVE, COMPOSER_CONFIG_CHIP, "text-muted-foreground")}
        >
          <ModelPillFace
            models={models}
            selection={selection}
            selectionTier={selectionTier}
            selectionProviderLabel={selectionProviderLabel}
            compactEffortValue={compactEffort?.value}
          />
        </Button>
      </PopoverTrigger>
      {/* `w-72`, down from `w-80`: the extra 32px existed to hold the effort
          segment on the selected row, and past four levels it did not hold it
          anyway — the row that exists to name a model truncated the name to
          nothing so the qualifier could fit. Rows are model names now. */}
      {/* `w-72` for a list of names; `w-88` where the Defaults view puts a tier
          name, a model name and a level on one row (VC-259) — one width for
          both views, so the toggle moves nothing but the rows. */}
      <PopoverContent
        align="start"
        side="top"
        className={cn("p-0", tiers === undefined ? "w-72" : "w-88")}
      >
        {/* WHAT IS SELECTED, SAID IN FULL (VC-288) — and the keyboard's reveal
            for a pill that draws eight characters of it. The pill is a focus
            stop, Enter opens this, Escape closes it, and nothing about the
            selection has moved: reading is not choosing.

            It wraps rather than truncates. A reveal that truncates is the thing
            it was opened to escape, and a popover has a width of its own to
            spend — two lines of a long name here cost nothing, where the same
            two lines in the composer row would move the box someone is typing
            in. Outside the command root, so cmdk's arrow keys still land on the
            first ROW rather than on a line that is not a choice.

            The same string the pill's accessible name carries, from the same
            function, so the two cannot drift into saying different things about
            one selection. */}
        <div
          data-testid="model-pill-identity"
          // `py-1` — the ladder's 4px rung. `py-1.5` was 6px from nowhere on
          // `docs/DESIGN.md`'s five steps, bought nothing this line needed, and
          // is exactly the kind of value the collapse exists to keep out.
          className="flex items-start gap-2 border-b px-2 py-1 text-ui text-muted-foreground"
        >
          <ModelMark
            model={
              selectedModel(models, selection) ?? {
                providerId: selection.providerId,
                modelId: selection.modelId,
                label: selection.modelId,
              }
            }
            providerLabel={
              selectedModel(models, selection)?.providerLabel ??
              selectionProviderLabel ??
              selection.providerId
            }
          />
          <span className="min-w-0 break-words">{identity}</span>
        </div>
        {compact && compactEffort !== undefined ? (
          <div
            data-testid="combined-model-effort"
            className="flex justify-center border-b px-4 py-3"
          >
            <EffortSlider
              railRef={compactEffortRailRef}
              levels={compactEffort.levels}
              value={compactEffort.value}
              onChange={compactEffort.onChange}
              onDismiss={() => setOpen(false)}
            />
          </div>
        ) : null}
        <PromptInputCommand>
          {/* Inside the command root, so arrow keys reach the list from the
              toggle too; the search field keeps focus in the All view through
              its own `autoFocus`, which the popover's focus scope honours. No
              motion on the switch: a control used tens of times a day. */}
          {tiers !== undefined ? (
            <div className="flex h-8 items-center border-b px-2">
              <Segmented<ModelPickerView>
                ariaLabel="Model list"
                testId="model-picker-view"
                value={view}
                options={PICKER_VIEWS}
                onChange={setView}
              />
            </div>
          ) : null}
          {/* No search box over the Defaults view: five rows, nothing to
              filter, and a field that filtered nothing would be a lie. */}
          {showDefaults ? null : <PromptInputCommandInput placeholder="Model" autoFocus />}
          <PromptInputCommandList>
            {showDefaults ? (
              <PromptInputCommandGroup>
                {tiers.map((row) => (
                  <TierRow
                    key={row.tier}
                    row={row}
                    siblings={tierModels}
                    selected={
                      row.model !== null &&
                      row.model.providerId === selection.providerId &&
                      row.model.modelId === selection.modelId &&
                      row.reasoningLevel === selection.reasoningLevel
                    }
                    onPick={() => {
                      if (row.model === null || row.reasoningLevel === null) return;
                      onChange({
                        ...selection,
                        providerId: row.model.providerId,
                        modelId: row.model.modelId,
                        reasoningLevel: row.reasoningLevel,
                      });
                      setOpen(false);
                    }}
                  />
                ))}
              </PromptInputCommandGroup>
            ) : null}
            {showDefaults ? null : <PromptInputCommandEmpty>No match</PromptInputCommandEmpty>}
            {showDefaults
              ? null
              : providers.map((provider) => (
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
                            <ModelMark model={model} providerLabel={model.providerLabel} />
                            <span className="min-w-0 flex-1 truncate tabular-nums">
                              {model.label}
                            </span>
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

/**
 * One tier in the Defaults view: the tier's name, then the model it resolves
 * to and the level it runs at — or, where it cannot be picked, the one word
 * that says why. Drawn with {@link ModelName} like every other model surface;
 * the provider is said only where two tiers share a model name.
 *
 * A row that cannot be picked is disabled rather than hidden: the table is
 * the user's own configuration, and the Settings pane is where it is fixed.
 * The word beside it ("unset", "hidden", "signed out") is enough to say which
 * pane; a sentence about the fallback ladder is not this row's to carry.
 */
function TierRow({
  row,
  siblings,
  selected,
  onPick,
}: {
  row: ComposerTierRow;
  /** Every model the table names, so a name two tiers share gets its provider. */
  siblings: readonly NonNullable<ComposerTierRow["model"]>[];
  selected: boolean;
  onPick(): void;
}) {
  const ready = row.state === "ready";
  return (
    <PromptInputCommandItem
      value={row.tier}
      disabled={!ready}
      onSelect={onPick}
      data-testid={`model-picker-tier-${row.tier}`}
      data-tier-state={row.state}
    >
      <CheckIcon className={cn("size-3.5 shrink-0", !selected && "invisible")} weight="bold" />
      {/* Three columns: the tier name at a fixed width (five short words), the
          model taking what is left and truncating, and the level — or the
          state word in its place — pinned to the right edge where truncation
          cannot reach it. The level is the fact that tells two rows on the
          same model apart, so it is the one the name gives way to. */}
      <span className="w-24 shrink-0 truncate">{row.label}</span>
      {row.model === null || row.state === "unset" ? (
        <span className="ml-auto text-muted-foreground">{TIER_STATE_LABEL.unset}</span>
      ) : (
        <>
          <ModelName
            model={row.model}
            models={siblings}
            providerLabel={row.model.providerLabel}
            muted={row.state !== "ready"}
            className="min-w-0 flex-1"
          />
          <span className="ml-auto shrink-0 text-muted-foreground">
            {row.state === "ready" ? row.reasoningLevel : TIER_STATE_LABEL[row.state]}
          </span>
        </>
      )}
    </PromptInputCommandItem>
  );
}
