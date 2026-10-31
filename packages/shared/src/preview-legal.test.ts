import { describe, expect, it } from "vite-plus/test";

import {
  PREVIEW_AGREEMENT_URL,
  PREVIEW_AGREEMENT_VERSION,
  PREVIEW_PRIVACY_URL,
} from "./preview-legal";

describe("preview legal contract", () => {
  it("pins the version recorded by sign-in to the published preview text", () => {
    expect(PREVIEW_AGREEMENT_VERSION).toBe("preview-0.3-2026-10-31");
  });

  it.each([
    [PREVIEW_AGREEMENT_URL, "/legal/preview/"],
    [PREVIEW_PRIVACY_URL, "/legal/privacy/"],
  ])("links to the public HTTPS page %s", (address, path) => {
    const url = new URL(address);
    expect(url.origin).toBe("https://volli.app");
    expect(url.pathname).toBe(path);
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
  });
});
