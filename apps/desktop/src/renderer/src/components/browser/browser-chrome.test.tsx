import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Button } from "@renderer/components/ui/button";
import { BrowserChrome, type BrowserChromeProps } from "./browser-chrome";

interface InspectableProps {
  "aria-label"?: string;
  children?: React.ReactNode;
  disabled?: boolean;
  onClick?(): void;
  onSubmit?(event: { preventDefault(): void }): void;
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

function props(overrides: Partial<BrowserChromeProps> = {}): BrowserChromeProps {
  return {
    tab: {
      tabId: "tab-1",
      projectId: "project-1",
      ticketId: null,
      createdBy: "user",
      url: "https://volli.dev/docs",
      title: "Volli docs",
      loading: false,
      canGoBack: false,
      canGoForward: true,
      generation: 2,
    },
    address: " https://example.com/next ",
    error: null,
    onAddressChange: () => undefined,
    onNavigate: () => undefined,
    onBack: () => undefined,
    onForward: () => undefined,
    onReload: () => undefined,
    onOpenDevTools: () => undefined,
    ...overrides,
  };
}

describe("BrowserChrome", () => {
  it("submits a trimmed address through the Browser Tab navigation command", () => {
    let navigated: string | undefined;
    let prevented = false;
    const tree = BrowserChrome(props({ onNavigate: (url) => (navigated = url) }));
    const form = findElements(tree, "form")[0];

    form?.props.onSubmit?.({ preventDefault: () => (prevented = true) });

    expect(prevented).toBe(true);
    expect(navigated).toBe("https://example.com/next");
  });

  it("drives history reachability and reload from pushed Browser Tab state", () => {
    const calls: string[] = [];
    const tree = BrowserChrome(
      props({
        onBack: () => calls.push("back"),
        onForward: () => calls.push("forward"),
        onReload: () => calls.push("reload"),
      }),
    );
    const buttons = findElements(tree, Button);
    const named = (label: string) => buttons.find((button) => button.props["aria-label"] === label);

    expect(named("Back")?.props.disabled).toBe(true);
    expect(named("Forward")?.props.disabled).toBe(false);
    named("Forward")?.props.onClick?.();
    named("Reload")?.props.onClick?.();
    expect(calls).toEqual(["forward", "reload"]);
  });

  it("shows the live page title, loading state, URL field, error, and DevTools control", () => {
    const html = renderToStaticMarkup(
      <BrowserChrome
        {...props({
          tab: { ...props().tab, loading: true },
          error: "Navigation failed",
        })}
      />,
    );

    expect(html).toContain("Volli docs");
    expect(html).toContain('aria-label="Address"');
    expect(html).toContain('value=" https://example.com/next "');
    expect(html).toContain('aria-label="Loading"');
    expect(html).toContain("Navigation failed");
    expect(html).toContain('aria-label="Open DevTools"');
  });
});
