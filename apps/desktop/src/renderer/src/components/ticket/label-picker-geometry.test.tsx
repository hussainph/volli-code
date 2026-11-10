// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { Popover, PopoverTrigger } from "@renderer/components/ui/popover";
import { LabelPickerContent, LabelPickerSurface } from "./label-picker";

it("keeps label search outside the sole bounded row scrollport and preserves keyboard multi-select", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const value = Array.from({ length: 50 }, (_, i) => `label-${String(i).padStart(2, "0")}`);
  const onChange = vi.fn();
  try {
    await act(async () =>
      root.render(
        <Popover open>
          <PopoverTrigger>Labels</PopoverTrigger>
          <LabelPickerSurface>
            <LabelPickerContent projectId="project-one" value={value} onChange={onChange} />
          </LabelPickerSurface>
        </Popover>,
      ),
    );
    const panel = document.querySelector<HTMLElement>('[data-slot="popover-content"]')!;
    const body = panel.querySelector<HTMLElement>('[data-slot="popover-body"]')!;
    expect(body.classList.contains("overflow-hidden")).toBe(true);
    expect(body.classList.contains("overflow-y-auto")).toBe(false);
    expect(body.className).toContain("available-height)-2px");
    const list = panel.querySelector<HTMLElement>('[role="listbox"]')!;
    expect(list.classList.contains("overflow-y-auto")).toBe(true);
    const search = panel.querySelector<HTMLInputElement>('[role="combobox"]')!;
    expect(list.contains(search)).toBe(false);
    await act(async () =>
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })),
    );
    expect(
      document.getElementById(search.getAttribute("aria-activedescendant")!)?.textContent,
    ).toBe("label-49");
    await act(async () =>
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(onChange).toHaveBeenCalledExactlyOnceWith(value.slice(0, -1));
    expect(panel.isConnected).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
