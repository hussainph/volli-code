// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ComposerAddMenu } from "./composer-add-menu";

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function openMenu(element: React.ReactElement): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(element));
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Add to message"]')!;
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  return document.body;
}

describe("the `+` menu's attach row on a remote host (VC-713)", () => {
  it("stays, disabled, and says why, with no file input behind it", async () => {
    const body = await openMenu(
      <ComposerAddMenu
        onFiles={() => undefined}
        pickers={false}
        attachUnavailable="Not available on hetzner-1 yet"
      />,
    );
    const row = body.querySelector('[data-slot="attach-unavailable"]');
    expect(row?.textContent).toContain("Attach files…");
    expect(row?.textContent).toContain("Not available on hetzner-1 yet");
    expect(row?.getAttribute("data-disabled")).not.toBeNull();
    expect(container!.querySelector('input[type="file"]')).toBeNull();
  });

  it("offers the ordinary attach row for This Mac", async () => {
    const body = await openMenu(<ComposerAddMenu onFiles={() => undefined} pickers={false} />);
    expect(body.querySelector('[data-slot="attach-unavailable"]')).toBeNull();
    expect(body.textContent).toContain("Attach files…");
    expect(container!.querySelector('input[type="file"]')).not.toBeNull();
  });

  it("is a menu even on a surface that takes no files, to say they cannot be attached", async () => {
    const body = await openMenu(
      <ComposerAddMenu pickers={false} attachUnavailable="Not available on hetzner-1 yet" />,
    );
    expect(body.querySelector('[data-slot="attach-unavailable"]')).not.toBeNull();
  });
});
