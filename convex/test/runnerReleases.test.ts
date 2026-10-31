import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { api, internal } from "../functions/_generated/api";
import { setup } from "./board-helpers";

const API = "https://api.github.com/repos/hussainph/volli-code/releases?per_page=100&page=";
const base = "https://github.com/hussainph/volli-code/releases/download";
function release(
  version: string,
  options: { draft?: boolean; prerelease?: boolean; asset?: boolean; at?: string } = {},
) {
  return {
    tag_name: `v${version}`,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? version.includes("-"),
    published_at: options.at ?? "2026-10-30T00:00:00Z",
    assets:
      options.asset === false
        ? []
        : [
            {
              name: "volli-runner-manifest.json",
              browser_download_url: `${base}/v${version}/volli-runner-manifest.json`,
            },
          ],
  };
}
function manifest(version: string, minRunnerVersion = "0.3.0") {
  return {
    schemaVersion: 1,
    version,
    releaseTag: `v${version}`,
    minRunnerVersion,
    minGlibc: "2.31",
    targets: [
      {
        platform: "linux",
        arch: "x64",
        url: `${base}/v${version}/volli-runner-${version}-linux-x64.tar.gz`,
        size: 123,
        sha256: "a".repeat(64),
      },
    ],
    provenance: { bundleUrl: `${base}/v${version}/volli-runner-provenance.sigstore.json` },
  };
}
function fakeFetch(pages: unknown[][], manifests: Record<string, unknown> = {}) {
  const fetch = vi.fn(async (input: string | URL | Request, _options?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(API)) {
      const page = Number(url.slice(API.length));
      return Response.json(pages[page - 1] ?? [], {
        headers: {
          etag: `"page-${page}"`,
          ...(page < pages.length ? { link: `<${API}${page + 1}>; rel="next"` } : {}),
        },
      });
    }
    const version = /\/download\/v([^/]+)\//u.exec(url)?.[1];
    if (!version) throw new Error(`Unexpected test URL ${url}`);
    return Response.json(manifests[version] ?? manifest(version));
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
async function channels(t: ReturnType<typeof setup>) {
  return t.run(async (ctx) =>
    (await ctx.db.query("releaseChannels").collect()).toSorted((a, b) =>
      a.channel.localeCompare(b.channel),
    ),
  );
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("public runner release feed", () => {
  test("drafts and releases without runner assets are ignored; prereleases only advance canary", async () => {
    const t = setup();
    const fetch = fakeFetch([
      [
        release("0.5.0", { draft: true }),
        release("0.4.0", { asset: false }),
        release("0.4.0-canary.9"),
        release("0.3.0"),
        release("0.4.0-canary.10"),
      ],
    ]);
    await t.action(internal.runnerReleases.poll, {});
    expect(await channels(t)).toMatchObject([
      { channel: "canary", version: "0.4.0-canary.10", minVersion: "0.3.0" },
      {
        channel: "stable",
        version: "0.3.0",
        manifestUrl: `${base}/v0.3.0/volli-runner-manifest.json`,
      },
    ]);
    for (const [, options] of fetch.mock.calls) {
      expect(new Headers(options?.headers).has("authorization")).toBe(false);
    }
  });

  test("a stable release supersedes its prerelease; later maintenance releases do not downgrade it", async () => {
    const t = setup();
    fakeFetch([
      [
        release("0.4.0-canary.10"),
        release("0.4.0"),
        release("0.3.1", { at: "2026-10-31T00:00:00Z" }),
      ],
    ]);
    await t.action(internal.runnerReleases.poll, {});
    expect((await channels(t)).map((row) => row.version)).toEqual(["0.4.0", "0.4.0"]);
  });

  test("a prerelease alone creates no stable pointer", async () => {
    const t = setup();
    fakeFetch([[release("0.4.0-canary.1")]]);
    await t.action(internal.runnerReleases.poll, {});
    expect(await channels(t)).toMatchObject([{ channel: "canary", version: "0.4.0-canary.1" }]);
  });

  test("conditional pagination reuses 304 pages while noticing an older page's changed assets", async () => {
    const t = setup();
    fakeFetch([[release("0.4.0-canary.1")], [release("0.3.0")]]);
    await t.action(internal.runnerReleases.poll, {});
    const fetch = fakeFetch([[], [release("0.3.1")]]);
    fetch.mockImplementationOnce(async () => new Response(null, { status: 304 }));
    await t.action(internal.runnerReleases.poll, {});
    expect(await channels(t)).toMatchObject([
      { channel: "canary", version: "0.4.0-canary.1" },
      { channel: "stable", version: "0.3.1" },
    ]);
    expect(
      fetch.mock.calls
        .slice(0, 2)
        .map(([, options]) => new Headers(options?.headers).get("if-none-match")),
    ).toEqual(['"page-1"', '"page-2"']);
  });

  test("RUNNER_RELEASE_REPO selects a public repository, never a URL or request credential", async () => {
    const t = setup();
    vi.stubEnv("RUNNER_RELEASE_REPO", "example/runner");
    const fetch = vi.fn(async (_input: string | URL | Request, _options?: RequestInit) =>
      Response.json([]),
    );
    vi.stubGlobal("fetch", fetch);
    await t.action(internal.runnerReleases.poll, {});
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/example/runner/releases?per_page=100&page=1",
    );
    vi.stubEnv("RUNNER_RELEASE_REPO", "https://example.com/private");
    await expect(t.action(internal.runnerReleases.poll, {})).rejects.toThrow(
      "Invalid RUNNER_RELEASE_REPO",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test.each([403, 429, 500])("HTTP %s preserves the last good feed", async (status) => {
    const t = setup();
    fakeFetch([[release("0.3.0")]]);
    await t.action(internal.runnerReleases.poll, {});
    const before = await channels(t);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status })),
    );
    await expect(t.action(internal.runnerReleases.poll, {})).rejects.toThrow(`(${status})`);
    expect(await channels(t)).toEqual(before);
  });

  test.each([
    { schemaVersion: 2 },
    { version: "0.9.0" },
    { minRunnerVersion: "bad" },
    { minRunnerVersion: "0.5.0" },
    { releaseTag: "vwrong" },
    { minGlibc: "2.35" },
    { targets: [] },
    { provenance: { bundleUrl: "http://insecure.test/bundle" } },
  ])(
    "a malformed canary manifest retains that pointer without blocking stable: %j",
    async (change) => {
      const t = setup();
      fakeFetch([[release("0.3.0"), release("0.4.0-canary.1")]], {
        "0.4.0-canary.1": { ...manifest("0.4.0-canary.1"), ...change },
      });
      await t.action(internal.runnerReleases.poll, {});
      expect(await channels(t)).toMatchObject([{ channel: "stable", version: "0.3.0" }]);
    },
  );

  test("a poll with no usable manifest leaves pointers and cache untouched", async () => {
    const t = setup();
    fakeFetch([[release("0.3.0")]], { "0.3.0": { ...manifest("0.3.0"), schemaVersion: 2 } });
    await expect(t.action(internal.runnerReleases.poll, {})).rejects.toThrow(
      "No selected runner release",
    );
    expect(await channels(t)).toEqual([]);
    expect(await t.query(internal.runnerReleases.cache, { repo: "hussainph/volli-code" })).toEqual(
      [],
    );
  });

  test("an operator pin survives polling and can explicitly resume the feed", async () => {
    const t = setup();
    const pin = {
      channel: "stable" as const,
      version: "0.3.0",
      minVersion: "0.2.0",
      manifestUrl: `${base}/v0.3.0/volli-runner-manifest.json`,
      publishedAt: 1,
    };
    await t.mutation(internal.runnerReleases.pin, pin);
    fakeFetch([[release("0.4.0")]]);
    await t.action(internal.runnerReleases.poll, {});
    expect(await channels(t)).toMatchObject([
      { channel: "canary", version: "0.4.0" },
      { ...pin, pinned: true },
    ]);
    await t.mutation(internal.runnerReleases.pin, { ...pin, pinned: false });
    await t.action(internal.runnerReleases.poll, {});
    expect((await channels(t)).map((row) => row.version)).toEqual(["0.4.0", "0.4.0"]);
  });

  test("public clients have no operator pin or poll function", () => {
    // The generated API's public projection excludes these internal functions.
    expectTypeNotPublic(api);
  });
});
function expectTypeNotPublic(_publicApi: typeof api) {
  // @ts-expect-error deployment-operator mutation is internal only
  void _publicApi.runnerReleases.pin;
}
