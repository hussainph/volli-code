import { afterEach, expect, it, vi } from "vite-plus/test";
import type { Project } from "@volli/shared";
import { LOCAL_LAUNCH } from "@volli/shared";
import { useProjectsStore } from "@renderer/stores/projects";
import { useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { adoptLaunch } from "@renderer/stores/launch";
import { followRunnerDraftTabs } from "./runner-picker-restore";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));
const originalProjects = useProjectsStore.getState();
const originalDrafts = useChatDraftsStore.getState();
const originalSessions = useChatSessionsStore.getState();
let stop = () => {};
afterEach(() => {
  stop();
  useProjectsStore.setState(originalProjects, true);
  useChatDraftsStore.setState(originalDrafts, true);
  useChatSessionsStore.setState(originalSessions, true);
  adoptLaunch(LOCAL_LAUNCH);
  vi.restoreAllMocks();
});
const scope = JSON.stringify(["https://example.convex.cloud", "person"]);
function draft(id: string, accountScope = scope) {
  useChatDraftsStore
    .getState()
    .openProvisional(id, { projectId: "project", ticketId: null, operationId: id, title: null });
  useChatDraftsStore.getState().freezeRunnerStart(id, {
    accountScope,
    intent: {
      clientRequestId: id,
      runnerId: "box",
      projectId: "project",
      ticketId: null,
      model: null,
      body: "{}",
    },
  });
}
const project: Project = {
  id: "project",
  name: "Project",
  path: "/scratch/project",
  ticketPrefix: "P",
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
};

it("restores pending current-account starts only when their project arrives, without resurrecting closed tabs", () => {
  adoptLaunch({ store: "cloud", backendUrl: "https://example.convex.cloud", userId: "person" });
  useChatDraftsStore.setState({ drafts: {} });
  useChatSessionsStore.setState({ openTabs: {} });
  useProjectsStore.setState({ projects: [] });
  draft("mine");
  draft("other", "another-account");
  stop = followRunnerDraftTabs();
  expect(useChatSessionsStore.getState().openTabs).toEqual({});
  useProjectsStore.setState({ projects: [project] });
  expect(useChatSessionsStore.getState().openTabs).toEqual({ project: ["mine"] });
  expect(useChatDraftsStore.getState().drafts.other).toBeDefined();
  useChatSessionsStore.getState().closeChatTab("project", "mine");
  useProjectsStore.setState({ projects: [{ ...project, name: "Renamed" }] });
  expect(useChatSessionsStore.getState().openTabs).toEqual({});
});

it("local restoration never discards or opens a pending cloud request", () => {
  adoptLaunch(LOCAL_LAUNCH);
  useChatDraftsStore.setState({ drafts: {} });
  useChatSessionsStore.setState({ openTabs: {} });
  draft("cloud");
  useChatSessionsStore
    .getState()
    .restoreProvisionalChatTabs(useChatDraftsStore.getState().drafts, new Set(), new Set());
  expect(useChatDraftsStore.getState().drafts.cloud).toBeDefined();
  expect(useChatSessionsStore.getState().openTabs).toEqual({});
});
