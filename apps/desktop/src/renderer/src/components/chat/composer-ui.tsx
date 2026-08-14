/**
 * The Session composer.
 *
 * Three ideas, and the shape follows from them:
 *
 *  1. **One model pill, and only where the model is yours to pick.** Provider is
 *     a heading inside the popover and effort is a segment on the selected row,
 *     because neither is a decision you make on its own — you pick a model, and
 *     the other two qualify it. Codex's shape: two values, one caret. An
 *     executor that pins its own model renders no pill at all rather than a
 *     disabled one, on the same rule as the mode segment below: a control naming
 *     models the harness will drop is worse than no control.
 *  2. **Delivery is session state, not a control.** Idle, ⏎ sends. While a turn
 *     is live the submit glyph becomes Queue, ⏎ queues, ⌘⏎ steers without
 *     interrupting, and ⌫ on an empty box takes the newest queued message back.
 *     Stop turn appears beside submit only while there is something to stop.
 *  3. **What you type can open a list, and the list never takes the cursor.**
 *     `/` at the start of the box and `@` at a word boundary open a picker as a
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
} from "@ai-elements/prompt-input";
import { expandCommandInvocation, type IndexedFile, type PromptTemplate } from "@volli/shared";

import { COMPOSER_STACK_SHELL } from "@renderer/chat/composer-stack";
import {
  activePickerRow,
  applyPickerRow,
  composerPicker,
  composerPickerToken,
  movePickerActive,
  type ComposerPickerDismissal,
  type ComposerPickerRow,
} from "@renderer/chat/composer-picker";
import {
  composerIntent,
  takeQueued,
  unqueueLast,
  type ComposerIntent,
  type QueuedMessage,
} from "@renderer/chat/session-model";
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
  onSubmit(text: string, intent: ComposerIntent): void;
  onStop(): void;
  /** `/` picker rows, and what expands a staged `/name args` on submit. */
  promptTemplates?: readonly PromptTemplate[];
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
  className?: string;
}

const NO_TEMPLATES: readonly PromptTemplate[] = [];
const NO_FILES: readonly IndexedFile[] = [];

export function SessionComposer({
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
  files = NO_FILES,
  onFilePickerOpen,
  interactionOpen = false,
  className,
}: SessionComposerProps) {
  const canSubmit = ready && value.trim().length > 0;
  // The menu's own event callbacks share this render. Keeping the selected id
  // in their closure lets close distinguish Edit from an ordinary dismissal
  // without adding component state to a fully controlled composer.
  let editedQueueId: string | null = null;

  const send = (intent: ComposerIntent) => {
    if (!canSubmit) return;
    // The one place `/` expansion happens, and the last thing before the
    // existing submit path takes over. The expansion is what the transcript
    // shows, because it is what was sent: there is no second "display text"
    // travelling beside a durable message, and inventing one to keep `/review`
    // on screen would mean the record and the request disagree about what the
    // model was asked.
    onSubmit(expandCommandInvocation(value.trim(), promptTemplates), intent);
  };

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
      files={files}
      onFilePickerOpen={onFilePickerOpen}
      textareaRef={textareaRef}
    >
      <PromptInput
        className={cn(
          "pointer-events-auto overflow-hidden transition-[color,box-shadow] has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot=input-group-control]:focus-visible]:ring-[3px] has-[[data-slot=input-group-control]:focus-visible]:ring-ring/50",
          COMPOSER_STACK_SHELL,
          className,
        )}
        onSubmit={() => send(composerIntent({ working, steer: false }))}
      >
        {queued.length > 0 ? (
          <PromptInputHeader className="flex-col items-stretch gap-0.5 border-b border-border/70">
            {queued.map((entry) => (
              <div
                key={entry.id}
                role="group"
                aria-label={`Queued message: ${entry.text}`}
                className="flex min-w-0 items-center gap-1 text-xs"
              >
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{entry.text}</span>
                <span className="flex shrink-0 items-center gap-0.5">
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
          />
        </PromptInputBody>

        <PromptInputFooter className="border-t border-border/70 pt-2">
          <PromptInputTools className="min-w-0">
            <ModelPill
              models={models}
              selection={selection}
              selectionProviderLabel={selectionProviderLabel}
              disabled={modelChoiceDisabled}
              onChange={onSelectionChange}
            />
          </PromptInputTools>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {working ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Stop turn"
                onClick={onStop}
              >
                {/* One of the few glyphs that keeps its fill: a stop square MEANS
                  solid the way a play triangle does, and hollow it reads as a
                  checkbox. It is also the exception rather than the category —
                  it only exists while a turn is running. */}
                <SquareIcon className="size-3.5" weight="fill" />
              </Button>
            ) : null}
            <PromptInputSubmit
              status="ready"
              disabled={!canSubmit}
              aria-label={working ? "Queue" : "Send"}
            >
              {working ? (
                <QueueIcon className="size-4" />
              ) : (
                <ArrowUpIcon className="size-4" weight="bold" />
              )}
            </PromptInputSubmit>
          </div>
        </PromptInputFooter>
      </PromptInput>
    </ComposerPickerStack>
  );
}

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
        state={picker.state}
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
  onValueChange,
  onSteer,
  queued,
  onQueuedChange,
}: {
  value: string;
  ready: boolean;
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
      // and this is the surface's primary input.
      aria-label="Message"
      placeholder="Ask, plan, or implement…"
      className="min-h-16 text-sm"
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
  state: ReturnType<typeof composerPicker>;
  active: string;
  setActive(value: string): void;
  select(row: ComposerPickerRow): void;
  binding: ComposerCaretBinding;
}

/**
 * The caret-driven picker, kept out of the composer's render.
 *
 * Three pieces of state, and each earns its place. The **caret** is the one
 * thing a controlled textarea does not hand back on its own, and the whole
 * trigger is a function of it. The **active row** is a highlight, not a
 * document fact. **Dismissal** is what makes Escape mean something durable.
 *
 * What is NOT here is any decision: whether those three add up to an open
 * picker is `composerPicker`'s, in the pure module beside this one, and so is
 * what a picked row writes. This hook holds state and forwards keys.
 */
function useComposerPicker(input: {
  value: string;
  onValueChange(value: string): void;
  ready: boolean;
  interactionOpen: boolean;
  promptTemplates: readonly PromptTemplate[];
  files: readonly IndexedFile[];
  onFilePickerOpen?(): void;
  textareaRef?: React.Ref<HTMLTextAreaElement>;
}): ComposerPickerHandle {
  const { value, onValueChange, ready, interactionOpen, promptTemplates, files } = input;
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

  const state = composerPicker({
    text: value,
    caret,
    templates: promptTemplates,
    files,
    ready,
    interactionOpen,
    dismissed: inToken ? dismissed : null,
  });

  // The open EDGE, not every render: `refresh()` is cache-gated, but calling it
  // on each keystroke would still be a call per keystroke.
  const fileMode = state?.mode === "file";
  const { onFilePickerOpen } = input;
  React.useEffect(() => {
    if (fileMode) onFilePickerOpen?.();
  }, [fileMode, onFilePickerOpen]);

  const rows = state?.rows ?? [];
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

  return {
    state,
    active: activeValue,
    setActive,
    select,
    binding: {
      ref: textareaRef,
      handleKeyDown,
      trackCaret: (element) => setCaret(element.selectionStart ?? 0),
    },
  };
}

/* ------------------------------------------------------------------- model */

/**
 * `sonnet-4.5 · high` — two values, one caret.
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
 * `sonnet-4.5 · high`, or `Azure OpenAI · gpt-5.6-luna` where the name alone
 * would not say which model this is.
 *
 * A model name is not unique across providers, and this pill runs into that
 * twice. A selection the list does not hold — the Session is pinned to a
 * provider nobody is signed in to — falls back to its raw id, which is the same
 * id a signed-in provider may also carry; and two listed providers can both
 * ship a model called "GPT-5.6 Luna". Both read as an ordinary pill naming a
 * model that is not the one this Session will send to. Where the name is
 * ambiguous the provider leads it, exactly as Settings' model rows do.
 */
export function modelPillLabel(
  models: readonly ComposerModel[],
  selection: ComposerModelSelection,
  /** The Session's provider as the catalog names it, for a model no longer listed. */
  selectionProviderLabel?: string,
): string {
  const model = models.find(
    (candidate) =>
      candidate.providerId === selection.providerId && candidate.modelId === selection.modelId,
  );
  const name = model?.label ?? selection.modelId;
  if (!name) return "Model";
  const ambiguous =
    model === undefined ||
    models.some((candidate) => candidate !== model && candidate.label === name);
  const qualified = ambiguous
    ? `${model?.providerLabel ?? selectionProviderLabel ?? selection.providerId} · ${name}`
    : name;
  return selection.reasoningLevel ? `${qualified} · ${selection.reasoningLevel}` : qualified;
}

function ModelPill({
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
          size="sm"
          variant="ghost"
          disabled={disabled || models.length === 0}
          className="min-w-0 text-muted-foreground"
        >
          <span className="min-w-0 truncate">
            {modelPillLabel(models, selection, selectionProviderLabel)}
          </span>
          <CaretUpDownIcon className="size-3 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-80 p-0">
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
                      <PromptInputCommandItem
                        key={model.id}
                        value={`${model.providerId} ${model.modelId} ${model.label}`}
                        onSelect={() => {
                          onChange({
                            ...selection,
                            providerId: model.providerId,
                            modelId: model.modelId,
                            reasoningLevel: model.reasoningLevels.includes(selection.reasoningLevel)
                              ? selection.reasoningLevel
                              : (model.reasoningLevels[0] ?? "off"),
                          });
                          setOpen(false);
                        }}
                      >
                        <CheckIcon
                          className={cn("size-3.5 shrink-0", !selected && "invisible")}
                          weight="bold"
                        />
                        <span className="min-w-0 flex-1 truncate">{model.label}</span>
                        {selected && model.reasoningLevels.length > 1 ? (
                          <EffortSegment
                            variants={model.reasoningLevels}
                            value={selection.reasoningLevel}
                            onChange={(reasoningLevel) =>
                              onChange({ ...selection, reasoningLevel })
                            }
                          />
                        ) : null}
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
 * Effort rides the selected row: it qualifies one model rather than standing
 * beside it, and it must not close the popover — changing effort is a smaller
 * decision than changing model, so it stays in place for a second look.
 */
function EffortSegment({
  variants,
  value,
  onChange,
}: {
  variants: readonly string[];
  value: string;
  onChange(variant: string): void;
}) {
  return (
    <span className="flex shrink-0 items-center gap-0.5 rounded-full bg-muted p-0.5">
      {variants.map((variant) => (
        <button
          key={variant}
          type="button"
          aria-pressed={variant === value}
          onClick={(event) => {
            event.stopPropagation();
            onChange(variant);
          }}
          className={cn(
            "rounded-full px-2 py-0.5 text-xs transition-colors duration-150 ease-swift",
            variant === value
              ? "bg-background text-foreground shadow-[var(--shadow-raised)]"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {variant}
        </button>
      ))}
    </span>
  );
}
