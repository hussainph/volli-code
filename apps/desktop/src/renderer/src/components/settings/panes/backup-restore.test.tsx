// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ProfileRestoreStatus } from "@volli/shared";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { BackupRestore } from "./backup-restore";
const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  choose: vi.fn(),
  directory: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
  restart: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@renderer/lib/session-rpc-ipc-link", () => ({
  sessionRpcClient: () => ({
    backups: {
      restoreStatus: { query: mocks.status },
      restoreChoose: { mutate: mocks.choose },
      restoreDirectory: { mutate: mocks.directory },
      restoreStart: { mutate: mocks.start },
      restoreCancel: { mutate: mocks.cancel },
      restoreRestart: { mutate: mocks.restart },
    },
  }),
}));
vi.mock("@renderer/lib/toast", () => ({ toastError: mocks.toast }));
const idle: ProfileRestoreStatus = {
  revision: "r",
  phase: "idle",
  bundles: [
    {
      fileName: "bundle.tar.gz",
      createdAt: 1700000000000,
      sizeBytes: 1024,
      verification: "verified",
      keptForMove: true,
    },
  ],
  selectedFile: null,
  projects: [],
  checkpoints: 0,
  paused: false,
  problems: [],
  credentialsMessage: null,
  previousProfile: null,
};
let container: HTMLElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.status.mockResolvedValue(idle);
  mocks.directory.mockResolvedValue("/local/beta");
  mocks.restart.mockResolvedValue(null);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <BackupRestore />
      </TooltipProvider>,
    ),
  );
}
function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent?.trim() === label,
  );
  if (!found) throw new Error(`No button ${label}`);
  return found;
}
describe("Storage backup restore", () => {
  it("lists bundles and asks for each directory before staging; shows credentials and restarts", async () => {
    const mapped: ProfileRestoreStatus = {
      ...idle,
      phase: "mapping",
      selectedFile: "bundle.tar.gz",
      projects: [
        { id: "a", name: "Alpha", directory: "/local/alpha" },
        { id: "b", name: "Beta", directory: null },
      ],
    };
    mocks.choose.mockResolvedValue(mapped);
    mocks.start.mockResolvedValue({
      ...mapped,
      revision: "next",
      phase: "ready",
      credentialsMessage: "Backups never carry credentials.",
      previousProfile: "/profile/.volli-replaced-123",
    });
    await mount();
    expect(container.textContent).toContain("Verified");
    expect(container.textContent).toContain("Kept for move");
    expect(container.textContent).toContain("1.0 KB");
    await act(async () => button("Restore bundle.tar.gz").click());
    expect(mocks.choose).toHaveBeenCalledWith({ fileName: "bundle.tar.gz" });
    expect(document.body.textContent).toContain("/local/alpha");
    expect(button("Prepare restore").disabled).toBe(true);
    await act(async () => button("Directory for Beta").click());
    expect(button("Prepare restore").disabled).toBe(false);
    await act(async () => button("Prepare restore").click());
    expect(mocks.start).toHaveBeenCalledWith({
      expectedRevision: "r",
      projectPaths: { a: "/local/alpha", b: "/local/beta" },
    });
    expect(document.body.textContent).toContain("Backups never carry credentials.");
    expect(document.body.textContent).toContain("Previous profile backup");
    await act(async () => button("Restart and restore").click());
    expect(mocks.restart).toHaveBeenCalledWith({ expectedRevision: "next" });
  });
  it("picks a file, shows named problems, and reports failed mutations", async () => {
    mocks.choose.mockResolvedValue({
      ...idle,
      phase: "failed",
      problems: [{ kind: "archive", message: "Bundle is not a gzip archive" }],
    });
    await mount();
    await act(async () => button("Restore…").click());
    expect(mocks.choose).toHaveBeenCalledWith({});
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "archive: Bundle is not a gzip archive",
    );
    mocks.choose.mockRejectedValue(new Error("file unavailable"));
    await act(async () => button("Choose backup…").click());
    expect(mocks.toast).toHaveBeenCalledWith("Couldn't restore: file unavailable");
  });
  it("reattaches to progress and cancels through the revision-fenced host command", async () => {
    mocks.status.mockResolvedValue({ ...idle, phase: "staging", checkpoints: 12 });
    mocks.cancel.mockResolvedValue({ ...idle, phase: "cancelled" });
    await mount();
    await act(async () => button("Restore…").click());
    expect(document.querySelector('progress[aria-label="Restore progress"]')).toBeTruthy();
    expect(document.body.textContent).toContain("12 checkpoints");
    await act(async () => button("Cancel restore").click());
    expect(mocks.cancel).toHaveBeenCalledWith({ expectedRevision: "r" });
    expect(document.body.textContent).toContain("current profile is unchanged");
  });
  it("shows an unavailable local restore rather than an empty inventory", async () => {
    mocks.status.mockRejectedValue(new Error("Restart in local mode to restore a backup."));
    await mount();
    expect(button("Restore…").disabled).toBe(true);
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "Restart in local mode",
    );
  });
});
