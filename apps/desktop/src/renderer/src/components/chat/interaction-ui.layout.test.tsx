// @vitest-environment jsdom
/**
 * The footer in the two states a static render cannot reach (VC-288).
 *
 * `interaction-ui.test.tsx` reads the markup, which is enough for the layout
 * rule itself — a row that may take a second line, and a cluster that may be
 * squeezed. What it cannot reach is the RECOVERY footer: the notice slot only
 * exists once a press has been refused, either by the harness (`Not delivered`)
 * or by the card's own requirement, and both are state written by an event.
 *
 * That state is exactly where the clipping was worst, because the notice is a
 * fourth thing on a row that already held three: at a 320px pane the footer had
 * to draw a warning, a withdrawal, a refusal and the control that retries, and
 * the retry is the one a `nowrap` row put past the edge. So what is asserted
 * here is reachability rather than pixels — jsdom lays nothing out, but it does
 * know whether a control is in the document, inside the footer, and able to
 * take focus, and a control that is none of those cannot be pressed at any
 * width.
 */
import type { RendererSessionInteraction, SessionInteractionPrompt } from "@volli/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { InteractionCard } from "./interaction-ui";

let container: HTMLElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom implements no media queries, and the card asks about reduced motion
  // for its step transition. "Not reduced" is the case that animates, so it is
  // the one worth rendering under.
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

function prompt(overrides: Partial<SessionInteractionPrompt> = {}): SessionInteractionPrompt {
  return {
    id: "prompt:0",
    label: "Which branch should this land on?",
    detail: null,
    options: [
      { id: "question:0:bWFpbg", label: "main", description: null },
      { id: "question:0:cmVsZWFzZQ", label: "release", description: null },
    ],
    // Several answers, so the step draws a control of its own to move on with:
    // a single choice is answered by the click that chooses it and needs none
    // (`interactionStep`'s `advanceLabel`), and this file is about the footer.
    multiple: true,
    custom: false,
    ...overrides,
  };
}

/** A harness question: encoded ids, so the card owns the refusal itself. */
function ask(prompts: readonly SessionInteractionPrompt[]): RendererSessionInteraction {
  return {
    id: "question:ask",
    attachmentId: "attach-1",
    kind: "question",
    title: "Before I start the migration",
    detail: null,
    options: prompts.flatMap((entry) => entry.options),
    multiple: false,
    prompts,
    native: { id: null, detail: null },
  };
}

const WALK = [prompt(), prompt({ id: "prompt:1", label: "And the tag?" })] as const;

function mount(node: React.ReactElement): void {
  act(() => root?.render(node));
}

function footer(): HTMLElement {
  const found = container?.querySelector<HTMLElement>('[data-slot="interaction-footer"]');
  if (found === null || found === undefined) throw new Error("no footer");
  return found;
}

/** Every control the footer draws, in the order the keyboard walks them. */
function footerButtons(): readonly HTMLButtonElement[] {
  return [...footer().querySelectorAll<HTMLButtonElement>("button")];
}

/** Press the control that answers, whatever this build calls it. */
function pressAdvance(): void {
  const submit = footerButtons().find((button) => button.type === "submit");
  if (submit === undefined) throw new Error("no advance control");
  act(() => {
    submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/**
 * That a control can be pressed by a keyboard: it is in the document, it is not
 * disabled, and focus lands on it. `disabled` also carries
 * `pointer-events-none` from `ui/button.tsx`, so this is the mouse's answer
 * too — and a clipped control still focuses, which is why the layout half of
 * this claim is asserted on the markup next door rather than here.
 */
function reachable(button: HTMLButtonElement): boolean {
  button.focus();
  return !button.disabled && document.activeElement === button;
}

/** That focus would be VISIBLE on it — `ui/button.tsx`'s ring, in its classes. */
function ringed(button: HTMLButtonElement): boolean {
  return button.className.includes("focus-visible:ring-2");
}

describe("the footer once a press has been refused", () => {
  it("keeps every action reachable beside the notice the refusal added", () => {
    mount(
      <InteractionCard
        interaction={ask(WALK)}
        onResolve={() => Promise.resolve(false)}
        onWithdraw={() => undefined}
      />,
    );

    const before = footerButtons();
    expect(before.length).toBeGreaterThanOrEqual(4);
    expect(before.every(reachable)).toBe(true);

    // Nothing chosen, so the press is refused by the card's own requirement:
    // the notice appears, and it appears IN the footer, competing for the same
    // row as the controls it is explaining.
    pressAdvance();
    const notice = footer().querySelector('[role="alert"]');
    expect(notice).not.toBeNull();

    // The retry is the whole point of the state. Every control that was live
    // before the refusal is still live and still inside the footer after it.
    const after = footerButtons();
    expect(after.map((button) => button.textContent)).toEqual(
      before.map((button) => button.textContent),
    );
    expect(after.every(reachable)).toBe(true);
  });

  it("keeps every action reachable after a valid delivery fails", async () => {
    const resolve = vi.fn(() => Promise.resolve(false));
    mount(
      <InteractionCard interaction={ask(WALK)} onResolve={resolve} onWithdraw={() => undefined} />,
    );

    const before = footerButtons().map((button) => button.textContent);
    const refusal = footer().querySelector<HTMLButtonElement>('button[data-variant="outline"]');
    expect(refusal).not.toBeNull();
    await act(async () => {
      refusal?.click();
      await Promise.resolve();
    });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(footer().querySelector('[role="alert"]')?.textContent).toBe("Not delivered");
    const after = footerButtons();
    expect(after.map((button) => button.textContent)).toEqual(before);
    expect(after.every(reachable)).toBe(true);
  });

  it("wraps that row rather than pushing the retry past the card's edge", () => {
    mount(<InteractionCard interaction={ask(WALK)} onResolve={() => Promise.resolve(false)} />);
    pressAdvance();

    // The shell clips (`overflow-hidden`), so the footer wrapping is the only
    // thing standing between a four-item row and an action nobody can press.
    expect(footer().className).toContain("flex-wrap");
    const actions = footer().querySelector<HTMLElement>('[data-slot="interaction-actions"]');
    expect(actions?.className).toContain("flex-wrap");
    expect(actions?.className).not.toContain("shrink-0");
  });
});

/**
 * THE ACCEPTANCE WIDTHS, AND WHAT THIS ENVIRONMENT CAN HONESTLY SAY ABOUT THEM
 * (VC-288 review).
 *
 * The acceptance names three pane widths and four zoom levels, and the second
 * list collapses into the first: browser zoom scales the CSS pixel, so a 480px
 * pane at 150% zoom IS a 320 CSS-px pane, which is why the requirement is
 * written in CSS px at all. These three widths are that matrix.
 *
 * WHAT IS ASSERTED HERE: at each width, every action the card offers is in the
 * document, inside the footer, able to take focus, able to SHOW that focus, and
 * standing in a row whose classes permit the break that keeps it inside the
 * card. Also that the break is between controls and never inside one.
 *
 * WHAT IS NOT, and cannot be: jsdom performs no layout and applies no
 * stylesheet. Every box here is 0×0, `getComputedStyle` knows nothing of a
 * Tailwind class, and so "does this overflow at 320px" is not a question this
 * environment can be asked — an assertion on `scrollWidth` would be an
 * assertion about numbers the test itself invented. The layout contract is
 * therefore asserted as the classes that decide it, and the pixels belong to a
 * real engine: `apps/desktop/e2e` drives the app.
 */
describe("the footer at the acceptance widths", () => {
  for (const width of [320, 480, 720]) {
    it(`keeps every action reachable and focus-visible at ${width}px`, () => {
      if (container !== null) container.style.width = `${width}px`;
      mount(
        <InteractionCard
          interaction={ask(WALK)}
          onResolve={() => Promise.resolve(true)}
          onWithdraw={() => undefined}
        />,
      );

      const buttons = footerButtons();
      // Withdraw, minimise, Skip and the control that advances: the row that
      // could not be drawn on one line at any of these widths.
      expect(buttons.length).toBeGreaterThanOrEqual(4);
      for (const button of buttons) {
        expect(reachable(button)).toBe(true);
        expect(ringed(button)).toBe(true);
      }

      // The row may become two rows, and the cluster inside it may become two
      // — the two classes that stand between this footer and the card's own
      // `overflow-hidden`.
      const actions = footer().querySelector<HTMLElement>('[data-slot="interaction-actions"]');
      expect(footer().className).toContain("flex-wrap");
      expect(actions?.className).toContain("flex-wrap");
      expect(actions?.className).not.toContain("shrink-0");

      // And the break stays BETWEEN controls: `ui/button.tsx`'s global
      // `whitespace-nowrap` is what keeps `Send answer` from hyphenating, and
      // this footer's fix was deliberately local so that rule could stand.
      for (const button of buttons) {
        expect(button.className).toContain("whitespace-nowrap");
      }
    });
  }
});
