import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_RELEASE_ORIGIN } from "../update/manifest";
import { updateOrigin } from "./update-origin";

const VERSION = "0.3.0-canary.2";
describe("the bootstrap release base", () => {
  it("takes the selected release's parent, retaining a mirror path and trailing slash", () => {
    expect(updateOrigin(undefined, VERSION)).toBeUndefined();
    expect(updateOrigin(`${DEFAULT_RELEASE_ORIGIN}v${VERSION}`, VERSION)).toBe(
      DEFAULT_RELEASE_ORIGIN,
    );
    expect(updateOrigin(`https://mirror.example/prefix/v${VERSION}/`, VERSION)).toBe(
      "https://mirror.example/prefix/",
    );
    for (const host of ["127.0.0.1", "[::1]", "localhost"])
      expect(updateOrigin(`http://${host}:8080/prefix/v${VERSION}`, VERSION)).toBe(
        `http://${host}:8080/prefix/`,
      );
  });
  it("refuses insecure non-loopback, credentialed, ambiguous or wrong-version URLs", () => {
    for (const base of [
      "not a url",
      `ftp://mirror.example/v${VERSION}`,
      `http://mirror.example/v${VERSION}`,
      `https://user@mirror.example/v${VERSION}`,
      `https://:password@mirror.example/v${VERSION}`,
      `https://mirror.example/v${VERSION}?x=1`,
      `https://mirror.example/v${VERSION}#hash`,
      "https://mirror.example/v0.2.0",
    ])
      expect(() => updateOrigin(base, VERSION)).toThrow();
  });
});
