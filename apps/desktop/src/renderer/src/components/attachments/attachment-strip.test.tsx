// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { blobUrl, type BlobLinkView } from "@volli/shared";
import { AttachmentStrip, AttachmentThumb, middleTruncate } from "./attachment-strip";

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
  it("shows a file glyph, size and single-line name with a preserved tail", async () => {
    await act(async () => root.render(<AttachmentThumb attachment={pdf} />));
    const tile = host.firstElementChild!;
    expect(tile.classList.contains("max-w-full")).toBe(true);
    expect(tile.classList.contains("bg-card")).toBe(true);
    expect(host.querySelector("svg")).not.toBeNull();
    const name = host.querySelector(`[title="${pdf.originalName}"]`)!;
    expect(name.classList.contains("truncate")).toBe(true);
    expect(name.classList.contains("text-label")).toBe(true);
    expect(name.querySelector(".sr-only")!.textContent).toBe(pdf.originalName);
    // One string with a flush ellipsis: start of the name, then the tail with its extension.
    expect(name.firstElementChild!.textContent).toBe("very-long-desi…oject.pdf");
    expect(host.textContent).toContain("PDF · 1.0 KB");
    expect(tile.getAttribute("title")).toBe(`${pdf.originalName} · PDF · 1.0 KB`);
  });

  it.each(["queued", "uploading", "failed"] as const)(
    "announces %s without trying to preview an unfinished upload",
    async (state) => {
      await act(async () => root.render(<AttachmentThumb attachment={{ ...image, state }} />));
      const label =
        state === "failed" ? "Upload failed" : state === "uploading" ? "Uploading" : "Queued";
      expect(
        host
          .querySelector(`[role="${state === "failed" ? "alert" : "status"}"]`)
          ?.getAttribute("aria-label"),
      ).toBe(`${image.originalName}: ${label}`);
      expect(host.textContent).toContain(label);
      if (state !== "queued") expect(host.querySelector("img")).toBeNull();
      if (state === "uploading") expect(host.querySelector(".animate-spin")).not.toBeNull();
    },
  );

  it("keeps images labeled and served from the blob store", async () => {
    await act(async () => root.render(<AttachmentThumb attachment={image} />));
    const img = host.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(blobUrl(image.blobHash));
    expect(img.alt).toBe(image.label);
    expect(img.draggable).toBe(false);
    expect(img.classList.contains("size-16")).toBe(true);
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

describe("bounded composer attachments", () => {
  it("gives a long filename one bounded card edge without shrinking its hit target", async () => {
    await act(async () =>
      root.render(<AttachmentStrip presentation="composer" attachments={[pdf]} />),
    );
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Manage 1 attachments"]')!;
    expect(trigger.dataset.size).toBe("sm");
    expect(trigger.classList.contains("max-w-full")).toBe(true);
    // The chat-only CSS owns its face; this shared token also serves ticket capture.
    expect(trigger.classList.contains("border-border")).toBe(false);
    expect(trigger.classList.contains("bg-card")).toBe(false);
    expect(trigger.textContent).toBe(pdf.originalName);
    expect(trigger.querySelector(".truncate")).not.toBeNull();
    await act(async () => trigger.click());
    const manager = document.querySelector('[data-slot="attachment-manager"]')!;
    expect(manager.querySelector(".sr-only")!.textContent).toBe(pdf.originalName);
  });

  it.each([0, 3, 50])(
    "keeps %i files in one token row and makes every removal reachable in the manager",
    async (count) => {
      const attachments = Array.from({ length: count }, (_, i) => ({
        ...pdf,
        linkId: `link-${i}`,
        label: `File ${i}`,
        originalName: `file-${i}.txt`,
      }));
      const remove = vi.fn();
      await act(async () =>
        root.render(
          <AttachmentStrip presentation="composer" attachments={attachments} onRemove={remove} />,
        ),
      );
      expect(host.querySelectorAll('[role="listitem"]')).toHaveLength(0);
      const trigger = host.querySelector<HTMLButtonElement>(
        `[aria-label="Manage ${count} attachments"]`,
      );
      if (count === 0) {
        expect(trigger).toBeNull();
        return;
      }
      expect(host.querySelectorAll('[data-slot="composer-attachments"]')).toHaveLength(1);
      await act(async () => trigger?.click());
      const manager = document.querySelector('[data-slot="attachment-manager"]');
      expect(manager?.className).toContain("overflow-y-auto");
      expect(manager?.querySelectorAll('[role="listitem"]')).toHaveLength(count);
      const last = manager?.querySelector<HTMLButtonElement>(
        `[aria-label="Remove File ${count - 1}"]`,
      );
      await act(async () => last?.click());
      expect(remove).toHaveBeenCalledExactlyOnceWith(attachments[count - 1]);
    },
  );
});

describe("middleTruncate", () => {
  it("keeps short names whole and cuts long ones once, keeping the extension", () => {
    expect(middleTruncate("README")).toBe("README");
    expect(middleTruncate("very-long-design-notes-for-this-project.pdf")).toBe(
      "very-long-desi…oject.pdf",
    );
    expect(middleTruncate("x".repeat(24))).toHaveLength(24);
    expect(middleTruncate("x".repeat(40))).toHaveLength(24);
    expect(middleTruncate("very-long-design-notes-for-this-project.pdf", 18)).toBe(
      "very-lon…oject.pdf",
    );
  });
});
