import { describe, expect, it } from "vite-plus/test";

import {
  summarizeUpdateFailure,
  UPDATE_FAILURE_FALLBACK,
  UPDATE_FAILURE_SUMMARY_MAX,
} from "./update-failure";

/** The shape electron-updater actually throws for a missing feed file. */
const HTTP_404 = [
  "Cannot find latest-mac.yml in the latest release artifacts (https://github.com/acme/volli/releases/download/v0.2.2/latest-mac.yml): HttpError: 404 ",
  '"method: GET url: https://github.com/acme/volli/releases/download/v0.2.2/latest-mac.yml',
  "",
  "Please double check that your authentication token is correct. Due to security reasons, actual status maybe not reported, but 404.",
  '"',
  'Headers: { "x-github-request-id": "C0FF:EE", "set-cookie": "_gh_sess=abc", "server": "github.com" }',
].join("\n");

describe("summarizeUpdateFailure", () => {
  it("keeps what went wrong and drops the URL, the request and the header dump", () => {
    const summary = summarizeUpdateFailure(HTTP_404);
    expect(summary).toBe(
      "Cannot find latest-mac.yml in the latest release artifacts: HttpError: 404",
    );
    for (const leak of ["https", "github.com", "method", "C0FF", "_gh_sess", "Headers"]) {
      expect(summary, leak).not.toContain(leak);
    }
  });

  it("cuts a dump that starts on the first line", () => {
    expect(summarizeUpdateFailure('HttpError: 502 Bad Gateway {"server":"cdn"}')).toBe(
      "HttpError: 502 Bad Gateway",
    );
    expect(summarizeUpdateFailure("HttpError: 403 Headers: x")).toBe("HttpError: 403");
  });

  it("strips host names, IP addresses and header-shaped pairs", () => {
    expect(summarizeUpdateFailure("getaddrinfo ENOTFOUND objects.githubusercontent.com")).toBe(
      "getaddrinfo ENOTFOUND",
    );
    expect(summarizeUpdateFailure("connect ECONNREFUSED 140.82.112.3:443")).toBe(
      "connect ECONNREFUSED",
    );
    expect(
      summarizeUpdateFailure("Request failed, content-type: text/html, authorization: abc"),
    ).toBe("Request failed");
  });

  it("removes anything credential-shaped", () => {
    expect(
      summarizeUpdateFailure("Bad credentials for ghp_0123456789abcdefghijABCDEFGHIJ012345"),
    ).not.toContain("ghp_0123456789");
  });

  it("keeps plain messages as they are, first sentence only", () => {
    expect(summarizeUpdateFailure("net::ERR_INTERNET_DISCONNECTED")).toBe(
      "net::ERR_INTERNET_DISCONNECTED",
    );
    expect(summarizeUpdateFailure("Disk full. Free some space and retry.")).toBe("Disk full.");
    expect(summarizeUpdateFailure("  \n  offline  \n more")).toBe("offline");
  });

  it("caps a long sentence with an ellipsis", () => {
    const summary = summarizeUpdateFailure(`Failure ${"word ".repeat(60)}`);
    expect(summary.length).toBe(UPDATE_FAILURE_SUMMARY_MAX);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("says something when nothing is left", () => {
    expect(summarizeUpdateFailure("")).toBe(UPDATE_FAILURE_FALLBACK);
    expect(summarizeUpdateFailure("https://example.com/feed.yml")).toBe(UPDATE_FAILURE_FALLBACK);
  });
});
