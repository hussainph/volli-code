import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { COMPACT_VERB, COMPOSER_VERBS } from "@volli/shared";
import type { PromptResource, PromptTemplate, SkillReference } from "@volli/shared";

import { PromptInput } from "@renderer/components/ui/ai-elements/prompt-input";
import { AttachmentStrip } from "@renderer/components/attachments/attachment-strip";
import type { ComposerPickerState } from "@renderer/chat/composer-picker";
import { Button } from "@renderer/components/ui/button";
import { DropdownMenuContent, DropdownMenuItem } from "@renderer/components/ui/dropdown-menu";

import { EffortPill } from "./composer-effort-ui";
import { ComposerPicker } from "./composer-picker-ui";
import {
  modelPillLabel,
  ModelPill,
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

/**
 * The composer's own element tree, with no renderer under it — which is how
 * every assertion below reads its props rather than its markup.
 *
 * `.type`, because `SessionComposer` is `React.memo`'d (see its own comment for
 * why) and a memo component is an object, not a function. `.type` is the render
 * function inside it, so this stays the same call it always was.
 */
const composerTree = SessionComposer.type;

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
    const tree = composerTree(
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
    // Two focus requests: one inside `editQueued` (which the modal menu's
    // focus trap swallows while the content is still mounted) and one from
    // `onCloseAutoFocus`, the first moment after the trap is gone — the only
    // request that can actually land on the textarea.
    expect(acts).toEqual(["queue", "draft", "focus", "focus"]);
    expect(restorePrevented).toBe(true);
  });

  it("does not edit or remove a row whose resident delivery claim rejects mutation", () => {
    let draft: string | undefined;
    let focusRequests = 0;
    const tree = composerTree(
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

  // Unqueue and edit are the same gesture, and neither may lose the file the
  // row carried: the files go back to the strip BEFORE the row leaves the
  // queue, because the removal path reads the strip to tell "came back" from
  // "deleted" — restoring after would read as a delete and drop the links.
  it("hands an edited row's attachments back to the strip before it leaves the queue", () => {
    const acts: string[] = [];
    const attachments = [
      {
        linkId: "link-1",
        blobHash: "ab".repeat(32),
        label: "shot.png",
        originalName: "shot.png",
        mime: "image/png",
        sizeBytes: 2048,
      },
    ];
    const tree = composerTree(
      composerProps({
        queued: [{ id: "m1", text: "look", attachments }],
        onQueuedChange: () => {
          acts.push("queue");
          return true;
        },
        onValueChange: () => acts.push("draft"),
        onComposerFocusRequest: () => acts.push("focus"),
        onRestoreAttachments: (restored) => {
          acts.push("restore");
          expect(restored).toEqual(attachments);
        },
      }),
    );

    findElements(tree, DropdownMenuItem)[0]?.props.onSelect?.();

    expect(acts).toEqual(["restore", "queue", "draft", "focus"]);
  });

  it("wires direct Steer and removal before handing focus to the composer", () => {
    let steered: string | undefined;
    let nextQueue: readonly { id: string; text: string }[] | undefined;
    const acts: string[] = [];
    const tree = composerTree(
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
  return findElements(composerTree(footerProps(overrides)), EffortPill)[0];
}

describe("the attachment strip's place in the box", () => {
  const ATTACHMENT = {
    linkId: "link-1",
    blobHash: "ab".repeat(32),
    label: "shot.png",
    originalName: "shot.png",
    mime: "image/png",
    sizeBytes: 2048,
  } as const;

  function stripElement(overrides: Partial<SessionComposerProps> = {}) {
    const tree = composerTree(composerProps({ attachments: [ATTACHMENT], ...overrides }));
    return findElements(tree, AttachmentStrip)[0];
  }

  // `PromptInputBody` is `display:contents`, so the strip is a flex child of
  // the vendored `InputGroup` — `items-center`, and a column once the footer
  // mounts. Without a width of its own the strip sat mid-composer while the
  // words and the controls ran edge to edge: one thumbnail floating over the
  // textarea's centre. It starts from the left (VC-137).
  it("fills the box's width, so the thumbnails start from the left", () => {
    const strip = stripElement();

    expect(strip).toBeDefined();
    expect(strip?.props.className).toContain("w-full");
  });

  it("stays left-anchored in its own row, never centring its items", () => {
    const strip = stripElement();

    expect(strip?.props.className).not.toContain("justify-center");
    expect(strip?.props.className).not.toContain("items-center");
  });
});

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
  const tree = composerTree(
    composerProps({ working: false, queued: [], onSubmit: (text) => (sent = text), ...props }),
  );
  findElements(tree, PromptInput)[0]?.props.onSubmit?.();
  return sent;
}

/** {@link submitComposer}, keeping the message-scoped resources too. */
function submitComposerWithResources(
  props: Partial<SessionComposerProps>,
): { text: string; resources: readonly PromptResource[] } | undefined {
  let sent: { text: string; resources: readonly PromptResource[] } | undefined;
  const tree = composerTree(
    composerProps({
      working: false,
      queued: [],
      onSubmit: (text, _intent, resources) => (sent = { text, resources: resources ?? [] }),
      ...props,
    }),
  );
  findElements(tree, PromptInput)[0]?.props.onSubmit?.();
  return sent;
}

/**
 * The model pill under a controlled open — `/model`'s target. The pill keeps
 * its own state when uncontrolled; the verb's press supplies `open`, and what
 * is pinned here is that the caller's open is the popover's open: Radix
 * marks the trigger `data-state="open"` the moment it is.
 */
describe("the model pill's controlled open", () => {
  function pillMarkup(overrides: Partial<Parameters<typeof ModelPill>[0]> = {}): string {
    return renderToStaticMarkup(
      <ModelPill
        models={MODELS}
        selection={{ providerId: "anthropic", modelId: "sonnet-4.5", reasoningLevel: "" }}
        disabled={false}
        onChange={() => undefined}
        {...overrides}
      />,
    );
  }

  it("takes the caller's open as the popover's own", () => {
    expect(pillMarkup({ open: true })).toContain('data-state="open"');
  });

  it("stays uncontrolled when no open arrives", () => {
    // No `open` prop — the internal state is the only opinion, exactly as
    // before the verb existed.
    expect(pillMarkup()).toContain('data-state="closed"');
    expect(pillMarkup({ open: false })).toContain('data-state="closed"');
  });
});

describe("what a composed message actually sends", () => {
  it("expands a staged command with its arguments before the submit path sees it", () => {
    expect(submitComposer({ value: "/review src/app.ts", promptTemplates: TEMPLATES })).toBe(
      "Review src/app.ts closely.",
    );
  });

  it("expands a command that takes nothing", () => {
    expect(submitComposer({ value: "/ship", promptTemplates: TEMPLATES })).toBe("Ship it.");
  });

  it("expands a command staged mid-draft, keeping the prose around it", () => {
    expect(submitComposer({ value: "please /review src/app.ts", promptTemplates: TEMPLATES })).toBe(
      "please Review src/app.ts closely.",
    );
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

  // The composer performs no verb: it hands the text on untouched and the
  // plane's `composerPress` claims it. What matters here is that it arrives
  // claimable — a `/compact` expanded into some prompt body would be a
  // compaction request quietly sent to the model as a message.
  it("sends a verb's draft through as typed, even against a template of that name", () => {
    const shadowing = [
      ...TEMPLATES,
      { name: "compact", description: "my own prompt", content: "Please summarize this chat." },
    ];

    expect(submitComposer({ value: "/compact", promptTemplates: shadowing })).toBe("/compact");
    expect(
      submitComposer({ value: "/compact keep the API work", promptTemplates: shadowing }),
    ).toBe("/compact keep the API work");
  });

  // VC-49: a skill reference is never rewritten into the body. The text keeps
  // the slash reference — mid-sentence included — and the resolved body
  // travels beside it as a message-scoped resource.
  it("sends a skill reference as typed, with its body beside the message", () => {
    const skills: readonly SkillReference[] = [
      {
        name: "logos",
        description: "Design logos",
        body: "# Logos",
        userInvokeOnly: false,
        root: ".agents/skills/logos",
      },
    ];
    const sent = submitComposerWithResources({
      value: "can you tell me what /logos does?",
      promptTemplates: TEMPLATES,
      skills,
    });
    expect(sent?.text).toBe("can you tell me what /logos does?");
    expect(sent?.text).not.toContain("BEGIN RESOURCE");
    expect(sent?.resources).toEqual([
      {
        name: "logos",
        text: "Skill directory: .agents/skills/logos/ — file references in this skill resolve relative to it.\n\n# Logos",
      },
    ]);
  });
});

describe("the composer while a question is waiting on an answer", () => {
  /** The blocked turn, exactly as the plane hands it over: live, and asked. */
  function answeringComposer(overrides: Partial<SessionComposerProps> = {}): string {
    return renderToStaticMarkup(
      <SessionComposer
        {...composerProps({ working: true, interactionOpen: true, answering: true, ...overrides })}
      />,
    );
  }

  it("is a live box that says where its words are going", () => {
    const html = answeringComposer();
    // Never disabled, which is the whole point: a question must not be able to
    // take the composer away from the person it is asking.
    expect(html).toContain('placeholder="Your answer"');
    expect(html).toContain('aria-label="Answer"');
    expect(html).not.toContain("<textarea disabled");
  });

  it("stops calling the press a queue while the queue could not release it", () => {
    // `ask_user` blocks INSIDE a turn, so `working` holds for the whole of a
    // pending question — and a queue drains into an idle Session, which this
    // one cannot become until the question is answered.
    expect(answeringComposer()).toContain('aria-label="Answer"');
    expect(answeringComposer()).not.toContain('aria-label="Queue"');
    // The turn is still live, so the way to stop it is still on the row.
    expect(answeringComposer()).toContain('aria-label="Stop turn"');
  });

  it("is the ordinary message box again the moment nothing is asked", () => {
    const html = renderToStaticMarkup(
      <SessionComposer {...composerProps({ working: true, interactionOpen: true })} />,
    );
    expect(html).toContain('placeholder="Ask, plan, or implement…"');
    expect(html).toContain('aria-label="Message"');
    expect(html).toContain('aria-label="Queue"');
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

/**
 * The card draws a mode and its rows and takes nothing else — the token being
 * completed is the composer's business. The fixture stays a whole
 * `ComposerPickerState` because that is what the composer builds; this narrows
 * it exactly as the call site does.
 */
function renderPicker(value: ComposerPickerState | null): string {
  return renderToStaticMarkup(
    <ComposerPicker
      mode={value?.mode ?? null}
      rows={value?.rows ?? []}
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

  it("heads a verb row Actions, apart from the rows that only write text", () => {
    const html = renderPicker(
      pickerState({
        rows: [
          {
            kind: "verb",
            value: "verb:compact",
            label: "/compact",
            detail: COMPACT_VERB.description,
            verb: COMPACT_VERB,
          },
          ...pickerState().rows,
        ],
      }),
    );

    // Two headings, and the verb's comes first — the flat row order and the
    // visual one have to agree or the arrow keys walk a different list. The
    // `>heading<` form is deliberate: the card's own aria-label says
    // "Commands" for the whole `/` mode and would otherwise win the race.
    expect(html).toContain(">Actions<");
    expect(html).toContain("/compact");
    expect(html.indexOf(">Actions<")).toBeLessThan(html.indexOf(">Commands<"));
  });

  it("draws a glyph for every verb there is, and never the same one twice", () => {
    // The glyph names the act, so two verbs wearing one mark is the row
    // saying less than it looks like it does. `VERB_ICONS` is keyed by the
    // closed name union, so a verb with no glyph cannot compile — what this
    // pins is the half the type cannot: that the six are distinct drawings,
    // and that each verb actually reaches its own.
    const paths = COMPOSER_VERBS.map((verb) => {
      const html = renderPicker(
        pickerState({
          rows: [
            {
              kind: "verb",
              value: `verb:${verb.name}`,
              label: `/${verb.name}`,
              detail: verb.description,
              verb,
            },
          ],
        }),
      );
      const path = /<svg[^>]*>(.*?)<\/svg>/s.exec(html)?.[1];
      expect(path, `${verb.name} drew no glyph`).toBeTruthy();
      return path;
    });

    expect(new Set(paths).size).toBe(COMPOSER_VERBS.length);
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
