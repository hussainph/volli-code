// @vitest-environment jsdom
import { ACTIVITY_METADATA_KEY, type ActivityDescriptor } from "@volli/shared";
import type { DynamicToolUIPart } from "ai";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ActivityBundle, copyActivityObject, ToolRow } from "./activity-ui";

const descriptor: ActivityDescriptor = {
  kind: "read-file",
  nativeToolName: "read",
  subject: { label: "src/session.ts", path: "src/session.ts", lineRange: null },
  outcome: null,
  startedAt: 1,
  endedAt: 2,
};

const row: DynamicToolUIPart = {
  type: "dynamic-tool",
  toolName: "read",
  toolCallId: "read-1",
  state: "output-available",
  input: null,
  output: "export {};",
  toolMetadata: { [ACTIVITY_METADATA_KEY]: descriptor } as DynamicToolUIPart["toolMetadata"],
};

const bashRow: DynamicToolUIPart = {
  type: "dynamic-tool",
  toolName: "bash",
  toolCallId: "bash-1",
  state: "output-available",
  input: { command: "pnpm run typecheck &&\npnpm run test" },
  output: { content: [{ type: "text", text: "Typecheck passed\nTests passed" }] },
  toolMetadata: {
    [ACTIVITY_METADATA_KEY]: {
      ...descriptor,
      kind: "run-command",
      nativeToolName: "bash",
      // The input is what actually ran. This deliberately disagrees with the
      // descriptor to keep the UI's command source honest.
      subject: { label: "validation", path: null, lineRange: null },
    },
  } as DynamicToolUIPart["toolMetadata"],
};

// A failed row opens the bundle on its own (`bundleNeedsAttention`), which is
// how both tests below get the capped window into static markup with no click.
const failed: DynamicToolUIPart = {
  type: "dynamic-tool",
  toolName: "read",
  toolCallId: "read-2",
  state: "output-error",
  input: null,
  errorText: "boom",
  toolMetadata: { [ACTIVITY_METADATA_KEY]: descriptor } as DynamicToolUIPart["toolMetadata"],
};

const openBundle = () =>
  renderToStaticMarkup(<ActivityBundle rows={[{ kind: "tool", part: failed, key: "read-2" }]} />);

describe("ActivityBundle scroll window", () => {
  it("caps the open bundle without trapping the wheel inside it (VC-32)", () => {
    // The cap must stay — an uncapped payload shoves the feed off screen — but
    // `overscroll-contain` must not come back: it turned the cap's edges into a
    // dead zone where the transcript ignored the wheel entirely.
    const html = openBundle();

    expect(html).toContain("max-h-96");
    expect(html).toContain("overflow-auto");
    expect(html).not.toContain("overscroll-contain");
  });

  it("paints nothing over the window's own bottom edge (VC-60)", () => {
    // The scrim this guards against covered the last row whole — 28 of 28px —
    // and stayed there at the BOTTOM of the scroll, where there is no cut to
    // announce. It is gone, with the hook that armed it; what says "there is
    // more" is the app's overlay scrollbar, which retracts on its own.
    //
    // WHAT THIS CANNOT SEE: a scrim gated on a measurement. Effects do not run
    // under `renderToStaticMarkup`, so a re-added `clipped ? … : null` renders
    // as nothing here and passes. The standing guard is that nothing measures
    // this box any more; this catches an unconditional re-add.
    const html = openBundle();

    // The scrim's own shape: an inert layer positioned over the window. (A bare
    // `pointer-events-none` would match the button primitive's `[&_svg]:` rule.)
    expect(html).not.toContain("pointer-events-none absolute");
    expect(html).not.toContain("gradient");
  });
});

/* ------------------------------------------------ expanded detail colouring */

/** A token span as the chat's code fences paint one: a light colour plus the dark-theme variable. */
const TOKEN_SELECTOR = '[style*="--shiki-dark"]';

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

function mountExpanded(part: DynamicToolUIPart): HTMLElement {
  act(() => {
    root?.render(<ToolRow part={part} />);
  });
  const disclosure = container?.querySelector<HTMLButtonElement>('[aria-label="Show details"]');
  if (!disclosure) throw new Error("row has no disclosure");
  act(() => disclosure.click());
  return container as HTMLElement;
}

/**
 * The first grammar load is real work (shiki compiles the TextMate regexes on
 * first use), so the async tests get a budget above the poll's own deadline:
 * `waitFor` must be the one to fail, or its loop outlives the test and its
 * stray `act` scopes break the next one's mount.
 */
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

const readTs: DynamicToolUIPart = {
  ...row,
  toolCallId: "read-ts",
  output: "export const answer = 42;\n// the question",
};

const writeTs: DynamicToolUIPart = {
  type: "dynamic-tool",
  toolName: "write",
  toolCallId: "write-ts",
  state: "output-available",
  // The real Write shape is a record, not a bare string: the file lives in
  // `content` and the output is only the harness confirmation (VC-125).
  input: { path: "src/created.ts", content: "export const created = true;\n" },
  output: "ok",
  toolMetadata: {
    [ACTIVITY_METADATA_KEY]: {
      ...descriptor,
      kind: "write-file",
      nativeToolName: "write",
      subject: { label: "src/created.ts", path: "src/created.ts", lineRange: null },
    },
  } as DynamicToolUIPart["toolMetadata"],
};

const editTs: DynamicToolUIPart = {
  type: "dynamic-tool",
  toolName: "edit",
  toolCallId: "edit-ts",
  state: "output-available",
  input: null,
  output: "ok",
  toolMetadata: {
    [ACTIVITY_METADATA_KEY]: {
      ...descriptor,
      kind: "edit-file",
      nativeToolName: "edit",
      outcome: {
        exitCode: null,
        matchCount: null,
        fileCount: null,
        lineCount: null,
        bytes: null,
        addedLines: 1,
        removedLines: 1,
        diff: "@@ -1,2 +1,2 @@\n-const answer = 41;\n+const answer = 42;\n export {};",
        summary: null,
      },
    },
  } as DynamicToolUIPart["toolMetadata"],
};

describe("ToolRow expanded detail colouring (VC-125)", () => {
  it(
    "colours a Read row's lines with the file's grammar and keeps the number column",
    async () => {
      const host = mountExpanded(readTs);

      // Plain text first: the row is readable before any grammar has loaded.
      expect(host.textContent).toContain("export const answer = 42;");
      expect(host.querySelector(TOKEN_SELECTOR)).toBeNull();

      await waitFor(() => host.querySelector(TOKEN_SELECTOR) !== null);

      const lines = Array.from(host.querySelectorAll("[data-line]"));
      expect(lines).toHaveLength(2);
      // The number column is untouched; the text beside it is now tokens that
      // still spell the same line.
      expect(lines[0]?.textContent).toMatch(/^1\s*export const answer = 42;$/);
      expect(lines[1]?.textContent).toMatch(/^2\s*\/\/ the question$/);
      expect(lines[0]?.querySelectorAll(TOKEN_SELECTOR).length).toBeGreaterThan(1);
      // Light and dark are both in the token, the same way a code fence carries them.
      const token = host.querySelector<HTMLElement>(TOKEN_SELECTOR);
      expect(token?.getAttribute("style")).toMatch(/--sdm-c:\s*#/);
      expect(token?.getAttribute("style")).toMatch(/--shiki-dark:\s*#/);
    },
    HIGHLIGHT_TEST_TIMEOUT_MS,
  );

  it(
    "colours diff lines after the marker and keeps the change kind visible",
    async () => {
      const host = mountExpanded(editTs);
      await waitFor(() => host.querySelector(TOKEN_SELECTOR) !== null);

      const lines = Array.from(host.querySelectorAll<HTMLElement>("[data-line]"));
      expect(lines.map((line) => line.textContent)).toEqual([
        "@@ -1,2 +1,2 @@",
        "-const answer = 41;",
        "+const answer = 42;",
        " export {};",
      ]);
      const [hunk, removed, added, context] = lines;

      // The hunk header is diff syntax, not source: never fed to the grammar.
      expect(hunk?.querySelector(TOKEN_SELECTOR)).toBeNull();

      // Tokens carry the syntax colour, so the tint moves to a row wash and the
      // marker keeps the old text tint.
      expect(added?.className).toContain("bg-primary/10");
      expect(removed?.className).toContain("bg-destructive/10");
      expect(context?.className).not.toMatch(/bg-(primary|destructive)\/10/);
      expect(added?.querySelector("[data-marker]")?.textContent).toBe("+");
      expect(added?.querySelector("[data-marker]")?.className).toContain("text-primary-text");
      expect(removed?.querySelector("[data-marker]")?.textContent).toBe("-");
      expect(removed?.querySelector("[data-marker]")?.className).toContain("text-destructive");
      for (const line of [removed, added, context]) {
        expect(line?.querySelectorAll(TOKEN_SELECTOR).length).toBeGreaterThan(1);
        // The marker itself is never a token.
        expect(line?.querySelector("[data-marker]")?.matches(TOKEN_SELECTOR)).toBe(false);
      }
    },
    HIGHLIGHT_TEST_TIMEOUT_MS,
  );

  it(
    "colours a Write row's file-content output while preserving the content",
    async () => {
      const host = mountExpanded(writeTs);

      expect(host.textContent).toContain("export const created = true;");
      expect(host.querySelector(TOKEN_SELECTOR)).toBeNull();
      await waitFor(() => host.querySelector(TOKEN_SELECTOR) !== null);

      const line = host.querySelector("[data-line]");
      expect(line?.textContent).toBe("export const created = true;");
      expect(line?.querySelectorAll(TOKEN_SELECTOR).length).toBeGreaterThan(1);
    },
    HIGHLIGHT_TEST_TIMEOUT_MS,
  );

  it("leaves a Bash row's output plain", async () => {
    const host = mountExpanded(bashRow);
    // Give a would-be highlighter longer than it needs; nothing should arrive.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    expect(host.textContent).toContain("Typecheck passed");
    expect(host.querySelector(TOKEN_SELECTOR)).toBeNull();
  });
});

describe("ToolRow copy control", () => {
  it("renders a copy control for an activity object", () => {
    const html = renderToStaticMarkup(<ToolRow part={row} />);

    expect(html).toContain('aria-label="Copy"');
  });

  it("keeps the command inline and gives it a visible disclosure control", () => {
    const html = renderToStaticMarkup(<ToolRow part={bashRow} />);

    expect(html).toContain("pnpm run typecheck &amp;&amp;\npnpm run test");
    expect(html).toContain('class="min-w-0 truncate font-mono text-ui text-foreground"');
    expect(html).toContain("cursor-pointer hover:bg-muted/30 hover:text-foreground");
    expect(html).toContain('aria-label="Show details"');
    expect(html).toContain('title="Show details"');
    expect(html).toContain("size-5");
    expect(html).toContain("motion-reduce:transition-none opacity-100");
  });

  it("reports a fulfilled clipboard write as copied", async () => {
    const writeText = vi.fn(async () => undefined);

    await expect(copyActivityObject("src/session.ts", { writeText })).resolves.toBe("copied");
    expect(writeText).toHaveBeenCalledWith("src/session.ts");
  });

  it("reports a rejected clipboard write as failed", async () => {
    const writeText = vi.fn(async () => Promise.reject(new Error("denied")));

    await expect(copyActivityObject("src/session.ts", { writeText })).resolves.toBe("failed");
  });
});
