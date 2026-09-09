/**
 * The Session composer in every state it has, at every width the app hands
 * it — the rig VC-335's redesign was judged on, kept so the next pass has the
 * same one.
 *
 * One state at a time by default (the picker row at the top), or every state
 * stacked, at one of three widths: the reading measure (720px), a comfortable
 * split (480px) and the app's own narrowest chat pane (265px — the 940px
 * window minimum less the rail, the sidebar, the frame and a ticket's right
 * rail). Idle and empty, idle with a draft, a live turn with a queue,
 * attachments, the frozen pill (no model choosable) and the inert box. The
 * new-ticket footer and the Automation Instructions box sit under them,
 * because the ticket asked that the chat composer's language carry to every
 * prompt surface and this is where the three are judged side by side.
 *
 * `scripts/lab-shot.mjs composer-states out.png --click "All states"` is how
 * this was read without a display.
 */
import * as React from "react";
import type { BlobLinkView, IndexedFile, PromptTemplate, SkillReference } from "@volli/shared";

import {
  ComposerPickerStack,
  SessionComposer,
  type ComposerModel,
  type ComposerModelSelection,
  type ComposerTierRow,
} from "@renderer/components/chat/composer-ui";
import { ComposerFooter } from "@renderer/components/board/new-ticket/composer-footer";
import { InstructionsTextarea } from "@renderer/components/automations/automation-editor";
import type { QueuedMessage, SessionContextUsage } from "@volli/session-presentation";
import { cn } from "@renderer/lib/utils";

export const title = "Composer · states × widths";
export const note =
  "Every composer state at 720 / 480 / 265px, with the other prompt surfaces under it";

const MODELS: readonly ComposerModel[] = [
  {
    id: "anthropic/claude-sonnet-4.5",
    providerId: "anthropic",
    providerLabel: "Anthropic",
    modelId: "claude-sonnet-4.5",
    label: "Claude Sonnet 4.5",
    reasoningLevels: ["off", "low", "medium", "high"],
  },
  {
    id: "anthropic/claude-opus-4.1",
    providerId: "anthropic",
    providerLabel: "Anthropic",
    modelId: "claude-opus-4.1",
    label: "Claude Opus 4.1",
    reasoningLevels: ["off", "low", "medium", "high", "max"],
  },
  {
    id: "openai/gpt-5",
    providerId: "openai",
    providerLabel: "OpenAI",
    modelId: "gpt-5",
    label: "GPT-5",
    reasoningLevels: ["minimal", "low", "medium", "high"],
  },
];

const TIERS: readonly ComposerTierRow[] = [
  {
    tier: "fast",
    label: "Fast",
    state: "ready",
    model: {
      providerId: "anthropic",
      providerLabel: "Anthropic",
      modelId: "claude-sonnet-4.5",
      label: "Claude Sonnet 4.5",
    },
    reasoningLevel: "low",
  },
  {
    tier: "deep",
    label: "Deep",
    state: "ready",
    model: {
      providerId: "anthropic",
      providerLabel: "Anthropic",
      modelId: "claude-opus-4.1",
      label: "Claude Opus 4.1",
    },
    reasoningLevel: "high",
  },
  { tier: "visual", label: "Visual", state: "unset", model: null, reasoningLevel: null },
  {
    tier: "ticket",
    label: "Ticket Sessions",
    state: "ready",
    model: {
      providerId: "anthropic",
      providerLabel: "Anthropic",
      modelId: "claude-sonnet-4.5",
      label: "Claude Sonnet 4.5",
    },
    reasoningLevel: "medium",
  },
  {
    tier: "global",
    label: "Global",
    state: "signed-out",
    model: { providerId: "openai", providerLabel: "OpenAI", modelId: "gpt-5", label: "GPT-5" },
    reasoningLevel: "high",
  },
];

const SELECTION = {
  providerId: "anthropic",
  modelId: "claude-sonnet-4.5",
  reasoningLevel: "high",
} as const satisfies ComposerModelSelection;

const TEMPLATES: readonly PromptTemplate[] = [
  {
    name: "review",
    description: "Review a file for bugs and style",
    content: "Review $1 for bugs and style.",
  },
  { name: "ship", description: "Open a pull request", content: "Open a pull request." },
];

const SKILLS: readonly SkillReference[] = [];

const FILES: readonly IndexedFile[] = [
  { relPath: "src/main/index.ts", kind: "other", artifact: false },
  { relPath: "src/renderer/src/components/chat/composer-ui.tsx", kind: "other", artifact: false },
  { relPath: "docs/DESIGN.md", kind: "markdown", artifact: false },
  { relPath: ".volli/artifacts/composer-notes.md", kind: "markdown", artifact: true },
];

const QUEUED: readonly QueuedMessage[] = [
  { id: "q1", text: "Then run the tests and fix whatever fails.", attachments: [] },
  { id: "q2", text: "Open a PR when green.", attachments: [] },
];

const CONTEXT: SessionContextUsage = {
  usedTokens: 84_000,
  contextWindow: 200_000,
  fraction: 0.42,
  segments: [
    { id: "system", label: "System", tokens: 12_000 },
    { id: "user", label: "You", tokens: 8_000 },
    { id: "assistant", label: "Assistant", tokens: 30_000 },
    { id: "reasoning", label: "Reasoning", tokens: 4_000 },
    { id: "tools", label: "Tools", tokens: 30_000 },
  ],
};

const ATTACHMENTS: readonly BlobLinkView[] = [
  {
    linkId: "b1",
    blobHash: "a".repeat(64),
    label: "screenshot.png",
    originalName: "Screenshot 2026-09-01 at 10.31.44.png",
    mime: "image/png",
    sizeBytes: 182_000,
  },
  {
    linkId: "b2",
    blobHash: "d".repeat(64),
    label: "spec.pdf",
    originalName: "spec.pdf",
    mime: "application/pdf",
    sizeBytes: 1_200_000,
  },
];

const WIDTHS = [
  { label: "720 · reading measure", width: 720 },
  { label: "480 · split", width: 480 },
  { label: "265 · narrowest pane", width: 265 },
] as const;

type StateId = "empty" | "draft" | "working" | "attachments" | "frozen" | "inert";

const STATES: readonly { id: StateId; label: string }[] = [
  { id: "empty", label: "Idle, empty" },
  { id: "draft", label: "Idle, draft" },
  { id: "working", label: "Turn live, two queued" },
  { id: "attachments", label: "Two attachments" },
  { id: "frozen", label: "Frozen pill (no models)" },
  { id: "inert", label: "Not ready" },
];

function Cell({ state, width }: { state: StateId; width: number }) {
  const [value, setValue] = React.useState(
    state === "draft" || state === "working"
      ? "Rename the picker's `active` to `highlighted` and update the tests."
      : "",
  );
  const [selection, setSelection] = React.useState<ComposerModelSelection>(SELECTION);
  const [queued, setQueued] = React.useState(state === "working" ? QUEUED : []);
  const working = state === "working";
  return (
    <div style={{ width }} className="shrink-0">
      <SessionComposer
        value={value}
        onValueChange={setValue}
        models={state === "frozen" ? [] : MODELS}
        tiers={TIERS}
        selection={selection}
        selectionTier={state === "empty" ? "Ticket Sessions" : null}
        onSelectionChange={setSelection}
        modelChoiceDisabled={working}
        working={working}
        ready={state !== "inert"}
        queued={queued}
        onQueuedChange={setQueued}
        onSteerQueued={() => undefined}
        onSubmit={() => setValue("")}
        onStop={() => undefined}
        promptTemplates={TEMPLATES}
        skills={SKILLS}
        files={FILES}
        contextUsage={state === "empty" ? null : CONTEXT}
        attachments={state === "attachments" ? ATTACHMENTS : []}
        onAttachFiles={() => undefined}
        onRemoveAttachment={() => undefined}
      />
    </div>
  );
}

export default function ComposerStatesScratch() {
  const [instructions, setInstructions] = React.useState("");
  const [state, setState] = React.useState<StateId>("empty");
  const [width, setWidth] = React.useState<number>(720);
  const [all, setAll] = React.useState(false);
  return (
    <div data-testid="composer-states" className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-2">
        {STATES.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => setState(option.id)}
            aria-pressed={option.id === state}
            className="rounded-full border border-border px-2 py-1 text-label text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
          >
            {option.label}
          </button>
        ))}
        <span className="mx-2 text-muted-foreground">·</span>
        {WIDTHS.map((option) => (
          <button
            key={option.width}
            type="button"
            onClick={() => setWidth(option.width)}
            aria-pressed={option.width === width}
            className="rounded-full border border-border px-2 py-1 text-label text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
          >
            {option.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setAll((current) => !current)}
          aria-pressed={all}
          className="ml-auto rounded-full border border-border px-2 py-1 text-label text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
        >
          All states
        </button>
      </div>

      {all ? (
        STATES.map((option) => (
          <section key={option.id} className="flex flex-col gap-2">
            <h2 className="text-label uppercase text-muted-foreground">{option.label}</h2>
            <Cell state={option.id} width={width} />
          </section>
        ))
      ) : (
        <Cell key={`${state}:${width}`} state={state} width={width} />
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-label uppercase text-muted-foreground">New-ticket footer</h2>
        <div style={{ width }} className={cn("rounded-xl border border-border bg-card")}>
          <div className="border-t border-border px-4 py-2">
            <ComposerFooter
              onAttachFiles={() => undefined}
              run={{
                models: MODELS,
                tiers: TIERS,
                selection: SELECTION,
                setSelection: () => undefined,
              }}
              createMore={false}
              onCreateMoreChange={() => undefined}
              onCreate={() => undefined}
              onKickoff={() => undefined}
              disabled={false}
            />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-label uppercase text-muted-foreground">Automation instructions</h2>
        <div style={{ width }}>
          <ComposerPickerStack
            value={instructions}
            onValueChange={setInstructions}
            ready
            interactionOpen={false}
            promptTemplates={TEMPLATES}
            skills={SKILLS}
            verbs={[]}
            files={FILES}
            layout="overlay"
          >
            <InstructionsTextarea
              value={instructions}
              onValueChange={setInstructions}
              className="min-h-48 rounded-xl bg-card px-4 py-4 shadow-raised"
            />
          </ComposerPickerStack>
        </div>
      </section>
    </div>
  );
}
