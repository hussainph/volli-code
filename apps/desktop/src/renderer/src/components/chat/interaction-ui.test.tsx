/**
 * What the card *says*, as opposed to what it decides.
 *
 * The decisions are `interaction.ts`'s and are tested there against the draft
 * alone — the walk (`interactionStep`), what a press of the control that moves
 * it on does (`interactionAdvance`), what a blocked press says
 * (`promptRequirement`), and whether the box beside the options is open at all
 * (`askFieldOpen`). This file is deliberately the other half, because the
 * renderer test project runs under vitest's default `node` environment: there
 * is no DOM to click, so what it can assert is the markup, and the markup is
 * exactly where the mistakes it is here for live — two acts drawn at one
 * weight, a control wearing a sentence written for a placeholder, a request
 * that takes focus off the composer it mounted beside, and a question drawn
 * with the verdict card's chrome.
 */
import type { SessionInteraction, SessionInteractionPrompt } from "@volli/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ComposerInteractionStack,
  InteractionCard,
  PendingInteractionAnnouncement,
} from "./interaction-ui";

const PERMISSION_OPTIONS = [
  { id: "once", label: "Allow once", description: null },
  { id: "always", label: "Allow always", description: null },
  { id: "reject", label: "Reject", description: null },
];

function permission(): SessionInteraction {
  return {
    id: "permission:p1",
    attachmentId: "attach-1",
    kind: "permission",
    title: "rm -rf node_modules",
    detail: "bash",
    options: PERMISSION_OPTIONS,
    multiple: false,
    prompts: [
      {
        id: "prompt:0",
        label: "rm -rf node_modules",
        detail: "bash",
        options: PERMISSION_OPTIONS,
        multiple: false,
        custom: false,
      },
    ],
    native: { id: "perm-1", detail: null },
  };
}

function asked(): SessionInteraction {
  const options = [{ id: "question:0:bWFpbg", label: "main", description: null }];
  return {
    id: "question:q1",
    attachmentId: "attach-1",
    kind: "question",
    title: "Which branch?",
    detail: null,
    options,
    multiple: false,
    prompts: [
      {
        id: "prompt:0",
        label: "Which branch?",
        detail: null,
        options,
        multiple: false,
        custom: false,
      },
    ],
    native: { id: "q-1", detail: null },
  };
}

function freeText(options: SessionInteraction["options"] = []): SessionInteraction {
  return {
    id: "question:free-text",
    attachmentId: "attach-1",
    kind: "question",
    title: "What should change?",
    detail: null,
    options,
    multiple: false,
    prompts: [
      {
        id: "prompt:0",
        label: "What should change?",
        detail: null,
        options,
        multiple: false,
        custom: true,
      },
    ],
    native: { id: "q-free-text", detail: null },
  };
}

function askPrompt(overrides: Partial<SessionInteractionPrompt> = {}): SessionInteractionPrompt {
  return {
    id: "prompt:0",
    label: "Which branch should this land on?",
    detail: null,
    options: [
      { id: "question:0:bWFpbg", label: "main", description: "ships on the next tag" },
      { id: "question:0:cmVsZWFzZQ", label: "release", description: null },
    ],
    multiple: false,
    custom: true,
    ...overrides,
  };
}

/** A harness question: encoded ids, so none of them can read as a declared no. */
function ask(prompts: readonly SessionInteractionPrompt[]): SessionInteraction {
  return {
    id: "question:ask",
    attachmentId: "attach-1",
    kind: "question",
    title: "Before I start the migration",
    detail: null,
    options: prompts.flatMap((prompt) => prompt.options),
    multiple: prompts.some((prompt) => prompt.multiple),
    prompts,
    native: { id: "ask-1", detail: null },
  };
}

function drawn(interaction: SessionInteraction): string {
  return renderToStaticMarkup(<InteractionCard interaction={interaction} onResolve={() => {}} />);
}

/**
 * The variant the button carrying this label was drawn with.
 *
 * Read off `data-variant`, which the shared button stamps for exactly this: the
 * class list is one long string in which every variant's colours look alike, and
 * the question here is which idiom the control belongs to, not what it computes.
 */
function buttonVariant(html: string, label: string): string | null {
  const button = html
    .split("<button")
    .find((fragment) => fragment.startsWith(" ") && fragment.includes(`>${label}</button>`));
  return button?.match(/data-variant="([^"]+)"/)?.[1] ?? null;
}

describe("the card's controls", () => {
  it("draws request withdrawal and refusal at different weights", () => {
    // Withdrawing the request and rejecting it are different durable acts. Both
    // as `ghost size="sm"` said they were the same kind of act, in the one place
    // a reader is deciding between them.
    const html = renderToStaticMarkup(
      <InteractionCard
        interaction={asked()}
        onResolve={() => undefined}
        onWithdraw={() => undefined}
      />,
    );
    expect(buttonVariant(html, "Cancel request")).toBe("ghost");
    expect(buttonVariant(html, "Reject")).toBe("outline");
  });

  it("leaves request withdrawal off the mount that did not ask for one", () => {
    // A card on a row sits beside a composer that still has its own.
    expect(
      renderToStaticMarkup(<InteractionCard interaction={asked()} onResolve={() => undefined} />),
    ).not.toContain("Cancel request");
  });

  it("names the box it opens rather than repeating the box's own question", () => {
    // The control that reveals a permission's field read "What to do instead" —
    // the placeholder's sentence, on a button. Labels are nouns.
    const html = renderToStaticMarkup(
      <InteractionCard interaction={permission()} onResolve={() => undefined} />,
    );
    expect(html).toContain(">Note</button>");
    expect(html).not.toContain("What to do instead");
  });

  it("shares the composer stack's rounded shell", () => {
    const html = renderToStaticMarkup(
      <InteractionCard interaction={asked()} onResolve={() => undefined} />,
    );
    expect(html).toContain("rounded-2xl");
  });

  it("never autofocuses a request that mounts beside the live composer", () => {
    const freeForm = renderToStaticMarkup(
      <ComposerInteractionStack interaction={freeText()} onResolve={() => undefined}>
        <textarea aria-label="Message" />
      </ComposerInteractionStack>,
    );

    expect(freeForm).toContain('aria-label="Message"');
    expect(freeForm).toContain('data-slot="composer-interaction-drawer"');
    expect(freeForm).toContain('data-slot="composer-interaction-origin"');
    expect(freeForm).not.toContain('autofocus=""');
  });
});

describe("the ask-user card", () => {
  it("draws a harness question as a walk and a permission as a list of verdicts", () => {
    // The fork is what is being asked, never where the card stands. A question
    // answers through rows it owns; a permission keeps its native inputs, every
    // declared verdict weighted against its neighbours in one view.
    const walk = drawn(ask([askPrompt()]));
    expect(walk).toContain('role="radio"');
    expect(walk).not.toContain('type="radio"');

    const gate = renderToStaticMarkup(
      <InteractionCard interaction={permission()} onResolve={() => undefined} />,
    );
    expect(gate).toContain('type="radio"');
    expect(gate).not.toContain('role="radio"');
  });

  it("keeps a sandbox escalation on the verdict card", () => {
    // Stored as a question, but it offers a declared yes and no — which is the
    // permission's shape, and the one case `kind` alone reads wrong.
    const raised: SessionInteraction = {
      ...ask([
        {
          id: "prompt:0",
          label: "Write outside the worktree",
          detail: null,
          options: [
            { id: "continue", label: "Keep working", description: null },
            { id: "stop", label: "Stop the turn", description: null },
          ],
          multiple: false,
          custom: false,
        },
      ]),
      title: "Write outside the worktree",
    };
    expect(drawn(raised)).toContain('type="radio"');
  });

  it("counts the questions only where there is more than one to count", () => {
    expect(drawn(ask([askPrompt()]))).not.toContain("Question 1 of");
    const walk = drawn(ask([askPrompt(), askPrompt({ id: "prompt:1", label: "Which remote?" })]));
    expect(walk).toContain("Question 1 of 2");
    expect(walk).toContain("Previous question");
  });

  it("offers a skip only while there is somewhere to skip to", () => {
    // Skipping is movement, not an answer, so the last question has nothing to
    // step to — and a single question is its own last.
    expect(drawn(ask([askPrompt(), askPrompt({ id: "prompt:1" })]))).toContain(">Skip<");
    expect(drawn(ask([askPrompt()]))).not.toContain(">Skip<");
  });

  it("names each row with the numeral that presses it", () => {
    const html = drawn(ask([askPrompt()]));
    expect(html).toContain(">1</span>");
    expect(html).toContain(">2</span>");
    // And the box is the row after the last option, so its number continues.
    expect(html).toContain(">3</span>");
  });

  it("opens the box beside the options only where the harness takes words", () => {
    expect(drawn(ask([askPrompt({ custom: true })]))).toContain("<textarea");
    // `custom: false` is a model that asked for one of the listed answers; a
    // box under it would collect words the reply has no slot for.
    const listed = drawn(ask([askPrompt({ custom: false })]));
    expect(listed).not.toContain("<textarea");
    expect(listed).toContain('role="radio"');
  });

  it("makes the box the whole answer where there is nothing to choose", () => {
    const html = drawn(ask([askPrompt({ options: [], custom: true })]));
    expect(html).toContain("<textarea");
    expect(html).not.toContain('role="radio"');
    // No numeral either: a lone box is not one row of a list.
    expect(html).not.toContain(">1</span>");
  });

  it("ticks several answers rather than replacing one", () => {
    const html = drawn(ask([askPrompt({ multiple: true })]));
    expect(html).toContain('role="checkbox"');
    expect(html).toContain('aria-checked="false"');
    // And it grows the control that says the question is done, which a single
    // choice does not need — there the click is the whole step.
    expect(html).toContain('type="submit"');
    expect(drawn(ask([askPrompt(), askPrompt({ id: "prompt:1" })]))).not.toContain('type="submit"');
  });

  it("names the group with the question it is asking", () => {
    const html = drawn(ask([askPrompt()]));
    const labelledBy = html.match(/role="radiogroup" aria-labelledby="([^"]+)"/)?.[1];
    expect(labelledBy).toBeTruthy();
    expect(html).toContain(`id="${labelledBy}"`);
  });

  it("still offers the refusal no harness id can carry, box or no box", () => {
    for (const custom of [true, false]) {
      const html = renderToStaticMarkup(
        <InteractionCard
          interaction={ask([askPrompt({ custom })])}
          onResolve={() => undefined}
          onWithdraw={() => undefined}
        />,
      );
      expect(buttonVariant(html, "Reject")).toBe("outline");
      expect(buttonVariant(html, "Cancel request")).toBe("ghost");
    }
  });

  it("leaves the footer's notice slot empty until a press is blocked", () => {
    // Validation is raised by a press and cleared by the edit that answers it,
    // so nothing about a freshly drawn card says anything is wrong with it.
    const html = drawn(ask([askPrompt({ custom: false })]));
    expect(html).not.toContain("Choose an option");
    expect(html).not.toContain("Write an answer");
    expect(html).not.toContain("Not delivered");
  });

  it("never autofocuses a lone box that mounted beside the live composer", () => {
    // The reference autofocuses because it is the only thing on screen. Here
    // the composer below is still mounted and may already have someone's words
    // in it; focus moves into the card only once the reader is driving it.
    const html = renderToStaticMarkup(
      <ComposerInteractionStack
        interaction={ask([askPrompt({ options: [], custom: true })])}
        onResolve={() => undefined}
      >
        <textarea aria-label="Message" />
      </ComposerInteractionStack>,
    );
    expect(html).toContain("<textarea");
    expect(html).not.toContain('autofocus=""');
  });
});

describe("the co-mounted request announcement", () => {
  it("politely announces a pending title without a focusable control", () => {
    const html = renderToStaticMarkup(<PendingInteractionAnnouncement interaction={asked()} />);

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).toContain("Request pending: Which branch?");
    expect(html).not.toContain("tabindex");
    expect(html).not.toContain("autofocus");
  });

  it("keeps the live region mounted while there is nothing to announce", () => {
    const html = renderToStaticMarkup(<PendingInteractionAnnouncement interaction={null} />);

    expect(html).toContain('role="status"');
    expect(html).not.toContain("Request pending:");
  });
});
