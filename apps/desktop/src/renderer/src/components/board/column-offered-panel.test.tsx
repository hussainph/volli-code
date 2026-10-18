// @vitest-environment jsdom
/**
 * The Offered panel's ORIGIN-column drawing (VC-218).
 *
 * A release into the column every lifted card already stands in is not an
 * arrival, so it starts nothing whatever row the picker names — the arrival
 * rule `armedMoveDecision` keeps and `armed-run.test.ts` pins. What only the
 * drawing can hold is that the panel SAYS so: its Automation rows dimmed and
 * out of the pointer's reach, and the lit row Move only, at both sizes.
 */
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { NO_AUTOMATION_TRIGGER, type Automation } from "@volli/shared";

import {
  ColumnOfferedPanel,
  MOVE_ONLY_ROW,
  OFFERED_ROW_ATTRIBUTE,
  type ColumnOfferedPanelProps,
} from "./column-offered-panel";

let root: Root | null = null;
let container: HTMLElement | null = null;

function automation(id: string, name: string): Automation {
  return {
    id,
    projectId: "p1",
    name,
    instructions: "/implement",
    trigger: NO_AUTOMATION_TRIGGER,
    runtime: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

const ROWS = [automation("a1", "Implement"), automation("a2", "Two-opinion review")];

async function mount(props: Partial<ColumnOfferedPanelProps>): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ColumnOfferedPanel rows={ROWS} expanded highlighted={0} armedId="a1" {...props} />,
    );
  });
  const panel = container.querySelector<HTMLElement>("[data-offered-panel]");
  if (panel === null) throw new Error("no offered panel");
  return panel;
}

/** Every drawn row, Move only last, as `[name, lit, inert, pointer target]`. */
function rows(panel: HTMLElement): [string, boolean, boolean, string | null][] {
  // The panel's own children, less the footer line under them.
  return [...panel.children]
    .slice(0, -1)
    .map((row) => [
      row.querySelector("span")?.textContent ?? "",
      row.getAttribute("aria-current") === "true",
      row.getAttribute("data-offered-row-inert") === "true",
      row.getAttribute(OFFERED_ROW_ATTRIBUTE),
    ]);
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

describe("the Offered panel over the card's own column", () => {
  it("draws a live column's rows as targets, with the default lit", async () => {
    const panel = await mount({});
    expect(panel.getAttribute("data-offered-inert")).toBeNull();
    expect(rows(panel)).toEqual([
      ["Implement", true, false, "0"],
      ["Two-opinion review", false, false, "1"],
      ["Move only", false, false, MOVE_ONLY_ROW],
    ]);
    expect(panel.textContent).toContain("default");
  });

  it("dims the origin column's rows, takes them off the pointer, and lights Move only", async () => {
    // Whatever the picker's own highlight says: every release here moves only.
    const panel = await mount({ inert: true, highlighted: 1 });
    expect(panel.getAttribute("data-offered-inert")).toBe("true");
    expect(rows(panel)).toEqual([
      ["Implement", false, true, null],
      ["Two-opinion review", false, true, null],
      ["Move only", true, false, MOVE_ONLY_ROW],
    ]);
    for (const row of panel.querySelectorAll('[data-offered-row-inert="true"]')) {
      expect(row.className).toContain("opacity-50");
      expect(row.getAttribute("aria-disabled")).toBe("true");
    }
    expect(panel.querySelectorAll('[aria-disabled="true"]')).toHaveLength(ROWS.length);
    // The armed row is no default here: a plain release starts nothing either.
    expect(panel.textContent).not.toContain("default");
  });

  it("says the same at the compact size, before ⌥ grows it", async () => {
    const panel = await mount({ inert: true, expanded: false });
    expect(rows(panel).map(([name, lit, inert]) => [name, lit, inert])).toEqual([
      ["Implement", false, true],
      ["Two-opinion review", false, true],
      ["Move only", true, false],
    ]);
  });
});
