import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Button } from "@renderer/components/ui/button";
import { BrowserHolderDot, browserHolderLabel } from "./browser-holder-dot";
import { BrowserHolderPill, type BrowserHolderPillProps } from "./browser-holder-pill";

interface InspectableProps {
  "aria-label"?: string;
  children?: React.ReactNode;
  onClick?(): void;
}

function findButtons(node: React.ReactNode): React.ReactElement<InspectableProps>[] {
  const found: React.ReactElement<InspectableProps>[] = [];
  for (const child of React.Children.toArray(node)) {
    if (!React.isValidElement(child)) continue;
    if (child.type === Button) found.push(child as React.ReactElement<InspectableProps>);
    found.push(...findButtons((child.props as InspectableProps).children));
  }
  return found;
}

const session = {
  kind: "session" as const,
  sessionId: "ses-a",
  name: "Fix checkout form",
  color: "#d07c00",
};

function props(overrides: Partial<BrowserHolderPillProps> = {}): BrowserHolderPillProps {
  return {
    holder: session,
    onTakeOver: () => undefined,
    onAskToLeave: () => undefined,
    onHandBack: () => undefined,
    ...overrides,
  };
}

describe("BrowserHolderPill (VC-239)", () => {
  it("offers a holding Session's two controls, wired to their handlers", () => {
    const calls: string[] = [];
    const buttons = findButtons(
      BrowserHolderPill(
        props({
          onTakeOver: () => calls.push("take over"),
          onAskToLeave: () => calls.push("ask to leave"),
          onHandBack: () => calls.push("hand back"),
        }),
      ),
    );
    expect(buttons.map((button) => button.props["aria-label"])).toEqual([
      "Take over",
      "Ask to leave",
    ]);
    for (const button of buttons) button.props.onClick?.();
    expect(calls).toEqual(["take over", "ask to leave"]);
  });

  it("offers the person one control, Hand back, and names the state Yours", () => {
    let handedBack = 0;
    const tree = BrowserHolderPill(
      props({ holder: { kind: "person" }, onHandBack: () => (handedBack += 1) }),
    );
    const buttons = findButtons(tree);
    expect(buttons.map((button) => button.props["aria-label"])).toEqual(["Hand back"]);
    buttons[0]?.props.onClick?.();
    expect(handedBack).toBe(1);
    expect(renderToStaticMarkup(tree)).toContain("Yours");
  });

  it("wears the Session's colour, and the foreground for the person", () => {
    expect(renderToStaticMarkup(BrowserHolderPill(props()))).toContain("background-color:#d07c00");
    expect(
      renderToStaticMarkup(BrowserHolderPill(props({ holder: { kind: "person" } }))),
    ).toContain("var(--foreground)");
  });
});

describe("BrowserHolderDot (VC-239)", () => {
  it("draws nothing for a free tab, the Session's colour for its hold, the foreground for the person", () => {
    expect(BrowserHolderDot({ holder: null })).toBeNull();
    const held = renderToStaticMarkup(<BrowserHolderDot holder={session} />);
    expect(held).toContain('data-holder="session"');
    expect(held).toContain("background-color:#d07c00");
    expect(held).toContain('aria-label="Held by Fix checkout form"');
    const yours = renderToStaticMarkup(<BrowserHolderDot holder={{ kind: "person" }} />);
    expect(yours).toContain('data-holder="person"');
    expect(yours).toContain("var(--foreground)");
    expect(browserHolderLabel({ kind: "person" })).toBe("Yours");
  });
});
