// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { DynamicToolUIPart } from "ai";
import { presentTranscriptTool } from "@volli/session-presentation";
import { PresentedToolRow } from "./presented-tool-row";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("expands the actual delegation relation list and puts Show fewer after the expanded list", () => {
  const ids = Array.from({ length: 10 }, (_, index) => `session-${index + 1}`);
  const names = new Map(
    ids.map((id, index) => [id, index === 7 ? "مراجعة التباين" : `Audit ${index + 1}`]),
  );
  const parents = new Map(ids.map((id, index) => [id, ids[index - 1] ?? null]));
  const part: DynamicToolUIPart = {
    type: "dynamic-tool",
    toolCallId: "delegate",
    toolName: "session_delegate",
    state: "output-available",
    input: { task: "Audit contrast" },
    output: { details: { sessionId: ids[9], handle: "session-10" } },
  };
  const presentation = presentTranscriptTool(part, {
    sessionNames: names,
    sessionParents: parents,
  });
  if (presentation === null) throw new Error("Expected real delegation presenter");
  const openSession = vi.fn();
  act(() =>
    root.render(
      <PresentedToolRow part={part} presentation={presentation} onOpenSession={openSession} />,
    ),
  );
  expect(container.querySelector('[aria-label="Delegation relations"]')).toBeNull();
  act(() => container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!.click());
  const region = container.querySelector<HTMLElement>('[aria-label="Delegation relations"]')!;
  expect(region.tabIndex).toBe(0);
  expect(region.querySelectorAll("li")).toHaveLength(5);
  const more = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "5 more Sessions",
  )!;
  act(() => more.click());
  expect(region.querySelectorAll("li")).toHaveLength(10);
  expect(
    [...region.querySelectorAll("li")].map((item) => item.querySelector("button bdi")?.textContent),
  ).toEqual(ids.map((id) => names.get(id)));
  const last = region.querySelectorAll("li")[9]!;
  act(() => last.querySelector<HTMLButtonElement>("button")!.click());
  expect(openSession).toHaveBeenLastCalledWith(ids[9]);
  expect(last.textContent).toContain("Delegated by Audit 9");
  for (const [index, row] of [...region.querySelectorAll("li")].entries()) {
    const number = row.querySelector('[dir="ltr"]')!;
    expect([...number.children].map((child) => child.textContent)).toEqual([
      String(index + 1),
      ".",
    ]);
    expect(row.querySelector('bdi[dir="auto"]')).not.toBeNull();
  }
  const fewer = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Show fewer Sessions",
  )!;
  expect(region.compareDocumentPosition(fewer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(fewer.getAttribute("aria-expanded")).toBe("true");
  act(() => fewer.click());
  expect(region.querySelectorAll("li")).toHaveLength(5);
  expect(more.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector("[title]")).toBeNull();
});
