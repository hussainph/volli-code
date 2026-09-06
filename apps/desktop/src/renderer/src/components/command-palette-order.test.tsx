// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Command } from "cmdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { commandPaletteFilter } from "./command-palette-search";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  window.HTMLElement.prototype.scrollIntoView = () => {};
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

describe("command palette section priority", () => {
  it("keeps Tickets ahead of a more relevant Session for a non-empty query", async () => {
    await act(async () => {
      root?.render(
        <Command filter={commandPaletteFilter}>
          <Command.Input value="session" onValueChange={() => {}} />
          <Command.List>
            <Command.Group heading="Tickets">
              <Command.Item
                value="ticket VC-1 Session cleanup Alpha"
                keywords={["VC-1", "Session cleanup", "Alpha"]}
              >
                Session cleanup
              </Command.Item>
            </Command.Group>
            <Command.Group heading="Sessions">
              <Command.Item
                value="session Session Alpha · Project Session Alpha"
                keywords={["Session", "Alpha · Project Session", "Alpha"]}
              >
                Session
              </Command.Item>
            </Command.Group>
          </Command.List>
        </Command>,
      );
    });

    const headings = Array.from(
      container?.querySelectorAll<HTMLElement>("[cmdk-group-heading]") ?? [],
      (heading) => heading.textContent,
    );
    expect(headings).toEqual(["Tickets", "Sessions"]);
  });
});
