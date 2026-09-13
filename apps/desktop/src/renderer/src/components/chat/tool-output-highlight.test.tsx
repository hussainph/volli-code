// @vitest-environment jsdom
/**
 * Colour is paid for by a reader, not by a transcript (VC-338).
 *
 * Two gates, and they are different mechanisms worth pinning separately:
 *
 *  - a CLOSED row has no highlighted body because it has no body — the
 *    disclosure unmounts it, which is the cheapest possible form of lazy;
 *  - an OPEN row that is off screen has a body and plain text in it, and
 *    nothing reaches the highlighter until the row is looked at.
 *
 * The observer is stubbed rather than simulated: jsdom lays nothing out, so a
 * real IntersectionObserver would have nothing to observe. The stub is the
 * contract (`observe` a node, report an intersection later), and the hook's
 * no-observer fallback — colour it now — is what the rest of the suite runs
 * under, which is why the other highlight tests beside this file still see
 * tokens without touching any of this.
 */
import { ACTIVITY_METADATA_KEY, type ActivityDescriptor } from "@volli/shared";
import type { DynamicToolUIPart } from "ai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ToolRow } from "./activity-ui";

const TOKEN_SELECTOR = "[data-line] span[style*='--sdm-c']";

const descriptor: ActivityDescriptor = {
  kind: "read-file",
  nativeToolName: "read",
  subject: { label: "src/session.ts", path: "src/session.ts", lineRange: null },
  outcome: null,
  startedAt: 1,
  endedAt: 2,
};

const readTs: DynamicToolUIPart = {
  type: "dynamic-tool",
  toolName: "read",
  toolCallId: "read-lazy",
  state: "output-available",
  input: null,
  output: "export const lazy = true;\n// paid for on sight",
  toolMetadata: { [ACTIVITY_METADATA_KEY]: descriptor } as DynamicToolUIPart["toolMetadata"],
};

/** Every node an observer was asked to watch, with the way to report it seen. */
const watched: { node: Element; see: () => void }[] = [];

class StubIntersectionObserver {
  private readonly entries: Element[] = [];

  constructor(private readonly callback: IntersectionObserverCallback) {}

  observe(node: Element): void {
    this.entries.push(node);
    watched.push({
      node,
      see: () => {
        this.callback(
          [{ isIntersecting: true, target: node } as unknown as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      },
    });
  }

  unobserve(): void {}

  disconnect(): void {
    this.entries.length = 0;
  }
}

const HIGHLIGHT_WAIT_MS = 8000;
const HIGHLIGHT_TEST_TIMEOUT_MS = HIGHLIGHT_WAIT_MS + 4000;

/** The grammar loads off-thread; poll until the swap lands or give up loudly. */
async function waitFor(predicate: () => boolean, timeoutMs = HIGHLIGHT_WAIT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for highlight");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
}

async function settle(ms = 250): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

let container: HTMLElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  watched.length = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);
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

function mount(part: DynamicToolUIPart): HTMLElement {
  act(() => {
    root?.render(<ToolRow part={part} />);
  });
  return container as HTMLElement;
}

function expand(host: HTMLElement): void {
  const disclosure = host.querySelector<HTMLButtonElement>('[aria-label="Show details"]');
  if (!disclosure) throw new Error("row has no disclosure");
  act(() => disclosure.click());
}

describe("tool output that nobody has looked at", () => {
  it("is not in the document at all while the row is closed", async () => {
    const host = mount(readTs);
    await settle();

    expect(host.textContent).not.toContain("export const lazy = true;");
    expect(host.querySelector("[data-line]")).toBeNull();
    expect(watched).toHaveLength(0);
  });

  it(
    "renders plain text off screen and colours it once the row is seen",
    async () => {
      const host = mount(readTs);
      expand(host);

      // Open, so the payload is readable — and uncoloured, because nothing has
      // told us the reader can see it.
      expect(host.textContent).toContain("export const lazy = true;");
      await settle();
      expect(host.querySelector(TOKEN_SELECTOR)).toBeNull();
      expect(watched).toHaveLength(1);

      act(() => watched[0]?.see());
      await waitFor(() => host.querySelector(TOKEN_SELECTOR) !== null);

      const lines = Array.from(host.querySelectorAll("[data-line]"));
      expect(lines).toHaveLength(2);
      expect(lines[0]?.textContent).toMatch(/export const lazy = true;$/);
      expect(lines[0]?.querySelectorAll(TOKEN_SELECTOR).length).toBeGreaterThan(1);
    },
    HIGHLIGHT_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the colour when the row scrolls back off screen",
    async () => {
      const host = mount(readTs);
      expand(host);
      act(() => watched[0]?.see());
      await waitFor(() => host.querySelector(TOKEN_SELECTOR) !== null);

      // The observer is disconnected after the latch, so there is no way back
      // to plain text — which is the point: re-tokenizing on every pass of a
      // long transcript is the cost this gate exists to avoid.
      await settle();
      expect(host.querySelector(TOKEN_SELECTOR)).not.toBeNull();
    },
    HIGHLIGHT_TEST_TIMEOUT_MS,
  );
});
