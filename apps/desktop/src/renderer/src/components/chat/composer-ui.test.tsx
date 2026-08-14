import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Button } from "@renderer/components/ui/button";
import { DropdownMenuContent, DropdownMenuItem } from "@renderer/components/ui/dropdown-menu";

import { SessionComposer, type SessionComposerProps } from "./composer-ui";

interface InspectableProps {
  "aria-label"?: string;
  children?: React.ReactNode;
  className?: string;
  density?: "default" | "compact";
  onClick?(): void;
  onCloseAutoFocus?(event: { preventDefault(): void }): void;
  onSelect?(): void;
}

function findElements(
  node: React.ReactNode,
  type: React.ElementType,
): React.ReactElement<InspectableProps>[] {
  const found: React.ReactElement<InspectableProps>[] = [];
  for (const child of React.Children.toArray(node)) {
    if (!React.isValidElement(child)) continue;
    if (child.type === type) found.push(child as React.ReactElement<InspectableProps>);
    found.push(...findElements((child.props as InspectableProps).children, type));
  }
  return found;
}

function composerProps(overrides: Partial<SessionComposerProps> = {}): SessionComposerProps {
  return {
    value: "",
    onValueChange: () => undefined,
    models: [],
    selection: { providerId: "", modelId: "", reasoningLevel: "" },
    onSelectionChange: () => undefined,
    working: true,
    ready: true,
    queued: [{ id: "m1", text: "also cover the empty-name branch" }],
    onQueuedChange: () => undefined,
    onSteerQueued: () => undefined,
    onSubmit: () => undefined,
    onStop: () => undefined,
    ...overrides,
  };
}

function renderComposer(working = true): string {
  return renderToStaticMarkup(<SessionComposer {...composerProps({ working })} />);
}

describe("the queued message row", () => {
  it("keeps steer and removal direct while editing lives behind an accessible menu", () => {
    const html = renderComposer();

    expect(html).toContain("Steer");
    expect(html).toContain('aria-label="Steer queued message: also cover the empty-name branch"');
    expect(html).toContain('aria-label="Remove queued message: also cover the empty-name branch"');
    expect(html).toContain('data-slot="dropdown-menu-trigger"');
    expect(html).toContain('aria-label="Queued message actions: also cover the empty-name branch"');
    expect(html).not.toContain('aria-label="Edit queued message"');
  });

  it("names every repeated queue control with the message it acts on", () => {
    const html = renderToStaticMarkup(
      <SessionComposer
        {...composerProps({
          queued: [
            { id: "m1", text: "first follow-up" },
            { id: "m2", text: "second follow-up" },
          ],
        })}
      />,
    );

    for (const text of ["first follow-up", "second follow-up"]) {
      expect(html).toContain(`aria-label="Queued message: ${text}"`);
      expect(html).toContain(`aria-label="Steer queued message: ${text}"`);
      expect(html).toContain(`aria-label="Remove queued message: ${text}"`);
      expect(html).toContain(`aria-label="Queued message actions: ${text}"`);
    }
  });

  it("wires Edit message to return that row to the current draft", () => {
    let nextQueue: readonly { id: string; text: string }[] | undefined;
    let nextDraft: string | undefined;
    const acts: string[] = [];
    const tree = SessionComposer(
      composerProps({
        value: "new thought",
        onQueuedChange: (queue) => {
          acts.push("queue");
          nextQueue = queue;
        },
        onValueChange: (value) => {
          acts.push("draft");
          nextDraft = value;
        },
        onComposerFocusRequest: () => acts.push("focus"),
      }),
    );
    const edits = findElements(tree, DropdownMenuItem);
    const edit = edits[0];
    const menu = findElements(tree, DropdownMenuContent)[0];
    let restorePrevented = false;

    expect(edits).toHaveLength(1);
    expect(renderToStaticMarkup(<>{edit?.props.children}</>)).toContain("Edit message");
    expect(edit?.props.density).toBe("compact");
    // Dismissing a menu with its trigger intact keeps Radix's normal restore.
    menu?.props.onCloseAutoFocus?.({ preventDefault: () => (restorePrevented = true) });
    expect(restorePrevented).toBe(false);
    edit?.props.onSelect?.();
    menu?.props.onCloseAutoFocus?.({
      preventDefault: () => {
        restorePrevented = true;
      },
    });
    expect(nextQueue).toEqual([]);
    expect(nextDraft).toBe("also cover the empty-name branch\nnew thought");
    expect(acts).toEqual(["queue", "draft", "focus"]);
    expect(restorePrevented).toBe(true);
  });

  it("does not edit or remove a row whose resident delivery claim rejects mutation", () => {
    let draft: string | undefined;
    let focusRequests = 0;
    const tree = SessionComposer(
      composerProps({
        onQueuedChange: () => false,
        onValueChange: (value) => {
          draft = value;
        },
        onComposerFocusRequest: () => {
          focusRequests += 1;
        },
      }),
    );

    findElements(tree, DropdownMenuItem)[0]?.props.onSelect?.();
    const remove = findElements(tree, Button).find(
      (button) =>
        button.props["aria-label"] === "Remove queued message: also cover the empty-name branch",
    );
    remove?.props.onClick?.();

    expect(draft).toBeUndefined();
    expect(focusRequests).toBe(0);
  });

  it("wires direct Steer and removal before handing focus to the composer", () => {
    let steered: string | undefined;
    let nextQueue: readonly { id: string; text: string }[] | undefined;
    const acts: string[] = [];
    const tree = SessionComposer(
      composerProps({
        onSteerQueued: (id) => {
          acts.push(`steer:${id}`);
          steered = id;
        },
        onQueuedChange: (queue) => {
          acts.push(`queue:${queue.length}`);
          nextQueue = queue;
        },
        onComposerFocusRequest: () => acts.push("focus"),
      }),
    );
    const buttons = findElements(tree, Button);
    const named = (label: string) => buttons.find((button) => button.props["aria-label"] === label);

    named("Steer queued message: also cover the empty-name branch")?.props.onClick?.();
    expect(acts).toEqual(["steer:m1", "focus"]);
    acts.length = 0;
    named("Remove queued message: also cover the empty-name branch")?.props.onClick?.();
    expect(steered).toBe("m1");
    expect(nextQueue).toEqual([]);
    expect(acts).toEqual(["queue:0", "focus"]);
  });

  it("offers Steer only while there is an active turn", () => {
    const html = renderComposer(false);

    expect(html).not.toContain('aria-label="Steer queued message:');
    expect(html).toContain('aria-label="Remove queued message:');
    expect(html).toContain('aria-label="Queued message actions:');
  });

  it("names turn interruption and draws keyboard focus on the outer rounded shell", () => {
    const html = renderComposer();

    expect(html).toContain('aria-label="Stop turn"');
    expect(html).not.toContain('aria-label="Stop"');
    expect(html).toContain("has-[[data-slot=input-group-control]:focus-visible]:ring-[3px]");
  });
});
