/**
 * The composer's `/` and `@` pickers, live, over a feed that can be covered.
 *
 * Two questions, and the feed is here for the second one.
 *
 * **Does it read as part of the composer?** Type `/` at the very start of the
 * box, or `@` after a space, and drive it with the arrow keys — the cursor
 * should never leave the textarea, and Escape should close the list without
 * closing anything else.
 *
 * **Does it push the transcript up, or land on top of it?** The plane below
 * reproduces `chat-plane.tsx`'s bottom-clearance contract with the same hook
 * the app measures with ({@link useMeasuredHeight}): the whole bottom mount is
 * observed, published as `--composer-height`, and the feed pads its bottom by
 * it. The picker is a sibling *inside* that mount, so opening it grows the
 * measured box and the last message rides up — while the composer's own box,
 * being the last child of a bottom-anchored container, does not move a pixel.
 * An absolutely-positioned picker would look identical on an empty transcript
 * and quietly cover the last message here, which is exactly why the feed is
 * pinned to its bottom.
 *
 * Fixtures cover both halves of the command grammar, because they behave
 * differently on pick: `/review` reads `$1`, so picking it stages `/review `
 * and waits for an argument; `/ship` reads nothing, so picking it drops the
 * whole prompt into the box. The file rows include several same-named files and
 * two artifacts, which is where the second column earns its place.
 *
 * The two request buttons mount a card in the slot — and pressing the other one
 * while a card is up replaces it, which is the case the stack's presence mode
 * has to be judged on. The picker must stay shut while a card is up: one thing
 * parks above the composer at a time.
 *
 * **Watch the composer, not the card.** Nothing here may move it: opening or
 * closing either picker, switching `/` to `@`, and every card arrival, exit and
 * replacement all grow or shrink the box *above* a bottom-anchored input. If the
 * composer slides, something in its ancestry took a `layout` prop.
 */
import * as React from "react";
import {
  promptId,
  type IndexedFile,
  type PromptTemplate,
  type SessionInteraction,
} from "@volli/shared";

import {
  SessionComposer,
  type ComposerModelSelection,
} from "@renderer/components/chat/composer-ui";
import { ComposerInteractionStack } from "@renderer/components/chat/interaction-ui";
import { ContentColumn } from "@renderer/components/layout/content-column";
import { Button } from "@renderer/components/ui/button";
import { useMeasuredHeight } from "@renderer/hooks/use-measured-height";

export const title = "Composer picker · / and @";
export const note = "Caret-driven pickers as a card in the composer stack, over a pinned feed";
export const viewport = "stage" as const;

const TEMPLATES: readonly PromptTemplate[] = [
  {
    name: "review",
    description: "Review a file for bugs and style",
    content: "Review $1 for bugs and style. Be specific about line numbers.",
  },
  {
    name: "refactor",
    description: "Refactor with a named goal",
    content: "Refactor $1 so that $ARGUMENTS. Keep the public interface unchanged.",
  },
  {
    name: "ship",
    description: "Open a pull request for the work so far",
    content: "Summarise the work so far, then open a pull request for it.",
  },
  {
    name: "explain",
    description: "Walk me through what this does",
    content: "Walk me through $1 line by line. Assume I have not seen it before.",
  },
  { name: "tidy", description: "", content: "Tidy the working tree and drop dead code." },
];

const FILES: readonly IndexedFile[] = [
  { relPath: "src/main/index.ts", kind: "other", artifact: false },
  { relPath: "src/renderer/src/app.tsx", kind: "other", artifact: false },
  { relPath: "src/renderer/src/components/chat/composer-ui.tsx", kind: "other", artifact: false },
  { relPath: "src/main/db/index.ts", kind: "other", artifact: false },
  { relPath: "src/renderer/src/stores/index.ts", kind: "other", artifact: false },
  { relPath: "packages/shared/src/index.ts", kind: "other", artifact: false },
  { relPath: "docs/DESIGN.md", kind: "markdown", artifact: false },
  { relPath: "README.md", kind: "markdown", artifact: false },
  { relPath: ".volli/artifacts/composer-notes.md", kind: "markdown", artifact: true },
  { relPath: ".volli/artifacts/index.md", kind: "markdown", artifact: true },
];

const SELECTION: ComposerModelSelection = {
  providerId: "anthropic",
  modelId: "sonnet-4.5",
  reasoningLevel: "high",
};

const BRANCH_OPTIONS = [
  { id: "main", label: "main", description: null },
  { id: "release", label: "release/2.1", description: null },
] as const;

const QUESTION: SessionInteraction = {
  id: "q1",
  attachmentId: "a1",
  kind: "question",
  title: "Which branch should this land on?",
  detail: null,
  options: BRANCH_OPTIONS,
  multiple: false,
  native: { id: "n1", detail: null },
};

/**
 * A second request, so the slot can be watched being *replaced* rather than only
 * filled and emptied. Deliberately a different height from the first: a swap
 * that changes the card's size is where a stack's presence mode shows its hand.
 *
 * Two prompts, so answering the first steps the carousel — the card's own
 * internal `layout` stage, which tweens the frame's height as the steps pass
 * each other. That one is allowed to animate, and this is where it proves it
 * animates the card and nothing outside it.
 */
const PERMISSION: SessionInteraction = {
  id: "q2",
  attachmentId: "a2",
  kind: "permission",
  title: "Run `pnpm build` in the worktree?",
  detail: "Writes to apps/desktop/out and packages/*/dist.",
  options: [
    { id: "once", label: "Allow once", description: null },
    { id: "always", label: "Always allow pnpm build", description: "For this project" },
    { id: "deny", label: "Deny", description: null },
  ],
  multiple: false,
  prompts: [
    {
      id: promptId(0),
      label: "Run `pnpm build` in the worktree?",
      detail: "Writes to apps/desktop/out and packages/*/dist.",
      options: [
        { id: "once", label: "Allow once", description: null },
        { id: "always", label: "Always allow pnpm build", description: "For this project" },
        { id: "deny", label: "Deny", description: null },
      ],
      multiple: false,
      custom: false,
    },
    {
      // Taller than the first on purpose: the frame has something to tween to.
      id: promptId(1),
      label: "And push the branch when it succeeds?",
      detail: null,
      options: [
        { id: "push", label: "Push to origin", description: "volli/VC-12-composer-stack" },
        { id: "pr", label: "Push and open a pull request", description: null },
        { id: "hold", label: "Hold", description: "Leave the commits local" },
        { id: "deny", label: "Deny", description: null },
      ],
      multiple: false,
      custom: true,
    },
  ],
  native: { id: "n2", detail: null },
};

/** Enough transcript to scroll, with the last line where a card would cover it. */
const FEED = [
  "Walk me through how the composer decides what to complete.",
  "It reads the caret, not the keystroke. `/` counts at a word boundary; `@` counts at any ref boundary.",
  "And when the list is open, who owns Enter?",
  "The list does, but only while it is open — the textarea keeps focus throughout and forwards the key.",
  "What happens to a message that starts with a command the project does not define?",
  "It goes out as written. An unknown command is a sentence that starts with a slash, not an error.",
  "Last one: does the transcript show the command or the prompt it expanded to?",
  "The prompt, because that is what was sent. THIS LINE MUST STAY VISIBLE WHEN THE PICKER OPENS.",
];

export default function ComposerPickerScratch() {
  const [value, setValue] = React.useState("");
  const [sent, setSent] = React.useState<string | null>(null);
  const [interaction, setInteraction] = React.useState<SessionInteraction | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const composerHeight = useMeasuredHeight<HTMLDivElement>();
  const feedRef = React.useRef<HTMLDivElement>(null);

  // Pinned to the bottom, like a live transcript. This is what makes the
  // clearance contract visible: if the picker ever stopped contributing
  // height, the last line would go under the card instead of moving up.
  React.useLayoutEffect(() => {
    const node = feedRef.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  });

  // Put a trigger in the box the way a person would: with the caret after it.
  // The caret has to be set AFTER React commits the new value — a microtask
  // runs first, sets the range against the OLD text, and the browser clamps it
  // to 0, which is how the last version of this button made the scratch lie.
  const [pendingSeed, setPendingSeed] = React.useState<string | null>(null);
  React.useLayoutEffect(() => {
    if (pendingSeed === null) return;
    setPendingSeed(null);
    const node = textareaRef.current;
    if (node === null) return;
    node.focus();
    node.setSelectionRange(pendingSeed.length, pendingSeed.length);
    // The picker reads the caret from a select event, exactly as it does for a
    // click. React's onSelect is driven by document `selectionchange`.
    document.dispatchEvent(new Event("selectionchange"));
  }, [pendingSeed]);
  const seed = (text: string): void => {
    setValue(text);
    setPendingSeed(text);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {[QUESTION, PERMISSION].map((request) => (
          <Button
            key={request.id}
            type="button"
            size="sm"
            variant={interaction?.id === request.id ? "default" : "outline"}
            // Pressing the other one while a card is up replaces the request
            // rather than emptying the slot — the swap the stack's presence
            // mode is actually chosen on.
            onClick={() =>
              setInteraction((current) => (current?.id === request.id ? null : request))
            }
          >
            {request.kind === "permission" ? "Permission" : "Question"}
          </Button>
        ))}
        <Button type="button" size="sm" variant="outline" onClick={() => seed("/")}>
          Seed /
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => seed("look at @src/")}>
          Seed @
        </Button>
      </div>

      {/* `chat-plane.tsx`'s shape, reproduced: a scroller that clears the
          measured bottom mount, and the mount itself pinned to the bottom. */}
      <div
        // Tall enough that the last message is still on screen with the tallest
        // card up — otherwise the clearance this scratch exists to show happens
        // entirely above the fold and it can only be measured, not seen.
        className="relative flex h-[44rem] min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-background"
        style={{ "--composer-height": `${composerHeight.height}px` } as React.CSSProperties}
      >
        <div ref={feedRef} className="min-h-0 flex-1 overflow-y-auto">
          <ContentColumn>
            <div className="flex flex-col gap-4 pt-6 pb-[calc(var(--composer-height)+2rem)]">
              {FEED.map((line, index) => (
                <p
                  key={line}
                  data-last-message={index === FEED.length - 1 ? "" : undefined}
                  className={
                    index % 2 === 0
                      ? "text-sm text-foreground"
                      : "rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground"
                  }
                >
                  {line}
                </p>
              ))}
              {sent === null ? null : (
                <pre className="rounded-lg border border-border bg-muted/40 p-3 text-xs whitespace-pre-wrap text-muted-foreground">
                  {sent}
                </pre>
              )}
            </div>
          </ContentColumn>
        </div>

        <div
          ref={composerHeight.ref}
          className="pointer-events-none absolute inset-x-0 bottom-0 bg-background pb-4"
        >
          <ContentColumn>
            <ComposerInteractionStack
              interaction={interaction}
              onResolve={() => setInteraction(null)}
              onWithdraw={() => setInteraction(null)}
            >
              <SessionComposer
                value={value}
                onValueChange={setValue}
                textareaRef={textareaRef}
                onComposerFocusRequest={() => textareaRef.current?.focus()}
                promptTemplates={TEMPLATES}
                files={FILES}
                interactionOpen={interaction !== null}
                models={[]}
                selection={SELECTION}
                onSelectionChange={() => undefined}
                working={false}
                ready
                queued={[]}
                onQueuedChange={() => undefined}
                onSteerQueued={() => undefined}
                onSubmit={(text) => {
                  setSent(text);
                  setValue("");
                }}
                onStop={() => undefined}
              />
            </ComposerInteractionStack>
          </ContentColumn>
        </div>
      </div>
    </div>
  );
}
