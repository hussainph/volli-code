// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { blobUrl, type BlobLinkView } from "@volli/shared";
import { AttachmentStrip, AttachmentThumb } from "./attachment-strip";

const pdf: BlobLinkView = {
  linkId: "pdf-link",
  blobHash: "a".repeat(64),
  label: "Design notes",
  originalName: "very-long-design-notes-for-this-project.pdf",
  mime: "application/pdf",
  sizeBytes: 1024,
};
const image: BlobLinkView = {
  ...pdf,
  linkId: "image-link",
  label: "Screenshot",
  mime: "image/png",
};
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("attachment tile contract", () => {
  it("takes the label rung and full token ink without changing the 64px tile", async () => {
    await act(async () => root.render(<AttachmentThumb attachment={pdf} />));
    const tile = host.firstElementChild!;
    expect(tile.classList.contains("size-16")).toBe(true);
    const card = host.querySelector('[aria-label="Design notes · PDF · 1.0 KB"]');
    expect(card).not.toBeNull();
    expect(card!.classList.contains("p-2")).toBe(true);
    expect(card!.classList.contains("bg-muted")).toBe(true);
    const labels = card!.querySelectorAll("span");
    expect(labels).toHaveLength(2);
    for (const label of labels) {
      expect(label.classList.contains("text-label")).toBe(true);
      // The rung owns letter-spacing; an extra utility can override it by CSS order.
      expect([...label.classList].some((token) => token.startsWith("tracking-"))).toBe(false);
    }
    expect(labels[1].classList.contains("text-foreground")).toBe(true);
    expect(labels[1].classList.contains("line-clamp-2")).toBe(true);
    expect(labels[1].textContent).toBe(pdf.originalName);
    expect(tile.getAttribute("title")).toBe("Design notes · PDF · 1.0 KB");
  });

  it("keeps images labeled and served from the blob store", async () => {
    await act(async () => root.render(<AttachmentThumb attachment={image} />));
    const img = host.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(blobUrl(image.blobHash));
    expect(img.alt).toBe(image.label);
    expect(img.draggable).toBe(false);
  });

  it("uses the shared icon button and passes the exact attachment to removal", async () => {
    const remove = vi.fn();
    await act(async () => root.render(<AttachmentThumb attachment={pdf} onRemove={remove} />));
    const button = host.querySelector("button")!;
    expect(button.dataset.size).toBe("icon-xs");
    expect(button.getAttribute("aria-label")).toBe("Remove Design notes");
    expect(button.classList.contains("focus-visible:opacity-100")).toBe(true);
    expect(button.classList.contains("group-hover:opacity-100")).toBe(true);
    await act(async () => button.click());
    expect(remove).toHaveBeenCalledExactlyOnceWith(pdf);
  });

  it("does not offer removal on a sent/read-only attachment", async () => {
    await act(async () => root.render(<AttachmentThumb attachment={pdf} />));
    expect(host.querySelector("button")).toBeNull();
  });

  it("keeps empty strips absent and populated strips list-shaped", async () => {
    await act(async () => root.render(<AttachmentStrip attachments={[]} />));
    expect(host.children).toHaveLength(0);
    await act(async () => root.render(<AttachmentStrip attachments={[pdf, image]} />));
    expect(host.querySelector('[role="list"]')?.getAttribute("aria-label")).toBe("Attachments");
    expect(host.querySelectorAll('[role="listitem"]')).toHaveLength(2);
  });
});
