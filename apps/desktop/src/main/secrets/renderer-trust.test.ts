import { describe, expect, it } from "vite-plus/test";
// Resolve the shared main-process teardown before timed assertions begin.
import "../broadcast";
import { PACKAGED_RENDERER_ENTRY_URL } from "../app-protocol";
import { isSecretRenderer } from "./renderer-trust";

describe("credential renderer trust", () => {
  it("trusts the built entry in unpackaged builds without a dev server", () => {
    expect(isSecretRenderer(PACKAGED_RENDERER_ENTRY_URL)).toBe(true);
    expect(isSecretRenderer(`${PACKAGED_RENDERER_ENTRY_URL}#settings`, "")).toBe(true);
  });
  it("trusts only the configured entry when the dev server is used", () => {
    const entry = "http://localhost:5173/";
    expect(isSecretRenderer(`${entry}#settings`, entry)).toBe(true);
    expect(isSecretRenderer(PACKAGED_RENDERER_ENTRY_URL, entry)).toBe(false);
    expect(isSecretRenderer("http://localhost:5174/", entry)).toBe(false);
  });
  it("rejects other bundle pages, query changes, external and malformed URLs", () => {
    for (const url of [
      "volli-app://bundle/cursor.html",
      `${PACKAGED_RENDERER_ENTRY_URL}?untrusted=true`,
      "https://example.com/index.html",
      "invalid",
    ])
      expect(isSecretRenderer(url)).toBe(false);
    expect(isSecretRenderer(PACKAGED_RENDERER_ENTRY_URL, "invalid")).toBe(false);
  });
});
