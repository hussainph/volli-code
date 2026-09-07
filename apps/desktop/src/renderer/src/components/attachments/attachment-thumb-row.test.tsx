import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { blobUrl, type BlobLinkView } from "@volli/shared";

import { AttachmentThumbRow } from "./attachment-strip";

function view(name: string, mime: string, hash: string): BlobLinkView {
  return {
    linkId: `l-${name}`,
    blobHash: hash,
    label: name,
    originalName: name,
    mime,
    sizeBytes: 1024,
  };
}

const png = (n: number) => view(`shot-${n}.png`, "image/png", String(n).repeat(64));

describe("AttachmentThumbRow (VC-273)", () => {
  it("renders nothing when nothing is attached", () => {
    expect(renderToStaticMarkup(<AttachmentThumbRow attachments={[]} />)).toBe("");
  });

  it("draws an image attachment as itself, over volli-blob", () => {
    const attachment = png(1);
    const html = renderToStaticMarkup(<AttachmentThumbRow attachments={[attachment]} />);
    expect(html).toContain(`src="${blobUrl(attachment.blobHash)}"`);
    expect(html).toContain("1 attachment");
  });

  it("stands a non-image up as its type rather than a broken picture", () => {
    const html = renderToStaticMarkup(
      <AttachmentThumbRow attachments={[view("spec.pdf", "application/pdf", "c".repeat(64))]} />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("PDF");
  });

  it("caps the row and counts the remainder", () => {
    const html = renderToStaticMarkup(
      <AttachmentThumbRow attachments={[png(1), png(2), png(3), png(4), png(5)]} />,
    );
    // Three drawn, two counted — the row shares one composer line with the
    // message text and its three controls.
    expect(html.match(/<img/g)).toHaveLength(3);
    expect(html).toContain("+2");
    expect(html).toContain("5 attachments");
  });

  it("pluralizes its group label", () => {
    expect(renderToStaticMarkup(<AttachmentThumbRow attachments={[png(1)]} />)).toContain(
      'aria-label="1 attachment"',
    );
    expect(renderToStaticMarkup(<AttachmentThumbRow attachments={[png(1), png(2)]} />)).toContain(
      'aria-label="2 attachments"',
    );
  });
});
