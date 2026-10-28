// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  SessionShare,
  SessionShareDialog,
  SessionTeamHeader,
  SessionTeamMark,
} from "./session-team";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { noteProjectTeam, useCloudTeamStore } from "@renderer/lib/cloud-team";
import { useCloudWorkspaceStore } from "@renderer/stores/cloud-board/workspace";

const mocks = vi.hoisted(() => ({ share: vi.fn(), error: vi.fn(), writable: true }));
vi.mock("@renderer/lib/cloud-team", async (original) => ({
  ...(await original<typeof import("@renderer/lib/cloud-team")>()),
  shareWithWorkspace: mocks.share,
}));
vi.mock("@renderer/components/hosts/use-hosts", () => ({ useCanWrite: () => mocks.writable }));
vi.mock("@renderer/lib/toast", () => ({ toastError: mocks.error }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.writable = true;
  mocks.share.mockReset();
  mocks.error.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  useCloudTeamStore.setState({
    viewerUserId: "ana",
    people: [{ userId: "ana", displayName: "Ana Li", status: "active" }],
    shareAll: false,
  });
  noteProjectTeam("p", [
    { id: "s", ownerUserId: "ana", role: "project", visibility: "private", turnActive: false },
  ]);
  useCloudWorkspaceStore.setState({ workspace: { id: "w", name: "Acme" } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useCloudTeamStore.setState({
    viewerUserId: null,
    people: [],
    sessions: {},
    byProject: {},
    shareAll: false,
  });
  useCloudWorkspaceStore.setState({ workspace: null });
  vi.unstubAllGlobals();
});
const button = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('button,[role="menuitem"]')].find(
    (node) => node.textContent === name || node.getAttribute("aria-label") === name,
  )!;
async function menu() {
  await act(async () =>
    root.render(
      <>
        <SessionTeamHeader sessionId="s" projectId="p" />
        <SessionShareDialog />
      </>,
    ),
  );
  const trigger = button("Session sharing");
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  const item = button("Share with workspace…");
  expect(item).toBeTruthy();
  await act(async () => item.click());
}

it("marks private and shared Sessions, including policy visibility and owner initials", async () => {
  await act(async () => root.render(<SessionTeamMark sessionId="s" />));
  expect(container.querySelector('[aria-label="Private"]')).not.toBeNull();
  await act(async () => useCloudTeamStore.setState({ shareAll: true, viewerUserId: "ben" }));
  expect(
    container.querySelector('[aria-label="Visible to the workspace (admin setting)"]'),
  ).not.toBeNull();
  expect(container.querySelector('[aria-label="Owner: Ana Li"]')?.textContent).toBe("AL");
  await act(async () =>
    noteProjectTeam("p", [
      { id: "s", ownerUserId: "ana", role: "project", visibility: "shared", turnActive: false },
    ]),
  );
  expect(container.querySelector('[aria-label="Shared with workspace"]')).not.toBeNull();
});

it("confirms the irreversible boundary before Share, cancels without a write, and surfaces refusals", async () => {
  await menu();
  expect(document.body.textContent).toContain(
    "Everyone in Acme can read this chat and its subagents. You can’t make it private again.",
  );
  expect(mocks.share).not.toHaveBeenCalled();
  await act(async () => button("Cancel").click());
  expect(mocks.share).not.toHaveBeenCalled();
  await menu();
  mocks.share.mockRejectedValueOnce(new Error("not_owner"));
  await act(async () => button("Share").click());
  expect(mocks.error).toHaveBeenCalledWith("not_owner");
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  mocks.share.mockResolvedValueOnce(undefined);
  await act(async () => button("Share").click());
  expect(mocks.share).toHaveBeenCalledWith("s");
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
});

it("keeps the row-context Share confirm mounted after selection", async () => {
  await act(async () =>
    root.render(
      <>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button>Session row</button>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <SessionShare sessionId="s" projectId="p" />
          </ContextMenuContent>
        </ContextMenu>
        <SessionShareDialog />
      </>,
    ),
  );
  await act(async () =>
    button("Session row").dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }),
    ),
  );
  await act(async () => button("Share with workspace…").click());
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  mocks.share.mockResolvedValueOnce(undefined);
  await act(async () => button("Share").click());
  expect(mocks.share).toHaveBeenCalledWith("s");
});

it("never offers Share to a teammate or for a subagent", async () => {
  useCloudTeamStore.setState({ viewerUserId: "ben" });
  await act(async () => root.render(<SessionTeamHeader sessionId="s" projectId="p" />));
  expect(button("Session sharing")).toBeUndefined();
  await act(async () => {
    useCloudTeamStore.setState({ viewerUserId: "ana" });
    noteProjectTeam("p", [
      { id: "s", ownerUserId: "ana", role: "subagent", visibility: "private", turnActive: false },
    ]);
  });
  expect(button("Session sharing")).toBeUndefined();
});
