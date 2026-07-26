import { describe, expect, it } from "vite-plus/test";

import { planLiveDocumentReconciliation } from "./live-document-reconciliation";

describe("planLiveDocumentReconciliation", () => {
  it("adopts disk quietly when the live model is clean", () => {
    expect(
      planLiveDocumentReconciliation({
        baseline: "before\n",
        local: "before\n",
        lastWrite: null,
        disk: {
          ok: true,
          text: "agent edit\n",
          revision: 2,
          truncated: false,
        },
      }),
    ).toEqual({
      kind: "apply",
      outcome: "adopt",
      baseline: "agent edit\n",
      value: "agent edit\n",
      revision: 2,
    });
  });

  it("keeps a local-only draft while advancing the observed disk revision", () => {
    expect(
      planLiveDocumentReconciliation({
        baseline: "before\n",
        local: "human draft\n",
        lastWrite: null,
        disk: {
          ok: true,
          text: "before\n",
          revision: 2,
          truncated: false,
        },
      }),
    ).toEqual({
      kind: "apply",
      outcome: "keep-local",
      baseline: "before\n",
      value: "human draft\n",
      revision: 2,
    });
  });
});
