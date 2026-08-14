/**
 * The composer's `/` and `@` pickers, live.
 *
 * The question this answers is the one no unit test can: whether a card that
 * appears because of what you typed reads as part of the composer or as
 * something that jumped in front of it. Type `/` at the very start of the box,
 * or `@` after a space, and drive it with the arrow keys — the cursor should
 * never leave the textarea, and Escape should close the list without closing
 * anything else.
 *
 * Fixtures cover both halves of the command grammar, because they behave
 * differently on pick: `/review` reads `$1`, so picking it stages `/review `
 * and waits for an argument; `/ship` reads nothing, so picking it drops the
 * whole prompt into the box. The file rows include two same-named files and an
 * artifact, which is where the second column earns its place.
 *
 * The toggle at the top mounts an interaction card in the slot. The picker must
 * stay shut while it is up: one thing parks above the composer at a time.
 */
import * as React from "react";
import type { IndexedFile, PromptTemplate, SessionInteraction } from "@volli/shared";

import {
  SessionComposer,
  type ComposerModelSelection,
} from "@renderer/components/chat/composer-ui";
import { ComposerInteractionStack } from "@renderer/components/chat/interaction-ui";
import { ContentColumn } from "@renderer/components/layout/content-column";
import { Button } from "@renderer/components/ui/button";

export const title = "Composer picker · / and @";
export const note = "Caret-driven command and file pickers as a card in the composer stack";
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

export default function ComposerPickerScratch() {
  const [value, setValue] = React.useState("");
  const [sent, setSent] = React.useState<string | null>(null);
  const [interaction, setInteraction] = React.useState<SessionInteraction | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  /**
   * Put a trigger in the box the way a person would: with the caret after it.
   * Setting the value alone leaves the DOM caret at 0, so the next character
   * typed lands *before* the sigil — which is a fixture artifact, not
   * behaviour, and it would make the scratch lie about the feature.
   */
  const seed = (text: string): void => {
    setValue(text);
    queueMicrotask(() => {
      const node = textareaRef.current;
      if (node === null) return;
      node.focus();
      node.setSelectionRange(text.length, text.length);
      // React's controlled value lands in the same commit; the picker reads the
      // caret from this event, exactly as it does for a click.
      node.dispatchEvent(new Event("select", { bubbles: true }));
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={interaction ? "default" : "outline"}
          onClick={() => setInteraction((current) => (current ? null : QUESTION))}
        >
          {interaction ? "Withdraw question" : "Raise a question"}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => seed("/")}>
          Seed /
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => seed("look at @src/")}>
          Seed @
        </Button>
      </div>

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

      {/* What the Session would have received — the expansion, because that is
          what was sent. Present in the lab only; the app has a transcript. */}
      {sent === null ? null : (
        <ContentColumn>
          <pre className="rounded-xl border border-border bg-muted/40 p-3 text-xs whitespace-pre-wrap text-muted-foreground">
            {sent}
          </pre>
        </ContentColumn>
      )}
    </div>
  );
}
