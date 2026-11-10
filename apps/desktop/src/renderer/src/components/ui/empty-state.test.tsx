// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EmptyState,
  EmptyStateScope,
  PanelEmptyState,
  type EmptyIllustration,
} from "./empty-state";
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("makes Inline literally empty, without text, frame, illustration or intrinsic height", () => {
  expect(renderToStaticMarkup(<EmptyState tier="inline" />)).toBe("");
  expect(
    renderToStaticMarkup(
      <EmptyStateScope tier="inline">
        <PanelEmptyState illustration="file" title="No files" />
      </EmptyStateScope>,
    ),
  ).toBe("");
});
it("names a Page or Panel with its actual reason heading and hides all decorative art", async () => {
  await act(async () =>
    root.render(<EmptyState tier="panel" illustration="mcp" title="No MCP servers" />),
  );
  const heading = host.querySelector("h2")!;
  expect(host.querySelector("section")?.getAttribute("aria-labelledby")).toBe(heading.id);
  expect(host.querySelector(".empty-art")?.getAttribute("aria-hidden")).toBe("true");
  expect(host.querySelector(".empty-art button")).toBeNull();
  expect(host.querySelectorAll("button")).toHaveLength(0);
});
it("uses ten distinct static compositions, with no activity, loading or animation drawing", () => {
  const names: EmptyIllustration[] = [
    "board",
    "automation",
    "file",
    "archive",
    "mcp",
    "skill",
    "secret",
    "chat",
    "search",
    "failed",
  ];
  const drawings = names.map((name) =>
    renderToStaticMarkup(
      <EmptyState
        tier="page"
        illustration={name}
        title="Reason"
        status={name === "failed" ? "failed" : "empty"}
        action={name === "failed" ? { label: "Try again", onAction: () => {} } : undefined}
      />,
    ),
  );
  expect(new Set(drawings.map((html) => html.match(/data-composition="([^"]+)/)?.[1])).size).toBe(
    10,
  );
  expect(drawings.every((html) => !html.includes("animate-") && !html.includes("skeleton"))).toBe(
    true,
  );
  const css = readFileSync(resolve(import.meta.dirname, "empty-state.css"), "utf8");
  expect(css).toContain("var(--canvas-secondary-stop)");
  expect(css).not.toMatch(/@keyframes|animation:|transition:/);
});
it("keeps failures visible even in an inline scope, neutral and recoverable", async () => {
  const retry = vi.fn();
  await act(async () =>
    root.render(
      <EmptyStateScope tier="inline">
        <PanelEmptyState
          illustration="board"
          status="failed"
          title="Couldn’t load the archive"
          action={{ label: "Try again", onAction: retry }}
        />
      </EmptyStateScope>,
    ),
  );
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(host.querySelector(".empty-art")?.getAttribute("data-composition")).toBe("failed");
  expect(host.querySelectorAll(".es-piece")).toHaveLength(1);
  expect(host.querySelector(".es-accent")).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(retry).toHaveBeenCalledExactlyOnceWith();
});
it("retains one real action, busy/read-only state, shortcut and accessible name", async () => {
  const run = vi.fn();
  await act(async () =>
    root.render(
      <EmptyState
        tier="page"
        illustration="board"
        title="No tickets yet"
        action={{
          label: "New ticket",
          onAction: run,
          busy: true,
          readOnly: true,
          shortcut: "C",
          keyshortcuts: "C",
        }}
      />,
    ),
  );
  const button = host.querySelector<HTMLButtonElement>("button")!;
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("aria-label")).toBe("New ticket");
  expect(button.getAttribute("aria-keyshortcuts")).toBe("C");
  expect(button.hasAttribute("data-host-read-only")).toBe(true);
  expect(host.querySelectorAll("button")).toHaveLength(1);
});
