// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { ProfileBackupsSection } from "./profile-backups-section";
import type { ProfileBackupStatus } from "@volli/shared";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  run: vi.fn(),
  reveal: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@renderer/lib/session-rpc-ipc-link", () => ({
  sessionRpcClient: () => ({
    backups: {
      status: { query: mocks.status },
      run: { mutate: mocks.run },
      reveal: { mutate: mocks.reveal },
    },
  }),
}));
vi.mock("./backup-restore", () => ({ BackupRestore: () => null }));
vi.mock("@renderer/lib/toast", () => ({ toastError: mocks.toast }));
let root: Root;
let container: HTMLElement;
const idle: ProfileBackupStatus = {
  revision: "history-revision",
  running: false,
  lastBackup: null,
  notice: null,
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.status.mockResolvedValue(idle);
  mocks.run.mockResolvedValue(idle);
  mocks.reveal.mockResolvedValue(null);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <ProfileBackupsSection />
      </TooltipProvider>,
    ),
  );
}
function button(label: string) {
  const result = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
  );
  if (!result) throw new Error(`No ${label} button`);
  return result;
}
describe("Storage profile backups", () => {
  it("shows verified time and size; backup and Finder go through semantic commands", async () => {
    mocks.status.mockResolvedValue({
      ...idle,
      lastBackup: { createdAt: 1793000000000, sizeBytes: 1024 },
    });
    await mount();
    expect(container.textContent).toContain("1.0 KB");
    expect(container.textContent).toContain(new Date(1793000000000).toLocaleString());
    await act(async () => button("Back up now").click());
    expect(mocks.run).toHaveBeenCalledOnce();
    await act(async () => button("Show in Finder").click());
    expect(mocks.reveal).toHaveBeenCalledOnce();
  });
  it("shows skipped/failed attempts and disables backup while running", async () => {
    mocks.status.mockResolvedValue({
      ...idle,
      running: true,
      notice: "Backup paused during a profile migration or move.",
    });
    await mount();
    expect(button("Backing up…").disabled).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("paused");
  });
  it("keeps a skipped or failed manual backup visible", async () => {
    mocks.run.mockResolvedValue({
      ...idle,
      notice: "Backup skipped: not enough free disk space. Free disk space, then Back up now.",
    });
    await mount();
    await act(async () => button("Back up now").click());
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "not enough free disk space",
    );
  });
  it("reports unavailable history without pretending there is no backup", async () => {
    mocks.status.mockRejectedValueOnce(new Error("Backup history unavailable"));
    await mount();
    expect(container.textContent).toContain("Unavailable");
    expect(button("Back up now").disabled).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Backup history unavailable",
    );
  });
  it("reports mutation failures", async () => {
    await mount();
    mocks.run.mockRejectedValue(new Error("worker failed"));
    await act(async () => button("Back up now").click());
    expect(mocks.toast).toHaveBeenCalledWith("Couldn't back up: worker failed");
    mocks.reveal.mockRejectedValue(new Error("Finder failed"));
    await act(async () => button("Show in Finder").click());
    expect(mocks.toast).toHaveBeenCalledWith("Couldn't show backups: Finder failed");
  });
});
