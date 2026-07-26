import { describe, expect, it, vi } from "vite-plus/test";

import { applyDocumentExternalValue } from "./monaco-document-editor";

describe("applyDocumentExternalValue", () => {
  it("updates an existing document model in one edit transaction and restores view state", () => {
    const viewState = { cursorState: [{ position: { lineNumber: 2, column: 3 } }], scrollTop: 50 };
    const restoreViewState = vi.fn();
    const applyExternalUpdate = vi.fn();
    const lease = { applyExternalUpdate };

    applyDocumentExternalValue({
      lease,
      editorView: {
        saveViewState: () => viewState,
        restoreViewState,
      },
      value: "agent document\n",
      revision: 3,
    });

    expect(applyExternalUpdate).toHaveBeenCalledWith({
      baseline: "agent document\n",
      value: "agent document\n",
      revision: 3,
    });
    expect(restoreViewState).toHaveBeenCalledWith(viewState);
  });
});
