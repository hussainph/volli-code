// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  title: "Build shell",
  focus: vi.fn(),
  onActivate: vi.fn(),
  offData: vi.fn(),
  offResize: vi.fn(),
}));
vi.mock("@renderer/stores/sessions", () => {
  const panes = [
    { kind: "pane", sessionId: "root", exitCode: null },
    { kind: "pane", sessionId: "child", exitCode: null },
  ];
  const state = () => ({
    byOwner: { owner: { tabs: [{ sessionId: "root", title: fixture.title, layout: panes }] } },
  });
  return {
    useSessionsStore: Object.assign(
      (select: (value: ReturnType<typeof state>) => unknown) => select(state()),
      { getState: state },
    ),
    sessionPanes: () => panes,
    findSessionPane: () => panes[0],
  };
});
vi.mock("@renderer/terminal/registry", () => {
  const engine = {
    attach: (host: HTMLElement) => {
      if (host.querySelector("textarea")) return;
      const input = document.createElement("textarea");
      const row = document.createElement("div");
      row.tabIndex = -1;
      row.textContent = "Build complete";
      host.append(input, row);
    },
    onData: () => fixture.offData,
    onResize: () => fixture.offResize,
    setPaused: vi.fn(),
    fit: vi.fn(),
    focus: fixture.focus,
  };
  return { getEngine: () => engine, getOrCreateEngine: () => engine };
});
import { TerminalView } from "./terminal-view";

let root: Root;
let container: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function render(sessionId = "child", visible = true) {
  await act(async () =>
    root.render(
      <TerminalView
        ownerId="owner"
        tabId="root"
        sessionId={sessionId}
        visible={visible}
        active={false}
        onActivate={fixture.onActivate}
      />,
    ),
  );
}
async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("api", { terminal: { setVisible: vi.fn() } });
  fixture.title = "Build shell";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
}

describe("TerminalView accessibility", () => {
  it("names each pane, follows tab renames and preserves the host identity", async () => {
    await mount();
    const host = container.querySelector('[role="region"]')!;
    const id = host.id;
    expect(host.getAttribute("aria-label")).toBe("Build shell — pane 2");
    fixture.title = "Renamed shell";
    await render();
    expect(host.getAttribute("aria-label")).toBe("Renamed shell — pane 2");
    expect(host.id).toBe(id);
    await render("root");
    expect(host.getAttribute("aria-label")).toBe("Renamed shell — pane 1");
    await render("root", false);
    expect(host.classList.contains("hidden")).toBe(true);
    await render("root", true);
    expect(host.classList.contains("hidden")).toBe(false);
  });

  it("activates keyboard input without redirecting focus from accessible output", async () => {
    await mount();
    const host = container.querySelector('[role="region"]')!;
    await act(async () => host.querySelector("textarea")!.focus());
    expect(fixture.onActivate).toHaveBeenCalledTimes(1);
    fixture.onActivate.mockClear();
    const row = host.querySelector<HTMLDivElement>('[tabindex="-1"]')!;
    await act(async () => row.focus());
    expect(fixture.onActivate).not.toHaveBeenCalled();
    expect(fixture.focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(row);
    expect(host.className).toContain("focus-within:ring-primary");
  });
});
