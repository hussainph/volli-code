import { describe, expect, it } from "vite-plus/test";

import { isInternalNavigationTarget } from "./navigation";

describe("isInternalNavigationTarget", () => {
  it("rejects a non-parseable target", () => {
    expect(
      isInternalNavigationTarget("not a url", {
        devOrigin: "http://localhost:5173",
        packagedPathname: null,
      }),
    ).toBe(false);
  });

  describe("dev policy (origin match)", () => {
    const policy = { devOrigin: "http://localhost:5173", packagedPathname: null };

    it("allows a same-origin dev URL", () => {
      expect(isInternalNavigationTarget("http://localhost:5173/index.html", policy)).toBe(true);
    });

    it("rejects a different origin", () => {
      expect(isInternalNavigationTarget("https://evil.example/x", policy)).toBe(false);
    });
  });

  describe("prod policy (exact packaged document)", () => {
    const policy = { devOrigin: null, packagedPathname: "/Apps/Volli/dist/index.html" };

    it("allows the packaged document itself", () => {
      expect(isInternalNavigationTarget("file:///Apps/Volli/dist/index.html", policy)).toBe(true);
    });

    it("allows the packaged document with a hash route (query/hash ignored)", () => {
      expect(
        isInternalNavigationTarget("file:///Apps/Volli/dist/index.html#/board?x=1", policy),
      ).toBe(true);
    });

    it("rejects a DIFFERENT local file (the drag-and-drop .html hole)", () => {
      expect(isInternalNavigationTarget("file:///Users/me/Downloads/evil.html", policy)).toBe(
        false,
      );
    });

    it("rejects a non-file protocol even if some pathname coincides", () => {
      expect(
        isInternalNavigationTarget("http://localhost/Apps/Volli/dist/index.html", policy),
      ).toBe(false);
    });
  });

  it("rejects everything when neither branch is configured", () => {
    expect(
      isInternalNavigationTarget("file:///anything", { devOrigin: null, packagedPathname: null }),
    ).toBe(false);
  });
});
