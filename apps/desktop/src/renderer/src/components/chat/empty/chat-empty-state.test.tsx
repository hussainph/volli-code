import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { VenueSnapshot } from "@volli/shared";

import { ChatEmptyState } from "./chat-empty-state";
import { VenueChips } from "./venue-chips";
import { VenueVisual } from "./venue-visual";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useUiStore } from "@renderer/stores/ui";
import { useVenueStore } from "@renderer/stores/venue";

function venue(over: Partial<VenueSnapshot> = {}): VenueSnapshot {
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

afterEach(() => {
  useVenueStore.setState({ byScope: {} });
  useUiStore.setState({ homeEmptyVisual: "streak" });
});

describe("VenueVisual", () => {
  it("draws one segment per non-empty state, summing to the total it prints", () => {
    const markup = draw(<VenueVisual venue={venue()} />);
    // 4 + 2 + 1 + 3 = 10, and the widths are that partition.
    expect(markup).toContain("10");
    expect(markup).toContain("width:40%"); // committed
    expect(markup).toContain("width:20%"); // modified
    expect(markup).toContain("width:10%"); // added
    expect(markup).toContain("width:30%"); // untracked
  });

  it("draws the hairline and names the base when there is one", () => {
    const markup = draw(<VenueVisual venue={venue()} />);
    expect(markup).toContain("+214");
    expect(markup).toContain("−63");
    expect(markup).toContain("vs main");
  });

  it("drops the hairline entirely for a venue with no base", () => {
    const markup = draw(
      <VenueVisual
        venue={venue({
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

describe("VenueChips", () => {
  it("names the venue kind and the branch, and nothing else", () => {
    const markup = draw(<VenueChips venue={venue()} />);
    expect(markup).toContain("Worktree");
    expect(markup).toContain("volli/VC-81-auto-title");
    // No sentences: if a fact matters, it is drawn.
    expect(markup).not.toContain("working tree");
  });

  it("calls a project's own checkout by its own name", () => {
    expect(draw(<VenueChips venue={venue({ kind: "main-checkout" })} />)).toContain(
      "Main checkout",
    );
  });

  it("names no branch on a detached HEAD rather than inventing one", () => {
    const markup = draw(<VenueChips venue={venue({ branch: null })} />);
    expect(markup).toContain("Worktree");
    expect(markup).not.toContain("HEAD");
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
  it("offers a Project Session the whole menu, and draws its default", () => {
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

  it("says nothing about a venue it has not read — no chips, no zeroed bar", () => {
    const markup = draw(<ChatEmptyState projectId="p1" ticketId="t1" />);

    expect(markup).not.toContain("Worktree");
    expect(markup).not.toContain('data-empty-visual="venue"');
  });
});
