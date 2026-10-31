import { describe, expect, it } from "vite-plus/test";

import { BUILD_DEPLOYMENT, DeploymentError, exactOrigin, resolveDeployment } from "./deployment";

const BAKED = {
  url: "https://rosy-cardinal-131.convex.cloud",
  siteUrl: "https://rosy-cardinal-131.convex.site",
};

describe("the deployment a runner links to", () => {
  it("is the baked one by default", () => {
    expect(resolveDeployment({ baked: BAKED })).toEqual(BAKED);
    expect(BUILD_DEPLOYMENT).toEqual({
      url: "https://baked-deployment.convex.cloud",
      siteUrl: "https://baked-deployment.convex.site",
    });
  });

  it("refuses a development build with none, and a malformed baked one", () => {
    expect(() => resolveDeployment({ baked: null })).toThrow("pass --server <url>");
    expect(() => resolveDeployment({ baked: { url: "nope", siteUrl: BAKED.siteUrl } })).toThrow(
      DeploymentError,
    );
  });

  it("follows --server, deriving a convex.cloud deployment's site", () => {
    expect(resolveDeployment({ server: "https://staging-1.convex.cloud/", baked: BAKED })).toEqual({
      url: "https://staging-1.convex.cloud",
      siteUrl: "https://staging-1.convex.site",
    });
  });

  it("takes --site for any other server, and refuses --site alone", () => {
    expect(
      resolveDeployment({
        server: "http://127.0.0.1:3210",
        site: "http://127.0.0.1:3211",
        baked: null,
      }),
    ).toEqual({ url: "http://127.0.0.1:3210", siteUrl: "http://127.0.0.1:3211" });
    expect(() => resolveDeployment({ server: "http://localhost:3210", baked: null })).toThrow(
      "pass --site <url> too",
    );
    expect(() => resolveDeployment({ site: "https://x.convex.site", baked: BAKED })).toThrow(
      "--site needs --server.",
    );
  });

  it("accepts only exact https origins, or http to loopback", () => {
    expect(exactOrigin("http://[::1]:3210", "--server")).toBe("http://[::1]:3210");
    for (const raw of [
      "not a url",
      "http://example.com",
      "https://user:pw@example.com",
      "https://example.com/path",
      "https://example.com/?q",
      "https://example.com/#f",
      "ftp://example.com",
    ]) {
      expect(() => exactOrigin(raw, "--server")).toThrow(DeploymentError);
    }
  });
});
