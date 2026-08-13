import { describe, expect, it, vi } from "vite-plus/test";

import type { DocumentIdentity } from "./document-identity";
import { startUnsavedDocumentReporting, unsavedDocumentLabels } from "./unsaved-report";

const fileIdentity = (relPath: string): DocumentIdentity => ({
  kind: "file",
  projectId: "project-1",
  checkout: { kind: "main" },
  relPath,
});

describe("unsavedDocumentLabels", () => {
  it("names a file by its basename", () => {
    expect(unsavedDocumentLabels([fileIdentity("src/models/train.py")])).toEqual(["train.py"]);
  });

  it("names a ticket body by what it is", () => {
    expect(
      unsavedDocumentLabels([{ kind: "ticket-body", projectId: "p1", ticketId: "t1" }]),
    ).toEqual(["Ticket description"]);
  });

  /** Two same-named files in different checkouts are two drafts at risk, not one. */
  it("keeps duplicate basenames so the count stays truthful", () => {
    expect(
      unsavedDocumentLabels([
        fileIdentity("train.py"),
        {
          kind: "file",
          projectId: "p1",
          checkout: { kind: "ticket", ticketId: "t1" },
          relPath: "train.py",
        },
      ]),
    ).toEqual(["train.py", "train.py"]);
  });
});

/** A registry stand-in whose unsaved set the test drives by hand. */
function fakeSource(documents: DocumentIdentity[]) {
  const listeners = new Set<() => void>();
  return {
    documents,
    unsavedDocuments: () => documents,
    observeUnsaved: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    change: () => {
      for (const listener of listeners) listener();
    },
  };
}

describe("startUnsavedDocumentReporting", () => {
  /** After a renderer reload, main is still holding whatever it last heard. */
  it("reports immediately so a stale report cannot outlive its drafts", () => {
    const send = vi.fn();
    const source = fakeSource([]);

    startUnsavedDocumentReporting(source, send);

    expect(send).toHaveBeenCalledWith({ names: [] });
  });

  it("reports the current set on every change", () => {
    const send = vi.fn();
    const source = fakeSource([]);
    startUnsavedDocumentReporting(source, send);

    source.documents.push(fileIdentity("train.py"));
    source.change();

    expect(send).toHaveBeenLastCalledWith({ names: ["train.py"] });
  });

  it("stops reporting once disposed", () => {
    const send = vi.fn();
    const source = fakeSource([]);
    const subscription = startUnsavedDocumentReporting(source, send);

    subscription.dispose();
    source.documents.push(fileIdentity("train.py"));
    source.change();

    expect(send).toHaveBeenCalledTimes(1);
  });
});
