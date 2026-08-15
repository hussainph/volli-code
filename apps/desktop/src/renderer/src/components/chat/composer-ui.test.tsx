import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { PromptTemplate } from "@volli/shared";

import { PromptInput } from "@renderer/components/ui/ai-elements/prompt-input";
import type { ComposerPickerState } from "@renderer/chat/composer-picker";
import { Button } from "@renderer/components/ui/button";
import { DropdownMenuContent, DropdownMenuItem } from "@renderer/components/ui/dropdown-menu";

import { EffortPill } from "./composer-effort-ui";
import { ComposerPicker } from "./composer-picker-ui";
import {
  modelPillLabel,
  SessionComposer,
  type ComposerModel,
  type SessionComposerProps,
} from "./composer-ui";

interface InspectableProps {
  "aria-label"?: string;
  children?: React.ReactNode;
  className?: string;
  disabled?: boolean;
  levels?: readonly string[];
  onClick?(): void;
  onCloseAutoFocus?(event: { preventDefault(): void }): void;
  onSelect?(): void;
  onSubmit?(): void;
}

function findElements(
  node: React.ReactNode,
  type: React.ElementType,
): React.ReactElement<InspectableProps>[] {
  const found: React.ReactElement<InspectableProps>[] = [];
  for (const child of React.Children.toArray(node)) {
    if (!React.isValidElement(child)) continue;
    if (child.type === type) found.push(child as React.ReactElement<InspectableProps>);
    found.push(...findElements((child.props as InspectableProps).children, type));
  }
  return found;
}

function composerProps(overrides: Partial<SessionComposerProps> = {}): SessionComposerProps {
  return {
    value: "",
    onValueChange: () => undefined,
    models: [],
    selection: { providerId: "", modelId: "", reasoningLevel: "" },
    onSelectionChange: () => undefined,
    working: true,
    ready: true,
    queued: [{ id: "m1", text: "also cover the empty-name branch" }],
    onQueuedChange: () => undefined,
    onSteerQueued: () => undefined,
    onSubmit: () => undefined,
    onStop: () => undefined,
    ...overrides,
  };
}

function renderComposer(working = true): string {
  return renderToStaticMarkup(<SessionComposer {...composerProps({ working })} />);
}

describe("the queued message row", () => {
  it("keeps steer and removal direct while editing lives behind an accessible menu", () => {
    const html = renderComposer();

    expect(html).toContain("Steer");
    expect(html).toContain('aria-label="Steer queued message: also cover the empty-name branch"');
    expect(html).toContain('aria-label="Remove queued message: also cover the empty-name branch"');
    expect(html).toContain('data-slot="dropdown-menu-trigger"');
    expect(html).toContain('aria-label="Queued message actions: also cover the empty-name branch"');
    expect(html).not.toContain('aria-label="Edit queued message"');
  });

  it("names every repeated queue control with the message it acts on", () => {
    const html = renderToStaticMarkup(
      <SessionComposer
        {...composerProps({
          queued: [
            { id: "m1", text: "first follow-up" },
            { id: "m2", text: "second follow-up" },
          ],
        })}
      />,
    );

    for (const text of ["first follow-up", "second follow-up"]) {
      expect(html).toContain(`aria-label="Queued message: ${text}"`);
      expect(html).toContain(`aria-label="Steer queued message: ${text}"`);
      expect(html).toContain(`aria-label="Remove queued message: ${text}"`);
      expect(html).toContain(`aria-label="Queued message actions: ${text}"`);
    }
  });

  it("wires Edit message to return that row to the current draft", () => {
    let nextQueue: readonly { id: string; text: string }[] | undefined;
    let nextDraft: string | undefined;
    const acts: string[] = [];
    const tree = SessionComposer(
      composerProps({
        value: "new thought",
        onQueuedChange: (queue) => {
          acts.push("queue");
          nextQueue = queue;
        },
        onValueChange: (value) => {
          acts.push("draft");
          nextDraft = value;
        },
        onComposerFocusRequest: () => acts.push("focus"),
      }),
    );
    const edits = findElements(tree, DropdownMenuItem);
    const edit = edits[0];
    const menu = findElements(tree, DropdownMenuContent)[0];
    let restorePrevented = false;

    expect(edits).toHaveLength(1);
    expect(renderToStaticMarkup(<>{edit?.props.children}</>)).toContain("Edit message");
    // Dismissing a menu with its trigger intact keeps Radix's normal restore.
    menu?.props.onCloseAutoFocus?.({ preventDefault: () => (restorePrevented = true) });
    expect(restorePrevented).toBe(false);
    edit?.props.onSelect?.();
    menu?.props.onCloseAutoFocus?.({
      preventDefault: () => {
        restorePrevented = true;
      },
    });
    expect(nextQueue).toEqual([]);
    expect(nextDraft).toBe("also cover the empty-name branch\nnew thought");
    expect(acts).toEqual(["queue", "draft", "focus"]);
    expect(restorePrevented).toBe(true);
  });

  it("does not edit or remove a row whose resident delivery claim rejects mutation", () => {
    let draft: string | undefined;
    let focusRequests = 0;
    const tree = SessionComposer(
      composerProps({
        onQueuedChange: () => false,
        onValueChange: (value) => {
          draft = value;
        },
        onComposerFocusRequest: () => {
          focusRequests += 1;
        },
      }),
    );

    findElements(tree, DropdownMenuItem)[0]?.props.onSelect?.();
    const remove = findElements(tree, Button).find(
      (button) =>
        button.props["aria-label"] === "Remove queued message: also cover the empty-name branch",
    );
    remove?.props.onClick?.();

    expect(draft).toBeUndefined();
    expect(focusRequests).toBe(0);
  });

  it("wires direct Steer and removal before handing focus to the composer", () => {
    let steered: string | undefined;
    let nextQueue: readonly { id: string; text: string }[] | undefined;
    const acts: string[] = [];
    const tree = SessionComposer(
      composerProps({
        onSteerQueued: (id) => {
          acts.push(`steer:${id}`);
          steered = id;
        },
        onQueuedChange: (queue) => {
          acts.push(`queue:${queue.length}`);
          nextQueue = queue;
        },
        onComposerFocusRequest: () => acts.push("focus"),
      }),
    );
    const buttons = findElements(tree, Button);
    const named = (label: string) => buttons.find((button) => button.props["aria-label"] === label);

    named("Steer queued message: also cover the empty-name branch")?.props.onClick?.();
    expect(acts).toEqual(["steer:m1", "focus"]);
    acts.length = 0;
    named("Remove queued message: also cover the empty-name branch")?.props.onClick?.();
    expect(steered).toBe("m1");
    expect(nextQueue).toEqual([]);
    expect(acts).toEqual(["queue:0", "focus"]);
  });

  it("offers Steer only while there is an active turn", () => {
    const html = renderComposer(false);

    expect(html).not.toContain('aria-label="Steer queued message:');
    expect(html).toContain('aria-label="Remove queued message:');
    expect(html).toContain('aria-label="Queued message actions:');
  });

  it("names turn interruption and wears no focus dressing on the shell", () => {
    const html = renderComposer();

    expect(html).toContain('aria-label="Stop turn"');
    expect(html).not.toContain('aria-label="Stop"');
    // The caret is the field's focus indicator (field-classes.ts records the
    // decision); a shell that lights up on focus is a regression.
    expect(html).not.toContain("focus-visible]:border-ring");
  });
});

/* ------------------------------------------------------------------ effort */

const MODELS: readonly ComposerModel[] = [
  {
    id: "anthropic/sonnet-4.5",
    providerId: "anthropic",
    providerLabel: "Anthropic",
    modelId: "sonnet-4.5",
    label: "sonnet-4.5",
    reasoningLevels: ["low", "medium", "xhigh"],
  },
  {
    // Pins its own effort: one level is not a decision, so there is nothing to
    // render — the same rule the model pill itself follows.
    id: "openai/o5-mini",
    providerId: "openai",
    providerLabel: "OpenAI",
    modelId: "o5-mini",
    label: "o5-mini",
    reasoningLevels: ["medium"],
  },
];

function footerProps(overrides: Partial<SessionComposerProps> = {}): SessionComposerProps {
  return composerProps({
    working: false,
    queued: [],
    models: MODELS,
    selection: { providerId: "anthropic", modelId: "sonnet-4.5", reasoningLevel: "medium" },
    ...overrides,
  });
}

function renderFooter(overrides: Partial<SessionComposerProps> = {}): string {
  return renderToStaticMarkup(<SessionComposer {...footerProps(overrides)} />);
}

/** The effort chip as an ELEMENT, so its props can be read rather than parsed. */
function effortPill(
  overrides: Partial<SessionComposerProps> = {},
): React.ReactElement<InspectableProps> | undefined {
  return findElements(SessionComposer(footerProps(overrides)), EffortPill)[0];
}

describe("the effort control's place in the footer", () => {
  it("stands beside the model pill rather than inside its popover", () => {
    const html = renderFooter();

    // Readable before the first keystroke, which is the whole complaint the
    // redesign answers — it used to be two levels down, on one row of a list.
    expect(html).toContain('aria-label="Reasoning effort: Medium"');
  });

  it("titles the wire format at the UI boundary", () => {
    const html = renderFooter({
      selection: { providerId: "anthropic", modelId: "sonnet-4.5", reasoningLevel: "xhigh" },
    });

    expect(html).toContain('aria-label="Reasoning effort: Extra high"');
    expect(html).toContain("Extra high");
    expect(html).not.toContain(">xhigh<");
  });

  it("renders no effort control at all for a model that pins its own", () => {
    const html = renderFooter({
      selection: { providerId: "openai", modelId: "o5-mini", reasoningLevel: "medium" },
    });

    expect(html).not.toContain("Reasoning effort");
    expect(html).toContain("o5-mini");
  });

  it("goes with the model pill when model policy is frozen by a live turn", () => {
    // Effort is part of the model selection, so a turn that freezes one
    // freezes the other; two controls disagreeing about that would be worse
    // than either answer.
    const frozen = effortPill({ modelChoiceDisabled: true });
    const open = effortPill();

    expect(frozen?.props.disabled).toBe(true);
    expect(open?.props.disabled).toBe(false);
  });

  it("hands the selected model's own stop set down, and never invents one", () => {
    expect(effortPill()?.props.levels).toEqual(["low", "medium", "xhigh"]);
  });

  it("rests its chrome dim, and comes up for focus AND for an open menu", () => {
    const html = renderFooter();

    expect(html).toContain("opacity-70");
    expect(html).toContain("group-focus-within/composer:opacity-100");
    // The half `:focus-within` cannot do: a Radix popover portals its content
    // out of this form, so opening the model list moves focus off the composer
    // and the row would dim under the hand that opened it.
    expect(html).toContain("has-[[data-state=open]]:opacity-100");
  });
});

describe("what the model pill is willing to say", () => {
  it("names the model and nothing else", () => {
    // The level used to ride along as a third term. A bare level word next to a
    // model name reads as a claim about the model.
    expect(
      modelPillLabel(MODELS, {
        providerId: "anthropic",
        modelId: "sonnet-4.5",
        reasoningLevel: "medium",
      }),
    ).toBe("sonnet-4.5");
  });

  it("still leads with the provider where the name alone would be ambiguous", () => {
    expect(
      modelPillLabel(MODELS, {
        providerId: "azure",
        modelId: "sonnet-4.5",
        reasoningLevel: "high",
      }),
    ).toBe("azure · sonnet-4.5");
    expect(
      modelPillLabel(
        MODELS,
        { providerId: "azure", modelId: "sonnet-4.5", reasoningLevel: "high" },
        "Azure OpenAI",
      ),
    ).toBe("Azure OpenAI · sonnet-4.5");
  });

  it("falls back to a noun when there is no model to name", () => {
    expect(modelPillLabel([], { providerId: "", modelId: "", reasoningLevel: "" })).toBe("Model");
  });
});

/* ------------------------------------------------------------------ picker */

const TEMPLATES: readonly PromptTemplate[] = [
  { name: "review", description: "Review a file", content: "Review $1 closely." },
  { name: "ship", description: "Open a pull request", content: "Ship it." },
];

/** Submit the composer's form the way ⏎ and the send button both do. */
function submitComposer(props: Partial<SessionComposerProps>): string | undefined {
  let sent: string | undefined;
  const tree = SessionComposer(
    composerProps({ working: false, queued: [], onSubmit: (text) => (sent = text), ...props }),
  );
  findElements(tree, PromptInput)[0]?.props.onSubmit?.();
  return sent;
}

describe("what a composed message actually sends", () => {
  it("expands a staged command with its arguments before the submit path sees it", () => {
    expect(submitComposer({ value: "/review src/app.ts", promptTemplates: TEMPLATES })).toBe(
      "Review src/app.ts closely.",
    );
  });

  it("expands a command that takes nothing", () => {
    expect(submitComposer({ value: "/ship", promptTemplates: TEMPLATES })).toBe("Ship it.");
  });

  it("sends an unknown command as written rather than losing the message", () => {
    expect(submitComposer({ value: "/nope please", promptTemplates: TEMPLATES })).toBe(
      "/nope please",
    );
  });

  it("leaves ordinary prose — and its surrounding space — exactly as before", () => {
    expect(submitComposer({ value: "  just a message  ", promptTemplates: TEMPLATES })).toBe(
      "just a message",
    );
  });

  it("sends nothing at all from an empty box", () => {
    expect(submitComposer({ value: "   ", promptTemplates: TEMPLATES })).toBeUndefined();
  });

  it("cannot expand what it was never given", () => {
    expect(submitComposer({ value: "/ship" })).toBe("/ship");
  });
});

function pickerState(overrides: Partial<ComposerPickerState> = {}): ComposerPickerState {
  return {
    mode: "command",
    from: 0,
    to: 4,
    query: "rev",
    rows: [
      {
        kind: "command",
        value: "review",
        label: "/review",
        detail: "Review a file",
        template: TEMPLATES[0]!,
      },
    ],
    ...overrides,
  };
}

function renderPicker(value: ComposerPickerState | null): string {
  return renderToStaticMarkup(
    <ComposerPicker
      state={value}
      active="review"
      onActiveChange={() => undefined}
      onSelect={() => undefined}
    />,
  );
}

describe("the picker card", () => {
  it("renders nothing at all when the picker is closed", () => {
    expect(renderPicker(null)).toBe("");
  });

  it("stands on the shared composer-stack shell rather than a popover", () => {
    const html = renderPicker(pickerState());

    expect(html).toContain('data-slot="composer-picker"');
    expect(html).toContain("rounded-container");
    expect(html).not.toContain('data-slot="popover-content"');
  });

  it("names a command row with its slash and its description", () => {
    const html = renderPicker(pickerState());

    expect(html).toContain("/review");
    expect(html).toContain("Review a file");
    expect(html).toContain("Commands");
  });

  it("shows a file row's directory beside its name, and heads the group Files", () => {
    const html = renderPicker(
      pickerState({
        mode: "file",
        rows: [
          {
            kind: "file",
            value: "src/app.ts",
            label: "app.ts",
            detail: "src",
            relPath: "src/app.ts",
            artifact: false,
          },
        ],
      }),
    );

    expect(html).toContain("app.ts");
    expect(html).toContain(">src<");
    expect(html).toContain("Files");
  });

  it("takes no focus of its own — there is no input inside it", () => {
    expect(renderPicker(pickerState())).not.toContain('data-slot="command-input"');
  });

  it("says so when nothing matched, without a sentence about it", () => {
    const html = renderPicker(pickerState({ rows: [] }));

    expect(html).toContain("No match");
  });
});

/**
 * The layout contract, not decoration: `chat-plane.tsx` measures the whole
 * bottom mount and publishes it as `--composer-height`, which is what the
 * transcript pads its bottom by. The picker only pushes the feed up — instead
 * of covering its last message — because it occupies real height inside that
 * measured box, above the input. Both halves are asserted here because both are
 * one careless `absolute` away from silently breaking on a full transcript and
 * looking perfect on an empty one.
 */
describe("the picker's place in the composer stack", () => {
  it("costs no height at all while it is closed", () => {
    expect(renderPicker(null)).toBe("");
  });

  it("takes layout space rather than floating over the transcript", () => {
    const html = renderPicker(pickerState());
    const card = /<div data-slot="composer-picker" class="([^"]*)"/.exec(html)?.[1];

    // The card's OWN classes — cmdk's sr-only label carries an inline
    // `position:absolute` of its own, and that 1px box is not the question.
    // Either utility here would make the card contribute no height, so the
    // feed's clearance would not grow and the card would land on top of the
    // last message.
    expect(card).toBeDefined();
    expect(card).not.toMatch(/\babsolute\b/);
    expect(card).not.toMatch(/\bfixed\b/);
  });

  it("stacks the picker above the input in one normal-flow column", () => {
    const html = renderComposer();

    // The stack is the composer's OUTERMOST element, so whatever wraps
    // SessionComposer — in the app, chat-plane's ResizeObserver'd bottom
    // mount — necessarily contains the picker's slot too, and the measured
    // height grows when the picker opens.
    expect(
      html.startsWith('<div data-slot="composer-picker-stack" class="flex flex-col gap-2">'),
    ).toBe(true);
    // The composer's own shell comes after the picker's slot: growth happens
    // above the input, and the input itself does not move.
    expect(html.indexOf('data-slot="composer-picker-stack"')).toBeLessThan(html.indexOf("<form"));
  });
});
