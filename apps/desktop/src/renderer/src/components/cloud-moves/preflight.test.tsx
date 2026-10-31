// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { CloudMovePreflight, CloudMoveSnapshot } from "@volli/shared";
import { MovePreflight } from "./preflight";
import { fakeApi, preflight, snapshot } from "./test-support";
import { useCloudMovesStore } from "@renderer/stores/cloud-moves";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  select: vi.fn(),
  session: vi.fn(),
  ticket: vi.fn(),
  settings: vi.fn(),
}));
vi.mock("@renderer/lib/toast", () => ({ toastError: mocks.toast }));
vi.mock("@renderer/components/settings/panes/account-pane", () => ({
  AccountPane: () => <button>Continue with GitHub</button>,
}));
vi.mock("@renderer/stores/projects", () => ({
  useProjectsStore: { getState: () => ({ select: mocks.select }) },
}));
vi.mock("@renderer/stores/ui", () => ({
  useUiStore: {
    getState: () => ({ openSessionDetail: mocks.session, setSettingsOpen: mocks.settings }),
  },
}));
vi.mock("@renderer/stores/project-ui", () => ({
  useProjectUiStore: { getState: () => ({ openTicketView: mocks.ticket }) },
}));
let root: Root;
let container: HTMLElement;
let api: ReturnType<typeof fakeApi>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  api = fakeApi();
  useCloudMovesStore.setState({ sheet: null });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function mount(next: CloudMoveSnapshot = snapshot, projectIds?: string[]) {
  await act(async () =>
    root.render(
      <MovePreflight
        api={api}
        snapshot={next}
        {...(projectIds === undefined ? {} : { projectIds })}
      />,
    ),
  );
}
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing ${label}`);
  return found;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Move pre-flight", () => {
  it("shows counts, sizes, estimate, backup, exclusions, visibility and queue safety; dry run never starts a move", async () => {
    await mount();
    expect(container.textContent).toContain("12 tickets · 30 Sessions · 400 events");
    expect(container.textContent).toContain("2 attachments (2.0 KB)");
    expect(container.textContent).toContain("Transcripts 4.0 KB · Pi logs 8.0 KB");
    expect(container.textContent).toContain("About 3 min");
    expect(container.textContent).toContain("Total for 1 project · About 3 min");
    expect(container.textContent).toContain("/profile/backups");
    expect(container.textContent).toContain("Machine settings — Only used on this Mac");
    expect(container.textContent).toContain("Board and ad-hoc chats stay private");
    expect(container.textContent).toContain("Automations (2) — Kept paused");
    expect(container.textContent).toContain("Don’t install an older Volli build");
    expect(container.querySelector('[role="checkbox"][data-state="checked"]')).not.toBeNull();
    await click("Run a dry run only");
    expect(api.preflight).toHaveBeenCalledTimes(2);
    expect(api.start).not.toHaveBeenCalled();
    await click("Move");
    expect(api.start).toHaveBeenCalledWith({
      preflightId: "dry-run",
      workspaceId: "workspace",
      projectIds: ["project"],
      stopAtFirstProblem: true,
    });
    expect(useCloudMovesStore.getState().sheet?.kind).toBe("progress");
  });
  it("Move all excludes removed projects by default and sends only checked projects", async () => {
    api.preflight.mockResolvedValue({
      ...preflight,
      projects: [...preflight.projects, { ...preflight.projects[0]!, id: "second", name: "Comet" }],
    });
    await mount();
    expect(api.preflight).toHaveBeenCalledWith({ workspaceId: null, includeRemoved: false });
    await act(async () =>
      (container.querySelector('[aria-label="Move Comet"]') as HTMLElement).click(),
    );
    await click("Move");
    expect(api.start.mock.calls[0]?.[0].projectIds).toEqual(["project"]);
  });
  it("single-project entry binds its id; an idle blocker links to its Session and cannot move", async () => {
    api.preflight.mockResolvedValue({
      ...preflight,
      projects: [
        {
          ...preflight.projects[0]!,
          blockers: [{ message: "A Session is running.", sessionId: "session" }],
        },
      ],
    });
    await mount(snapshot, ["project"]);
    expect(api.preflight).toHaveBeenCalledWith({
      projectIds: ["project"],
      workspaceId: null,
      includeRemoved: false,
    });
    expect(container.textContent).not.toContain("Include removed projects");
    expect(button("Move").disabled).toBe(true);
    await click("Open Session");
    expect(mocks.select).toHaveBeenCalledWith("project");
    expect(mocks.session).toHaveBeenCalledWith("project", "session");
  });
  it("does not move without a sign-in, Workspace permission, disk space or any selected projects", async () => {
    await mount({ ...snapshot, account: null, workspaces: [], unavailable: "Sign in to move." });
    expect(container.textContent).toContain("Continue with GitHub");
    expect(button("Move").disabled).toBe(true);
    // Signing in keeps the dry run already answered; only a re-run asks again.
    await mount(snapshot);
    expect(api.preflight).toHaveBeenCalledOnce();
    api.preflight.mockResolvedValue({ ...preflight, disk: { requiredBytes: 20000, freeBytes: 1 } });
    await click("Run a dry run only");
    expect(button("Move").disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    api.preflight.mockResolvedValue({ ...preflight, projects: [] });
    await click("Run a dry run only");
    expect(button("Move").disabled).toBe(true);
    expect(container.textContent).toContain("No local projects");
  });
  it("keeps one dry run across a Workspace change and moves into the Workspace chosen last", async () => {
    const answer = deferred<CloudMovePreflight>();
    api.preflight.mockReturnValueOnce(answer.promise);
    const account = {
      ...snapshot,
      workspaces: [...snapshot.workspaces, { id: "another", name: "Another team", canMove: true }],
    };
    await mount(account);
    expect(button("Move").disabled).toBe(true);
    await act(async () => {
      const select = container.querySelector("select")!;
      select.value = "another";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(api.preflight).toHaveBeenCalledOnce();
    await act(async () => answer.resolve({ ...preflight, id: "the-dry-run" }));
    await click("Move");
    expect(api.start).toHaveBeenCalledWith(
      expect.objectContaining({ preflightId: "the-dry-run", workspaceId: "another" }),
    );
  });
  it("never restarts a running dry run when the sign-in or the Workspace list blips (VC-1029)", async () => {
    const answer = deferred<CloudMovePreflight>();
    api.preflight.mockReturnValueOnce(answer.promise);
    await mount();
    // What a long dry run sees: the sign-in briefly without its viewer, the
    // Workspace list emptied and reloaded, the same person back.
    for (const blip of [
      { ...snapshot, account: null },
      { ...snapshot, account: null, workspaces: [] },
      { ...snapshot, workspaces: [] },
      snapshot,
    ])
      await mount(blip);
    expect(api.preflight).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Checking projects…");
    await act(async () => answer.resolve(preflight));
    expect(container.textContent).not.toContain("Checking projects…");
    expect(button("Move").disabled).toBe(false);
  });
  it("shows the running dry run's project, phase and counts", async () => {
    api.preflight.mockReturnValueOnce(deferred<CloudMovePreflight>().promise);
    await mount({
      ...snapshot,
      preflight: {
        phase: "exporting",
        projectIndex: 3,
        projectCount: 8,
        projectName: "Volli",
        done: 41200,
        total: 98000,
        unit: "records",
        startedAt: 1,
      },
    });
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Project 3 of 8 · Volli · Exporting records · 41,200 of 98,000 records",
    );
  });
  it("shows read failures and mutation failures, retaining a retry", async () => {
    api.preflight.mockRejectedValueOnce(
      new Error("Wait for the running move to finish, then run the dry run again."),
    );
    await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Wait for the running move to finish, then run the dry run again.",
    );
    expect(container.textContent).not.toContain("private raw details");
    await click("Run a dry run only");
    api.start.mockRejectedValueOnce(new Error("Finish this project’s running Session first."));
    await click("Move");
    expect(mocks.toast).toHaveBeenCalledWith("Finish this project’s running Session first.");
    expect(button("Move").disabled).toBe(false);
  });
});
