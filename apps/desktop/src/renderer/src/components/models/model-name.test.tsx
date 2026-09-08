// @vitest-environment jsdom
/**
 * What a shared model name does with a name it cannot draw whole (VC-288).
 *
 * The pure half of this file's module is pinned in `model-identity.test.ts`;
 * this is the drawing, and it exists because the first answer here was a
 * `title` — the pointer's alone, on rows a keyboard walks. Every surface that
 * draws `ModelName` is a list row inside a Select or a cmdk list, where a
 * focus stop of its own would be a nested interactive control the composite
 * widget cannot survive, so a row's answer is simply not truncating.
 *
 * The row was only half the surface. Radix copies the selected item's own
 * children into the CLOSED SELECT TRIGGER, a fixed-height control that must
 * keep the name to one line — and there the second answer, "press it open",
 * is not a reveal a person can ask for while looking at the control, and is
 * not available at all while the Select is disabled. So the trigger's copy
 * carries the reveal (VC-288 re-review): a bubble with the whole identity, on
 * hover and on the keyboard's own focus, opened only when the run is
 * measurably clipped.
 *
 * A real jsdom environment: this is about focus, an ancestor's disabled state
 * and a portalled bubble, none of which exist in a string of HTML. jsdom lays
 * nothing out, so the clipping — the one thing that decides whether the reveal
 * may open at all — is stubbed onto the run the way `tab-strip.test.tsx` stubs
 * it, and every assertion below is about what the DOM then does.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { ModelName } from "./model-identity";

const MODEL = {
  providerId: "anthropic",
  modelId: "claude-opus-4-5-with-a-very-long-name",
  label: "Claude Opus 4.5 (very long name, as they get)",
};

/** What the trigger's copy has to say when it is asked. */
const IDENTITY = `${MODEL.label} · Anthropic`;

function run(markup: string): string {
  // The name's own run is the second span: the first is the flex wrapper the
  // mark rides in.
  const spans = markup.split("<span").slice(1);
  return spans[1] ?? "";
}

/** The run's classes, as tokens — so a variant is not mistaken for the rule. */
function runClasses(markup: string): readonly string[] {
  return (/class="([^"]*)"/.exec(run(markup))?.[1] ?? "").split(" ");
}

describe("ModelName in a list row", () => {
  it("wraps the name rather than clipping it out of a keyboard's reach", () => {
    const markup = renderToStaticMarkup(<ModelName model={MODEL} models={[MODEL]} />);
    expect(runClasses(markup)).toContain("break-words");
    // Not `truncate`: an ellipsis in a row a keyboard can highlight but not
    // focus is a value with no way out of it at all. Unconditionally, that is
    // — the trigger-only variant below is a different rule.
    expect(runClasses(markup)).not.toContain("truncate");
  });

  it("keeps the whole run as the pointer's `title` as well", () => {
    const markup = renderToStaticMarkup(
      <ModelName model={MODEL} models={[MODEL]} providerLabel="Anthropic" alwaysProvider />,
    );
    expect(markup).toContain('title="Claude Opus 4.5 (very long name, as they get) · Anthropic"');
  });

  it("still clips to one line where Radix copies it into a closed trigger", () => {
    // A Select trigger is a fixed-height control drawing the selected ITEM's
    // own children, so this is the one place the run must not wrap — and the
    // one place it therefore has to be able to reveal itself instead.
    const markup = renderToStaticMarkup(<ModelName model={MODEL} models={[MODEL]} />);
    expect(runClasses(markup)).toContain("in-data-[slot=select-trigger]:truncate");
  });
});

let container: HTMLElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.unstubAllGlobals();
});

/** One model in one Select, closed, with that model already selected. */
function mountSelect(options: { disabled?: boolean } = {}): void {
  act(() => {
    root?.render(
      <Select value="model" disabled={options.disabled ?? false}>
        <SelectTrigger aria-label="Runtime model">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="model">
            <ModelName model={MODEL} models={[MODEL]} providerLabel="Anthropic" alwaysProvider />
          </SelectItem>
        </SelectContent>
      </Select>,
    );
  });
}

function trigger(): HTMLButtonElement {
  const found = container?.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]');
  if (found === null || found === undefined) throw new Error("no select trigger");
  return found;
}

/** The name run Radix copied into the closed trigger. */
function triggerName(): HTMLElement {
  const found = trigger().querySelector<HTMLElement>('[data-slot="model-name"]');
  if (found === null) throw new Error("the trigger is drawing no model name");
  return found;
}

/** jsdom measures nothing; this is a run too long for the box it is drawn in. */
function clip(element: HTMLElement): void {
  Object.defineProperty(element, "clientWidth", { configurable: true, get: () => 120 });
  Object.defineProperty(element, "scrollWidth", { configurable: true, get: () => 480 });
}

/** What the reveal is currently saying, if it is open at all. It portals. */
function revealText(): string | null {
  return document.body.querySelector('[data-slot="tooltip-content"]')?.textContent ?? null;
}

function press(target: Element, key: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

/**
 * Let the frozen state settle. Whether the host can take focus is a fact about
 * an attribute, not about a prop this component is given, so it is read with a
 * `MutationObserver` — and those deliver on the microtask queue.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("ModelName in a closed Select trigger", () => {
  it("reveals the whole identity when the keyboard reaches the trigger", () => {
    // The gap the re-review kept open: the trigger truncates, and the only way
    // to the rest of the name was to OPEN the list — a press that changes what
    // the screen is showing, to read a value that was already on it.
    mountSelect();
    clip(triggerName());

    act(() => trigger().focus());

    expect(revealText()).toBe(IDENTITY);
  });

  it("closes on Escape without taking the focus with it", () => {
    mountSelect();
    clip(triggerName());
    act(() => trigger().focus());

    press(trigger(), "Escape");

    expect(revealText()).toBeNull();
    // Escape dismissed a label, not the control: a keyboard is still where it
    // was, and the Select never opened.
    expect(document.activeElement).toBe(trigger());
    expect(trigger().getAttribute("data-state")).toBe("closed");
  });

  it("closes again when focus leaves the trigger", () => {
    mountSelect();
    clip(triggerName());
    act(() => trigger().focus());
    expect(revealText()).toBe(IDENTITY);

    act(() => trigger().blur());

    expect(revealText()).toBeNull();
  });

  it("stays quiet for a name the trigger draws whole", () => {
    // A bubble over a control that is hiding nothing is noise, and noise is
    // how the reveal that matters gets missed.
    mountSelect();

    act(() => trigger().focus());

    expect(revealText()).toBeNull();
  });

  it("reveals the identity on hover as well", async () => {
    mountSelect();
    const name = triggerName();
    clip(name);

    await act(async () => {
      name.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
      // The name's own provider uses the product's 500ms hover delay.
      await new Promise((resolve) => setTimeout(resolve, 550));
    });

    expect(revealText()).toBe(IDENTITY);
  });
});

describe("ModelName in a disabled Select trigger", () => {
  it("is still readable from the keyboard while the selection is frozen", () => {
    // READING IS NOT CHOOSING. A disabled Radix trigger is a `<button disabled>`
    // — out of the tab order, and its subtree gets no pointer events either —
    // so "press it open" and "hover it" are both gone at once, in the state
    // (saving, loading) where a person is most likely to be checking what the
    // row says. The value brings its own stop for exactly as long as the
    // control cannot carry one.
    mountSelect({ disabled: true });
    const name = triggerName();
    clip(name);
    expect(trigger().disabled).toBe(true);

    expect(name.tabIndex).toBe(0);
    act(() => name.focus());

    expect(revealText()).toBe(IDENTITY);
    expect(document.activeElement).toBe(name);
    // And the stop needs no `aria-label` to be worth landing on: the clipping
    // is CSS, so the run already HOLDS the whole value for anything reading
    // the page rather than looking at it.
    expect(name.textContent).toBe(IDENTITY);
  });

  it("hands the stop back to the trigger when the selection thaws", async () => {
    // Two stops on one control is the bug the tab strip refused to write. The
    // name's own is borrowed for the frozen state and given back the moment
    // the trigger can take focus itself — carrying the focus with it, rather
    // than dropping a keyboard onto the body mid-save.
    mountSelect({ disabled: true });
    const name = triggerName();
    act(() => name.focus());

    mountSelect({ disabled: false });
    await settle();

    expect(triggerName().tabIndex).toBe(-1);
    expect(document.activeElement).toBe(trigger());
  });

  it("leaves focus alone when the selection thaws elsewhere on the page", async () => {
    mountSelect({ disabled: true });

    mountSelect({ disabled: false });
    await settle();

    // Nobody was standing on the borrowed stop, so nothing is moved: a save
    // finishing must not steal a keyboard from wherever it went meanwhile.
    expect(document.activeElement).toBe(document.body);
    expect(triggerName().tabIndex).toBe(-1);
  });
});
