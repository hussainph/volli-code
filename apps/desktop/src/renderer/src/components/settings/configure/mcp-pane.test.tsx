// @vitest-environment jsdom
import type { McpCatalogTool, McpOperationRecord, McpServerRecord, Project } from "@volli/shared";
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
    provenance: { source: null, registryType: null, version: null, digest: null },
    catalog,
    stale: true,
    error: "Could not refresh Fixture.",
    refreshedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function operation(overrides: Partial<McpOperationRecord> = {}): McpOperationRecord {
  return {
    id: "session-9:tc-1",
    projectId: project.id,
    serverId: "server-1",
    serverName: "Fixture",
    operation: "install",
    outcome: "applied",
    summary: "Installed Fixture (id server-1) with 1 of 2 tools on.",
    detail: null,
    provenance: { source: null, registryType: null, version: null, digest: null },
    sessionId: "session-9",
    ticketId: null,
    createdAt: Date.now() - 3_600_000,
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
    const list = vi.fn(async () => ({ ok: true as const, servers: [], operations: [] }));
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
    const list = vi.fn(async () => ({ ok: true as const, servers: [initial], operations: [] }));
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
    const list = vi.fn(async () => ({ ok: true as const, servers: [initial], operations: [] }));
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

describe("McpPane provenance (VC-380)", () => {
  it("shows where a server came from, and says Volli did not verify it", async () => {
    const list = vi.fn(async () => ({
      ok: true as const,
      servers: [
        record({
          stale: false,
          error: null,
          provenance: {
            source: "registry.modelcontextprotocol.io/io.github.acme/files",
            registryType: "npm",
            version: "1.4.2",
            digest: "sha256:2f0c1d",
          },
        }),
      ],
      operations: [],
    }));
    await render({ list });
    await act(async () => undefined);

    const text = container!.textContent ?? "";
    expect(text).toContain("registry.modelcontextprotocol.io/io.github.acme/files");
    expect(text).toContain("1.4.2");
    expect(text).toContain("sha256:2f0c1d");
    // A version and a digest shown without this read as a guarantee Volli
    // never made: nothing is downloaded, so nothing is checked against them.
    expect(text).toMatch(/not verified/i);
  });

  it("says nothing at all about origin when nobody recorded one", async () => {
    const list = vi.fn(async () => ({
      ok: true as const,
      servers: [record({ stale: false, error: null })],
      operations: [],
    }));
    await render({ list });
    await act(async () => undefined);

    // A server a person typed in by hand has no origin, and an empty
    // "Source: —" row would be a control talking about nothing.
    expect(container!.textContent ?? "").not.toMatch(/not verified/i);
  });
});

describe("McpPane freshness (VC-380)", () => {
  it("says when a catalog was last read, so a healthy row can be judged", async () => {
    const list = vi.fn(async () => ({
      ok: true as const,
      servers: [record({ stale: false, error: null, refreshedAt: Date.now() - 7_200_000 })],
      operations: [],
    }));
    await render({ list });
    await act(async () => undefined);

    expect(container!.textContent ?? "").toContain("2h ago");
  });

  it("says a catalog was never read rather than showing a stamp it does not have", async () => {
    const list = vi.fn(async () => ({
      ok: true as const,
      servers: [record({ stale: false, error: null, refreshedAt: null })],
      operations: [],
    }));
    await render({ list });
    await act(async () => undefined);

    expect(container!.textContent ?? "").toContain("Never refreshed");
  });
});

describe("McpPane activity (VC-380)", () => {
  it("shows a person what an agent Session installed, and when", async () => {
    const list = vi.fn(async () => ({
      ok: true as const,
      servers: [record({ stale: false, error: null })],
      operations: [operation()],
    }));
    await render({ list });
    await act(async () => undefined);

    const text = container!.textContent ?? "";
    expect(text).toContain("Recent activity");
    expect(text).toContain("Installed Fixture (id server-1) with 1 of 2 tools on.");
    expect(text).toContain("1h ago");
    // Which agent matters less than THAT an agent did it rather than a person.
    expect(text).toContain("by an agent Session");
  });

  it("keeps a removal and its recovery line, after the server row is gone", async () => {
    const list = vi.fn(async () => ({
      ok: true as const,
      // The server is gone. Its record is the only place the transport survives,
      // which is exactly the case a person needs the list for.
      servers: [],
      operations: [
        operation({
          operation: "remove",
          summary: "Removed Fixture (id server-1) and its 2-tool catalog.",
          detail: "Configuration recorded here so it can be re-added: local: node fixture.mjs.",
        }),
      ],
    }));
    await render({ list });
    await act(async () => undefined);

    const text = container!.textContent ?? "";
    expect(text).toContain("Removed Fixture (id server-1) and its 2-tool catalog.");
    expect(text).toContain("local: node fixture.mjs");
  });

  it("says nothing at all when this project has no history", async () => {
    const list = vi.fn(async () => ({ ok: true as const, servers: [], operations: [] }));
    await render({ list });
    await act(async () => undefined);

    expect(container!.textContent ?? "").not.toContain("Recent activity");
  });
});
