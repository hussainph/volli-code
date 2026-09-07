// @vitest-environment jsdom
/**
 * THE FOUR PIECES OF THE NARROW DIFF, WIRED TOGETHER (VC-288 review).
 *
 * `diff-fit.test.ts` pins the arithmetic, `use-pane-width.test.tsx` pins the
 * observer, and `diff-presentation-toggle.test.tsx` pins the band. All three
 * can pass while the pane is wired to none of them — the fit read from the
 * window instead of the element, the fitted value handed to the band but not
 * to Monaco, the observer attached to a node that no longer exists after a
 * reload. This file is the one that mounts the real `DiffView` and moves a real
 * `ResizeObserver`, so what is asserted is the chain: a pane resize reaches the
 * editor's `presentation` prop AND the band's own words, together, from one
 * measurement.
 *
 * WHAT IS FAKED, and why it is honest to fake it: Monaco (a canvas editor that
 * jsdom cannot lay out — the prop it is handed is the whole of what this pane
 * decides), the document registry behind it, and the three IPC reads the load
 * makes. Nothing about the fit is faked, and the widths below are the
 * acceptance widths.
 */
import type { Ticket } from "@volli/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useUiStore } from "@renderer/stores/ui";

/** Every presentation Monaco has been asked to draw, in order. */
const drawn: string[] = [];

vi.mock("@renderer/components/editor/monaco-diff-editor", () => ({
  MonacoDiffEditor: ({ presentation }: { presentation: string }) => {
    drawn.push(presentation);
    return <div data-testid="fake-monaco" data-presentation={presentation} />;
  },
  releaseDiffLeases: () => undefined,
  diffEditorInitFailureMessage: () => "no",
}));

const lease = {
  model: { getValue: () => "b\n" },
  snapshot: () => ({ baseline: "b\n", baselineRevision: 5, savePolicy: "explicit" as const }),
  applyExternalUpdate: () => undefined,
  adoptCleanBaseline: () => undefined,
};

vi.mock("@renderer/editor/monaco-runtime", () => ({
  loadMonacoRuntime: async () => ({
    registry: { acquire: () => lease, peek: () => null },
  }),
}));

vi.mock("@renderer/lib/toast", () => ({ toastError: () => undefined }));

/** The fake observers a render made, with the element each is watching. */
let observers: { target: Element | null; notify(): void }[] = [];
let container: HTMLElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  drawn.length = 0;
  observers = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      target: Element | null = null;
      constructor(private readonly callback: () => void) {
        observers.push(this as unknown as { target: Element | null; notify(): void });
      }
      observe(element: Element): void {
        this.target = element;
      }
      unobserve(): void {}
      disconnect(): void {}
      notify(): void {
        this.callback();
      }
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      worktree: {
        changeSet: async () => ({
          ok: true,
          changeSet: {
            baseRevision: "base-1",
            files: [
              {
                path: "src/app.ts",
                status: "modified",
                insertions: 2,
                deletions: 1,
                binary: false,
              },
            ],
          },
        }),
        baseRead: async () => ({ ok: true, content: "a\n", truncated: false }),
      },
      files: {
        read: async () => ({
          ok: true,
          content: { type: "text", text: "b\n", truncated: false },
          mtime: 5,
          source: "worktree",
        }),
        watch: async () => ({ ok: true }),
        unwatch: async () => ({ ok: true }),
        onChanged: () => () => undefined,
      },
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  useUiStore.setState({ diffPresentation: "side-by-side" });
  vi.unstubAllGlobals();
});

const TICKET = { id: "t1" } as Ticket;

async function mountDiff(): Promise<void> {
  const { DiffView } = await import("./diff-view");
  await act(async () => {
    // The provider the app shell mounts around everything (`ui/sidebar.tsx`):
    // the control band's toggles are tooltip triggers.
    root?.render(
      <TooltipProvider>
        <DiffView projectId="p1" ticket={TICKET} relPath="src/app.ts" />
      </TooltipProvider>,
    );
  });
  // The load is three awaited IPC round trips before the editor state lands.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The pane the fit is measured from. */
function pane(): HTMLElement {
  const found = container?.querySelector<HTMLElement>("[data-diff-fit]");
  if (found === null || found === undefined) throw new Error("no diff pane");
  return found;
}

/** Give the pane a width and let the observer that watches it report. */
function resizePane(width: number): void {
  const element = pane();
  Object.defineProperty(element, "clientWidth", { configurable: true, get: () => width });
  act(() => {
    for (const observer of observers) {
      if (observer.target === element) observer.notify();
    }
  });
}

function bandSaysNarrow(): boolean {
  return container?.querySelector('[data-testid="ticket-diff-inline-fallback"]') !== null;
}

function monacoPresentation(): string | null {
  return (
    container?.querySelector('[data-testid="fake-monaco"]')?.getAttribute("data-presentation") ??
    null
  );
}

describe("a side-by-side diff in a pane that cannot hold two columns", () => {
  it("falls back at 320 and at 480, restores at 720, and says so in the band each time", async () => {
    useUiStore.setState({ diffPresentation: "side-by-side" });
    await mountDiff();

    // The acceptance widths, walked in one mount: this is a divider drag, and
    // the same element answers all three without remounting anything.
    resizePane(320);
    expect(monacoPresentation()).toBe("inline");
    expect(pane().getAttribute("data-diff-fit")).toBe("narrow");
    expect(bandSaysNarrow()).toBe(true);

    resizePane(480);
    expect(monacoPresentation()).toBe("inline");
    expect(bandSaysNarrow()).toBe(true);

    resizePane(720);
    expect(monacoPresentation()).toBe("side-by-side");
    expect(pane().getAttribute("data-diff-fit")).toBe("chosen");
    expect(bandSaysNarrow()).toBe(false);
  });

  it("never rewrites the stored choice, so the control still shows what was asked for", async () => {
    useUiStore.setState({ diffPresentation: "side-by-side" });
    await mountDiff();
    resizePane(320);

    // The preference is app-wide and durable; a pane being narrow for a minute
    // is not a person changing their mind. Both segments stay pressable, and
    // the one that is pressed is still the stored one.
    expect(useUiStore.getState().diffPresentation).toBe("side-by-side");
    const chosen = container?.querySelector('[data-choice="side-by-side"]');
    expect(chosen?.getAttribute("aria-pressed")).toBe("true");
    expect(chosen?.hasAttribute("disabled")).toBe(false);
  });

  it("leaves a diff already chosen inline alone, and says nothing about the pane", async () => {
    useUiStore.setState({ diffPresentation: "inline" });
    await mountDiff();
    resizePane(320);

    expect(monacoPresentation()).toBe("inline");
    // Nothing is being overridden, so there is no news: the band's line exists
    // to explain a disagreement, and there is none.
    expect(bandSaysNarrow()).toBe(false);
  });

  it("hands the editor one prop change rather than a new editor on every resize", async () => {
    useUiStore.setState({ diffPresentation: "side-by-side" });
    await mountDiff();
    resizePane(320);
    resizePane(720);

    // A resize restyles the live DiffEditor (`updateOptions`) instead of
    // rebuilding one, which is what keeps scroll position and selection.
    expect(drawn.at(-3)).toBe("side-by-side");
    expect(drawn.at(-2)).toBe("inline");
    expect(drawn.at(-1)).toBe("side-by-side");
    expect(container?.querySelectorAll('[data-testid="fake-monaco"]')).toHaveLength(1);
  });
});
