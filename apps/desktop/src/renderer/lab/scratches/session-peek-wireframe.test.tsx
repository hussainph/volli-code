// @vitest-environment jsdom
/**
 * The two things the model tests cannot say: that this scratch still RENDERS,
 * and that the rules are actually wired to the surface.
 *
 * A scratch is dev-server-only and never built, so nothing in CI would notice it
 * breaking — you find out the day you open the lab to judge a change, which is
 * the worst possible moment. The interaction pass here is deliberately narrow:
 * the keyboard path, because it is the one that can be driven without a pointer,
 * and the three claims that would make the design a different design if they
 * stopped holding — a peek that takes focus, an answer that leaves before Send,
 * and a pin that moves when another row is touched.
 *
 * `session-peek-wireframe-model.test.ts` owns the rules themselves. This owns
 * the wiring.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { isScratchModule } from "../scratch";
import * as scratch from "./session-peek-wireframe";

const html = renderToStaticMarkup(<scratch.default />);

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

async function mount(): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<scratch.default />));
  return container;
}

/** The nav band's rows, in the order the sidebar draws them. */
function navRows(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[data-peek-surface="nav"]')];
}

function rowButton(row: HTMLElement): HTMLButtonElement {
  const button = row.querySelector("button");
  if (button === null) throw new Error("row has no activation target");
  return button;
}

async function press(node: HTMLElement, key: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });
}

describe("the wireframe scratch's contract and content", () => {
  it("satisfies the contract the lab shell discovers it by, at window viewport", () => {
    expect(isScratchModule(scratch)).toBe(true);
    expect(scratch.title).toBe("Session peek · Excalidraw v2");
    expect(scratch.viewport).toBe("window");
  });

  it("draws the sketch's four sessions in both sidebars, with provider glyphs and accessible state", () => {
    for (const session of ["Session 1", "Session 2", "Session 3", "Session 4"]) {
      // Once per sidebar.
      expect(html.match(new RegExp(session, "g"))?.length).toBeGreaterThanOrEqual(2);
    }
    expect(html).toContain("Waiting for you");
    expect(html).toContain("Interrupted");
    expect(html).toContain('data-session-glyph="waiting"');
  });

  it("links the v1 scratch rather than replacing it", () => {
    expect(html).toContain('href="#session-peek"');
  });

  it("says which parts are simulated", () => {
    expect(html).toContain("no backend");
    expect(html).toContain("Session transcript (lab mock)");
    expect(html).toContain("Nothing delivered yet.");
  });

  it("opens no peek before anything is hovered or stepped to", () => {
    expect(html).not.toContain('role="note"');
    expect(html).not.toContain('role="dialog"');
  });
});

describe("the keyboard path", () => {
  it("opens a read-only peek with Space and leaves focus on the row", async () => {
    const host = await mount();
    const row = navRows(host)[1];
    if (row === undefined) throw new Error("missing Session 2 row");
    const button = rowButton(row);
    await act(async () => button.focus());

    await press(button, " ");

    const card = document.querySelector("[data-peek-card]");
    expect(card?.getAttribute("role")).toBe("note");
    // The whole argument of the surface: hovering — and stepping — reads.
    expect(document.activeElement).toBe(button);
    expect(card?.textContent).toContain("Which cache backend should the indexer use");
    // No field, and nothing in it that could take a keystroke.
    expect(card?.querySelector("textarea")).toBeNull();
    for (const removed of [
      "Hover is read-only",
      "Last activity",
      "Question waiting",
      "ses-2c4d08",
    ]) {
      expect(card?.textContent).not.toContain(removed);
    }
  });

  it("pins with R, becomes a non-modal dialog, and moves focus into it", async () => {
    const host = await mount();
    const row = navRows(host)[1];
    if (row === undefined) throw new Error("missing Session 2 row");
    const button = rowButton(row);
    await act(async () => button.focus());

    await press(button, " ");
    await press(button, "r");

    const card = document.querySelector<HTMLElement>("[data-peek-card]");
    expect(card?.getAttribute("role")).toBe("dialog");
    expect(card?.getAttribute("aria-modal")).toBe("false");
    expect(card?.textContent).toContain("Session 2");
    expect(card?.textContent).toContain("VC-201");
    expect(card?.querySelector("form")?.getAttribute("aria-label")).toBe(
      "Reply to Session 2 (VC-201)",
    );
    expect(card?.textContent).not.toContain("Answer goes to");
    expect(card?.querySelector("textarea")).not.toBeNull();
    expect(document.activeElement).toBe(card);
  });

  it("keeps the pinned recipient when another row is stepped to", async () => {
    const host = await mount();
    const rows = navRows(host);
    const second = rows[1];
    const fourth = rows[3];
    if (second === undefined || fourth === undefined) throw new Error("missing rows");
    const button = rowButton(second);
    await act(async () => button.focus());

    await press(button, " ");
    await press(button, "r");
    // The pointer's equivalent of this is walking across the band.
    await press(rowButton(fourth), "ArrowDown");

    const card = document.querySelector<HTMLElement>("[data-peek-card]");
    expect(card?.querySelector("form")?.getAttribute("aria-label")).toBe(
      "Reply to Session 2 (VC-201)",
    );
    expect(card?.textContent).not.toContain("Session 4");
  });

  it("selects an option without delivering anything, and delivers only on Send", async () => {
    vi.useFakeTimers();
    try {
      const host = await mount();
      const row = navRows(host)[1];
      if (row === undefined) throw new Error("missing Session 2 row");
      const button = rowButton(row);
      await act(async () => button.focus());

      await press(button, " ");
      await press(button, "r");

      const card = document.querySelector<HTMLElement>("[data-peek-card]");
      const radios = [...(card?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? [])];
      const postgres = radios[1];
      if (postgres === undefined) throw new Error("missing option");

      await act(async () => postgres.click());
      expect(postgres.checked).toBe(true);
      // Selecting is not answering.
      expect(host.textContent).toContain("Nothing delivered yet.");

      const send = [...(card?.querySelectorAll("button") ?? [])].find((node) =>
        node.textContent?.startsWith("Send"),
      );
      if (send === undefined) throw new Error("missing Send");
      await act(async () => send.click());
      // The simulated round trip.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      // The transcript line — its own arrow form, so this cannot be satisfied
      // by the option label still sitting in the open card.
      expect(host.textContent).toContain("→ “Postgres”");
      expect(host.textContent).not.toContain("→ “Postgres — slower, no new infra”");
      expect(host.textContent).not.toContain("Nothing delivered yet.");
      // The badge flips only now, and the assertion is scoped to the row so the
      // sketch's own "waiting on you → working" note cannot satisfy it.
      expect(row.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain("Working");
      expect(row.querySelector('[role="img"]')?.getAttribute("aria-label")).not.toContain(
        "Waiting for you",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("steps down the band with J and follows focus", async () => {
    const host = await mount();
    const rows = navRows(host);
    const first = rows[0];
    if (first === undefined) throw new Error("missing first row");
    const button = rowButton(first);
    await act(async () => button.focus());

    await press(button, "j");

    const second = rows[1];
    if (second === undefined) throw new Error("missing second row");
    expect(document.activeElement).toBe(rowButton(second));
  });
});
