import { describe, expect, it, vi } from "vite-plus/test";

import { applyDocumentExternalValue } from "./monaco-document-editor";

describe("applyDocumentExternalValue", () => {
  it("adopts the host's value as model text and baseline in one transaction", () => {
    // No editor view is involved: the registry lands the change as minimal edit
    // operations and Monaco maps the caret through them. Restoring a pre-edit
    // view-state snapshot afterwards would undo exactly that mapping.
    const applyExternalUpdate = vi.fn();

    applyDocumentExternalValue({
      lease: { applyExternalUpdate },
      value: "agent document\n",
      revision: 3,
    });

    expect(applyExternalUpdate).toHaveBeenCalledWith({
      baseline: "agent document\n",
      value: "agent document\n",
      revision: 3,
    });
  });
});
