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
import type { RendererSessionInteraction, SessionInteractionPrompt } from "@volli/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ComposerInteractionStack,
  InteractionCard,
  InteractionReceiptLine,
  PendingInteractionAnnouncement,
} from "./interaction-ui";

const PERMISSION_OPTIONS = [
  { id: "once", label: "Allow once", description: null },
  { id: "always", label: "Allow always", description: null },
  { id: "reject", label: "Reject", description: null },
];

function permission(): RendererSessionInteraction {
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
    native: { id: null, detail: null },
  };
}

function asked(): RendererSessionInteraction {
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
    native: { id: null, detail: null },
  };
}

function freeText(options: RendererSessionInteraction["options"] = []): RendererSessionInteraction {
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
    native: { id: null, detail: null },
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
function ask(prompts: readonly SessionInteractionPrompt[]): RendererSessionInteraction {
  return {
    id: "question:ask",
    attachmentId: "attach-1",
    kind: "question",
    title: "Before I start the migration",
    detail: null,
    options: prompts.flatMap((prompt) => prompt.options),
    multiple: prompts.some((prompt) => prompt.multiple),
    prompts,
    native: { id: null, detail: null },
  };
}

function drawn(interaction: RendererSessionInteraction): string {
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

/**
 * The opening tag of the button wearing an `aria-label`, for the controls that
 * carry a glyph instead of a word.
 *
 * {@link buttonVariant} matches on text content, which an icon control has none
 * of — and the attributes are the whole of what one of those has to say.
 */
function labelledControl(html: string, label: string): string | null {
  const button = html
    .split("<button")
    .find((fragment) => fragment.startsWith(" ") && fragment.includes(`aria-label="${label}"`));
  return button === undefined ? null : button.slice(0, button.indexOf(">"));
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
    expect(html).toContain("rounded-container");
  });

  it("never autofocuses a request that mounts beside the live composer", () => {
    const freeForm = renderToStaticMarkup(
      <ComposerInteractionStack interaction={freeText()} onResolve={() => undefined}>
        <textarea aria-label="Message" />
      </ComposerInteractionStack>,
    );

    expect(freeForm).toContain('aria-label="Message"');
    expect(freeForm).toContain('data-slot="composer-interaction-drawer"');
    // Both slots, because e2e selects on them — not because their presence
    // proves the origin is still the plain div it has to be. A `layout` prop
    // renders the same markup as none, so the one invariant this stack turns
    // on (the composer never moves while a card enters) is invisible from
    // here and is measured frame-by-frame in the Lab instead. Green does not
    // mean the composer held still.
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
    const raised: RendererSessionInteraction = {
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

/**
 * A permission whose options declare no refusal of their own, which is what
 * makes the words a redirection and stands the box open on the verdict card —
 * the one shape in which both cards draw a text box at once.
 */
function noteOpenPermission(): RendererSessionInteraction {
  const options = PERMISSION_OPTIONS.slice(0, 2);
  return {
    id: "permission:p2",
    attachmentId: "attach-1",
    kind: "permission",
    title: "rm -rf node_modules",
    detail: "bash",
    options,
    multiple: false,
    prompts: [
      {
        id: "prompt:0",
        label: "rm -rf node_modules",
        detail: "bash",
        options,
        multiple: false,
        custom: false,
      },
    ],
    native: { id: null, detail: null },
  };
}

/** Every text box's class list in a rendered card, in document order. */
function boxes(html: string): string[] {
  return [...html.matchAll(/<textarea[^>]*class="([^"]*)"/g)].map(([, classes]) => classes ?? "");
}

/** The markup of the one row carrying this label, out of the list it sits in. */
function optionRow(html: string, label: string): string {
  const row = html.split("<label").find((fragment) => fragment.includes(`>${label}</span>`));
  if (row === undefined) throw new Error(`no option row labelled ${label}`);
  return row;
}

describe("the question that stands out of the transcript's way", () => {
  it("opens showing the question, and offers to put it away", () => {
    // Mounting minimised would hide the thing the card interrupted the reader
    // for. The gesture is the reader's, every time, and the control that takes
    // it says which way it goes.
    const html = drawn(ask([askPrompt()]));
    const control = labelledControl(html, "Minimize question");

    expect(control).not.toBeNull();
    expect(control).toContain('aria-expanded="true"');
    expect(labelledControl(html, "Expand question")).toBeNull();
    // Still the open card, not a strip: the rows are drawn.
    expect(html).toContain("ships on the next tag");
  });

  it("points the control at the part of the card it closes", () => {
    // `aria-controls` is the only thing tying a disclosure to what it discloses,
    // and the id is `useId`'s — so this asserts they agree rather than asserting
    // any particular string.
    const html = drawn(ask([askPrompt()]));
    const controls = labelledControl(html, "Minimize question")?.match(
      /aria-controls="([^"]+)"/,
    )?.[1];

    expect(controls).toBeTruthy();
    expect(html).toContain(`<div id="${controls}"`);
  });

  it("keeps it a view control rather than one more answer", () => {
    // Ghost and muted, beneath withdrawal in the same way withdrawal is beneath
    // the verdict: how much room a card takes up is not a decision about the
    // question, and a control at the weight of one would say it was.
    const html = renderToStaticMarkup(
      <InteractionCard
        interaction={ask([askPrompt()])}
        onResolve={() => undefined}
        onWithdraw={() => undefined}
      />,
    );

    expect(labelledControl(html, "Minimize question")).toContain('data-variant="ghost"');
    // And it changed neither of the acts it now stands beside.
    expect(buttonVariant(html, "Cancel request")).toBe("ghost");
    expect(buttonVariant(html, "Reject")).toBe("outline");
  });

  it("leaves the verdict card alone", () => {
    // A permission is bounded — inline rows, few of them, a detail capped at
    // `max-h-32` — so it never grows into the transcript the way a walk through
    // stacked options does. Nothing here is asking to be put away.
    const html = renderToStaticMarkup(
      <InteractionCard interaction={permission()} onResolve={() => undefined} />,
    );

    expect(labelledControl(html, "Minimize question")).toBeNull();
  });

  it("offers nothing to put away on a request that asks nothing", () => {
    // A request with no questions is all footer. There is no stage to close,
    // and a control pointing at one that was never drawn is a broken
    // `aria-controls` on top of a control that does nothing.
    const html = drawn(ask([]));

    expect(labelledControl(html, "Minimize question")).toBeNull();
    expect(labelledControl(html, "Expand question")).toBeNull();
  });
});

describe("the two cards as one family", () => {
  it("draws both lists of answers with the same row", () => {
    // The guarantee this test exists for: the shared row is a string in one
    // place, and the two cards are different elements around it. Nothing stops
    // a class being added to one of them and not the other except this.
    const verdict = optionRow(
      renderToStaticMarkup(
        <InteractionCard interaction={permission()} onResolve={() => undefined} />,
      ),
      "Allow once",
    );
    const answer = optionRow(drawn(ask([askPrompt()])), "main");
    for (const shared of ["gap-2", "rounded-lg", "px-2", "py-2", "transition-colors"])
      expect([shared, verdict.includes(shared), answer.includes(shared)]).toEqual([
        shared,
        true,
        true,
      ]);
  });

  it("keeps the standing grant's down-weighting ink rather than size", () => {
    // A smaller row is a smaller hit target for a live control. What says a
    // standing grant is not a louder yes is its ink, and the two rows are the
    // same height and the same weight so that the ink is all that differs.
    const html = renderToStaticMarkup(
      <InteractionCard interaction={permission()} onResolve={() => undefined} />,
    );
    const once = optionRow(html, "Allow once");
    const always = optionRow(html, "Allow always");
    expect(once).toContain("text-foreground");
    expect(always).toContain("text-muted-foreground");
    expect(always).not.toContain("text-foreground");
    expect(always).toContain("opacity-70");
    // Same row, same type step: only the colour moved.
    expect(once.includes("py-2")).toBe(always.includes("py-2"));
    expect(once.includes("text-ui font-medium")).toBe(always.includes("text-ui font-medium"));
  });

  it("leaves the only border to the card, on every box either card opens", () => {
    // One border per surface. A field drawing its own edge inside a bordered
    // card is two frames around one thing, and it read as a foreign control in
    // a card whose rows are washes rather than boxes. What says a box takes
    // words is its placeholder and the caret — the composer's own answer.
    const cases: readonly (readonly [string, string])[] = [
      ["the lone answer", drawn(ask([askPrompt({ options: [], custom: true })]))],
      ["the box beside the options", drawn(ask([askPrompt({ custom: true })]))],
      ["the verdict card's words", drawn(noteOpenPermission())],
    ];
    for (const [what, html] of cases) {
      const drawnBoxes = boxes(html);
      expect([what, drawnBoxes.length]).toEqual([what, 1]);
      expect([what, drawnBoxes[0]?.includes("border-0")]).toEqual([what, true]);
      expect([what, drawnBoxes[0]?.includes("shadow-raised")]).toEqual([what, false]);
    }
  });

  it("marks every verdict as one press, and an opaque answer as not", () => {
    // The arrow is the gesture telling the truth about itself: it stands on the
    // rows `optionSubmitsOnSelect` sends from, which is now every declared
    // verdict — a gate that cost one click for `once` and two for the option
    // beside it taught the fastest gesture in the app and then withheld it.
    const gate = renderToStaticMarkup(
      <InteractionCard interaction={permission()} onResolve={() => undefined} />,
    );
    for (const label of ["Allow once", "Allow always", "Reject"])
      expect(optionRow(gate, label)).toContain("bg-foreground");

    // A question's ids are the harness's own encoded values and state no
    // verdict, so a click there answers rather than decides — and the several
    // answers of a multiple prompt are never one press either.
    expect(optionRow(drawn(ask([askPrompt({ multiple: true })])), "main")).not.toContain(
      "bg-foreground",
    );
  });
});

/** The foot mount: a card with the real composer standing under it. */
function stacked(interaction: RendererSessionInteraction): string {
  return renderToStaticMarkup(
    <ComposerInteractionStack interaction={interaction} onResolve={() => undefined}>
      <textarea aria-label="Answer" placeholder="Your answer" />
    </ComposerInteractionStack>,
  );
}

describe("the question whose answer is typed in the composer", () => {
  it("draws no box of its own beside the composer that takes the words", () => {
    // One box, not two. `askFieldOpen` still says this question accepts free
    // text; what changed is where that text is typed — into the input the
    // reader's hands are already in, four pixels below.
    const html = stacked(ask([askPrompt({ custom: true })]));
    expect(html).toContain('role="radio"');
    expect(html.match(/<textarea/g)).toHaveLength(1);
    expect(html).toContain('placeholder="Your answer"');
  });

  it("stands its own commit control down where there is nothing else to commit", () => {
    // A question that listed nothing to choose between has its whole answer
    // downstairs, so a button here could only ever come back with "Write an
    // answer" at a box it does not have.
    const html = stacked(ask([askPrompt({ options: [], custom: true })]));
    expect(html).not.toContain('type="submit"');
    // The two exits it keeps: refusing the question, and withdrawing it stays
    // the caller's to offer.
    expect(html).toContain(">Reject</button>");
  });

  it("keeps the rows that answer it, and the control a multi-select needs", () => {
    const html = stacked(ask([askPrompt({ multiple: true, custom: true })]));
    expect(html).toContain('role="checkbox"');
    expect(html).toContain('type="submit"');
  });

  it("keeps its own box wherever the composer cannot answer for it", () => {
    // A permission: its words are a note beside a verdict, and a verdict is
    // pressed rather than typed.
    expect(
      renderToStaticMarkup(
        <ComposerInteractionStack interaction={permission()} onResolve={() => undefined}>
          <textarea aria-label="Message" />
        </ComposerInteractionStack>,
      ),
    ).toContain(">Note</button>");
    // And a request that asked more than one thing: the composer has no
    // position in that walk, so the card keeps the box the counter belongs to.
    const several = stacked(
      ask([askPrompt({ custom: true }), askPrompt({ id: "prompt:1", custom: true })]),
    );
    expect(several).toContain("Question 1 of 2");
    expect(several.match(/<textarea/g)).toHaveLength(2);
  });

  it("keeps its box on a card that has no composer under it", () => {
    // The row mount. The deferral is the foot's to decide, because the foot is
    // the only place a composer stands beside the card.
    expect(drawn(ask([askPrompt({ custom: true })]))).toContain("<textarea");
  });
});

describe("the receipt an answered question leaves", () => {
  it("reads the words back, and gives them the room to be read in", () => {
    const html = renderToStaticMarkup(
      <InteractionReceiptLine
        interaction={freeText()}
        resolution={{ optionIds: [], response: "cut a patch instead" }}
      />,
    );
    expect(html).toContain("You answered");
    expect(html).toContain("cut a patch instead");
    // The one trailer with unbounded length is the one that gives, and the
    // whole of it stays a hover away.
    expect(html).toContain('title="cut a patch instead"');
    expect(html).toContain("flex-1 truncate");
  });

  it("keeps a verdict's one-word trailer at its own size", () => {
    const html = renderToStaticMarkup(
      <InteractionReceiptLine
        interaction={permission()}
        resolution={{ optionIds: ["once"], response: null }}
      />,
    );
    expect(html).toContain("You allowed");
    expect(html).toContain(">once</span>");
    expect(html).not.toContain("flex-1 truncate");
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
