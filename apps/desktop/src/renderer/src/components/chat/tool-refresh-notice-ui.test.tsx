// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptToolRefresh } from "@volli/session-presentation";
import { expect, it } from "vite-plus/test";
import { ToolRefreshNotice } from "./tool-refresh-notice-ui";

const refresh: TranscriptToolRefresh = {
  sequence: 8,
  afterMessageId: null,
  trigger: "cold-turn",
  added: ["read", "write"],
  changed: ["codemode"],
};

/** Names render as mono values; the suffix stays in the row's sans. */
const updated = (name: string) => `<span class="font-mono">${name}</span> (updated)`;

it("shows a quiet expandable row with additions, changed names and trigger", () => {
  const html = renderToStaticMarkup(<ToolRefreshNotice refresh={refresh} defaultOpen />);
  expect(html).toContain("Tools updated: 2 added");
  expect(html).toContain('data-slot="collapsible"');
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain("Cold turn");
  expect(html).toContain('<span class="font-mono">read</span>');
  expect(html).toContain('<span class="font-mono">write</span>');
  expect(html).toContain(updated("codemode"));
  expect(html).not.toContain('role="alert"');
  expect(html).not.toContain("<details");
});

it("starts collapsed with the names out of the DOM", () => {
  const html = renderToStaticMarkup(<ToolRefreshNotice refresh={refresh} />);
  expect(html).toContain("Tools updated: 2 added");
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain("Cold turn");
  expect(html).not.toContain("codemode");
});

it("draws the trigger as a transcript row: arrow cursor, no selection, visible keyboard ring", () => {
  const html = renderToStaticMarkup(<ToolRefreshNotice refresh={refresh} />);
  const trigger = new DOMParser()
    .parseFromString(html, "text/html")
    .querySelector('[data-slot="collapsible-trigger"]');
  expect(trigger?.tagName).toBe("BUTTON");
  const classes = trigger?.className.split(" ") ?? [];
  expect(classes).toEqual(
    expect.arrayContaining([
      "cursor-default",
      "select-none",
      "font-medium",
      "focus-visible:ring-1",
      "focus-visible:ring-ring",
    ]),
  );
  expect(classes).not.toContain("cursor-pointer");
  expect(classes).not.toContain("font-semibold");
  expect(html).toContain("group-data-[state=open]/refresh:rotate-90");
  expect(html).toContain("motion-reduce:transition-none");
});

it("lets long tool names wrap instead of widening the transcript", () => {
  const long = "mcp__workspace_documentation_server__search_every_indexed_repository_page";
  const html = renderToStaticMarkup(
    <ToolRefreshNotice refresh={{ ...refresh, added: [long], changed: [] }} defaultOpen />,
  );
  expect(html).toContain(`<li class="min-w-0 wrap-anywhere"><span class="font-mono">${long}`);
});

it("toggles from the trigger", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<ToolRefreshNotice refresh={refresh} />));
  const trigger = container.querySelector<HTMLButtonElement>("button")!;
  expect(container.textContent).not.toContain("Cold turn");
  await act(async () => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(container.textContent).toContain("Cold turn");
  expect(container.textContent).toContain("codemode (updated)");
  await act(async () => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await act(async () => root.unmount());
  container.remove();
});

it.each([
  ["warm-turn", "Warm turn"],
  ["compaction", "Compaction"],
  ["model-switch", "Model switch"],
  ["code-mode", "Code Mode"],
  ["future-trigger", "future-trigger"],
])("names an update-only %s refresh without suggesting nothing changed", (trigger, label) => {
  const html = renderToStaticMarkup(
    <ToolRefreshNotice
      refresh={{
        sequence: 9,
        afterMessageId: null,
        trigger: trigger as TranscriptToolRefresh["trigger"],
        added: [],
        changed: ["codemode"],
      }}
      defaultOpen
    />,
  );
  expect(html).toContain("Tools updated: 1 updated");
  expect(html).toContain(label);
  expect(html).toContain(updated("codemode"));
  expect(html).not.toContain("0 added");
});
