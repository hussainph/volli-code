/**
 * What the card *says*, as opposed to what it decides.
 *
 * The decisions are `interaction.ts`'s and are tested there against the draft
 * alone. What is left is the part only a rendered card can get wrong: two acts
 * drawn at one weight, and a control wearing a sentence written for a
 * placeholder. Static markup is enough for both — neither is a behaviour.
 */
import type { SessionInteraction } from "@volli/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { InteractionCard, PendingInteractionAnnouncement } from "./interaction-ui";

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

  it("autofocuses only a true free-text-only prompt at the composer mount", () => {
    const freeForm = renderToStaticMarkup(
      <InteractionCard interaction={freeText()} focusFreeTextOnMount onResolve={() => undefined} />,
    );
    const mixed = renderToStaticMarkup(
      <InteractionCard
        interaction={freeText([{ id: "main", label: "main", description: null }])}
        focusFreeTextOnMount
        onResolve={() => undefined}
      />,
    );

    expect(freeForm).toMatch(/<textarea[^>]*autofocus=""/);
    expect(mixed).not.toContain('autofocus=""');
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
