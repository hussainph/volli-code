// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { SettingsIcon } from "@renderer/components/ui/icon";

import { afterEach, expect, it, vi } from "vite-plus/test";
import { PrefShell, type PrefGroup } from "./pref-shell";

const groups: readonly PrefGroup[] = [
  {
    key: "preferences",
    label: "Preferences",
    categories: [
      {
        key: "appearance",
        label: "Appearance",
        icon: SettingsIcon,
        count: 3,
        attention: { state: "waiting", label: "Needs attention" },
        content: <p>Appearance controls</p>,
      },
    ],
  },
];
let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

it("keeps rail identities centred, selection, counts and attention on tinted glass", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollTo = vi.fn();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const onSelect = vi.fn();
  act(() =>
    root?.render(
      <PrefShell
        surfaceLabel="Settings"
        groups={groups}
        activeKey="appearance"
        onSelect={onSelect}
      />,
    ),
  );
  const nav = host.querySelector("nav")!;
  expect(nav.dataset.slot).toBe("pref-navigation");
  expect(nav.classList.contains("glass")).toBe(true);
  expect(host.querySelector('[data-slot="pref-shell"]')?.getAttribute("style")).toBeNull();
  expect(nav.querySelector('[data-slot="identity-tile"][data-size="sm"] svg')).not.toBeNull();
  const selected = nav.querySelector<HTMLButtonElement>('[aria-current="page"]')!;
  expect(selected.textContent).toContain("3");
  expect(selected.textContent).toContain("Needs attention");
  act(() => selected.click());
  expect(onSelect).toHaveBeenCalledWith("appearance");
  expect(host.textContent).toContain("Appearance controls");
});

it("preserves result routing, empty results and native search clearing", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollTo = vi.fn();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const onSelect = vi.fn();
  act(() =>
    root?.render(
      <PrefShell
        surfaceLabel="Settings"
        groups={groups}
        activeKey="appearance"
        onSelect={onSelect}
      />,
    ),
  );
  const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  const type = (value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  expect(input.closest('[data-slot="input-group"]')?.classList.contains("search-capsule")).toBe(
    true,
  );
  type("Motion");
  expect(host.textContent).toContain("1 setting found");
  const result = host.querySelector<HTMLButtonElement>("nav button")!;
  expect(result.querySelector('[data-slot="identity-tile"]')).not.toBeNull();
  act(() => result.click());
  expect(onSelect).toHaveBeenCalledWith("appearance");
  expect(input.value).toBe("");
  type("no-such-preference");
  expect(host.textContent).not.toContain("No matching settings");
  expect(host.querySelector('[role="status"]')?.textContent).toBe("0 settings found");
  expect(host.querySelector('[role="status"]')?.getAttribute("aria-live")).toBe("polite");
  type("");
  expect(host.querySelector('[aria-current="page"]')).not.toBeNull();
});

it("uses sibling floating glass and paper planes with the shared heading ladder", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollTo = vi.fn();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() =>
    root?.render(
      <PrefShell
        surfaceLabel="Settings"
        groups={groups}
        activeKey="appearance"
        onSelect={() => {}}
      />,
    ),
  );
  expect(host.querySelector("nav")?.className).toContain("rounded-none");
  expect(host.querySelector("nav")?.className).toContain("border-r");
  expect(host.querySelector("h1")?.className).toContain("text-title");
  expect(host.querySelector("h3")?.className).toContain("text-ui font-semibold");
});
