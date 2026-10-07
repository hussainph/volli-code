// @vitest-environment jsdom
/**
 * "Open a project on <host>…" (VC-710) over the scripted remote-hosts API:
 * the host's list read each time the sheet opens, Open and Close, the empty,
 * error and can't-add states with their one recovery, and New project…,
 * which creates on the host and then opens what it made.
 */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  CreateRemoteProjectResult,
  HostWorkspaceCreateInput,
  HostWorkspaceCreateResult,
  RemoteHost,
} from "@volli/shared";

import { useExperimentsStore } from "@renderer/stores/experiments";
import {
  setHostWorkspacesApi,
  setRemoteHostsApi,
  useRemoteHostsStore,
} from "@renderer/stores/remote-hosts";
import {
  createFakeRemoteHostsApi,
  registryHost,
  type FakeRemoteHostsApi,
} from "@renderer/stores/remote-hosts.test-support";

import { HostsChrome } from "./hosts-chrome";
import { useHostSignInSheet } from "./sign-ins/remote-host-sign-in-source";
import { click, HETZNER_ID, hostWorld, type HostWorld } from "./hosts.test-support";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast, Toaster: () => null }));

const HOST = registryHost({ id: HETZNER_ID, name: "hetzner-1", target: "deploy@hetzner-1" });
const ACME = {
  id: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b",
  name: "Acme",
  prefix: "AC",
  path: "/srv/volli/acme",
  tickets: 2,
};
const COMMAND = "sudo volli-hostd operator-token --for 'deploy'";
const OTHER = registryHost({ id: "host-mini", name: "mac-mini", target: "me@mac-mini" });

let world: HostWorld | null = null;
let api: FakeRemoteHostsApi;

beforeEach(() => {
  api = createFakeRemoteHostsApi();
  setRemoteHostsApi(api);
});

afterEach(async () => {
  await act(async () => useRemoteHostsStore.getState().closeProjectSheet());
  await world?.cleanup();
  world = null;
  setRemoteHostsApi(null);
  setHostWorkspacesApi(null);
  useRemoteHostsStore.setState({
    hosts: [],
    readOnly: null,
    openProject: { open: false, hostId: null, start: "list", opening: 0 },
  });
  toast.mockClear();
  toast.error.mockClear();
  document.body.innerHTML = "";
});

function sheet(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
  if (found === null) throw new Error("sheet closed");
  return found;
}

const isOpen = (): boolean => document.querySelector('[data-slot="dialog-content"]') !== null;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function type(label: string, value: string): Promise<void> {
  const field = sheet().querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (field === null) throw new Error(`No field "${label}"`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(name: string): HTMLButtonElement | undefined {
  return [...sheet().querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name,
  );
}

async function openSheet(start: "list" | "new" = "list", host: RemoteHost = HOST): Promise<void> {
  world = hostWorld();
  useRemoteHostsStore.getState().setHosts([host]);
  await world.render(<HostsChrome />);
  await act(async () => useRemoteHostsStore.getState().openProjectSheet(HOST.id, start));
  await settle();
}

/** A create refused for want of a sudo password, or with a wrong one. */
const refuse = (code: "needs-password" | "wrong-password"): CreateRemoteProjectResult => ({
  ok: false,
  failure: {
    code,
    message: code === "needs-password" ? "Enter your password." : "Wrong.",
    command: null,
  },
});

describe("Open a project on <host>…", () => {
  it("lists the host's projects, read when it opens, and opens one on this Mac", async () => {
    api.projectsOf.set(HOST.id, { projects: [ACME], adds: { kind: "ready" } });
    await openSheet();
    expect(api.calls).toEqual([["projects", HOST.id]]);
    expect(sheet().textContent).toContain("Open a project on hetzner-1");
    expect(sheet().textContent).toContain("AC · /srv/volli/acme · 2 tickets");
    await click(sheet(), "Open Acme");
    expect(api.calls.at(-1)).toEqual(["openWorkspace", HOST.id, ACME.id]);
    expect(toast).toHaveBeenCalledWith("Opened Acme on hetzner-1");
    expect(useRemoteHostsStore.getState().openProject.open).toBe(false);
  });

  it("offers Close for one already open here, and keeps the sheet", async () => {
    api.projectsOf.set(HOST.id, { projects: [{ ...ACME, id: "remote" }], adds: { kind: "ready" } });
    await openSheet();
    await click(sheet(), "Close Acme on this Mac");
    expect(api.calls.at(-1)).toEqual(["closeWorkspace", HOST.id, "remote"]);
    expect(toast).toHaveBeenCalledWith("Closed Acme on this Mac");
    expect(isOpen()).toBe(true);
    api.refuseNext("closeWorkspace", "registry");
    await click(sheet(), "Close Acme on this Mac");
    await settle();
    expect(toast.error).toHaveBeenCalled();
  });

  it("says when an open did not happen, and stays", async () => {
    api.projectsOf.set(HOST.id, { projects: [ACME], adds: { kind: "ready" } });
    api.refuseNext("openWorkspace", "Couldn’t save this Mac’s hosts file.");
    await openSheet();
    await click(sheet(), "Open Acme");
    await settle();
    expect(toast.error).toHaveBeenCalled();
    expect(isOpen()).toBe(true);
  });

  it("says why it could not read the host, and tries again", async () => {
    api.projectsOf.set(HOST.id, new Error("Couldn't reach hetzner-1."));
    await openSheet();
    expect(sheet().textContent).toContain("Couldn't reach hetzner-1.");
    api.projectsOf.set(HOST.id, { projects: [ACME], adds: { kind: "ready" } });
    await click(sheet(), "Try again");
    await settle();
    expect(sheet().textContent).toContain("Acme");
  });

  it("an empty host offers New project…, then creates and opens it", async () => {
    await openSheet();
    expect(sheet().textContent).toContain("No projects on hetzner-1 yet.");
    await click(sheet(), "New project…");
    expect(sheet().textContent).toContain("New project on hetzner-1");
    await type("Git URL or folder on hetzner-1", "acme");
    expect(sheet().textContent).toContain("A folder on hetzner-1 is a full path");
    expect(button("Create and open")?.disabled).toBe(true);
    await type("Git URL or folder on hetzner-1", "git@github.com:me/acme.git");
    expect(sheet().textContent).toContain("Cloned into /srv/volli on the host");
    await type("Name (optional)", "Acme");
    await click(sheet(), "Create and open");
    await settle();
    expect(api.calls).toContainEqual([
      "createProject",
      { hostId: HOST.id, gitUrl: "git@github.com:me/acme.git", name: "Acme" },
    ]);
    expect(api.calls.at(-1)).toEqual(["openWorkspace", HOST.id, ACME.id]);
    expect(useRemoteHostsStore.getState().openProject.open).toBe(false);
  });

  it("shows a create's refusal in one line with its command, and tries again", async () => {
    const refused: CreateRemoteProjectResult = {
      ok: false,
      failure: {
        code: "not-operator",
        message:
          "This Mac can’t add projects on hetzner-1 yet. Run this there once, then try again.",
        command: COMMAND,
      },
    };
    api.nextCreate = refused;
    await openSheet("new");
    await type("Git URL or folder on hetzner-1", "/srv/volli/acme");
    await click(sheet(), "Create and open");
    await settle();
    expect(sheet().querySelector('[role="alert"]')?.textContent).toContain(COMMAND);
    api.nextCreate = null;
    await click(sheet(), "Try again");
    await settle();
    expect(api.calls).toContainEqual([
      "createProject",
      { hostId: HOST.id, path: "/srv/volli/acme" },
    ]);
    expect(useRemoteHostsStore.getState().openProject.open).toBe(false);
  });

  it("asks for the sudo password a clone needs: read once, sent once, cleared, and asked once more if wrong", async () => {
    api.nextCreate = refuse("needs-password");
    await openSheet("new");
    await type("Git URL or folder on hetzner-1", "https://github.com/me/acme");
    await click(sheet(), "Create and open");
    await settle();
    const field = () =>
      sheet().querySelector<HTMLInputElement>('input[aria-label="Your password on hetzner-1"]');
    expect(field()?.type).toBe("password");
    expect(button("Clone with sudo")?.disabled).toBe(true);
    api.nextCreate = refuse("wrong-password");
    await type("Your password on hetzner-1", "wrong-one");
    await click(sheet(), "Clone with sudo");
    expect(api.calls.at(-1)).toEqual([
      "createProject",
      { hostId: HOST.id, gitUrl: "https://github.com/me/acme", sudoPassword: "wrong-one" },
    ]);
    await settle();
    // Asked once more, the field empty.
    expect(sheet().textContent).toContain("Wrong.");
    expect(field()?.value).toBe("");
    await type("Your password on hetzner-1", "still-wrong");
    await click(sheet(), "Clone with sudo");
    await settle();
    // Twice wrong: it stops asking; Try again starts over without one.
    expect(field()).toBeNull();
    api.nextCreate = null;
    await click(sheet(), "Try again");
    await settle();
    expect(api.calls.at(-2)).toEqual([
      "createProject",
      { hostId: HOST.id, gitUrl: "https://github.com/me/acme" },
    ]);
    expect(useRemoteHostsStore.getState().openProject.open).toBe(false);
  });

  it("sends a clone that needs a token to Sign-ins on the host", async () => {
    api.nextCreate = {
      ok: false,
      failure: {
        code: "needs-credential",
        message: "Add a GitHub token in Sign-ins on hetzner-1, then try again.",
        command: null,
      },
    };
    await openSheet("new");
    await type("Git URL or folder on hetzner-1", "https://github.com/me/private");
    await click(sheet(), "Create and open");
    await settle();
    expect(sheet().textContent).toContain("Add a GitHub token in Sign-ins on hetzner-1");
    // The sign-in sheet itself is VC-702's (its own tests): here, only that it is asked to open.
    const open = vi.spyOn(useHostSignInSheet.getState(), "open").mockImplementation(() => {});
    await click(sheet(), "Sign-ins on hetzner-1…");
    expect(open).toHaveBeenCalledWith({ hostId: HOST.id, hostName: "hetzner-1", providerId: null });
    expect(useRemoteHostsStore.getState().openProject.open).toBe(false);
    open.mockRestore();
  });

  it("never sends a URL carrying a token: it says so, and nothing leaves the window", async () => {
    await openSheet("new");
    await type(
      "Git URL or folder on hetzner-1",
      "https://github.com/me/acme.git?access_token=SENTINEL",
    );
    expect(sheet().textContent).toContain("Use the repository's plain URL");
    expect(button("Create and open")?.disabled).toBe(true);
    await act(async () => sheet().querySelector("form")!.requestSubmit());
    expect(api.calls.some(([method]) => method === "createProject")).toBe(false);
  });

  it("says when a create threw, and goes Back to the list", async () => {
    api.nextCreate = new Error("lost");
    await openSheet("new");
    await type("Git URL or folder on hetzner-1", "/srv/volli/acme");
    await click(sheet(), "Create and open");
    await settle();
    expect(sheet().textContent).toContain("Couldn’t add hetzner-1: lost");
    await click(sheet(), "Back");
    await settle();
    expect(sheet().textContent).toContain("Open a project on hetzner-1");
  });

  it("names the one command a login with no operator token runs, and offers only that", async () => {
    api.projectsOf.set(HOST.id, {
      projects: [],
      adds: { kind: "needs-operator", command: COMMAND },
    });
    await openSheet();
    expect(sheet().textContent).toContain("Run this once on hetzner-1");
    expect(sheet().textContent).toContain(COMMAND);
    expect(button("New project…")).toBeUndefined();
  });

  it("offers no New project… on a host where agents share the login", async () => {
    api.projectsOf.set(HOST.id, { projects: [], adds: { kind: "user-install" } });
    await openSheet();
    expect(sheet().textContent).toContain("Update hetzner-1 to create projects from here");
    expect(button("New project…")).toBeUndefined();
    await click(sheet(), "Re-add");
    expect(useRemoteHostsStore.getState().addHost).toEqual({ open: true, target: HOST.target });
    expect(api.calls.filter(([method]) => method === "projects")).toHaveLength(1);
  });

  it("drops a list that lands after the sheet closed", async () => {
    const answer = Promise.withResolvers<void>();
    api.projects = async (hostId) => {
      await answer.promise;
      return { hostId, projects: [], adds: { kind: "ready" } };
    };
    await openSheet();
    await act(async () => useRemoteHostsStore.getState().closeProjectSheet());
    await act(async () => answer.resolve());
    expect(isOpen()).toBe(false);
  });

  // Review B3: a late answer belongs to its own opening; a newer one is never touched.
  it.each([
    ["dismissed", async () => useRemoteHostsStore.getState().closeProjectSheet()],
    [
      "switched to another host",
      async () => useRemoteHostsStore.getState().openProjectSheet(OTHER.id),
    ],
    [
      "reopened",
      async () => {
        useRemoteHostsStore.getState().closeProjectSheet();
        useRemoteHostsStore.getState().openProjectSheet(HOST.id);
      },
    ],
    ["its host forgotten", async () => useRemoteHostsStore.getState().setHosts([OTHER])],
    [
      "unmounted by cloud turning off",
      async () =>
        useExperimentsStore.setState({
          snapshot: { cloud: { enabled: false, source: "storage" } },
        }),
    ],
  ])("starts nothing from a create that lands after the view was %s", async (_, change) => {
    const created = Promise.withResolvers<CreateRemoteProjectResult>();
    api.nextCreate = null;
    const real = api.createProject;
    api.createProject = async (input) => {
      await real(input);
      return created.promise;
    };
    await openSheet("new");
    await act(async () => useRemoteHostsStore.getState().setHosts([HOST, OTHER]));
    await type("Git URL or folder on hetzner-1", "/srv/volli/acme");
    await click(sheet(), "Create and open");
    await act(change);
    await settle();
    const before = useRemoteHostsStore.getState().openProject;
    await act(async () => created.resolve({ ok: true, created: true, project: ACME }));
    await settle();
    expect(api.calls.some(([method]) => method === "openWorkspace")).toBe(false);
    expect(toast).not.toHaveBeenCalled();
    expect(useRemoteHostsStore.getState().openProject).toEqual(before);
  });

  it("starts no toast or dismissal from an open that lands after another host's opening", async () => {
    api.projectsOf.set(HOST.id, { projects: [ACME], adds: { kind: "ready" } });
    const opened = Promise.withResolvers<null>();
    api.openWorkspace = async () => opened.promise;
    await openSheet();
    await act(async () => useRemoteHostsStore.getState().setHosts([HOST, OTHER]));
    await click(sheet(), "Open Acme");
    await act(async () => useRemoteHostsStore.getState().openProjectSheet(OTHER.id));
    await settle();
    expect(sheet().textContent).toContain("Open a project on mac-mini");
    await act(async () => opened.resolve(null));
    await settle();
    expect(toast).not.toHaveBeenCalled();
    expect(useRemoteHostsStore.getState().openProject).toMatchObject({
      open: true,
      hostId: OTHER.id,
    });
  });

  it("closes with Done, and with the host forgotten", async () => {
    await openSheet();
    await click(sheet(), "Done");
    expect(useRemoteHostsStore.getState().openProject.open).toBe(false);
    await act(async () => useRemoteHostsStore.getState().openProjectSheet(HOST.id));
    await settle();
    expect(isOpen()).toBe(true);
    await act(async () => useRemoteHostsStore.getState().setHosts([]));
    expect(isOpen()).toBe(false);
  });
});

const MODERN = {
  ...HOST,
  mode: "user" as const,
  hostScope: { status: "ready" as const, granted: ["host.workspaces"] },
};
const MODERN_ROW = { id: ACME.id, name: ACME.name, path: ACME.path, gitRemoteUrl: null };

describe("projects before a Workspace on a modern HOST connection", () => {
  it("lists modern rows honestly and creates on a user install, with no SSH or sudo", async () => {
    const list = vi.fn(async () => ({ workspaces: [MODERN_ROW], omitted: 0 }));
    const create = vi.fn(async () => ({ ok: true as const, workspace: MODERN_ROW }));
    setHostWorkspacesApi(() => ({ list, create }));
    await openSheet("list", MODERN);
    expect(list).toHaveBeenCalledOnce();
    expect(sheet().textContent).toContain(ACME.path);
    expect(sheet().textContent).not.toContain("tickets");
    expect(sheet().textContent).not.toContain("AC ·");
    expect(api.calls).toEqual([]);
    await click(sheet(), "New project…");
    await settle();
    await type("Git URL or folder on hetzner-1", "/srv/volli/acme");
    await type("Name (optional)", " A ");
    await click(sheet(), "Create and open");
    await settle();
    expect(create).toHaveBeenCalledWith({
      commandId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
      source: { path: ACME.path },
      name: "A",
    });
    expect(api.calls).toEqual([["openWorkspace", HOST.id, ACME.id]]);
  });

  it("requires an absolute folder path on modern hosts without SSH shell expansion", async () => {
    const list = vi.fn(async () => ({ workspaces: [], omitted: 0 }));
    const create = vi.fn();
    setHostWorkspacesApi(() => ({ list, create }));
    await openSheet("new", MODERN);
    await type("Git URL or folder on hetzner-1", "~/acme");
    expect(sheet().textContent).toContain("A folder on hetzner-1 is a full path");
    expect(button("Create and open")?.disabled).toBe(true);
    await act(async () => sheet().querySelector("form")!.requestSubmit());
    expect(create).not.toHaveBeenCalled();
    expect(api.calls).toEqual([]);
  });

  it("reuses a commandId on ambiguity/still-running, re-lists target-exists and creates a new id on edit", async () => {
    const list = vi.fn(async () => ({ workspaces: [], omitted: 0 }));
    const create = vi
      .fn<(input: HostWorkspaceCreateInput) => Promise<HostWorkspaceCreateResult>>()
      .mockRejectedValueOnce(new Error("outcome unknown"))
      .mockResolvedValueOnce({
        ok: false,
        failure: { code: "still-running", message: "Still running." },
      })
      .mockResolvedValueOnce({
        ok: false,
        failure: { code: "target-exists", message: "Target exists; check the project list." },
      })
      .mockResolvedValueOnce({ ok: true, workspace: MODERN_ROW });
    setHostWorkspacesApi(() => ({ list, create }));
    await openSheet("new", MODERN);
    await type("Git URL or folder on hetzner-1", "https://example.test/acme.git");
    expect(sheet().textContent).toContain("Cloned on the host, then added.");
    await click(sheet(), "Create and open");
    await settle();
    expect(sheet().textContent).toContain("outcome unknown");
    await click(sheet(), "Try again");
    await settle();
    expect(sheet().textContent).toContain("Still running.");
    await click(sheet(), "Try again");
    await settle();
    expect(sheet().textContent).toContain("Target exists; check the project list.");
    expect(list).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(3); // No silent retry or reclone.
    expect(create.mock.calls[1]![0].commandId).toBe(create.mock.calls[0]![0].commandId);
    expect(create.mock.calls[2]![0].commandId).toBe(create.mock.calls[0]![0].commandId);
    expect(sheet().querySelector('input[type="password"]')).toBeNull();
    await type("Name (optional)", "Different");
    await click(sheet(), "Create and open");
    await settle();
    expect(create.mock.calls[3]![0].commandId).not.toBe(create.mock.calls[0]![0].commandId);
    expect(create.mock.calls[3]![0].source).toEqual({ gitUrl: "https://example.test/acme.git" });
    expect(api.calls).toEqual([["openWorkspace", HOST.id, ACME.id]]);
  });

  it.each(["connecting", "unavailable", "ready"] as const)(
    "says a modern %s failure and never falls back to SSH",
    async (status) => {
      const list = vi.fn();
      setHostWorkspacesApi(() => ({ list, create: vi.fn() }));
      await openSheet("list", { ...MODERN, hostScope: { status, granted: [] } });
      expect(sheet().textContent).toContain(
        status === "ready" ? "did not grant project access" : "Try again when it reconnects",
      );
      expect(api.calls).toEqual([]);
      expect(list).not.toHaveBeenCalled();
    },
  );

  it("blocks New-project entry on an older user host and offers exactly Re-add", async () => {
    await openSheet("new", { ...HOST, mode: "user", hostScope: { status: "older", granted: [] } });
    expect(sheet().textContent).toContain("Update hetzner-1 to create projects from here");
    expect(button("Create and open")).toBeUndefined();
    expect(button("Re-add")).toBeDefined();
    await click(sheet(), "Re-add");
    expect(useRemoteHostsStore.getState().addHost).toEqual({ open: true, target: HOST.target });
    expect(api.calls.some(([method]) => method === "createProject")).toBe(false);
  });
});
