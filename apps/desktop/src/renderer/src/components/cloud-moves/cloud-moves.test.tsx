// @vitest-environment jsdom
import { act, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CloudMoveRailRow,
  CloudMoveReadOnlyBanner,
  CloudMovesRoot,
  CloudMovesSettings,
} from "./cloud-moves";
import { fakeApi, move, snapshot } from "./test-support";
import { closeCloudMoves, useCloudMovesStore } from "@renderer/stores/cloud-moves";
const mocks = vi.hoisted(() => ({
  enabled: true,
  launch: "local",
  projectId: "project",
  toast: vi.fn(),
}));
vi.mock("@renderer/lib/toast", () => ({ toastError: mocks.toast }));
vi.mock("@renderer/components/hosts/use-hosts", () => ({ useCloudEnabled: () => mocks.enabled }));
vi.mock("@renderer/stores/launch", () => ({ launchStore: () => mocks.launch }));
vi.mock("@renderer/stores/projects", () => ({
  useProjectsStore: (select: (state: { selectedProjectId: string }) => unknown) =>
    select({ selectedProjectId: mocks.projectId }),
}));
vi.mock("@renderer/components/settings/panes/account-pane", () => ({
  AccountPane: () => <p>Sign in</p>,
}));
vi.mock("@renderer/components/ui/sidebar", () => ({
  SidebarMenu: ({ children }: PropsWithChildren) => <div>{children}</div>,
  SidebarMenuItem: ({ children }: PropsWithChildren) => <div>{children}</div>,
  SidebarMenuButton: ({
    children,
    onClick,
    "aria-label": label,
  }: PropsWithChildren<{ onClick(): void; "aria-label": string }>) => (
    <button onClick={onClick} aria-label={label}>
      {children}
    </button>
  ),
}));
let root: Root;
let container: HTMLElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.enabled = true;
  mocks.launch = "local";
  mocks.projectId = "project";
  useCloudMovesStore.setState({ snapshot: null, api: null, error: null, sheet: null });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(children: React.ReactNode) {
  await act(async () => root.render(children));
}

describe("move entry and persistent surfaces", () => {
  it("uses the latest move of a project, not an obsolete read-only or failed attempt", async () => {
    useCloudMovesStore.setState({
      snapshot: {
        ...snapshot,
        moves: [
          { ...move, state: "problem" },
          { ...move, moveId: "newer", state: "returned", localReadOnly: false },
        ],
      },
    });
    await render(
      <>
        <CloudMoveRailRow />
        <CloudMoveReadOnlyBanner />
      </>,
    );
    expect(container.textContent).toBe("");
  });
  it.each(["returned", "finished", "rolled-back"] as const)(
    "does not leave a settled %s move nagging in the rail",
    async (state) => {
      useCloudMovesStore.setState({
        snapshot: { ...snapshot, moves: [{ ...move, state, localReadOnly: false }] },
      });
      await render(<CloudMoveRailRow />);
      expect(container.textContent).toBe("");
    },
  );
  it("paused copies expose Resume and a cancel confirmation, with failures visible", async () => {
    const api = fakeApi();
    useCloudMovesStore.setState({
      api,
      snapshot: {
        ...snapshot,
        moves: [
          { ...move, state: "waiting", message: "Move paused.", actions: ["resume", "cancel"] },
        ],
      },
    });
    await render(<CloudMoveReadOnlyBanner />);
    expect(container.textContent).toContain("Move paused");
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((item) => item.textContent === "Resume")!
        .click(),
    );
    expect(api.command).toHaveBeenCalledWith({ moveId: "move", action: "resume" });
    api.command.mockRejectedValueOnce(new Error("Sign in as the person who started the move."));
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((item) => item.textContent === "Resume")!
        .click(),
    );
    expect(mocks.toast).toHaveBeenCalledWith("Sign in as the person who started the move.");
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((item) => item.textContent === "Cancel…")!
        .click(),
    );
    expect(useCloudMovesStore.getState().sheet).toEqual(
      expect.objectContaining({ kind: "progress", cancelMoveId: "move" }),
    );
  });
  it("flag off has no read, rail row or banner even with journal facts present", async () => {
    const api = fakeApi();
    mocks.enabled = false;
    useCloudMovesStore.setState({ snapshot: { ...snapshot, moves: [move] } });
    await render(
      <>
        <CloudMovesRoot api={api} />
        <CloudMoveRailRow />
        <CloudMoveReadOnlyBanner />
      </>,
    );
    expect(container.textContent).toBe("");
    expect(api.snapshot).not.toHaveBeenCalled();
    expect(api.onChanged).not.toHaveBeenCalled();
  });
  it("unmoved projects get no banner or progress row", async () => {
    useCloudMovesStore.setState({ snapshot });
    await render(
      <>
        <CloudMoveRailRow />
        <CloudMoveReadOnlyBanner />
      </>,
    );
    expect(container.textContent).toBe("");
  });
  it("Settings opens Move all; closing the sheet keeps the persisted rail row, which reopens it", async () => {
    useCloudMovesStore.setState({ snapshot: { ...snapshot, moves: [move] } });
    await render(
      <>
        <CloudMovesSettings />
        <CloudMoveRailRow />
      </>,
    );
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((item) => item.textContent === "Move all projects…")!
        .click(),
    );
    expect(useCloudMovesStore.getState().sheet).toEqual(
      expect.objectContaining({ kind: "prepare" }),
    );
    await act(async () => closeCloudMoves());
    expect(container.textContent).toContain("Atlas · Moving");
    await act(async () =>
      (
        container.querySelector('[aria-label="Move to Volli Cloud progress"]') as HTMLElement
      ).click(),
    );
    expect(useCloudMovesStore.getState().sheet).toEqual(
      expect.objectContaining({ kind: "progress", queueId: "queue" }),
    );
  });
  it("frozen and archived local copies name their move; cloud launches never show a local read-only banner", async () => {
    useCloudMovesStore.setState({ snapshot: { ...snapshot, moves: [move] } });
    await render(<CloudMoveReadOnlyBanner />);
    expect(container.textContent).toContain("read-only while it moves");
    await act(async () =>
      useCloudMovesStore.setState({
        snapshot: {
          ...snapshot,
          moves: [{ ...move, state: "finished", confirmedAt: 1793000000000 }],
        },
      }),
    );
    expect(container.textContent).toContain("Moved to Volli Cloud (My team)");
    mocks.launch = "cloud";
    await render(<CloudMoveReadOnlyBanner />);
    expect(container.textContent).toBe("");
  });
});
