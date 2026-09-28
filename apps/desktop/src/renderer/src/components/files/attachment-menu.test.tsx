// @vitest-environment jsdom
/**
 * The paperclip menu that replaced the rail's permanent chip strip (VC-406,
 * revision 06).
 *
 * Two environments on purpose. The DETAIL is a drawing and is asserted as
 * static markup — what a row says, and which verbs a read-only host does NOT
 * get. The MENU is a surface that portals out of its host's render, so what it
 * needs proving is a real open: the trigger is reachable, what it opens lists
 * the attachments, and the picker's `change` path (the app's one file dialog)
 * reaches the caller.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BlobLinkView, NamedBlobLink } from "@volli/shared";

import { AttachmentMenu, AttachmentMenuDetail, attachmentMenuLabel } from "./attachment-menu";

const noop = (): void => {};

function attachment(label: string): BlobLinkView {
  return {
    linkId: `link-${label}`,
    blobHash: `hash-${label}`,
    label,
    originalName: `${label}.png`,
    mime: "image/png",
    sizeBytes: 1024,
  };
}

describe("AttachmentMenuDetail", () => {
  it("draws one compact row per attachment, with the owner's remove", () => {
    const html = renderToStaticMarkup(
      <AttachmentMenuDetail
        attachments={[attachment("spec"), attachment("mock")]}
        onAttachFiles={noop}
        onRemove={noop}
      />,
    );

    expect(html).toContain("spec");
    expect(html).toContain("mock");
    expect(html).toContain('aria-label="Remove spec"');
    // A row, not the composer's 64px tile and not a chip: this list is checked,
    // not looked at. The full file name rides the row's title.
    expect(html).not.toContain("size-16");
    expect(html).toContain("spec · spec.png");
  });

  it("is read-only for a host that supplied the list", () => {
    const html = renderToStaticMarkup(<AttachmentMenuDetail attachments={[attachment("spec")]} />);

    expect(html).toContain("spec");
    expect(html).not.toContain("Remove spec");
    expect(html).not.toContain("Attach files");
  });

  it("still offers Attach with nothing attached yet", () => {
    const html = renderToStaticMarkup(
      <AttachmentMenuDetail attachments={[]} onAttachFiles={noop} onRemove={noop} />,
    );

    expect(html).toContain("Nothing attached yet");
    expect(html).toContain('aria-label="Attach files"');
  });

  it("takes a host's read-only NamedBlobLink view as it is", () => {
    // The two lists that reach this menu are different types — the live strip
    // from `useAttachments` and a host's named view — and both are attachments.
    const named: NamedBlobLink = {
      linkId: "link-1",
      blobHash: "hash-1",
      label: "brief",
      originalName: "brief.pdf",
    };

    expect(renderToStaticMarkup(<AttachmentMenuDetail attachments={[named]} />)).toContain("brief");
  });
});

/** The header's paperclip, wherever it was mounted. */
function trigger(): HTMLButtonElement {
  const found = document.querySelector('[data-testid="rail-attachments-trigger"]');
  if (!(found instanceof HTMLButtonElement)) throw new Error("no paperclip");
  return found;
}

describe("attachmentMenuLabel", () => {
  it("carries the count, which is the discoverable part", () => {
    expect(attachmentMenuLabel(0)).toBe("Attachments");
    expect(attachmentMenuLabel(2)).toBe("Attachments (2)");
  });
});

describe("AttachmentMenu", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

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
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    document.querySelectorAll('[data-slot="popover-content"]').forEach((node) => node.remove());
    vi.unstubAllGlobals();
  });

  async function open(node: React.ReactElement): Promise<void> {
    await act(async () => {
      root?.render(node);
    });
    await act(async () => {
      trigger().click();
    });
  }

  it("says how many are attached before it is opened", async () => {
    await act(async () => {
      root?.render(<AttachmentMenu attachments={[attachment("spec")]} onRemove={noop} />);
    });

    expect(trigger().getAttribute("aria-label")).toBe("Attachments (1)");
    expect(trigger().getAttribute("title")).toBe("Attachments (1)");
    // The list is behind the press, not permanently on screen.
    expect(document.querySelectorAll('[data-testid="rail-attachments-list"]')).toHaveLength(0);
  });

  it("opens onto the real attachments, and removes one through the owner", async () => {
    const removed: BlobLinkView[] = [];
    await open(
      <AttachmentMenu
        attachments={[attachment("spec")]}
        onAttachFiles={noop}
        onRemove={(entry) => removed.push(entry)}
      />,
    );

    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
      "Attachments",
    );
    expect(document.querySelectorAll('[data-testid="rail-attachments-list"]')).toHaveLength(1);
    expect(document.body.textContent).toContain("spec");
    const remove = document.querySelector<HTMLButtonElement>('[aria-label="Remove spec"]');
    await act(async () => {
      remove?.click();
    });

    expect(removed.map((entry) => entry.label)).toEqual(["spec"]);
  });

  it("hands picked files to the caller through the app's own picker", async () => {
    const picked: string[] = [];
    await open(
      <AttachmentMenu
        attachments={[]}
        onAttachFiles={(files) => picked.push(...files.map((file) => file.name))}
      />,
    );

    const input = document.querySelector<HTMLInputElement>("input[data-composer-file-picker]");
    expect(input).not.toBeNull();
    const file = new File(["x"], "spec.pdf", { type: "application/pdf" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => {
      input?.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(picked).toEqual(["spec.pdf"]);
  });

  it("leaves the capped list a keyboard stop of its own, with no row to tab to", async () => {
    // The cap hides rows past 64px of list, and a read-only menu has no buttons
    // to tab through — without a stop on the scroller itself the overflow is
    // reachable by pointer only.
    await open(<AttachmentMenu attachments={[attachment("spec"), attachment("mock")]} />);

    const list = document.querySelector<HTMLElement>('[data-testid="rail-attachments-list"]');
    expect(list?.tabIndex).toBe(0);
    expect(list?.getAttribute("aria-label")).toBe("Attachments");
    expect(list?.className).toContain("focus-visible:ring-ring");
    list?.focus();
    expect(document.activeElement).toBe(list);
    // Focusable, not actionable: the rows stay as inert as they were.
    expect(document.querySelectorAll('[aria-label="Remove spec"]')).toHaveLength(0);
  });

  it("offers neither verb where the host owns the list", async () => {
    await open(<AttachmentMenu attachments={[attachment("spec")]} />);

    expect(document.body.textContent).toContain("spec");
    expect(document.querySelectorAll('[aria-label="Remove spec"]')).toHaveLength(0);
    expect(document.querySelectorAll('[aria-label="Attach files"]')).toHaveLength(0);
    expect(document.querySelectorAll("input[data-composer-file-picker]")).toHaveLength(0);
  });
});
