// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { WorkingCopyReading, WorkingCopySnapshot } from "@volli/shared";

import { ChatEmptyState } from "./chat-empty-state";
import { WorkingCopyChips } from "./working-copy-chips";
import { WorkingCopyVisual } from "./working-copy-visual";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useUiStore } from "@renderer/stores/ui";
import { useWorkingCopyStore, workingCopyKey } from "@renderer/stores/working-copy";

function workingCopy(over: Partial<WorkingCopySnapshot> = {}): WorkingCopySnapshot {
  return {
    kind: "worktree",
    path: "/worktrees/volli-code-abc/VC-81",
    branch: "volli/VC-81-auto-title",
    files: { committed: 4, modified: 2, added: 1, untracked: 3 },
    diff: { added: 214, removed: 63, base: "main" },
    ...over,
  };
}

function draw(node: React.ReactElement): string {
  return renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
}

/**
 * A live mount, for the cases that read a store state set by the test: a
 * static render reads zustand's initial snapshot and would draw the empty
 * store whatever was seeded. The working copy door answers the mount-time refresh
 * with `reading` — the same answer the seeded entry came from — so the read
 * settles (nothing is left in flight on the singleton for a later test to
 * inherit) and lands on the state the test drew.
 */
let mounted: { root: Root; host: HTMLElement } | null = null;
function mount(node: React.ReactElement, reading: WorkingCopyReading): string {
  Object.assign(window, {
    api: { workingCopy: { snapshot: vi.fn().mockResolvedValue({ ok: true, reading }) } },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<TooltipProvider>{node}</TooltipProvider>));
  mounted = { root, host };
  return host.innerHTML;
}

afterEach(async () => {
  if (mounted !== null) {
    // Let the mount-time read settle before the store is reset, so its answer
    // cannot land in the next test's store.
    await act(async () => {
      await Promise.resolve();
    });
    act(() => mounted?.root.unmount());
    mounted.host.remove();
    mounted = null;
  }
  Reflect.deleteProperty(window, "api");
  useWorkingCopyStore.setState({ byScope: {} });
  useUiStore.setState({ homeEmptyVisual: "streak" });
});

describe("WorkingCopyVisual", () => {
  it("draws one segment per non-empty state, summing to the total it prints", () => {
    const markup = draw(<WorkingCopyVisual workingCopy={workingCopy()} />);
    // 4 + 2 + 1 + 3 = 10, and the widths are that partition.
    expect(markup).toContain("10");
    expect(markup).toContain("width:40%"); // committed
    expect(markup).toContain("width:20%"); // modified
    expect(markup).toContain("width:10%"); // added
    expect(markup).toContain("width:30%"); // untracked
  });

  it("draws the hairline and names the base when there is one", () => {
    const markup = draw(<WorkingCopyVisual workingCopy={workingCopy()} />);
    expect(markup).toContain("+214");
    expect(markup).toContain("−63");
    expect(markup).toContain("vs main");
  });

  it("drops the hairline entirely for a working copy with no base", () => {
    const markup = draw(
      <WorkingCopyVisual
        workingCopy={workingCopy({
          kind: "main-checkout",
          diff: null,
          files: { committed: 0, modified: 2, added: 0, untracked: 1 },
        })}
      />,
    );
    // An empty diff track would read as "no work", which is the opposite of
    // what a dirty main checkout means.
    expect(markup).not.toContain("vs ");
    expect(markup).not.toContain("bg-destructive");
    expect(markup).toContain("3");
  });
});

describe("WorkingCopyChips", () => {
  it("names the working copy kind and the branch, and nothing else", () => {
    const markup = draw(<WorkingCopyChips workingCopy={workingCopy()} />);
    expect(markup).toContain("Worktree");
    expect(markup).toContain("volli/VC-81-auto-title");
    // No sentences: if a fact matters, it is drawn.
    expect(markup).not.toContain("working tree");
  });

  it("calls a project's own checkout by its own name", () => {
    expect(
      draw(<WorkingCopyChips workingCopy={workingCopy({ kind: "main-checkout" })} />),
    ).toContain("Main checkout");
  });

  it("names no branch on a detached HEAD rather than inventing one", () => {
    const markup = draw(<WorkingCopyChips workingCopy={workingCopy({ branch: null })} />);
    expect(markup).toContain("Worktree");
    expect(markup).not.toContain("HEAD");
  });

  it("puts the untruncated value one focus away, not only one hover", () => {
    // VC-288. The chip caps at `max-w-48` and truncates, which is right — a
    // caption wider than the drawing above it is what made the two read as
    // thrown together. What was wrong is where the whole value lived: a
    // tooltip on a `<span>`, which a pointer can reach and a keyboard cannot.
    const markup = draw(<WorkingCopyChips workingCopy={workingCopy()} />);
    const chips = markup.split("<button").slice(1);
    expect(chips).toHaveLength(2);
    for (const chip of chips) {
      // A real button: in the tab order, and therefore a trigger Radix opens
      // on focus as well as on hover.
      expect(chip).toContain('type="button"');
      expect(chip).not.toContain("disabled");
    }
    // And the full value is the control's own name, so nothing has to be
    // opened at all to hear it.
    expect(markup).toContain('aria-label="Worktree · /worktrees/volli-code-abc/VC-81"');
    expect(markup).toContain('aria-label="Branch · volli/VC-81-auto-title"');
  });
});

/**
 * These render the composed surface at its DEFAULTS, which is all a static
 * render can honestly see: zustand serves `getInitialState()` to
 * `useSyncExternalStore` during server rendering, so a seeded singleton would
 * not reach the tree. Which drawing a stored choice resolves to is asserted
 * where that decision lives (`empty-visual.test.ts`); what is asserted here is
 * the part no unit test can — that the two scopes draw different objects.
 */
describe("ChatEmptyState", () => {
  it("offers a Board Session the whole menu, and draws its default", () => {
    const markup = draw(<ChatEmptyState projectId="p1" ticketId={null} />);

    expect(markup).toContain('data-empty-visual="streak"');
    expect(markup).toContain("empty-visual-picker");
    expect(markup).toContain("Streak");
    expect(markup).toContain("Board");
    expect(markup).toContain("Venue");
  });

  it("offers a Ticket Session no menu at all, and none of Home's fields", () => {
    const markup = draw(<ChatEmptyState projectId="p1" ticketId="t1" />);

    // The shortness of a ticket's menu is the identity signal, so there is no
    // picker to show — one item is a statement dressed as a question.
    expect(markup).not.toContain("empty-visual-picker");
    expect(markup).not.toContain('data-empty-visual="streak"');
    expect(markup).not.toContain('data-empty-visual="board"');
  });

  it("says nothing about a working copy it has not read — no chips, no zeroed bar", () => {
    const markup = draw(<ChatEmptyState projectId="p1" ticketId="t1" />);

    expect(markup).not.toContain("Worktree");
    expect(markup).not.toContain('data-empty-visual="venue"');
  });

  it("draws the waiting shape, not the main checkout, for a ticket still resolving its worktree (VC-286)", () => {
    useWorkingCopyStore.setState({
      byScope: {
        // The project's own reading exists and is the main checkout — the
        // one thing this ticket's chat must not borrow while it waits.
        [workingCopyKey("p1", null)]: {
          status: "ready",
          workingCopy: workingCopy({ kind: "main-checkout", diff: null }),
        },
        [workingCopyKey("p1", "t1")]: { status: "resolving" },
      },
    });

    const markup = mount(<ChatEmptyState projectId="p1" ticketId="t1" />, { state: "pending" });

    expect(markup).toContain('data-working-copy-state="resolving"');
    expect(markup).not.toContain("Main checkout");
    expect(markup).not.toContain("Worktree");
    expect(markup).not.toContain('data-empty-visual="venue"');
  });

  it("draws the working copy once the ticket's checkout is measured", () => {
    useWorkingCopyStore.setState({
      byScope: { [workingCopyKey("p1", "t1")]: { status: "ready", workingCopy: workingCopy() } },
    });

    const markup = mount(<ChatEmptyState projectId="p1" ticketId="t1" />, {
      state: "measured",
      workingCopy: workingCopy(),
    });

    expect(markup).toContain('data-empty-visual="venue"');
    expect(markup).toContain("Worktree");
    expect(markup).not.toContain("data-working-copy-state");
  });
});
