// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { toast } from "sonner";
import type { CloudSession } from "@renderer/lib/cloud-client";
import { toastError } from "@renderer/lib/toast";
import { fakeCloud, refusal } from "@renderer/stores/cloud-board/fake-cloud.test-support";
import { useCloudWorkspaceStore } from "@renderer/stores/cloud-board/workspace";
import { INITIAL_CLOUD_LINK_INPUT, useCloudLinkInputs } from "@renderer/stores/cloud-link";
import { useUiStore } from "@renderer/stores/ui";
import { WorkspaceSwitcher } from "./workspace-switcher";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { dismiss: vi.fn() }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const rows = [
  { workspaceId: "w1", name: "Acme" },
  { workspaceId: "w2", name: "Other" },
];
const invitation = {
  inviteId: "i1",
  workspaceId: "w2",
  workspaceName: "Other",
  role: "member",
  invitedByName: "Robin",
  expiresAt: 9999999999999,
};
const valid = {
  status: "valid",
  workspaceId: "w2",
  workspaceName: "Other",
  role: "member",
  invitedByName: "Robin",
  email: null,
  expiresAt: 9999999999999,
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
  const props = {
    follow: (fn: (s: CloudSession | null) => void) => {
      fn(cloud.session);
      return () => {};
    },
    current: () => cloud.session,
    select: vi.fn(async (_id: string) => {}),
  };
  const answer = (name: string, value: unknown) => act(() => cloud.answer(name, {}, value));
  return {
    cloud,
    props,
    answer,
    offline: () =>
      act(() => {
        cloud.connected = false;
        for (const fn of connections) fn();
      }),
  };
}
let root: Root;
let container: HTMLDivElement;
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
  vi.clearAllMocks();
});
const text = () => document.body.textContent ?? "";
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (n) => n.textContent?.trim() === label || n.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`No button ${label}: ${text()}`);
  return found;
}
async function mount(h: ReturnType<typeof harness>) {
  await act(async () => root.render(<WorkspaceSwitcher {...h.props} />));
  h.answer("workspaces:listMine", rows);
  h.answer("invites:listMine", []);
}
async function openMenu() {
  await act(async () =>
    button(useCloudWorkspaceStore.getState().workspace?.name ?? "Workspaces").dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
    ),
  );
}
function item(label: string) {
  const found = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(
    (n) => n.textContent?.trim() === label,
  );
  if (!found) throw new Error(`No item ${label}: ${text()}`);
  return found;
}
async function choose(label: string) {
  await act(async () => item(label).click());
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function type(label: string, value: string) {
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Workspace switcher", () => {
  it("checks the current Workspace, switches, and opens Workspace settings", async () => {
    const h = harness();
    await mount(h);
    await openMenu();
    expect(item("Acme").getAttribute("aria-checked")).toBe("true");
    await choose("Other");
    expect(h.props.select).toHaveBeenCalledWith("w2");
    await openMenu();
    await choose("Workspace settings…");
    expect(useUiStore.getState()).toMatchObject({
      settingsOpen: true,
      settingsCategory: "workspace",
    });
  });
  it("creates and opens a Workspace, keeping the same id on a refused retry", async () => {
    const h = harness();
    await mount(h);
    await openMenu();
    await choose("New workspace…");
    expect(button("Create").disabled).toBe(true);
    await type("Workspace name", " Team ");
    await click("Create");
    const first = h.cloud.mutations[0]!;
    expect(first).toMatchObject({ name: "workspaces:create", args: { name: "Team" } });
    await act(async () => first.reject(refusal("invalid_argument", "Try again.")));
    expect(toastError).toHaveBeenCalledWith("Try again.");
    await click("Create");
    expect(h.cloud.mutations[1]!.args).toEqual(first.args);
    await act(async () => h.cloud.mutations[1]!.resolve({ workspaceId: "w3" }));
    expect(h.props.select).toHaveBeenCalledWith("w3");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it("previews a code, joins only on explicit confirmation, and clears the preview when edited", async () => {
    const h = harness();
    h.cloud.queries.set("invites:preview", (args) => {
      expect(args).toEqual({ token: "code" });
      return valid;
    });
    await mount(h);
    await openMenu();
    await choose("Join a workspace…");
    await type("Invite code", " code ");
    await click("Preview");
    expect(text()).toContain("Other · Member · from Robin");
    expect(h.cloud.mutations).toHaveLength(0);
    await type("Invite code", "changed");
    expect(button("Preview")).toBeDefined();
    await type("Invite code", "code");
    await click("Preview");
    await click("Join");
    expect(h.cloud.mutations[0]).toMatchObject({
      name: "invites:acceptLink",
      args: { token: "code" },
    });
    await act(async () => h.cloud.mutations[0]!.resolve({ workspaceId: "w2" }));
    expect(h.props.select).toHaveBeenCalledWith("w2");
  });
  it.each([
    ["invalid", "This invite is no longer valid."],
    ["expired", "This invite has expired."],
    ["email_mismatch", "Sign in with robin@example.com"],
    ["suspended", "Your membership is suspended."],
    ["sender_cannot_invite", "This invite is no longer valid."],
  ])("refuses a %s preview", async (status, message) => {
    const h = harness();
    h.cloud.queries.set("invites:preview", () => ({
      ...valid,
      status,
      email: "robin@example.com",
    }));
    await mount(h);
    await openMenu();
    await choose("Join a workspace…");
    await type("Invite code", "code");
    await click("Preview");
    expect(text()).toContain(message);
    expect(button("Join").disabled).toBe(true);
    expect(h.cloud.mutations).toHaveLength(0);
  });
  it("retains the list read-only on disconnect and blocks an already-open dialog", async () => {
    const h = harness();
    await mount(h);
    await openMenu();
    await choose("New workspace…");
    await type("Workspace name", "Team");
    h.offline();
    expect(button("Create").disabled).toBe(true);
    await click("Create");
    expect(h.cloud.mutations).toHaveLength(0);
    await act(async () => button("Close").click());
    await openMenu();
    expect(item("Other").hasAttribute("data-disabled")).toBe(true);
    expect(item("New workspace…").hasAttribute("data-disabled")).toBe(true);
    expect(item("Join a workspace…").hasAttribute("data-disabled")).toBe(true);
    await choose("Other");
    expect(h.props.select).not.toHaveBeenCalled();
  });
  it("offers new and join with no Workspace and shows offline before the first answer", async () => {
    const h = harness();
    useCloudWorkspaceStore.setState({ workspace: null });
    await mount(h);
    h.answer("workspaces:listMine", []);
    await openMenu();
    expect(item("New workspace…").hasAttribute("data-disabled")).toBe(false);
    expect(item("Workspace settings…").hasAttribute("data-disabled")).toBe(true);
  });
  it("surfaces read failures with Retry, and write/selection failures as toasts", async () => {
    const h = harness();
    await mount(h);
    await act(async () =>
      h.cloud.fail("workspaces:listMine", {}, refusal("forbidden", "No access.")),
    );
    await openMenu();
    expect(text()).toContain("No access.");
    await choose("Retry");
    h.answer("workspaces:listMine", rows);
    h.props.select.mockRejectedValueOnce(new Error("Could not open."));
    await openMenu();
    await choose("Other");
    expect(toastError).toHaveBeenCalledWith("Could not open.");
  });
  it("offers each pending invite once, joins from its toast, and dismisses revoked actions", async () => {
    const h = harness();
    await mount(h);
    h.answer("invites:listMine", [invitation]);
    h.answer("invites:listMine", [{ ...invitation }]);
    expect(toast).toHaveBeenCalledTimes(1);
    const [message, options] = vi.mocked(toast).mock.calls[0]!;
    expect(message).toBe("Robin invited you to Other");
    await act(
      async () =>
        options!.action &&
        typeof options!.action === "object" &&
        "onClick" in options!.action &&
        options!.action.onClick({} as never),
    );
    expect(h.cloud.mutations[0]).toMatchObject({
      name: "invites:accept",
      args: { inviteId: "i1" },
    });
    await act(async () => h.cloud.mutations[0]!.resolve({ workspaceId: "w2" }));
    expect(h.props.select).toHaveBeenCalledWith("w2");
    h.answer("invites:listMine", []);
    expect(toast.dismiss).toHaveBeenCalledWith("workspace-invite:i1");
  });
});
