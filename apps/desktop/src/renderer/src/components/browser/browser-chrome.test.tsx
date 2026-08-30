import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { BROWSER_START_URL } from "../../../../browser-start-page";
import { BrowserChrome, normalizeBrowserAddress, type BrowserChromeProps } from "./browser-chrome";

interface InspectableProps {
  "aria-label"?: string;
  children?: React.ReactNode;
  disabled?: boolean;
  placeholder?: string;
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
      error: null,
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

describe("normalizeBrowserAddress", () => {
  it("defaults public hosts to HTTPS and loopback development hosts to HTTP", () => {
    expect(normalizeBrowserAddress("excalidraw.com")).toBe("https://excalidraw.com");
    expect(normalizeBrowserAddress("localhost:5173/app")).toBe("http://localhost:5173/app");
    expect(normalizeBrowserAddress("127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  });

  it("preserves explicit schemes so main still judges disallowed targets", () => {
    expect(normalizeBrowserAddress(" https://volli.dev/docs ")).toBe("https://volli.dev/docs");
    expect(normalizeBrowserAddress("file:///etc/passwd")).toBe("file:///etc/passwd");
    expect(normalizeBrowserAddress("javascript:alert(1)")).toBe("javascript:alert(1)");
  });
});

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

  it("names the empty field and hands the pane a way to aim at it", () => {
    // The aiming itself lives in `BrowserPane` (a menu restores focus to its
    // trigger after this tree commits, so the caret is taken a frame later);
    // this component's share of the job is the handle and the placeholder.
    const ref = { current: null };
    const input = findElements(BrowserChrome(props({ address: "", addressRef: ref })), Input)[0];

    expect(input?.props.placeholder).toBe("Enter a URL");
    expect((input?.props as { ref?: unknown } | undefined)?.ref).toBe(ref);
  });

  it("names a blank tab in the trailing title slot instead of showing its scheme", () => {
    const html = renderToStaticMarkup(
      <BrowserChrome
        {...props({
          // Chromium may report the raw URL as the document title. The blank
          // tab policy still wins in every title surface, not only the strip.
          tab: { ...props().tab, url: BROWSER_START_URL, title: BROWSER_START_URL },
          address: "",
        })}
      />,
    );

    expect(html).toContain("New Tab");
    expect(html).not.toContain(BROWSER_START_URL);
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
