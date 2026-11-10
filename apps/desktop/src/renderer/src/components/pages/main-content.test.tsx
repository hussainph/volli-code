// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { MainContent } from "./main-content";

const mocks = vi.hoisted(() => ({
  setSettingsOpen: vi.fn(),
  dismissEnvironmentFault: vi.fn(),
  retainEnvironmentFaultDismissals: vi.fn(),
  dismissReadinessNotice: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("@renderer/components/automations/automations-page", () => ({
  AutomationsPage: () => null,
}));
vi.mock("@renderer/components/home/home-surface", () => ({
  HomeSurface: () => <div>Project home</div>,
}));
vi.mock("@renderer/components/cloud-moves/cloud-moves", () => ({
  CloudMoveReadOnlyBanner: () => null,
}));
vi.mock("@renderer/components/settings/settings-panel", () => ({ SettingsPanel: () => null }));
vi.mock("@renderer/components/automations/automation-availability", () => ({
  AutomationsOnly: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@renderer/components/hosts/local-only", () => ({
  LocalOnly: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@renderer/hooks/use-active-nav", () => ({ useActiveNav: () => ["home", vi.fn()] }));
vi.mock("@renderer/hooks/use-add-project", () => ({ useAddProject: () => vi.fn() }));
vi.mock("@renderer/hooks/use-selected-project", () => ({
  useSelectedProject: () => ({ id: "project-a", name: "Acme", path: "/repo" }),
}));
vi.mock("@renderer/stores/projects", () => ({
  useProjectsStore: (select: (store: unknown) => unknown) =>
    select({ projects: [{ id: "project-a" }], pendingRemoteSelection: null }),
}));
vi.mock("@renderer/stores/ui", () => ({
  useUiStore: (select: (store: unknown) => unknown) =>
    select({
      ...mocks,
      settingsOpen: false,
      terminalFocusTarget: null,
      dismissedEnvironmentFaults: [],
    }),
}));
vi.mock("@renderer/stores/project-ui", () => ({
  useProjectUiStore: (select: (store: unknown) => unknown) =>
    select({
      byProject: {},
      dismissReadinessNotice: mocks.dismissReadinessNotice,
    }),
}));
vi.mock("@renderer/lib/toast", () => ({ toastError: mocks.toastError }));

let root: Root;
let host: HTMLDivElement;
let status: ReturnType<typeof vi.fn>;
let repair: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  status = vi.fn();
  repair = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("api", { cli: { status, repair } });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function measure(git: string | null, failedPath = false) {
  status.mockResolvedValue({
    ok: true,
    status: {
      environment: {
        loginPath: "/usr/bin",
        session: {
          path: "/volli/bin:/usr/bin",
          provenance: failedPath ? "probe-failed" : "adopted",
          interactiveProvenance: failedPath ? "probe-failed" : "already-complete",
          tools: { git, gh: null, node: null, npm: null, pnpm: null, yarn: null, bun: null },
          requiredTools: ["git", "node", "pnpm"],
          dependencies: "absent",
          installCommand: "pnpm install",
        },
        systemPathIssues: [],
      },
    },
  });
}

it("renders project home without any dependency installation offer or extra status read", async () => {
  measure("/usr/bin/git");
  await act(async () => root.render(<MainContent />));
  expect(host.textContent).toBe("Project home");
  expect(status).toHaveBeenCalledExactlyOnceWith({ cwd: "/repo" });
  expect(host.textContent).not.toContain("Dependencies aren't installed yet");
  expect(host.textContent).not.toContain("Run pnpm install");
  expect(host.textContent).not.toContain("Set a setup command");
});

it("keeps git onboarding review and dismissal actions", async () => {
  measure(null);
  await act(async () => root.render(<MainContent />));
  expect(host.textContent).toContain("Missing from the Session PATH: git");
  expect(host.textContent).not.toContain("node");
  expect(host.textContent).not.toContain("pnpm");
  const review = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Review details",
  )!;
  await act(async () => review.click());
  expect(mocks.setSettingsOpen).toHaveBeenCalledWith(true, "cli");
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Dismiss notice"]')!.click(),
  );
  expect(mocks.dismissReadinessNotice).toHaveBeenCalledWith("project-a", "readiness:project-a:git");
});

it.each(["refused", "rejected", "still-missing"])("surfaces a %s PATH repair", async (failure) => {
  measure(null, true);
  if (failure === "refused") repair.mockResolvedValue({ ok: false, error: "Repair refused" });
  if (failure === "rejected") repair.mockRejectedValue(new Error("Repair failed"));
  await act(async () => root.render(<MainContent />));
  const fix = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Fix now",
  )!;
  await act(async () => fix.click());
  expect(repair).toHaveBeenCalledOnce();
  expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(
    failure === "still-missing"
      ? "Volli still couldn't read your terminal's PATH"
      : `Couldn't repair the Session PATH: ${failure === "refused" ? "Repair refused" : "Repair failed"}`,
  );
  expect(host.textContent).toContain("Sessions can't find git.");
});
