/** Production-contract audit fixture; no uploads or host persistence. */
import * as React from "react";
import type { BlobLinkView } from "@volli/shared";
import {
  AttachmentStrip,
  AttachmentThumbRow,
} from "@renderer/components/attachments/attachment-strip";
import { Button } from "@renderer/components/ui/button";

export const title = "Attachments · production tile audit (VC-617)";
export const note =
  "Real attachment components, local removal only; compare long labels, focus and wrapping with the lab theme controls.";
const FILES: readonly BlobLinkView[] = [
  {
    linkId: "pdf",
    blobHash: "a".repeat(64),
    label: "Design notes",
    originalName: "very-long-design-notes-for-this-project.pdf",
    mime: "application/pdf",
    sizeBytes: 1024,
  },
  {
    linkId: "zip",
    blobHash: "b".repeat(64),
    label: "Assets",
    originalName: "assets.zip",
    mime: "application/zip",
    sizeBytes: 2048,
  },
  {
    linkId: "txt",
    blobHash: "c".repeat(64),
    label: "Readme",
    originalName: "README",
    mime: "text/plain",
    sizeBytes: 10,
  },
  {
    linkId: "code",
    blobHash: "d".repeat(64),
    label: "Source",
    originalName: "source.ts",
    mime: "text/plain",
    sizeBytes: 4096,
  },
];
export default function AttachmentTiles() {
  const [files, setFiles] = React.useState(FILES);
  return (
    <div className="flex flex-col gap-6 p-4 text-ui">
      <Button variant="outline" size="sm" className="self-start" onClick={() => setFiles(FILES)}>
        Reset attachments
      </Button>
      <section aria-label="Editable attachments" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Composer</h2>
        <div className="w-full max-w-80 rounded-container border bg-card p-4">
          <AttachmentStrip
            attachments={files}
            onRemove={(file) =>
              setFiles((current) => current.filter((entry) => entry.linkId !== file.linkId))
            }
          />
        </div>
      </section>
      <section aria-label="Read-only attachments" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Sent</h2>
        <AttachmentStrip attachments={FILES} />
      </section>
      <section aria-label="Queued attachments" className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Queued</h2>
        <AttachmentThumbRow attachments={FILES} />
      </section>
    </div>
  );
}
