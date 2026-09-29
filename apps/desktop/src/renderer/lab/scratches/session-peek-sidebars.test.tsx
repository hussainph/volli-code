// @vitest-environment jsdom
/**
 * The wiring of the sidebar-integration scratch — the claims its notes make,
 * driven through the DOM with fake timers.
 *
 * `session-peek/sidebar-model.test.ts` and `sidebar-live.test.ts` own the
 * rules (who peeks, what a folder shows, who may be answered; what unread is
 * and when a held row may move). This owns that the surface actually obeys
 * them: a folder's card opens, drills and steps back; the keys a tree needs
 * work; a peek held for a second reads its Session; a played afternoon moves
 * the held band once and the live one constantly; nothing moves while the
 * pointer is in a sidebar; the brief's scenario — answering from the rail —
 * leaves the work in front where it was.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { isScratchModule } from "../scratch";
import * as scratch from "./session-peek-sidebars";

/** Everything in the corpus is at rest for longer than the one-second dismissal guard. */
const DWELL = 400;
const WARM = 150;
const SUPPRESSION = 1000;

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // The conversation overlay pins its transcript to the bottom with one.
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
  scratch.seed();
  await act(async () => root.render(<scratch.default />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function row(rowId: string, surface: "nav" | "rail" = "nav"): HTMLElement {
  const node = host.querySelector<HTMLElement>(
    `[data-peek-surface="${surface}"][data-peek-row="${rowId}"]`,
  );
  if (node === null) throw new Error(`Missing ${surface} row ${rowId}`);
  return node;
}

function button(node: HTMLElement): HTMLButtonElement {
  const target = node instanceof HTMLButtonElement ? node : node.querySelector("button");
  if (target === null) throw new Error("Row has no button");
  return target;
}

function card(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-peek-card]");
}

function control(text: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === text || node.getAttribute("aria-label") === text,
  );
  if (found === undefined) throw new Error(`Missing control ${text}`);
  return found;
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function hover(node: HTMLElement, ms = DWELL): Promise<void> {
  await act(async () => {
    button(node).dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
  });
  await advance(ms);
}

async function click(node: HTMLElement): Promise<void> {
  await act(async () => node.click());
}

async function press(node: Element, key: string): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

/** Enter or leave a sidebar the way React hears it: an over/out pair across its edge. */
async function pointInto(node: Element): Promise<void> {
  await act(async () => {
    node.dispatchEvent(
      new MouseEvent("pointerover", { bubbles: true, relatedTarget: document.body }),
    );
  });
}

async function pointOutOf(node: Element): Promise<void> {
  await act(async () => {
    node.dispatchEvent(
      new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
    );
  });
}

function activeOrder(): string[] {
  return [
    ...host.querySelectorAll<HTMLElement>('[data-session-band="active"] [data-peek-surface="nav"]'),
  ].map((node) => node.dataset.peekRow ?? "");
}

function unreadDot(rowId: string, surface: "nav" | "rail" = "nav"): Element | null {
  return row(rowId, surface).querySelector("[data-unread-dot]");
}

async function playSteps(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await click(control("Step"));
}

async function setControl(text: string): Promise<void> {
  await click(control(text, host.querySelector("[data-lab-controls]")!));
  // A mode change closes whatever card was up; let its dismissal guard lapse.
  await advance(SUPPRESSION + 50);
}

const FOLDER_11 = "folder:tkt-11";

describe("the scratch's contract", () => {
  it("is discovered by the lab shell at window size, with the app's seed and bridge", () => {
    expect(isScratchModule(scratch)).toBe(true);
    expect(scratch.viewport).toBe("window");
    expect(typeof scratch.seed).toBe("function");
    expect(scratch.api).toBeDefined();
  });

  it("draws the shipped bands, keeping the unread six-hour-old Session in Active", () => {
    const nav = [...host.querySelectorAll<HTMLElement>('[data-peek-surface="nav"]')];
    expect(nav.map((node) => node.dataset.peekRow)).toEqual([
      "chat:chat-a1",
      "chat:chat-a2",
      "chat:chat-a3",
      "chat:chat-a4",
      "chat:chat-a5",
      "chat:chat-p8",
      "folder:tkt-11",
      "folder:tkt-14",
      "folder:tkt-10",
      "folder:tkt-12",
      "folder:tkt-9",
      "folder:tkt-7",
    ]);
    // Collapsed by default, as shipped: no folder has drawn its Sessions.
    expect(host.querySelector('[data-peek-row="chat:chat-p3"]')).toBeNull();
  });

  it("says where and when under an Active title, and never the state the mark carries", () => {
    const subtitle = (rowId: string, surface: "nav" | "rail" = "nav") =>
      row(rowId, surface).querySelector('button > span:not([role="img"]) > span:last-child')
        ?.textContent;
    expect(subtitle("chat:chat-a1")).toBe("VLT-14 · 2m ago");
    expect(subtitle("chat:chat-a2")).toBe("VLT-14 · just now");
    expect(subtitle("chat:chat-a5")).toBe("No ticket · 22m ago");
    // The rail sits inside the ticket, so only the when is left.
    expect(subtitle("chat:chat-a1", "rail")).toBe("2m ago");
    for (const rowId of ["chat:chat-a1", "chat:chat-a2", "chat:chat-a4", "chat:chat-a5"]) {
      expect(row(rowId).textContent).not.toMatch(
        /Doing|Working|Idle|Interrupted|Answer a question/,
      );
    }
  });

  it("draws Active and the rail with one two-line row, so the two sidebars cannot drift", () => {
    expect(button(row("chat:chat-a1")).className).toBe(
      button(row("chat:chat-a1", "rail")).className,
    );
    expect(button(row("chat:chat-a1")).parentElement?.className).toContain("min-h-13");
  });

  it("says each row's vendor and state on its mark", () => {
    expect(row("chat:chat-a1").querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "Anthropic · Waiting for you",
    );
    expect(row("chat:chat-a4").querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "Z.ai · Interrupted",
    );
  });
});

describe("unread (VC-108)", () => {
  it("draws unread as a blue dot and a heavier title, in both sidebars", () => {
    expect(unreadDot("chat:chat-a4")?.textContent).toBe("Unread");
    expect(unreadDot("chat:chat-p8")).not.toBeNull();
    expect(unreadDot("chat:chat-a1")).toBeNull();
    expect(row("chat:chat-a4").querySelector(".font-semibold")?.textContent).toBe("Chat");
    // The corpus's rail ticket has nothing unread; mark one to see it there too.
    expect(row("chat:chat-a1", "rail").hasAttribute("data-unread")).toBe(false);
  });

  it("never reads a Session by peeking it: the card says so, and opening it reads it", async () => {
    await hover(row("chat:chat-a4"));
    expect(card()?.querySelector("[data-peek-unread]")?.textContent).toBe("Unread");
    await advance(3000);
    expect(unreadDot("chat:chat-a4")).not.toBeNull();
    expect(card()?.querySelector("[data-peek-unread]")).not.toBeNull();
    await click(button(row("chat:chat-a4")));
    expect(unreadDot("chat:chat-a4")).toBeNull();
  });

  it("reads a Session by viewing its conversation from the peek", async () => {
    await hover(row("chat:chat-a4"));
    await click(control("View conversation", card()!));
    expect(unreadDot("chat:chat-a4")).toBeNull();
  });

  it("can still read on a 1s look, for comparison — not on the way past", async () => {
    await setControl("After a 1s look");
    await hover(row("chat:chat-a4"));
    await advance(500);
    expect(unreadDot("chat:chat-a4")).not.toBeNull();
    await advance(600);
    expect(unreadDot("chat:chat-a4")).toBeNull();
    expect(card()?.querySelector("[data-peek-unread]")).toBeNull();
  });

  it("toggles read and unread with U, in either sidebar", async () => {
    const a1 = button(row("chat:chat-a1", "rail"));
    await act(async () => a1.focus());
    await press(a1, "u");
    expect(unreadDot("chat:chat-a1", "rail")).not.toBeNull();
    expect(unreadDot("chat:chat-a1")).not.toBeNull();
    await press(a1, "u");
    expect(unreadDot("chat:chat-a1")).toBeNull();
  });

  it("brings a Previous Session marked unread back to Active", async () => {
    await click(row("folder:tkt-14"));
    const p1 = button(row("chat:chat-p1"));
    await act(async () => p1.focus());
    await press(p1, "u");
    // New to the band, so it goes to the top — under the question already asked.
    expect(activeOrder().slice(0, 2)).toEqual(["chat:chat-a1", "chat:chat-p1"]);
    expect(unreadDot("chat:chat-p1")).not.toBeNull();
  });

  it("marks what a turn leaves behind out of sight as unread, and reads what you answer", async () => {
    await playSteps(3);
    expect(unreadDot("chat:chat-a3")).not.toBeNull();
    await hover(row("chat:chat-a1", "rail"));
    await click(control("Answer", card()!));
    await act(async () => card()!.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
    await click(control("Send", card()!));
    await advance(500);
    expect(unreadDot("chat:chat-a1")).toBeNull();
  });
});

describe("the held order", () => {
  const START = [
    "chat:chat-a1",
    "chat:chat-a2",
    "chat:chat-a3",
    "chat:chat-a4",
    "chat:chat-a5",
    "chat:chat-p8",
  ];

  it("holds every row through tool calls and a finished turn, and lifts a new turn under the question", async () => {
    await playSteps(4);
    expect(activeOrder()).toEqual(START);
    await playSteps(1);
    expect(activeOrder()).toEqual([
      "chat:chat-a1",
      "chat:chat-a5",
      "chat:chat-a2",
      "chat:chat-a3",
      "chat:chat-a4",
      "chat:chat-p8",
    ]);
  });

  it("lets the shipped order re-sort on a tool call, for comparison", async () => {
    await setControl("Live recency (shipped)");
    await playSteps(1);
    expect(activeOrder().slice(0, 3)).toEqual(["chat:chat-a1", "chat:chat-a3", "chat:chat-a2"]);
  });

  it("floats a new question to the top, or holds it in place for comparison", async () => {
    await playSteps(7);
    expect(activeOrder().indexOf("chat:chat-a2")).toBe(2);
    await playSteps(1);
    expect(activeOrder().slice(0, 3)).toEqual(["chat:chat-a2", "chat:chat-a1", "chat:chat-a5"]);
    await setControl("Holds its place");
    await click(control("Reset"));
    await playSteps(8);
    expect(activeOrder().indexOf("chat:chat-a2")).toBe(2);
    expect(activeOrder()[0]).toBe("chat:chat-a5");
  });

  it("moves nothing while the pointer is in a sidebar, and lands the move when it leaves", async () => {
    const nav = host.querySelector('[data-testid="peek-nav"]')!;
    await pointInto(nav);
    await playSteps(5);
    expect(activeOrder()).toEqual(START);
    expect(host.querySelector("[data-waiting-moves]")).not.toBeNull();
    await pointOutOf(nav);
    expect(activeOrder().slice(0, 2)).toEqual(["chat:chat-a1", "chat:chat-a5"]);
    expect(host.querySelector("[data-waiting-moves]")).toBeNull();
  });

  it("keeps a read Session in Active while its peek is open, and retires it after", async () => {
    // A peek never reads by default; the 1s look is the quickest way to read under one.
    await setControl("After a 1s look");
    await hover(row("chat:chat-p8"));
    await advance(1100);
    expect(unreadDot("chat:chat-p8")).toBeNull();
    expect(activeOrder()).toContain("chat:chat-p8");
    await press(card()!, "Escape");
    expect(activeOrder()).not.toContain("chat:chat-p8");
  });

  it("starts the afternoon over on Reset", async () => {
    await playSteps(5);
    await click(control("Reset"));
    expect(activeOrder()).toEqual(START);
    expect(unreadDot("chat:chat-a3")).toBeNull();
  });
});

describe("a folder's peek (ticket mode, the proposal)", () => {
  it("opens the ticket after the dwell, lists its Sessions with what each did, and takes no focus", async () => {
    const folder = row(FOLDER_11);
    await act(async () => folder.focus());
    const focused = document.activeElement;
    await hover(folder);
    const peek = card();
    expect(peek?.dataset.peekSubject).toBe("ticket");
    expect(peek?.getAttribute("role")).toBe("note");
    expect(peek?.getAttribute("aria-label")).toBe("Peek at VLT-11, 4 sessions");
    expect(peek?.querySelectorAll("[data-peek-drill]")).toHaveLength(4);
    expect(peek?.textContent).toContain("Answered the reviewer");
    expect(peek?.textContent).toContain("Added window-padding-balance");
    // Read-only: a folder has no single recipient.
    expect(peek?.textContent).not.toMatch(/Answer$|Send/);
    expect(document.activeElement).toBe(focused);
  });

  it("drills into a Session and steps back on Escape, then closes on the next", async () => {
    await hover(row(FOLDER_11));
    await click(card()!.querySelector<HTMLElement>('[data-peek-drill="chat:chat-p3"]')!);
    let peek = card();
    expect(peek?.getAttribute("aria-label")).toBe("Peek at Chat, VLT-11");
    expect(peek?.querySelector("[data-peek-strip]")?.textContent).toContain("VLT-11");
    expect(peek?.querySelector("[data-peek-strip] button")?.getAttribute("aria-label")).toBe(
      "Back to VLT-11",
    );
    // The strip names the ticket; the card does not repeat it, and offers no reply.
    expect(peek?.querySelector("[data-peek-ticket-title]")).toBeNull();
    expect(peek?.textContent).not.toContain("Send");
    // Focus followed the swap into the new card, so the bridge holds it open.
    expect(peek?.contains(document.activeElement)).toBe(true);

    await press(document.activeElement!, "Escape");
    peek = card();
    expect(peek?.dataset.peekSubject).toBe("ticket");
    expect(document.activeElement).toBe(
      peek?.querySelector('[data-peek-drill="chat:chat-p3"]') ?? null,
    );

    await press(document.activeElement!, "Escape");
    expect(card()).toBeNull();
  });

  it("closes when the folder is pressed open, and the revealed Sessions peek on their own", async () => {
    await hover(row(FOLDER_11));
    expect(card()).not.toBeNull();
    await click(row(FOLDER_11));
    expect(card()).toBeNull();
    expect(row(FOLDER_11).getAttribute("aria-expanded")).toBe("true");

    await advance(SUPPRESSION + 50);
    await hover(row("chat:chat-p4"));
    expect(card()?.getAttribute("aria-label")).toBe("Peek at Chat, VLT-11");
    expect(card()?.textContent).toContain("Opened the PR; CI is green.");
  });
});

describe("the other folder modes", () => {
  it("opens nothing on a folder when folder peeks are off", async () => {
    await setControl("Nothing");
    await hover(row(FOLDER_11), 2 * DWELL);
    expect(card()).toBeNull();
  });

  it("stands a folder in for its newest Session, with a pager through the rest", async () => {
    await setControl("Newest session");
    await hover(row(FOLDER_11));
    const strip = () => card()?.querySelector("[data-peek-strip]");
    expect(strip()?.textContent).toContain("1 of 4");
    expect(card()?.getAttribute("aria-label")).toBe("Peek at Chat, VLT-11");
    await click(control("Older session", card()!));
    expect(strip()?.textContent).toContain("2 of 4");
    expect(card()?.textContent).toContain("Opened the PR; CI is green.");
  });
});

describe("the tree's keys", () => {
  it("opens a folder with →, returns from a Session to its folder with ←, and closes it with ←", async () => {
    const folder = button(row(FOLDER_11));
    await act(async () => folder.focus());
    await press(folder, "ArrowRight");
    expect(folder.getAttribute("aria-expanded")).toBe("true");

    const child = button(row("chat:chat-p5"));
    await act(async () => child.focus());
    await press(child, "ArrowLeft");
    expect(document.activeElement).toBe(folder);

    await press(folder, "ArrowLeft");
    expect(folder.getAttribute("aria-expanded")).toBe("false");
  });

  it("steps folders and their open Sessions in one order", async () => {
    await click(row(FOLDER_11));
    const folder = button(row(FOLDER_11));
    await act(async () => folder.focus());
    await press(folder, "ArrowDown");
    expect(document.activeElement).toBe(button(row("chat:chat-p3")));
  });
});

describe("moving between rows", () => {
  it("switches an open peek to the next row after the warm rest, not the full dwell", async () => {
    await hover(row("chat:chat-a2"));
    expect(card()?.getAttribute("aria-label")).toBe("Peek at Chat, VLT-14");
    await hover(row("chat:chat-a3"), WARM);
    expect(card()?.getAttribute("aria-label")).toBe(
      "Peek at Warm-park timer and the keep-awake flag, VLT-12",
    );
  });

  it("does not open a card for a row the pointer left for the band's header", async () => {
    await act(async () => {
      button(row("chat:chat-a5")).dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
    });
    const header = host.querySelector('[data-session-band="previous"] > div');
    await act(async () => {
      header?.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
    });
    await advance(2 * DWELL);
    expect(card()).toBeNull();
  });
});

describe("the brief's scenario: answer from the rail, keep the work in front", () => {
  it("answers the waiting question from its rail row and flips it to working in both sidebars", async () => {
    const inFront = () => host.querySelector('[aria-label="In front"] h1')?.textContent;
    expect(inFront()).toBe("Chat");

    await hover(row("chat:chat-a1", "rail"));
    expect(card()?.textContent).toContain("Which fix should land first?");
    await click(control("Answer", card()!));
    expect(card()?.getAttribute("role")).toBe("dialog");

    const option = [...card()!.querySelectorAll<HTMLInputElement>('input[type="radio"]')][1]!;
    await act(async () => option.click());
    await click(control("Send", card()!));
    await advance(500);

    for (const surface of ["nav", "rail"] as const) {
      expect(
        row("chat:chat-a1", surface).querySelector('[role="img"]')?.getAttribute("aria-label"),
      ).toBe("Anthropic · Working");
    }
    expect(inFront()).toBe("Chat");
  });

  it("offers a closed terminal's record no reply and no conversation", async () => {
    await click(row("folder:tkt-14"));
    await hover(row("session:term-p2"));
    const peek = card();
    expect(peek?.textContent).toContain("Claude Code in a terminal");
    expect(peek?.querySelector("footer")).toBeNull();
  });

  it("changes what is in front only when a row is opened, and moves the rail with it", async () => {
    await click(button(row("chat:chat-a3")));
    expect(host.querySelector('[aria-label="In front"] h1')?.textContent).toBe(
      "Warm-park timer and the keep-awake flag",
    );
    expect(host.querySelector('[aria-label="Ticket rail"] header')?.textContent).toContain(
      "VLT-12",
    );
  });
});
