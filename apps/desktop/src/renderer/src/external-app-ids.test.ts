import { describe, expect, it } from "vite-plus/test";

import { isKnownExternalAppId } from "../../external-app-ids";

describe("isKnownExternalAppId", () => {
  it("recognizes known ids and rejects corrupt persisted values", () => {
    expect(isKnownExternalAppId("vscode")).toBe(true);
    expect(isKnownExternalAppId("obsolete-editor")).toBe(false);
    expect(isKnownExternalAppId({ id: "vscode" })).toBe(false);
  });
});
