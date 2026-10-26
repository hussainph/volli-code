import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { resolveAccountConfig } from "./account/config";
import { packagedCloudConfig } from "./deployment-config";
import {
  launchConnectSources,
  withRendererConnections,
  LOOPBACK_CONNECT_SOURCES,
  rendererConnectSources,
  withConnectSources,
} from "./renderer-csp";

const page = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");

function cspOf(html: string): string {
  return /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/u.exec(html)![1]!;
}

describe("the main window's connections (VC-889)", () => {
  it("uses runtime launch origins and replaces the dev policy rather than duplicating it", async () => {
    const launch = {
      store: "cloud",
      deployment: "cloud",
      userId: "u",
      backendUrl: "https://api.example.com",
      siteUrl: "https://actions.example.net",
    } as const;
    const sources = launchConnectSources(launch, "https://storage.example.org");
    expect(sources).toEqual([
      "https://api.example.com",
      "wss://api.example.com",
      "https://storage.example.org",
    ]);
    const response = await withRendererConnections(
      new Response(withConnectSources(page, LOOPBACK_CONNECT_SOURCES), {
        headers: { "content-type": "text/html", "content-length": "999" },
      }),
      sources,
    );
    expect(response.headers.get("content-type")).toBe("text/html");
    expect(response.headers.has("content-length")).toBe(false);
    const csp = cspOf(await response.text());
    expect(csp.match(/connect-src/gu)).toHaveLength(1);
    expect(csp).toContain(
      "connect-src 'self' https://api.example.com wss://api.example.com https://storage.example.org;",
    );
    expect(csp).not.toContain("127.0.0.1");
    expect(csp).toContain("form-action 'none'");
    expect(launchConnectSources({ store: "local" }, "invalid unused config")).toEqual([]);
    expect(
      launchConnectSources(
        { ...launch, deployment: "local", backendUrl: "http://127.0.0.1:4321", siteUrl: null },
        null,
      ),
    ).toEqual(["http://127.0.0.1:4321", "ws://127.0.0.1:4321"]);
    const unchanged = new Response(page);
    expect(await withRendererConnections(unchanged, [])).toBe(unchanged);
    const notFound = new Response("missing", { status: 404 });
    expect(await withRendererConnections(notFound, sources)).toBe(notFound);
  });
  it("keeps the fixture's separate store port when launch CSP replaces the build policy", async () => {
    const config = resolveAccountConfig({
      packaged: false,
      env: {
        VOLLI_CONVEX_URL: "http://127.0.0.1:3210",
        VOLLI_CONVEX_SITE_URL: "http://127.0.0.1:3211",
        VOLLI_CLOUD_STORAGE_ORIGIN: "http://127.0.0.1:4321",
      },
    });
    expect(config.problem).toBeNull();
    const sources = launchConnectSources(
      { store: "cloud", userId: "u", backendUrl: config.backendUrl! },
      config.storageOrigin,
    );
    const response = await withRendererConnections(
      new Response(withConnectSources(page, LOOPBACK_CONNECT_SOURCES)),
      sources,
    );
    const csp = cspOf(await response.text());
    expect(csp.match(/connect-src/gu)).toHaveLength(1);
    expect(csp).toContain(
      "connect-src 'self' http://127.0.0.1:3210 ws://127.0.0.1:3210 http://127.0.0.1:4321;",
    );
    expect(csp).not.toContain("127.0.0.1:*");
    expect(csp).not.toContain("127.0.0.1:3211");
    // The exception is dev-only: compiled release inputs still require HTTPS.
    expect(() =>
      packagedCloudConfig({
        VOLLI_BUILD_WORKOS_CLIENT_ID: "client_release",
        VOLLI_BUILD_CONVEX_URL: "https://api.example.com",
        VOLLI_BUILD_CONVEX_SITE_URL: "https://actions.example.net",
        VOLLI_BUILD_STORAGE_ORIGIN: "http://127.0.0.1:4321",
      }),
    ).toThrow();
  });

  it("permits only exact storage origins, with HTTP limited to loopback", () => {
    const sources = rendererConnectSources({
      serve: true,
      env: { VOLLI_CLOUD_STORAGE_ORIGIN: "https://history.example.com/" },
    });
    expect(sources).toEqual([...LOOPBACK_CONNECT_SOURCES, "https://history.example.com"]);
    expect(cspOf(withConnectSources(page, sources))).toContain("https://history.example.com;");
    for (const origin of ["http://127.0.0.1:4321", "http://localhost:4321"]) {
      expect(
        rendererConnectSources({ serve: true, env: { VOLLI_CLOUD_STORAGE_ORIGIN: `${origin}/` } }),
      ).toEqual([...LOOPBACK_CONNECT_SOURCES, origin]);
    }
    expect(
      rendererConnectSources({
        serve: false,
        env: { VOLLI_CLOUD_STORAGE_ORIGIN: "https://history.example.com" },
      }),
    ).toEqual([]);
    expect(
      rendererConnectSources({ serve: true, env: { VOLLI_CLOUD_STORAGE_ORIGIN: "" } }),
    ).toEqual(LOOPBACK_CONNECT_SOURCES);
    for (const value of [
      "http://bucket.example.com",
      "https://*.example.com",
      "https://:pass@bucket.example.com",
      "https://user@bucket.example.com",
      "https://user:pass@bucket.example.com",
      "https://bucket.example.com/path",
      "https://bucket.example.com?key=value",
      "https://bucket.example.com/#hash",
      "not a URL",
    ]) {
      expect(() =>
        rendererConnectSources({ serve: true, env: { VOLLI_CLOUD_STORAGE_ORIGIN: value } }),
      ).toThrow();
    }
  });
  it("reach only its own origin in a build that asked for nothing", () => {
    expect(rendererConnectSources({ serve: false, env: {} })).toEqual([]);
    expect(withConnectSources(page, [])).toBe(page);
    expect(cspOf(page)).not.toContain("connect-src");
    expect(cspOf(page)).toContain("default-src 'self'");
  });

  it("add the loopback for the dev server, or a build that asks for it", () => {
    expect(rendererConnectSources({ serve: true, env: {} })).toBe(LOOPBACK_CONNECT_SOURCES);
    expect(rendererConnectSources({ serve: false, env: { VOLLI_CLOUD_LOOPBACK: "1" } })).toBe(
      LOOPBACK_CONNECT_SOURCES,
    );
    expect(cspOf(withConnectSources(page, LOOPBACK_CONNECT_SOURCES))).toBe(
      "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: volli-blob:; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*; form-action 'none'",
    );
  });
});
