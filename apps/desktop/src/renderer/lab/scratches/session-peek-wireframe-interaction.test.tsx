// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import SessionPeekWireframeScratch from "./session-peek-wireframe";

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<SessionPeekWireframeScratch />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function row(id = "session-2"): HTMLButtonElement {
  const node = host.querySelector<HTMLButtonElement>(
    `[data-peek-surface="nav"][data-peek-row="${id}"] button`,
  );
  if (node === null) throw new Error(`Missing row ${id}`);
  return node;
}

function card(): HTMLElement | null {
  return host.querySelector<HTMLElement>("[data-peek-card]");
}

async function press(node: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function control(text: string): HTMLButtonElement {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === text,
  );
  if (button === undefined) throw new Error(`Missing control ${text}`);
  return button;
}

// These exercise DOM focus/timer wiring, not just the reducer's focus labels.
describe("wireframe focus and hover wiring", () => {
  it("peeks after keyboard focus without taking focus, including with pointer hover disabled", async () => {
    await act(async () => control("off (keyboard)").click());
    const trigger = row();
    await act(async () => trigger.focus());
    await advance(300);
    expect(card()?.getAttribute("role")).toBe("note");
    expect(document.activeElement).toBe(trigger);
  });

  it("moves actual focus through field → dialog → row on Escape", async () => {
    const trigger = row();
    await act(async () => trigger.focus());
    await press(trigger, "r");
    const field = card()?.querySelector("textarea");
    if (field === undefined || field === null) throw new Error("Missing answer field");
    await act(async () => field.focus());
    expect(document.activeElement).toBe(field);
    await press(field, "Escape");
    expect(document.activeElement).toBe(card());
    await press(card()!, "Escape");
    expect(document.activeElement).toBe(trigger);
    expect(card()?.getAttribute("role")).toBe("note");
    await press(trigger, "Escape");
    expect(card()).toBeNull();
  });

  it("returns focus to the source row after a pointer pin is unpinned", async () => {
    const trigger = row();
    await act(async () => trigger.focus());
    await press(trigger, " ");
    const pin = [...(card()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (button) => button.textContent?.trim() === "Answer",
    );
    if (pin === undefined) throw new Error("Missing pin button");
    await act(async () => {
      pin.focus();
      pin.click();
    });
    expect(document.activeElement).toBe(card());
    await press(card()!, "Escape");
    expect(document.activeElement).toBe(trigger);
  });

  it("waits until the pointer rests rather than opening during a sweep within a row", async () => {
    const move = async () => {
      await act(async () => row().dispatchEvent(new MouseEvent("pointermove", { bubbles: true })));
    };
    await move();
    await advance(300);
    await move();
    await advance(300);
    expect(card()).toBeNull();
    await advance(100);
    expect(card()?.getAttribute("role")).toBe("note");
  });

  it("lets focus leave a pinned field without pulling it back", async () => {
    await press(row(), "r");
    const field = card()?.querySelector("textarea");
    if (!field) throw new Error("Missing field");
    await act(async () => field.focus());
    const outside = control("fails");
    await act(async () => outside.focus());
    expect(document.activeElement).toBe(outside);
    expect(card()?.getAttribute("role")).toBe("dialog");
  });

  it("uses Answer only for a pending question and Send with an icon otherwise", async () => {
    for (const id of ["session-1", "session-2", "session-3", "session-4"]) {
      await press(row(id), " ");
      const actions = [...card()!.querySelectorAll("footer button")];
      expect(actions.at(-1)?.textContent).toBe(id === "session-2" ? "Answer" : "Send");
      expect(actions.at(-1)?.querySelector("svg")).not.toBeNull();
      expect(card()?.textContent).not.toContain("Pin");
    }
  });

  it("replaces an ungenerated summary with skeletons without hiding the question or actions", async () => {
    await act(async () => control("loading").click());
    await press(row(), " ");
    const loading = card()?.querySelector('[data-summary-state="loading"]');
    expect(loading?.getAttribute("aria-busy")).toBe("true");
    expect(loading?.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(5);
    expect(card()?.textContent).not.toContain("Compared Redis");
    expect(card()?.textContent).toContain("Which cache backend");
    await act(async () => control("ready").click());
    expect(card()?.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(card()?.textContent).toContain("Compared Redis");
    await act(async () => control("unavailable").click());
    expect(card()?.textContent).toContain("Summary unavailable");
    expect(control("View conversation")).toBeDefined();
  });

  it("retains full stress content in the DOM and a route to the conversation", async () => {
    await act(async () => {
      control("unbroken").click();
      control("280px").click();
    });
    await press(row(), " ");
    expect(card()?.querySelector("[data-peek-session-title]")?.textContent).toHaveLength(256);
    expect(card()?.querySelector("[data-peek-ticket-title]")?.textContent).toHaveLength(512);
    expect(card()?.querySelector("[data-peek-summary]")?.textContent).toHaveLength(2048);
    expect(card()?.querySelector("[data-peek-question]")?.textContent).toHaveLength(512);
    expect(card()?.style.width).toContain("280px");
    expect(control("View conversation")).toBeDefined();
  });

  it("opens source messages in an overlay and returns to the same unfinished reply", async () => {
    await press(row(), "r");
    await act(async () =>
      card()!.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!.click(),
    );
    await act(async () => control("View conversation").click());
    const overlay = document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
    expect(overlay?.textContent).toContain("Conversation");
    expect(overlay?.textContent).toContain("An indexed cache table would be slower");
    expect(overlay?.textContent).not.toContain("Compared Redis with the existing");
    expect(card()).toBeNull();
    expect(host.textContent).toContain("Nothing delivered yet.");
    await advance(600);
    await press(overlay!, "Escape");
    await advance(1);
    expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(card()?.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]?.checked).toBe(
      true,
    );
    expect(document.activeElement?.textContent).toBe("View conversation");
  });

  it("names the question group and freeform field, with option subtitles and no implicit send", async () => {
    await press(row(), "r");
    const group = card()!.querySelector("fieldset")!;
    expect(group.querySelector("legend")?.textContent).toBe(
      "Which cache backend should the indexer use?",
    );
    const firstChoice = group.querySelector('input[type="radio"]')!;
    expect(document.getElementById(firstChoice.getAttribute("aria-labelledby")!)?.textContent).toBe(
      "Redis",
    );
    expect(
      document.getElementById(firstChoice.getAttribute("aria-describedby")!)?.textContent,
    ).toBe("Fast, adds a dependency");
    expect(group.querySelector('input[type="radio"]')?.closest("label")?.textContent).toBe(
      "RedisFast, adds a dependency",
    );
    expect(group.querySelector("textarea")?.getAttribute("aria-labelledby")).toBe(
      group.querySelector("legend")?.id,
    );
    await act(async () => group.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
    expect(host.textContent).toContain("Nothing delivered yet.");
    await act(async () => control("fails").click());
    await act(async () => control("Send").click());
    await advance(500);
    expect(group.getAttribute("aria-describedby")).toContain("peek-send-error");
    expect(group.querySelector("textarea")?.getAttribute("aria-describedby")).toContain(
      "peek-send-error",
    );
  });

  it("uses declared choice-only and multiple capabilities, with checkbox toggles", async () => {
    await act(async () => control("choices only").click());
    await press(row(), "r");
    expect(card()?.querySelector('input[type="radio"]')).not.toBeNull();
    expect(card()?.querySelector("textarea")).toBeNull();
    expect(control("Send").disabled).toBe(true);
    await act(async () => control("multiple").click());
    const checks = card()!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(checks).toHaveLength(2);
    await act(async () => checks[0]!.click());
    await act(async () => checks[1]!.click());
    expect(checks[0]?.checked).toBe(true);
    expect(checks[1]?.checked).toBe(true);
    await act(async () => checks[0]!.click());
    expect(checks[0]?.checked).toBe(false);
    expect(host.textContent).toContain("Nothing delivered yet.");
  });

  it("names a freeform-only answer from its prompt without inventing options", async () => {
    await act(async () => control("freeform").click());
    await press(row(), "r");
    const fieldset = card()!.querySelector("fieldset")!;
    expect(fieldset.querySelectorAll("input")).toHaveLength(0);
    expect(fieldset.querySelector("legend")?.textContent).toBe("What approach should we take?");
    expect(fieldset.querySelector("textarea")?.getAttribute("aria-labelledby")).toBe(
      fieldset.querySelector("legend")?.id,
    );
    expect(control("Send").disabled).toBe(true);
  });

  it("walks two questions without advancing on choice and sends only after the final step", async () => {
    await act(async () => control("two steps").click());
    await press(row(), "r");
    expect(card()?.textContent).toContain("Question 1 of 2");
    await act(async () => card()!.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
    expect(card()?.textContent).toContain("Question 1 of 2");
    expect(control("Send").disabled).toBe(true);
    await act(async () => control("Next").click());
    expect(card()?.textContent).toContain("Question 2 of 2");
    expect(document.activeElement).toBe(card()?.querySelector("fieldset"));
    expect(control("Send").disabled).toBe(true);
    await act(async () =>
      card()!.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!.click(),
    );
    expect(control("Send").disabled).toBe(false);
    await act(async () => control("Back").click());
    expect(document.activeElement).toBe(card()?.querySelector("fieldset"));
    expect(card()?.querySelector<HTMLInputElement>('input[type="radio"]')?.checked).toBe(true);
    expect(control("Send").disabled).toBe(true);
    await act(async () => control("Next").click());
    expect(card()?.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]?.checked).toBe(
      true,
    );
    expect(host.textContent).toContain("Nothing delivered yet.");
    await act(async () => control("Send").click());
    await advance(500);
    expect(host.textContent).toContain("Choose a cache");
    expect(host.textContent).toContain("All at once");
  });

  it("keeps both question drafts across a failed final Send and retries explicitly", async () => {
    await act(async () => {
      control("two steps").click();
      control("fails").click();
    });
    await press(row(), "r");
    await act(async () => card()!.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
    await act(async () => control("Next").click());
    await act(async () =>
      card()!.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!.click(),
    );
    await act(async () => control("Send").click());
    await advance(500);
    expect(card()?.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t send");
    expect(host.textContent).toContain("Nothing delivered yet.");
    await act(async () => control("Back").click());
    expect(card()?.querySelector<HTMLInputElement>('input[type="radio"]')?.checked).toBe(true);
    await act(async () => control("Next").click());
    expect(card()?.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]?.checked).toBe(
      true,
    );
    await act(async () => control("succeeds").click());
    await act(async () => control("Try again").click());
    await advance(500);
    expect(host.textContent).toContain("How should we roll this out? — All at once");
  });

  it("keeps retryable errors outside the scroll area and preserves the selected answer", async () => {
    await act(async () => control("fails").click());
    await press(row(), "r");
    await act(async () => card()!.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
    await act(async () => control("Send").click());
    await advance(500);
    const alert = card()?.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn’t send");
    expect(alert?.parentElement).toBe(card());
    expect(card()?.querySelector<HTMLInputElement>('input[type="radio"]')?.checked).toBe(true);
    expect(row().querySelector('[role="img"]')?.getAttribute("aria-label")).toContain(
      "Waiting for you",
    );
    expect(host.textContent).toContain("Nothing delivered yet.");
    await act(async () => control("succeeds").click());
    await act(async () => control("Try again").click());
    await advance(500);
    expect(card()?.querySelector('[role="alert"]')).toBeNull();
    expect(row().querySelector('[role="img"]')?.getAttribute("aria-label")).toContain("Working");
    await advance(2100);
    expect(card()).toBeNull();
    expect(control("Undo")).toBeDefined();
    await act(async () => control("Undo").click());
    expect(row().querySelector('[role="img"]')?.getAttribute("aria-label")).toContain(
      "Waiting for you",
    );
    expect(host.textContent).toContain("Nothing delivered yet.");
  });

  it("gives compact titles more weight and space while preserving accessible state", async () => {
    await act(async () => control("compact").click());
    expect(row().textContent).toContain("VC-201");
    expect(
      row().querySelector("[data-session-row-title]")?.classList.contains("font-semibold"),
    ).toBe(true);
    expect(row().textContent).not.toContain("Waiting for you");
    expect(row().querySelector('[role="img"]')?.getAttribute("aria-label")).toContain(
      "Waiting for you",
    );
    await press(row(), " ");
    expect(card()?.querySelector("header")?.textContent).not.toContain("Waiting for you");
    expect(card()?.querySelector("[data-peek-summary]")?.classList.contains("line-clamp-5")).toBe(
      true,
    );
  });

  it("cancels a pending pointer dwell when hover is disabled", async () => {
    await act(async () => row().dispatchEvent(new MouseEvent("pointermove", { bubbles: true })));
    await advance(100);
    await act(async () => control("off (keyboard)").click());
    await advance(500);
    expect(card()).toBeNull();
  });
});
