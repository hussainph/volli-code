// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { NO_AUTOMATION_TRIGGER, type Automation } from "@volli/shared";
import { BoardBoundary } from "./board-boundary";
import { BoardEmpty } from "./board-empty";

const access = vi.hoisted(() => ({ ready: true as boolean | null }));
vi.mock("@renderer/components/sessions/model-access-first-run", () => ({
  useModelAccessReady: () => access.ready,
  ModelAccessFirstRun: () => <span>Model access required</span>,
}));
import { ColumnOfferedPanel } from "./column-offered-panel";

it("contains a render fault and offers a named, repeatable board retry", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let failed = true;
  function Child() {
    if (failed) throw new Error("fixture fault");
    return <span>Board restored</span>;
  }
  try {
    await act(async () =>
      root.render(
        <BoardBoundary projectId="p1">
          <Child />
        </BoardBoundary>,
      ),
    );
    expect(host.querySelector("h2")?.textContent).toBe("Board unavailable");
    expect(host.querySelector("h2")?.classList.contains("text-heading")).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Board unavailable");
    expect(host.querySelector("button")?.textContent).toBe("Reload the board");
    const retry = host.querySelector("button")!;
    await act(async () => retry.click());
    expect(host.querySelector("[data-board-boundary-fallback]")).not.toBeNull();
    failed = false;
    await act(async () => host.querySelector("button")!.click());
    expect(host.textContent).toBe("Board restored");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    errors.mockRestore();
    vi.unstubAllGlobals();
  }
});

describe("empty board", () => {
  it("names the empty state without teaching the composer", () => {
    access.ready = true;
    const html = renderToStaticMarkup(<BoardEmpty projectId="p1" />);
    expect(html).toMatch(/<h2[^>]*>No tickets yet<[/]h2>/);
    expect(html).toContain('data-tier="page"');
    expect(html).toContain("New ticket");
    expect(html).not.toContain("Create &amp; start puts");
  });
  it("keeps the model read pending distinct from missing access", () => {
    access.ready = null;
    const html = renderToStaticMarkup(<BoardEmpty projectId="p1" />);
    expect(html).toContain("Loading model access");
    expect(html).not.toContain("Model access required");
    expect(html).not.toContain("New ticket");
    access.ready = false;
    expect(renderToStaticMarkup(<BoardEmpty projectId="p1" />)).toContain("Model access required");
  });
});

describe("offered drop targets", () => {
  const automation: Automation = {
    id: "a1",
    projectId: "p1",
    name: "Review every boundary in this ticket's diff",
    instructions: "Review",
    trigger: NO_AUTOMATION_TRIGGER,
    runtime: null,
    createdAt: 0,
    updatedAt: 0,
  };
  it("keeps the full target name and inset footer without truncating expanded choices", () => {
    const html = renderToStaticMarkup(
      <ColumnOfferedPanel rows={[automation]} expanded highlighted={0} armedId={null} />,
    );
    expect(html).toContain('data-offered-row="0"');
    expect(html).toContain("font-medium wrap-anywhere");
    expect(html).not.toContain("flex-1 truncate");
    expect(html).toContain('data-offered-row="move-only"');
    expect(html).toContain('class="px-2 py-1 text-label text-muted-foreground"');
    expect(html).toContain("Drop on a choice · Esc cancels");
  });
});
