// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Project } from "@volli/shared";
import type { Result } from "../../../../../ipc/contract";
import type { SecretsResult } from "../../../../../ipc/secrets";
import { toastError } from "@renderer/lib/toast";
import { configureGroups } from "../configure-groups";
import { SecretsPane } from "./secrets-pane";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));
const project: Project = {
  id: "p1",
  name: "Project",
  path: "/tmp/project",
  ticketPrefix: "T",
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
};
const inventory: SecretsResult = {
  ok: true,
  requests: [],
  secrets: [
    { id: "secret-1", name: "DEPLOY_TOKEN", scope: "project", projectId: "p1", lastUsedAt: null },
    { id: "secret-2", name: "OTHER_TOKEN", scope: "always", lastUsedAt: 1000 },
  ],
};
const api = {
  secrets: {
    list: vi.fn<() => Promise<SecretsResult>>(),
    replace: vi.fn<() => Promise<Result>>(),
    revoke: vi.fn<() => Promise<Result>>(),
  },
  appState: { set: vi.fn() },
};
let root: Root;
let host: HTMLElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("api", api);
  api.secrets.list.mockResolvedValue(inventory);
  api.secrets.replace.mockResolvedValue({ ok: true });
  api.secrets.revoke.mockResolvedValue({ ok: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<SecretsPane project={project} />));
}
function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((item) => item.textContent === label);
  if (found === undefined) throw new Error(`missing ${label}`);
  return found;
}
function password(): HTMLInputElement {
  const found = host.querySelector<HTMLInputElement>("input[type=password]");
  if (found === null) throw new Error("missing password field");
  return found;
}

describe("Configure Secrets", () => {
  it("has a searchable Secrets category and only displays metadata", async () => {
    const category = configureGroups(project)
      .flatMap((group) => group.categories)
      .find((item) => item.key === "secrets");
    expect(category?.label).toBe("Secrets");
    expect(category?.keywords).toContain("replacement credential");
    await render();
    expect(api.secrets.list).toHaveBeenCalledWith("p1");
    expect(host.textContent).toContain("DEPLOY_TOKEN");
    expect(host.textContent).toContain("Scope: Project · Last used: Never");
    expect(host.textContent).toContain("Scope: Always · Last used:");
    expect(host.querySelectorAll("input[type=password]")).toHaveLength(2);
    for (const input of host.querySelectorAll<HTMLInputElement>("input")) {
      expect(input.value).toBe("");
      expect(input.getAttribute("value")).toBeNull();
      expect(input.defaultValue).toBe("");
    }
  });

  it("clears a replacement immediately, writes only dedicated IPC once, then reloads metadata", async () => {
    const pending = Promise.withResolvers<Result>();
    api.secrets.replace.mockReturnValue(pending.promise);
    await render();
    const field = password();
    field.value = "write-only-secret";
    act(() => {
      button("Replace").click();
      expect(field.value).toBe("");
      button("Replace").click();
    });
    expect(api.secrets.replace.mock.calls).toEqual([
      [{ id: "secret-1", value: "write-only-secret" }],
    ]);
    expect(host.innerHTML).not.toContain("write-only-secret");
    await act(async () => pending.resolve({ ok: true }));
    expect(api.secrets.list).toHaveBeenCalledTimes(2);
    expect(password().value).toBe("");
    expect(api.appState.set).not.toHaveBeenCalled();
  });

  it("revokes by identity without sending any typed replacement", async () => {
    await render();
    const field = password();
    field.value = "unsent-replacement";
    await act(async () => button("Revoke").click());
    expect(field.value).toBe("");
    expect(api.secrets.revoke).toHaveBeenCalledWith("secret-1");
    expect(api.secrets.replace).not.toHaveBeenCalled();
    expect(api.secrets.list).toHaveBeenCalledTimes(2);
  });

  it("reports rejected mutations without echoing error or credential bytes", async () => {
    api.secrets.replace.mockResolvedValue({ ok: false, error: "write-only-secret" });
    await render();
    password().value = "write-only-secret";
    await act(async () => button("Replace").click());
    expect(password().value).toBe("");
    expect(toastError).toHaveBeenCalledWith("Couldn't replace the credential.");
    expect(JSON.stringify(vi.mocked(toastError).mock.calls)).not.toContain("write-only-secret");
  });

  it("surfaces list errors and allows a metadata-only refresh", async () => {
    api.secrets.list.mockRejectedValueOnce(new Error("unsafe error"));
    await render();
    expect(host.textContent).toContain("Couldn't load credentials. Refresh to try again.");
    expect(host.textContent).not.toContain("unsafe error");
    expect(toastError).toHaveBeenCalledWith("Couldn't load credentials.");
    await act(async () => button("Refresh").click());
    expect(host.textContent).toContain("DEPLOY_TOKEN");
  });
});
