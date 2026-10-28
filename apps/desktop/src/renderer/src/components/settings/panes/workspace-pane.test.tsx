// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { MemberRole } from "@volli/shared/cloud";
import type { CloudSession } from "@renderer/lib/cloud-client";
import { toastError } from "@renderer/lib/toast";
import { NOT_CONNECTED } from "@renderer/lib/cloud-board-api";
import { CLOUD_READ_ONLY } from "@renderer/stores/cloud-board/source";
import { fakeCloud, refusal } from "@renderer/stores/cloud-board/fake-cloud.test-support";
import { useCloudWorkspaceStore } from "@renderer/stores/cloud-board/workspace";
import { INITIAL_CLOUD_LINK_INPUT, useCloudLinkInputs } from "@renderer/stores/cloud-link";
import { WorkspacePane } from "./workspace-pane";
import { useWorkspace, type Member, type PendingInvite } from "./use-workspace";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const args = { workspaceId: "w1" };
const owner: Member = {
  memberId: "m1",
  userId: "u1",
  displayName: "Dana",
  email: "dana@example.com",
  avatarKey: null,
  role: "owner",
  status: "active",
  billingTier: "free",
  joinedAt: 1,
  suspendedAt: null,
};
const teammate: Member = {
  ...owner,
  memberId: "m2",
  userId: "u2",
  displayName: "Robin",
  email: "robin@example.com",
  role: "member",
  joinedAt: 2,
};
const invite: PendingInvite = {
  inviteId: "i1",
  email: "new@example.com",
  role: "member",
  invitedByUserId: "u1",
  invitedByName: "Dana",
  createdAt: 1,
  expiresAt: 12345,
};
function harness() {
  const cloud = fakeCloud();
  const connections = new Set<() => void>();
  Object.assign(cloud.session.client, {
    subscribeToConnectionState: (fn: () => void) => {
      connections.add(fn);
      return () => connections.delete(fn);
    },
  });
  let session: CloudSession | null = cloud.session;
  const followers = new Set<(s: CloudSession | null) => void>();
  const props = {
    follow: (fn: (s: CloudSession | null) => void) => {
      followers.add(fn);
      fn(session);
      return () => followers.delete(fn);
    },
    current: () => session,
    select: vi.fn(async (_id: string) => {}),
  };
  const answer = (name: string, value: unknown) =>
    act(() =>
      cloud.answer(
        name,
        name === "accounts:viewer" || name === "invites:listMine" ? {} : args,
        value,
      ),
    );
  const ready = (role: MemberRole = "owner", rows: Member[] = [owner, teammate]) => {
    answer("workspaces:get", { workspaceId: "w1", name: "Acme", role });
    answer("accounts:viewer", { userId: "u1" });
    answer(
      "members:list",
      rows.map((m) => (m.userId === "u1" ? { ...m, role } : m)),
    );
    answer("workspaces:policy", { shareAll: false, whoCanInvite: "members", revision: 7 });
    answer("invites:list", []);
    answer("invites:listMine", []);
  };
  return {
    cloud,
    props,
    answer,
    ready,
    connections,
    followers,
    offline: () =>
      act(() => {
        cloud.connected = false;
        for (const fn of connections) fn();
      }),
    close: () =>
      act(() => {
        session = null;
        for (const fn of followers) fn(null);
      }),
  };
}
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  useCloudWorkspaceStore.setState({ workspace: { id: "w1", name: "Acme" } });
  useCloudLinkInputs.setState({ input: { ...INITIAL_CLOUD_LINK_INPUT } });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.clearAllMocks();
  useCloudWorkspaceStore.setState({ workspace: null });
});
const text = () => document.body.textContent ?? "";
const button = (label: string, scope: ParentNode = document): HTMLButtonElement => {
  const node = [...scope.querySelectorAll("button")].find(
    (n) => n.textContent?.trim() === label || n.getAttribute("aria-label") === label,
  );
  if (!node) throw new Error(`No button ${label}: ${text()}`);
  return node;
};
async function click(label: string, scope?: ParentNode) {
  await act(async () => button(label, scope).click());
}
async function type(label: string, value: string) {
  const input =
    document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`) ??
    document.querySelector<HTMLInputElement>(`#${label}`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}
async function menu(name: string, choice: string) {
  await act(async () =>
    button(`More for ${name}`).dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
    ),
  );
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (n) => n.textContent?.trim() === choice,
  );
  if (!item) throw new Error(`No menu item ${choice}: ${text()}`);
  await act(async () => item.click());
}
async function resolve(h: ReturnType<typeof harness>, result: unknown) {
  await act(async () => h.cloud.mutations.at(-1)!.resolve(result));
}
async function reject(
  h: ReturnType<typeof harness>,
  code = "forbidden",
  message = "Your role does not allow this.",
) {
  await act(async () => h.cloud.mutations.at(-1)!.reject(refusal(code, message)));
}
const mount = (h = harness()) => {
  act(() => root.render(<WorkspacePane {...h.props} />));
  return h;
};

describe("Workspace sections", () => {
  it("loads, then lists the Workspace, your role, members and policy without empty invite sections", () => {
    const h = mount();
    expect(text()).toContain("Loading members…");
    h.ready();
    expect(document.querySelector<HTMLInputElement>("#workspace-name")?.value).toBe("Acme");
    for (const label of ["Your role", "Dana", "Robin", "Make everything shared", "Who can invite"])
      expect(text()).toContain(label);
    expect(text()).not.toContain("Invites");
    expect(text()).not.toContain("Invitations to you");
    expect(button("Leave…").disabled).toBe(true);
    expect(text()).toContain("Make someone else an owner");
  });
  it("shows just you and Invite, and no suspend UI", () => {
    const h = mount();
    h.ready("owner", [owner]);
    expect(text()).toContain("Just you so far.");
    expect(button("Invite").disabled).toBe(false);
    expect(text()).not.toContain("Suspend");
  });
  it("renames on blur using the backend-normalized value and shows errors inline", async () => {
    const h = mount();
    h.ready();
    const input = await type("workspace-name", "  Team  ");
    await act(async () => {
      input.focus();
      input.blur();
    });
    expect(h.cloud.mutations[0]).toMatchObject({
      name: "workspaces:rename",
      args: { ...args, name: "  Team  " },
    });
    await resolve(h, { name: "Team" });
    expect(input.value).toBe("Team");
    await type("workspace-name", "Other");
    await act(async () => {
      input.focus();
      input.blur();
    });
    await reject(h);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Your role does not allow this.",
    );
  });
  it("allows leave only when another active owner remains, and confirms once", async () => {
    const h = mount();
    h.ready("owner", [owner, { ...teammate, role: "owner" }]);
    await click("Leave…");
    expect(h.cloud.mutations).toHaveLength(0);
    await click("Leave");
    expect(h.cloud.mutations[0]).toMatchObject({ name: "members:leave", args });
    await resolve(h, {});
  });
  it("changes roles and removes after one confirm, surfacing last-owner refusals", async () => {
    const h = mount();
    h.ready();
    await menu("Robin", "Admin");
    expect(h.cloud.mutations[0]).toMatchObject({
      name: "members:setRole",
      args: { ...args, userId: "u2", role: "admin" },
    });
    await reject(h, "last_owner", "A workspace needs an owner.");
    expect(toastError).toHaveBeenCalledWith("A workspace needs an owner.");
    await menu("Robin", "Remove…");
    expect(text()).toContain("Their shared work stays; their private chats are hidden.");
    expect(h.cloud.mutations).toHaveLength(1);
    await click("Remove");
    expect(h.cloud.mutations[1]).toMatchObject({
      name: "members:remove",
      args: { ...args, userId: "u2" },
    });
    await resolve(h, {});
  });
  it("admin cannot touch owners; members see sharing read-only and may invite members only", async () => {
    const h = mount();
    h.ready("admin", [owner, { ...teammate, role: "owner" }]);
    expect(document.querySelector('[aria-label="More for Robin"]')).toBeNull();
    h.ready("member");
    expect(document.querySelector('[aria-label="More for Robin"]')).toBeNull();
    expect(document.querySelector('[role="switch"]')?.hasAttribute("disabled")).toBe(true);
    expect(document.querySelector("#workspace-name")).toBeNull();
    await click("Invite");
    const roles = document.querySelector('[aria-label="Invite role"]')!;
    expect(roles.textContent).toBe("Member");
  });
  it("uses the shared whoCanInvite policy and sender rule", () => {
    const h = mount();
    h.ready("member");
    h.answer("workspaces:policy", { shareAll: false, whoCanInvite: "admins", revision: 8 });
    expect([...document.querySelectorAll("button")].some((n) => n.textContent === "Invite")).toBe(
      false,
    );
    h.answer("invites:list", [invite, { ...invite, inviteId: "i2", invitedByUserId: "u2" }]);
    expect(
      [...document.querySelectorAll("button")].filter((n) => n.textContent === "Revoke"),
    ).toHaveLength(1);
    expect([...document.querySelectorAll("button")].some((n) => n.textContent === "New code")).toBe(
      false,
    );
  });
  it("writes each sharing control with the revision, without optimistic success", async () => {
    const h = mount();
    h.ready();
    await act(async () => (document.querySelector('[role="switch"]') as HTMLElement).click());
    expect(h.cloud.mutations[0]).toMatchObject({
      name: "workspaces:setPolicy",
      args: { ...args, shareAll: true, expectedRevision: 7 },
    });
    await reject(h, "revision_conflict", "The policy changed since you loaded it.");
    expect(toastError).toHaveBeenCalledWith("The policy changed since you loaded it.");
    expect(document.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
    await click("Admins");
    expect(h.cloud.mutations[1]).toMatchObject({
      args: { ...args, whoCanInvite: "admins", expectedRevision: 7 },
    });
    await resolve(h, {});
  });
});

describe("Invitations", () => {
  it("shows only preview verdicts actually returned by the API", () => {
    const h = mount();
    h.ready();
    h.answer("invites:list", [invite]);
    expect(text()).not.toContain("They need preview access");
    h.answer("invites:list", [{ ...invite, preview: "needs_access" }]);
    expect(text()).toContain("They need preview access from Volli first");
    h.answer("invites:list", [{ ...invite, preview: "future_verdict" }]);
    expect(text()).not.toContain("They need preview access");
    expect(text()).not.toContain("They can join now");
    h.answer("invites:list", [{ ...invite, preview: "sponsored" }]);
    expect(text()).toContain("They can join now");
  });
  it("distinguishes a completed Join from a failed Workspace navigation", async () => {
    const h = mount();
    h.ready();
    h.answer("invites:listMine", [
      { inviteId: "mine", workspaceName: "Team", invitedByName: "Robin", role: "member" },
    ]);
    h.props.select.mockRejectedValueOnce(new Error("Connection lost"));
    await click("Join");
    await resolve(h, { workspaceId: "w2" });
    expect(toastError).toHaveBeenCalledWith(
      "Joined the Workspace, but couldn’t open it: Connection lost",
    );
  });
  it("creates email invites, reports preview accurately and copies only on an explicit press", async () => {
    const h = mount();
    h.ready();
    const writeText = vi.fn(async (_value: string) => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await click("Invite");
    expect(text()).toContain("People you invite see every project here");
    await type("invite-email", "new@example.com");
    await click("Admin", document.querySelector('[aria-label="Invite role"]')!);
    await click("Create invite");
    expect(h.cloud.mutations[0]).toMatchObject({
      name: "invites:create",
      args: { ...args, email: "new@example.com", role: "admin" },
    });
    await resolve(h, { inviteId: "i1", token: "once-only-secret", preview: "already_granted" });
    expect(text()).toContain("They can join now");
    expect(text()).not.toContain("once-only-secret");
    expect(writeText).not.toHaveBeenCalled();
    await click("Copy invite");
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("sign in with new@example.com"));
    expect(text()).toContain("Copied");
    await click("Close");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it("creates a code, keeps it only in the dialog, and reports clipboard errors", async () => {
    const h = mount();
    h.ready();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn(async () => {
          throw new Error("Clipboard blocked");
        }),
      },
    });
    await click("Invite");
    await click("Code");
    await click("Create invite");
    expect(h.cloud.mutations[0]).toMatchObject({ args: { ...args, email: null, role: "member" } });
    await resolve(h, { inviteId: "i1", token: "code-only-once" });
    expect(text()).not.toContain("They need preview access from Volli first");
    expect(text()).not.toContain("They can join now");
    expect(text()).toContain("Workspace menu → Join a workspace…");
    // New people redeem it by pasting it into the sign-in pane's Invite code field.
    expect(text()).toContain("paste this code into Invite code, and sign in");
    expect(text()).toContain("Single-use code: code-only-once");
    expect(document.querySelector<HTMLInputElement>('[aria-label="Invite code"]')?.value).toBe(
      "code-only-once",
    );
    await click("Copy invite");
    expect(toastError).toHaveBeenCalledWith("Clipboard blocked");
    expect(text()).not.toContain("Copied");
    await click("Close");
    expect(text()).not.toContain("code-only-once");
  });
  it("shows failed invite creation, preserving the form for recovery", async () => {
    const h = mount();
    h.ready();
    await click("Invite");
    await type("invite-email", "new@example.com");
    await click("Create invite");
    await reject(h, "already_invited", "Someone else has already invited this address.");
    expect(toastError).toHaveBeenCalledWith("Someone else has already invited this address.");
    expect(document.querySelector<HTMLInputElement>("#invite-email")?.value).toBe(
      "new@example.com",
    );
  });
  it("reissues an email atomically, but revokes a code before creating its replacement", async () => {
    const h = mount();
    h.ready();
    h.answer("invites:list", [invite]);
    await click("New code");
    expect(h.cloud.mutations[0]).toMatchObject({
      name: "invites:create",
      args: { ...args, email: invite.email, role: "member" },
    });
    await resolve(h, { token: "email-token" });
    await click("Close");
    h.answer("invites:list", [{ ...invite, email: null }]);
    await click("New code");
    expect(h.cloud.mutations[1]).toMatchObject({
      name: "invites:revoke",
      args: { inviteId: "i1" },
    });
    await resolve(h, {});
    expect(h.cloud.mutations[2]).toMatchObject({
      name: "invites:create",
      args: { ...args, email: null, role: "member" },
    });
    await resolve(h, { token: "new-token", preview: "sponsored" });
    expect(text()).toContain("They can join now");
  });
  it("does not create a replacement when revocation fails; Revoke errors are also surfaced", async () => {
    const h = mount();
    h.ready();
    h.answer("invites:list", [{ ...invite, email: null }]);
    await click("New code");
    await reject(h);
    expect(h.cloud.mutations).toHaveLength(1);
    await click("Revoke");
    expect(h.cloud.mutations[1]).toMatchObject({
      name: "invites:revoke",
      args: { inviteId: "i1" },
    });
    await resolve(h, {});
  });
  it("joins an addressed invitation then opens the accepted Workspace", async () => {
    const h = mount();
    h.ready();
    h.answer("invites:listMine", [
      { inviteId: "mine", workspaceName: "Team", invitedByName: "Robin", role: "member" },
    ]);
    expect(text()).toContain("Invitations to you");
    await click("Join");
    expect(h.cloud.mutations[0]).toMatchObject({
      name: "invites:accept",
      args: { inviteId: "mine" },
    });
    expect(h.props.select).not.toHaveBeenCalled();
    await resolve(h, { workspaceId: "w2" });
    expect(h.props.select).toHaveBeenCalledWith("w2");
  });
  it.each([
    "invite_expired",
    "invite_invalid",
    "invite_email_mismatch",
    "suspended",
    "preview_waitlisted",
  ])("surfaces %s and does not switch", async (code) => {
    const h = mount();
    h.ready();
    h.answer("invites:listMine", [
      { inviteId: "mine", workspaceName: "Team", invitedByName: "Robin", role: "member" },
    ]);
    await click("Join");
    await reject(h, code, `Refused: ${code}`);
    expect(toastError).toHaveBeenCalledWith(`Refused: ${code}`);
    expect(h.props.select).not.toHaveBeenCalled();
  });
});

describe("Read failures, offline and scope changes", () => {
  it("shows read errors with Retry and resubscribes all sections", async () => {
    const h = mount();
    h.ready();
    act(() => h.cloud.fail("members:list", args, refusal("forbidden", "Access changed")));
    expect(text()).toContain("Access changed");
    await click("Retry");
    expect(h.cloud.watchers("members:list", args)).toBe(1);
    h.answer("members:list", [owner]);
    expect(text()).toContain("Just you so far.");
  });
  it("retains live answers read-only offline; a cold offline pane shows an Empty", () => {
    const h = mount();
    h.ready();
    h.offline();
    expect(text()).toContain("Robin");
    expect(text()).toContain("Read-only");
    expect(button("Invite").disabled).toBe(true);
    expect(button("More for Robin").disabled).toBe(true);
    h.close();
    expect(text()).not.toContain("Robin");
    expect(text()).toContain("Volli Cloud is offline.");
  });
  it("is read-only over an offline board snapshot, even with a connected socket", () => {
    const h = mount();
    h.ready();
    act(() => useCloudLinkInputs.getState().update({ snapshotAt: 42 }));
    expect(button("Invite").disabled).toBe(true);
  });
  it("cleans up watches and clears the old Workspace when selection changes", async () => {
    const h = mount();
    h.ready();
    await click("Invite");
    act(() => useCloudWorkspaceStore.setState({ workspace: { id: "w2", name: "Second" } }));
    expect(text()).not.toContain("Robin");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(h.cloud.watchers("members:list", args)).toBe(0);
    expect(h.cloud.watchers("members:list", { workspaceId: "w2" })).toBe(1);
  });
  it("keeps invitations reachable with no selected Workspace", () => {
    const h = mount();
    h.ready();
    act(() => useCloudWorkspaceStore.setState({ workspace: null }));
    h.answer("invites:listMine", [
      { inviteId: "mine", workspaceName: "Team", invitedByName: "Robin", role: "member" },
    ]);
    expect(text()).toContain("No Workspace selected.");
    expect(button("Join")).toBeDefined();
    expect(text()).not.toContain("Who can invite");
  });
  it("guards commands at invocation, not just through disabled buttons", async () => {
    const h = harness();
    let state!: ReturnType<typeof useWorkspace>;
    function Probe() {
      state = useWorkspace(h.props);
      return null;
    }
    act(() => root.render(<Probe />));
    h.offline();
    await expect(state.commands.create(null, "member")).rejects.toThrow(NOT_CONNECTED);
    expect(h.cloud.mutations).toHaveLength(0);
    h.cloud.connected = true;
    act(() => useCloudLinkInputs.getState().update({ snapshotAt: 42 }));
    await expect(state.commands.setRole("u2", "admin")).rejects.toThrow(CLOUD_READ_ONLY);
    expect(h.cloud.mutations).toHaveLength(0);
    act(() => root.unmount());
    root = createRoot(container);
    expect(h.followers.size).toBe(0);
    expect(h.connections.size).toBe(0);
    expect(h.cloud.watchers("members:list", args)).toBe(0);
  });
});
