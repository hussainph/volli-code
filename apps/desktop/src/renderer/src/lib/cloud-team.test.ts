import { afterEach, expect, it, vi } from "vite-plus/test";
import { fakeCloud } from "@renderer/stores/cloud-board/fake-cloud.test-support";
import { useCloudWorkspaceStore } from "@renderer/stores/cloud-board/workspace";
import { useCloudLinkInputs } from "@renderer/stores/cloud-link";
import {
  bindCloudTeam,
  noteProjectTeam,
  shareWithWorkspace,
  useCloudTeamStore,
} from "./cloud-team";
import type { CloudSession } from "./cloud-client";

const current = vi.hoisted(() => ({ session: null as CloudSession | null }));
vi.mock("./cloud-client", () => ({ cloudSession: () => current.session }));
let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  current.session = null;
  useCloudWorkspaceStore.setState({ workspace: null });
  useCloudTeamStore.setState({
    viewerUserId: null,
    people: [],
    shareAll: false,
    sessions: {},
    byProject: {},
  });
  vi.restoreAllMocks();
});

it("follows names and policy, keeps last live answers offline, clears on scope/client loss, and releases watchers", () => {
  const fake = fakeCloud();
  let follow!: (session: CloudSession | null) => void;
  useCloudWorkspaceStore.setState({ workspace: { id: "w", name: "Acme" } });
  stop = bindCloudTeam((listener) => {
    follow = listener;
    return () => {};
  });
  follow(fake.session);
  const args = { workspaceId: "w" };
  const directory = {
    viewerUserId: "ana",
    people: [{ userId: "ana", displayName: "Ana", status: "active" }],
  };
  fake.answer("members:people", args, directory);
  fake.answer("workspaces:policy", args, { shareAll: true });
  noteProjectTeam("p", [
    { id: "s", ownerUserId: "ana", visibility: "private", role: "project", turnActive: true },
  ]);
  expect(useCloudTeamStore.getState()).toMatchObject({
    ...directory,
    shareAll: true,
    sessions: { s: { ownerUserId: "ana" } },
  });
  fake.connected = false;
  expect(useCloudTeamStore.getState().people).toEqual(directory.people);
  useCloudWorkspaceStore.setState({ workspace: { id: "w2", name: "Other" } });
  expect(fake.watchers("members:people", args)).toBe(0);
  expect(useCloudTeamStore.getState()).toMatchObject({
    viewerUserId: null,
    people: [],
    sessions: {},
  });
  fake.fail("members:people", { workspaceId: "w2" }, new Error("not_a_member"));
  expect(useCloudTeamStore.getState().viewerUserId).toBeNull();
  follow(null);
  expect(fake.watchers("members:people", { workspaceId: "w2" })).toBe(0);
  stop();
  stop = undefined;
});

it("replaces a project's ownership rows and forgets vanished Sessions", () => {
  const row = {
    id: "s",
    ownerUserId: "ana",
    visibility: "private",
    role: "project",
    turnActive: false,
  } as const;
  noteProjectTeam("p", [row]);
  noteProjectTeam("p2", [{ ...row, id: "s2" }]);
  noteProjectTeam("p", []);
  expect(Object.keys(useCloudTeamStore.getState().sessions)).toEqual(["s2"]);
});

it("shares only through a connected live client and surfaces a backend refusal", async () => {
  await expect(shareWithWorkspace("s")).rejects.toThrow();
  const fake = fakeCloud();
  current.session = fake.session;
  useCloudLinkInputs.setState((state) => ({
    input: { ...state.input, online: true, snapshotAt: null },
  }));
  fake.connected = false;
  await expect(shareWithWorkspace("s")).rejects.toThrow();
  fake.connected = true;
  useCloudLinkInputs.setState((state) => ({ input: { ...state.input, snapshotAt: 1 } }));
  await expect(shareWithWorkspace("s")).rejects.toThrow();
  expect(fake.mutations).toHaveLength(0);
  useCloudLinkInputs.setState((state) => ({ input: { ...state.input, snapshotAt: null } }));
  const refused = shareWithWorkspace("s");
  fake.mutations[0]!.reject(new Error("not_owner"));
  await expect(refused).rejects.toThrow("not_owner");
  const accepted = shareWithWorkspace("s");
  expect(fake.mutations[1]).toMatchObject({
    name: "sessionVisibility:share",
    args: { sessionId: "s" },
  });
  fake.mutations[1]!.resolve({});
  await accepted;
});
