// @vitest-environment jsdom
import type { McpCatalogTool, McpServerRecord, Project } from "@volli/shared";
import { mcpProviderToolName } from "@volli/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { McpPane } from "./mcp-pane";

const project: Project = {
  id: "project-1",
  name: "Project",
  path: "/repo/project",
  ticketPrefix: "PRJ",
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
};

const catalog: readonly McpCatalogTool[] = [
  {
    name: "echo",
    description: "Echo",
    enabled: false,
    definition: {
      serverId: "server-1",
      toolName: "echo",
      providerName: mcpProviderToolName("server-1", "Fixture", "echo"),
      description: "Echo",
      inputSchema: { type: "object" },
    },
    error: null,
  },
];

function record(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    id: "server-1",
    projectId: project.id,
    name: "Fixture",
    enabled: true,
    transport: { type: "stdio", command: "node", args: ["fixture.mjs"] },
    catalog,
    stale: true,
    error: "Could not refresh Fixture.",
    refreshedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(mcp: Record<string, unknown>): Promise<HTMLDivElement> {
  Object.defineProperty(window, "api", { value: { mcp }, configurable: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<McpPane project={project} />));
  return container;
}

function button(text: string): HTMLButtonElement {
  const found = [...(container?.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!(found instanceof window.HTMLButtonElement)) throw new Error(`Button ${text} not found`);
  return found;
}

async function setValue(selector: string, value: string): Promise<void> {
  const input = container?.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
  if (input === null) throw new Error(`${selector} not found`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.clearAllMocks();
});

describe("McpPane", () => {
  it("tests a direct argv configuration, defaults discovered tools off, and saves only an explicit choice", async () => {
    const list = vi.fn(async () => ({ ok: true as const, servers: [] }));
    const test = vi.fn(async () => ({ ok: true as const, catalog }));
    const save = vi.fn(async (input: { server: McpServerRecord }) => ({
      ok: true as const,
      server: record({
        ...input.server,
        catalog: [{ ...catalog[0]!, enabled: true }],
        stale: false,
        error: null,
      }),
    }));
    await render({ list, test, save });
    await act(async () => undefined);

    await setValue("#mcp-server-name", "Fixture");
    await setValue("#mcp-command", "node");
    await setValue("#mcp-args", "fixture.mjs\n--safe");
    await act(async () => button("Test and discover").click());

    expect(test).toHaveBeenCalledWith({
      projectId: project.id,
      server: expect.objectContaining({
        name: "Fixture",
        enabled: true,
        transport: { type: "stdio", command: "node", args: ["fixture.mjs", "--safe"] },
      }),
    });
    const choice = container!.querySelector("fieldset input[type=checkbox]") as HTMLInputElement;
    expect(choice.checked).toBe(false);
    await act(async () => choice.click());
    await act(async () => button("Save server").click());

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: project.id, enabledTools: ["echo"] }),
    );
    expect(container!.textContent).toContain("Fixture");
  });

  it("loads an existing server for editing and explains both execution trust boundaries", async () => {
    const initial = record({ catalog: [{ ...catalog[0]!, enabled: true }] });
    const list = vi.fn(async () => ({ ok: true as const, servers: [initial] }));
    const save = vi.fn(async (input: { server: McpServerRecord }) => ({
      ok: true as const,
      server: record({ ...input.server, stale: false, error: null }),
    }));
    await render({ list, save });
    await act(async () => undefined);

    expect(container!.textContent).toContain("A local MCP command runs as you");
    expect(container!.textContent).toContain(
      "a remote server receives the arguments sent to its tools",
    );

    await act(async () =>
      (container!.querySelector('[aria-label="Edit Fixture"]') as HTMLButtonElement).click(),
    );
    expect((container!.querySelector("#mcp-server-name") as HTMLInputElement).value).toBe(
      "Fixture",
    );
    expect((container!.querySelector("#mcp-command") as HTMLInputElement).value).toBe("node");
    await setValue("#mcp-server-name", "Edited fixture");
    await act(async () => button("Save changes").click());

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: project.id,
        server: expect.objectContaining({ id: "server-1", name: "Edited fixture" }),
        enabledTools: ["echo"],
      }),
    );
  });

  it("shows stale health and wires tool selection, refresh, enablement, and removal", async () => {
    const initial = record();
    const selected = record({ catalog: [{ ...catalog[0]!, enabled: true }] });
    const refreshed = record({ stale: false, error: null });
    const list = vi.fn(async () => ({ ok: true as const, servers: [initial] }));
    const setTools = vi.fn(async () => ({ ok: true as const, server: selected }));
    const refresh = vi.fn(async () => ({ ok: true as const, server: refreshed }));
    const setEnabled = vi.fn(async () => ({
      ok: true as const,
      server: { ...refreshed, enabled: false },
    }));
    const remove = vi.fn(async () => ({ ok: true as const }));
    await render({ list, setTools, refresh, setEnabled, remove });
    await act(async () => undefined);

    expect(container!.textContent).toContain("Stale catalog");
    const tool = [...container!.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("echo"))
      ?.querySelector("input") as HTMLInputElement;
    await act(async () => tool.click());
    expect(setTools).toHaveBeenCalledWith({
      projectId: project.id,
      serverId: "server-1",
      enabledTools: ["echo"],
    });

    await act(async () =>
      (container!.querySelector('[aria-label="Refresh Fixture"]') as HTMLButtonElement).click(),
    );
    expect(refresh).toHaveBeenCalledWith({ projectId: project.id, serverId: "server-1" });

    const enabled = container!.querySelector('[aria-label="Fixture enabled"]') as HTMLInputElement;
    await act(async () => enabled.click());
    expect(setEnabled).toHaveBeenCalledWith({
      projectId: project.id,
      serverId: "server-1",
      enabled: false,
    });

    await act(async () =>
      (container!.querySelector('[aria-label="Remove Fixture"]') as HTMLButtonElement).click(),
    );
    expect(remove).toHaveBeenCalledWith({ projectId: project.id, serverId: "server-1" });
    expect(container!.textContent).toContain("No MCP servers yet.");
  });
});
