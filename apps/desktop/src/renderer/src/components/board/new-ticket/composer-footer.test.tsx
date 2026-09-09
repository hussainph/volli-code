// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Automation } from "@volli/shared";
import type { ComposerRun } from "./composer-run";

import { ComposerFooter, CreateRunAutomationItems } from "./composer-footer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";

const run: ComposerRun = {
  models: [],
  tiers: [],
  selection: null,
  setSelection: () => {},
};

function automation(id: string, name: string): Automation {
  return {
    id,
    name,
    projectId: "p1",
    instructions: "Run the work",
    trigger: { kind: "none" },
    runtime: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

const GROUPS = [
  {
    status: "todo" as const,
    label: "Todo",
    current: true,
    automations: [automation("a1", "Triage")],
  },
  {
    status: "doing" as const,
    label: "Doing",
    current: false,
    automations: [automation("a2", "Implement")],
  },
];

const automationRun = {
  ready: true,
  groups: GROUPS,
  enabledIds: [] as readonly string[],
  onRun: () => {},
};

let root: Root | null = null;
let container: HTMLElement | null = null;

/** Mount the items inside a real DropdownMenu and open it (Radix needs the Menu context). */
async function openItems(disabled = false): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger />
        <DropdownMenuContent>
          <CreateRunAutomationItems
            groups={GROUPS}
            enabledIds={[]}
            onRun={() => {}}
            disabled={disabled}
          />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

function render(
  overrides: {
    onAttachFiles?: (files: readonly File[]) => void;
    automationRun?: typeof automationRun;
    disabled?: boolean;
  } = {},
): string {
  return renderToStaticMarkup(
    <ComposerFooter
      run={run}
      createMore={false}
      onCreateMoreChange={() => {}}
      onCreate={() => {}}
      onKickoff={() => {}}
      automationRun={overrides.automationRun ?? automationRun}
      disabled={overrides.disabled ?? false}
      {...overrides}
    />,
  );
}

/**
 * VC-115: the footer carried two paperclips — this one, and a popover that
 * searched the project file index. The second is gone, so what these assert is
 * a COUNT, not just a presence: a returning project-file icon fails the first
 * test even though every other assertion still passes.
 */
describe("the composer footer's attach affordance", () => {
  it("offers exactly one paperclip, and it is the system file picker", () => {
    const html = render({ onAttachFiles: () => {} });

    expect(html.match(/aria-label="Attach files"/g)).toHaveLength(1);
    expect(html.match(/type="file"/g)).toHaveLength(1);
    expect(html).toContain("multiple");
  });

  it("no longer renders the project file-reference picker", () => {
    const html = render({ onAttachFiles: () => {} });

    expect(html).not.toContain("Attach file reference");
    expect(html).not.toContain("Search files…");
  });

  it("renders no attach control at all when the composer takes no files", () => {
    const html = render();

    expect(html).not.toContain('aria-label="Attach files"');
    expect(html).not.toContain('type="file"');
  });
});

/**
 * VC-329 item 4: the third commit. A caret welded onto the commit pill opens
 * the saved Automations, grouped by column; choosing one creates the ticket in
 * the chip's status and runs that record on it — not a rewritten prompt.
 */
describe("the composer footer's Create & run automation caret", () => {
  it("is always drawn, even for a project with no automations", () => {
    const html = render({ automationRun: { ...automationRun, groups: [] } });

    expect(html).toContain('data-testid="composer-run-automation"');
    expect(html).toContain('aria-label="Create and run an automation"');
  });

  it("lists the saved automations grouped and labelled by column", async () => {
    await openItems();

    const text = document.body.textContent ?? "";
    expect(text).toContain("Todo");
    expect(text).toContain("· this column");
    expect(text).toContain("Create & run: Triage");
    expect(text).toContain("Doing");
    expect(text).toContain("Create & run: Implement");
  });

  it("says so when the project lists no automations", () => {
    const html = renderToStaticMarkup(
      <CreateRunAutomationItems groups={[]} enabledIds={[]} onRun={() => {}} disabled={false} />,
    );

    expect(html).toContain("No ticket automations in this project.");
  });

  it("disables the automation rows while the composer cannot commit", async () => {
    await openItems(true);

    const items = [...document.querySelectorAll('[data-slot="dropdown-menu-item"]')];
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.getAttribute("data-disabled") !== null)).toBe(true);
  });
});

it("does not claim an empty catalogue or expose cached runs while reading", () => {
  const html = renderToStaticMarkup(
    <CreateRunAutomationItems
      groups={GROUPS}
      ready={false}
      enabledIds={[]}
      onRun={() => {}}
      disabled={false}
    />,
  );
  expect(html).toContain("Reading automations");
  expect(html).not.toContain("No ticket automations");
  expect(html).not.toContain("Implement");
});
