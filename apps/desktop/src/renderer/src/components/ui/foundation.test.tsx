// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Button, buttonVariants } from "./button";
import { Checkbox } from "./checkbox";
import { CONTROL_SIZE } from "./field-classes";
import { Input } from "./input";
import { InputGroup, InputGroupInput } from "./input-group";
import { InlineRename } from "./inline-rename";
import { Badge } from "./badge";
import { Segmented } from "./segmented";
import { Switch } from "./switch";
import { Textarea } from "./textarea";
import { Select, SelectTrigger, SelectValue } from "./select";
import { TooltipProvider } from "./tooltip";
import { ValueReveal } from "./value-reveal";

const noop = () => {};
function markupClass(element: React.ReactElement): string {
  const html = renderToStaticMarkup(element);
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.body.firstElementChild?.className ?? "";
}

describe("foundation control contracts", () => {
  it.each(["default", "outline", "secondary", "destructive"] as const)(
    "%s keeps lift and sinks on press, without a click-scale animation",
    (variant) => {
      const classes = buttonVariants({ variant });
      expect(classes).toContain("shadow-control");
      expect(classes).toContain("active:shadow-control-pressed");
      expect(classes).not.toContain("scale-");
      expect(classes).toContain("rounded-control");
    },
  );

  it("keeps ghost actions flat even on hover, and bounds long labels", () => {
    const classes = markupClass(<Button variant="ghost">A very long action label</Button>);
    expect(classes.split(" ")).not.toContain("shadow-control");
    expect(classes).not.toContain("hover:shadow-control-hover");
    expect(classes).toContain("hover:bg-accent");
    expect(classes).toContain("max-w-full");
    expect(classes).toContain("whitespace-normal");
    expect(classes).toContain("h-auto");
  });

  it.each(["xs", "sm", "default", "lg"] as const)("shares the %s field/action inset", (size) => {
    const inset = CONTROL_SIZE[size].split(" ")[1];
    expect(markupClass(<Input controlSize={size} />)).toContain(inset);
    // xs actions gained readable label inset; fields retain the compact rung.
    const actionInset = size === "xs" ? "px-control-pad-default" : inset;
    expect(markupClass(<Button size={size}>Action</Button>)).toContain(actionInset);
    const group = markupClass(<InputGroup controlSize={size} />);
    expect(group).toContain(CONTROL_SIZE[size].split(" ")[0]);
    expect(group.split(" ")).toContain("px-0");
    expect(group).not.toContain(inset);
  });

  it("keeps fields calm on hover and contained fields flat", () => {
    for (const field of [
      <Input key="input" />,
      <Textarea key="textarea" />,
      <InputGroup key="group" />,
    ]) {
      const classes = markupClass(field);
      expect(classes).toContain("shadow-raised");
      expect(classes).not.toContain("hover:");
      expect(classes).toContain("border-border-strong");
    }
    const input = markupClass(<InputGroupInput />).split(" ");
    expect(input).toContain("shadow-none");
    expect(input).not.toContain("shadow-control");
    expect(input).toContain("border-0");
    expect(input).not.toContain("border");
  });

  it("draws selected segments filled and unselected segments outlined", () => {
    const html = renderToStaticMarkup(
      <Segmented
        ariaLabel="View"
        value="list"
        options={[
          { key: "list", label: "List" },
          { key: "grid", label: "Grid" },
        ]}
        onChange={noop}
      />,
    );
    expect(html).toMatch(/data-variant="default"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/data-variant="outline"[^>]*aria-pressed="false"/);
  });

  it("uses the same material for switch and checkbox in both states", () => {
    for (const checked of [false, true]) {
      expect(markupClass(<Switch checked={checked} />)).toContain("shadow-control");
      expect(markupClass(<Checkbox checked={checked} />)).toContain("shadow-control");
    }
    expect(renderToStaticMarkup(<Checkbox />)).toContain("calc(var(--radius-control) / 2)");
  });

  it("keeps the select trigger on the same rung and bevel as the input", () => {
    const html = renderToStaticMarkup(
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Choose" />
        </SelectTrigger>
      </Select>,
    );
    expect(html).toContain("data-[size=default]:h-control-default");
    expect(html).toContain("data-[size=sm]:px-1");
    expect(html).toContain("data-[size=sm]:leading-4");
    expect(html).toContain("shadow-control");
    expect(html).toContain("active:shadow-control-pressed");
  });

  it("uses role contrast for secondary badges, not a decorative font variant", () => {
    const html = renderToStaticMarkup(<Badge variant="secondary">Ready</Badge>);
    expect(html).toContain("bg-control-secondary");
    expect(html).toContain("font-medium");
    expect(html).not.toContain("font-mono");
  });
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = undefined;
  vi.unstubAllGlobals();
});

function mount(element: React.ReactElement) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(element));
  return host;
}

describe("foundation interaction contracts", () => {
  it("renames once on Enter followed by blur, and preserves caller value typography", () => {
    const onCommit = vi.fn();
    const node = mount(
      <InlineRename value="old" className="font-mono" onCommit={onCommit} onCancel={noop} />,
    );
    const input = node.querySelector("input")!;
    expect(input.className).toContain("font-mono");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "new");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    act(() => input.blur());
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("new");
  });

  it("reveals a sans descriptor and inherits the value font without changing the host font", () => {
    const node = mount(
      <TooltipProvider>
        <ValueReveal term="Branch" full="volli/VC-617" className="font-mono">
          <span>volli/VC-617</span>
        </ValueReveal>
      </TooltipProvider>,
    );
    const button = node.querySelector("button")!;
    expect(button.className).toContain("font-mono");
    const value = button.firstElementChild as HTMLElement;
    value.style.fontFamily = "Test Value Font";
    act(() => button.focus());
    const content = document.querySelector('[data-slot="tooltip-content"]')!;
    expect(content.querySelector(".font-sans")?.textContent).toBe("Branch");
    const revealed = Array.from(content.querySelectorAll("span")).find(
      (span) => span.textContent === "volli/VC-617",
    )!;
    expect(revealed.style.fontFamily).toBe(getComputedStyle(value).fontFamily);
    expect(revealed.classList.contains("font-mono")).toBe(false);
  });
});
