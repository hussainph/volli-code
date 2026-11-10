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

  it("stands a non-image up as a glyph rather than a broken picture", () => {
    const html = renderToStaticMarkup(
      <AttachmentThumbRow attachments={[view("spec.pdf", "application/pdf", "c".repeat(64))]} />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("<svg");
    // The type still reaches the person, on the tooltip where it is readable.
    expect(html).toContain("spec.pdf · PDF");
  });

  it("keeps one named card beside the queued message and names the overflow", () => {
    const html = renderToStaticMarkup(
      <AttachmentThumbRow attachments={[png(1), png(2), png(3), png(4), png(5)]} />,
    );
    expect(html.match(/<img/g)).toHaveLength(1);
    expect(html).toContain("+4");
    expect(html).toContain("5 attachments");
    expect(html).toContain("4 more attachments: shot-2.png, shot-3.png, shot-4.png, shot-5.png");
    expect(html).toContain("PNG · 1.0 KB");
    expect(html).toContain("Queued");
    expect(html).toContain('title="shot-1.png"');
    expect(html).toContain('class="sr-only">shot-1.png');
  });

  it("honors an explicit cap", () => {
    const html = renderToStaticMarkup(
      <AttachmentThumbRow attachments={[png(1), png(2), png(3), png(4)]} max={3} />,
    );
    expect(html.match(/<img/g)).toHaveLength(3);
    expect(html).toContain("+1");
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
