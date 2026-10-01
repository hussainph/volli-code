// @vitest-environment jsdom
import type { McpCatalogTool } from "@volli/shared";
import { mcpProviderToolName } from "@volli/shared";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { McpToolPicker } from "./mcp-tool-picker";

function tool(
  name: string,
  options: {
    title?: string;
    readOnly?: boolean;
    destructive?: boolean;
    description?: string;
    unavailable?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  } = {},
): McpCatalogTool {
  const hints = {
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    ...(options.destructive === undefined ? {} : { destructive: options.destructive }),
  };
  return {
    name,
    description: options.description ?? `${name} description`,
    enabled: false,
    definition:
      options.unavailable === undefined
        ? {
            serverId: "s",
            toolName: name,
            providerName: mcpProviderToolName("s", "Server", name),
            description: "",
            inputSchema: {
              type: "object",
              ...(options.properties === undefined ? {} : { properties: options.properties }),
              ...(options.required === undefined ? {} : { required: options.required }),
            } as never,
          }
        : null,
    error: options.unavailable ?? null,
    ...(Object.keys(hints).length === 0 ? {} : { hints }),
  };
}

const CATALOG: readonly McpCatalogTool[] = [
  tool("list_issues", {
    title: "List issues",
    readOnly: true,
    properties: { team: { type: "string" }, limit: { type: "number" } },
    required: ["team"],
  }),
  tool("get_issue", { title: "Get issue", readOnly: true }),
  tool("create_issue", { title: "Create issue", readOnly: false }),
  tool("delete_issue", { title: "Delete issue", readOnly: false, destructive: true }),
  tool("render_graph", { unavailable: "input schema exceeds the node limit" }),
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The picker under a parent that holds the choice, as the server dialog does. */
function Harness({
  tools,
  initial,
  onChange,
}: {
  tools: readonly McpCatalogTool[];
  initial: readonly string[];
  onChange?: (next: Set<string>) => void;
}) {
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set(initial));
  return (
    <McpToolPicker
      serverName="Linear"
      tools={tools}
      selected={selected}
      focusFilter={1}
      onChange={(next) => {
        onChange?.(next);
        setSelected(next);
      }}
    />
  );
}

async function render(
  tools: readonly McpCatalogTool[] = CATALOG,
  initial: readonly string[] = [],
): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Harness tools={tools} initial={initial} />));
  return container;
}

function box(label: string): HTMLButtonElement {
  const found = container?.querySelector(`button[role="checkbox"][aria-label="${label}"]`);
  if (!(found instanceof window.HTMLButtonElement)) throw new Error(`checkbox ${label} not found`);
  return found;
}

function state(label: string): string | null {
  return box(label).getAttribute("aria-checked");
}

function button(label: string): HTMLButtonElement {
  const found = [...(container?.querySelectorAll("button") ?? [])].find(
    (candidate) =>
      candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
  );
  if (!(found instanceof window.HTMLButtonElement)) throw new Error(`button ${label} not found`);
  return found;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

async function filter(value: string): Promise<void> {
  const input = container!.querySelector('input[type="search"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
      input,
      value,
    );
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

async function key(target: HTMLElement, name: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("McpToolPicker", () => {
  it("groups read-only tools first, says the label is the server's, and counts what is on", async () => {
    const view = await render(CATALOG, ["list_issues"]);

    const groups = [...view.querySelectorAll('[role="group"][aria-label]')].map((group) =>
      group.getAttribute("aria-label"),
    );
    expect(groups).toEqual(["Show tools", "Read-only", "Can make changes", "Unavailable"]);
    expect(view.textContent).toContain("1 of 4 on");
    expect(view.textContent).toContain("1 of 2");
    expect(view.querySelector('[aria-label="About read-only tools"]')).not.toBeNull();
    expect(view.textContent).toContain("Destructive");
    // The exact name is never hidden behind the friendlier title.
    expect(view.textContent).toContain("List issues");
    expect(view.textContent).toContain("list_issues");
    expect(document.activeElement).toBe(view.querySelector('input[type="search"]'));
  });

  it("selects all, shows the mixed state, and deselects all — never the tool it cannot offer", async () => {
    await render();

    expect(state("Select all tools")).toBe("false");
    await click(box("List issues (list_issues)"));
    expect(state("Select all tools")).toBe("mixed");
    expect(state("Select all read-only tools")).toBe("mixed");

    await click(box("Select all tools"));
    for (const label of [
      "List issues (list_issues)",
      "Get issue (get_issue)",
      "Create issue (create_issue)",
      "Delete issue (delete_issue)",
    ]) {
      expect(state(label)).toBe("true");
    }
    expect(state("render_graph")).toBe("false");
    expect(box("render_graph").disabled).toBe(true);
    expect(container!.textContent).toContain("input schema exceeds the node limit");
    expect(state("Select all tools")).toBe("true");

    await click(box("Select all tools"));
    expect(state("Get issue (get_issue)")).toBe("false");
    expect(container!.textContent).toContain("0 of 4 on");
  });

  it("turns a whole group on and off from its own checkbox, leaving the other group alone", async () => {
    await render();

    await click(box("Select all tools that can make changes"));
    expect(state("Create issue (create_issue)")).toBe("true");
    expect(state("Delete issue (delete_issue)")).toBe("true");
    expect(state("List issues (list_issues)")).toBe("false");

    await click(box("Select all tools that can make changes"));
    expect(state("Create issue (create_issue)")).toBe("false");
  });

  it("makes Select all mean the listed tools once a filter narrows them", async () => {
    await render();

    await filter("issue");
    expect(container!.textContent).toContain("Select all 4 listed");
    await filter("create");
    expect(container!.textContent).toContain("Select all 1 listed");
    await click(box("Select all listed tools"));
    expect(state("Create issue (create_issue)")).toBe("true");

    await filter("");
    expect(state("List issues (list_issues)")).toBe("false");
    expect(state("Delete issue (delete_issue)")).toBe("false");
  });

  it("shows only what is on, or only what is off", async () => {
    const view = await render(CATALOG, ["get_issue"]);

    await click(button("On"));
    expect(view.textContent).toContain("Get issue");
    expect(view.textContent).not.toContain("Create issue");

    await click(button("Off"));
    expect(view.textContent).not.toContain("Get issue");
    expect(view.textContent).toContain("Create issue");
  });

  it("says when nothing matches, and puts every tool back in one click", async () => {
    const view = await render();

    await filter("nothing like this");
    expect(view.textContent).toContain("No tools match.");
    expect(view.querySelector('[aria-label="Select all tools"]')).toBeNull();
    await click(button("Show all tools"));
    expect(view.textContent).toContain("List issues");
    expect((view.querySelector('input[type="search"]') as HTMLInputElement).value).toBe("");
  });

  it("opens a tool to show its whole description and the arguments it takes", async () => {
    const view = await render();

    expect(view.textContent).not.toContain("Arguments");
    const open = button("Show details for List issues");
    expect(open.getAttribute("aria-expanded")).toBe("false");
    await click(open);
    expect(view.textContent).toContain("Arguments");
    expect(view.textContent).toContain("team");
    expect(view.textContent).toContain("limit?");
    await click(button("Hide details for List issues"));
    expect(view.textContent).not.toContain("Arguments");
  });

  it("offers no details control for a tool with nothing more to say", async () => {
    const view = await render([tool("bare", { description: "" })]);

    expect(view.querySelector('[aria-label="Show details for bare"]')).toBeNull();
    // A server that labels nothing gets one plain list: no group headings.
    expect(view.textContent).not.toContain("Read-only");
  });

  it("says a server offers no tools, rather than drawing an empty list", async () => {
    const view = await render([]);
    expect(view.textContent).toContain("This server offers no tools.");
    expect(view.textContent).toContain("0 of 0 on");
  });

  it("is one Tab stop: arrows, Home and End walk every checkbox, Right and Left reach details", async () => {
    await render();

    const stops = () =>
      [...container!.querySelectorAll<HTMLElement>('button[role="checkbox"]')].filter(
        (candidate) => candidate.tabIndex === 0,
      );
    // One stop for the whole list, and it starts on Select all.
    expect(stops()).toEqual([box("Select all tools")]);
    const details = button("Show details for List issues");
    expect(details.tabIndex).toBe(-1);

    const first = box("Select all tools");
    await act(async () => first.focus());
    await key(first, "ArrowDown");
    expect(document.activeElement).toBe(box("Select all read-only tools"));
    await key(document.activeElement as HTMLElement, "ArrowDown");
    expect(document.activeElement).toBe(box("List issues (list_issues)"));
    // The stop follows focus.
    expect(stops()).toEqual([box("List issues (list_issues)")]);

    await key(box("List issues (list_issues)"), "ArrowRight");
    expect(document.activeElement).toBe(details);
    await key(details, "ArrowLeft");
    expect(document.activeElement).toBe(box("List issues (list_issues)"));

    await key(box("List issues (list_issues)"), "ArrowUp");
    expect(document.activeElement).toBe(box("Select all read-only tools"));
    await key(document.activeElement as HTMLElement, "Home");
    expect(document.activeElement).toBe(first);
    await key(first, "ArrowUp");
    expect(document.activeElement).toBe(first);
    await key(first, "End");
    expect(document.activeElement).toBe(box("Delete issue (delete_issue)"));
    await key(box("Delete issue (delete_issue)"), "ArrowDown");
    expect(document.activeElement).toBe(box("Delete issue (delete_issue)"));
    // A row with no details, and keys that mean nothing here, go nowhere.
    await key(box("Select all tools"), "ArrowRight");
    await key(first, "a");
    expect(document.activeElement).toBe(box("Delete issue (delete_issue)"));
  });

  it("keeps a toggled row in place while On or Off is chosen", async () => {
    const view = await render(CATALOG, ["get_issue"]);

    await click(button("On"));
    await click(box("Get issue (get_issue)"));
    expect(state("Get issue (get_issue)")).toBe("false");
    expect(view.textContent).toContain("Get issue");
    // Choosing again re-reads who is on.
    await click(button("All"));
    await click(button("On"));
    expect(view.textContent).toContain("No tools match.");
  });

  it("clears a typed filter on Escape", async () => {
    const view = await render();
    await filter("create");
    const input = view.querySelector('input[type="search"]') as HTMLInputElement;
    await key(input, "Escape");
    expect(input.value).toBe("");
    expect(view.textContent).toContain("List issues");
    // An empty filter leaves Escape alone.
    await key(input, "Escape");
    expect(input.value).toBe("");
  });

  it("never lets a server's title stand in for another tool's name", async () => {
    await render([
      tool("list_items", { title: "List items" }),
      tool("delete_all", { title: "list_items" }),
    ]);
    expect(box("delete_all").getAttribute("aria-describedby")).not.toBeNull();
    expect(container!.querySelector('[aria-label="list_items (delete_all)"]')).toBeNull();
  });

  it("toggles from the title line, but not from reading the description", async () => {
    await render();
    const title = [...container!.querySelectorAll("label")].find((label) =>
      label.textContent?.startsWith("Get issue"),
    )!;
    await click(title);
    expect(state("Get issue (get_issue)")).toBe("true");
    const description = [...container!.querySelectorAll("span")].find(
      (span) => span.textContent === "get_issue description",
    )!;
    await click(description);
    expect(state("Get issue (get_issue)")).toBe("true");
  });
});
