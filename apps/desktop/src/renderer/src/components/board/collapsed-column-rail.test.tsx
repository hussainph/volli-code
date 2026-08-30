// @vitest-environment jsdom
/**
 * The rail's pills, as the ⌥ drag picker sees them (VC-132).
 *
 * One claim, and it is the one the pills failed on: **a collapsed pill is a
 * column**. An empty column can be ARMED — arming is a property of the column
 * and has nothing to do with whether a ticket is sitting in it — so a drag over
 * its pill must be able to grow the same Offered list, and a release under ⌥
 * must land on a named target there like anywhere else. While the pill carried
 * no `data-board-column`, the board's hit test could not name the column under
 * the pointer: ⌥ opened nothing, the hint never appeared, `Move only` could not
 * be aimed at, and the release started the armed countdown anyway.
 *
 * The picker's own arithmetic is unit-tested in `drag-picker-model.ts` and its
 * real ⌥ is driven in `e2e/automations-picker-smoke.mjs`. What only a rendered
 * pill can hold is what those two both trust: that the hit test
 * `board.tsx#pointerLanding` performs — `closest("[data-board-column]")` from
 * whatever is under the pointer — answers with this pill's status, for the pill
 * itself AND for every row of the panel floating over it. So that exact
 * composition is what this asserts, rather than the attribute in isolation.
 */
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { NO_AUTOMATION_TRIGGER, type Automation, type TicketStatus } from "@volli/shared";

import { CollapsedColumnRail } from "./collapsed-column-rail";
import type { ColumnOfferedPanelProps } from "./column-offered-panel";

let root: Root | null = null;
let container: HTMLElement | null = null;

function automation(id: string, name: string): Automation {
  return {
    id,
    projectId: "p1",
    name,
    instructions: "/review",
    trigger: NO_AUTOMATION_TRIGGER,
    runtime: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

const OFFERED = [automation("a1", "Implement"), automation("a2", "Two-opinion review")];

async function mount(options: {
  offeredFor?: (status: TicketStatus) => ColumnOfferedPanelProps | undefined;
  dimmedFor?: (status: TicketStatus) => boolean;
}) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <CollapsedColumnRail
        statuses={["needs_review", "done"]}
        dragActive
        onExpand={() => {}}
        animateEnter={false}
        offeredFor={options.offeredFor}
        dimmedFor={options.dimmedFor}
      />,
    );
  });
}

/** The board's own hit test, performed on an element the way a pointer would. */
function columnUnder(element: Element | null): string | null {
  return element?.closest<HTMLElement>("[data-board-column]")?.dataset["boardColumn"] ?? null;
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

describe("a collapsed pill", () => {
  it("names its column to the picker's hit test, like a standing column's root", async () => {
    await mount({});

    for (const status of ["needs_review", "done"]) {
      const pill = container?.querySelector(`[data-board-column="${status}"] button`) ?? null;
      expect(pill).not.toBeNull();
      expect(columnUnder(pill)).toBe(status);
    }
  });

  it("grows the picker: every landing target over a pill answers with that pill's column", async () => {
    await mount({
      offeredFor: (status) =>
        status === "needs_review"
          ? { rows: OFFERED, expanded: true, highlighted: 0, armedId: "a1" }
          : undefined,
    });

    // Two Automations plus Move only, each a target carrying its digit — the
    // same panel a standing column grows, drawn over the pill.
    const rows = [...(container?.querySelectorAll("[data-offered-row]") ?? [])];
    expect(rows.map((row) => row.getAttribute("data-offered-row"))).toEqual([
      "0",
      "1",
      "move-only",
    ]);
    // Including Move only: the target whose whole job is to be aimed at in a
    // column that would otherwise fire on arrival.
    for (const row of rows) expect(columnUnder(row)).toBe("needs_review");
    // And the column the pointer is not over grows nothing.
    expect(container?.querySelector('[data-board-column="done"] [data-offered-panel]')).toBeNull();
  });

  it("quiets the pills another column's open picker is not about", async () => {
    await mount({ dimmedFor: (status) => status === "done" });

    expect(container?.querySelector('[data-board-column="done"]')?.className).toContain(
      "opacity-50",
    );
    expect(container?.querySelector('[data-board-column="needs_review"]')?.className).not.toContain(
      "opacity-50",
    );
  });
});
