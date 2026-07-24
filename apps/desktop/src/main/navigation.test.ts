import { describe, expect, it } from "vite-plus/test";

import { isInternalNavigationTarget } from "./navigation";

describe("isInternalNavigationTarget", () => {
  it("rejects a non-parseable target", () => {
    expect(
      isInternalNavigationTarget("not a url", { kind: "dev", origin: "http://localhost:5173" }),
    ).toBe(false);
  });

  describe("dev policy (origin match)", () => {
    const policy = { kind: "dev", origin: "http://localhost:5173" } as const;

    it("allows a same-origin dev URL", () => {
      expect(isInternalNavigationTarget("http://localhost:5173/index.html", policy)).toBe(true);
    });

    it("rejects a different origin", () => {
      expect(isInternalNavigationTarget("https://evil.example/x", policy)).toBe(false);
    });

    it("fails closed for an opaque configured origin", () => {
      expect(
        isInternalNavigationTarget("file:///Users/me/Downloads/evil.html", {
          kind: "dev",
          origin: "null",
        }),
      ).toBe(false);
    });
  });

  describe("prod policy (exact packaged app entry)", () => {
    const policy = {
      kind: "packaged",
      scheme: "volli-app:",
      host: "bundle",
      pathname: "/index.html",
    } as const;

    it("allows the packaged entry document", () => {
      expect(isInternalNavigationTarget("volli-app://bundle/index.html", policy)).toBe(true);
    });

    it("allows the packaged document with query and hash state", () => {
      expect(isInternalNavigationTarget("volli-app://bundle/index.html?x=1#/board", policy)).toBe(
        true,
      );
    });

    it("rejects another custom-protocol host", () => {
      expect(isInternalNavigationTarget("volli-app://evil/index.html", policy)).toBe(false);
    });

    it("rejects same-origin assets as top-level documents", () => {
      expect(isInternalNavigationTarget("volli-app://bundle/assets/app.js", policy)).toBe(false);
    });

    it("rejects ports, credentials, and every other protocol", () => {
      expect(isInternalNavigationTarget("volli-app://bundle:99/index.html", policy)).toBe(false);
      expect(isInternalNavigationTarget("volli-app://user@bundle/index.html", policy)).toBe(false);
      expect(isInternalNavigationTarget("file:///Apps/Volli/dist/index.html", policy)).toBe(false);
      expect(isInternalNavigationTarget("https://bundle/index.html", policy)).toBe(false);
    });
  });
});
