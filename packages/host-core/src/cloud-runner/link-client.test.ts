import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { newId } from "@volli/shared/cloud";

import { createRunnerLinkClient, RunnerHttpError, type RunnerFetch } from "./link-client";

const HOST = {
  hostname: "box",
  platform: { os: "linux", distro: null, kernel: null, arch: "x64", glibc: null },
  installMode: "user" as const,
};
const RUNNER_ID = newId("runner");
const GRANT = { runnerId: RUNNER_ID, name: "box", credential: "vrc_a", generation: 1 };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientAnswering(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; body: unknown }[] = [];
  const fetch: RunnerFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body as string) });
    return answer(url, init);
  };
  return { client: createRunnerLinkClient({ siteUrl: "https://dep.convex.site/", fetch }), calls };
}

async function failure(promise: Promise<unknown>): Promise<RunnerHttpError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(RunnerHttpError);
  return error as RunnerHttpError;
}

/** A server that never answers: only the request's own signal ends it. */
const hangingFetch: RunnerFetch = (_url, init) =>
  new Promise((_done, fail) => {
    init.signal!.addEventListener("abort", () => fail(init.signal!.reason));
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the /runner/* client", () => {
  it("posts each request to its route and reads the reply through the shared codec", async () => {
    const replies: Record<string, unknown> = {
      "/runner/link": GRANT,
      "/runner/link/start": {
        requestId: "r",
        userCode: "BCDF-GHJK",
        pollSecret: "s",
        intervalMs: 5000,
        expiresAt: 9,
      },
      "/runner/link/poll": { status: "linked", grant: GRANT },
      "/runner/token": {
        token: "a.b.c",
        expiresAt: 2,
        serverTime: 1,
        credential: "vrc_b",
        generation: 2,
      },
    };
    const { client, calls } = clientAnswering((url) => json(200, replies[new URL(url).pathname]));
    await expect(client.link({ installToken: "vrt_x", host: HOST, name: null })).resolves.toEqual(
      GRANT,
    );
    await expect(client.startDeviceLink(HOST)).resolves.toMatchObject({ userCode: "BCDF-GHJK" });
    await expect(client.pollDeviceLink({ requestId: "r", pollSecret: "s" })).resolves.toEqual({
      status: "linked",
      grant: GRANT,
    });
    await expect(
      client.exchange({ runnerId: RUNNER_ID, credential: "vrc_a" }),
    ).resolves.toMatchObject({
      generation: 2,
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://dep.convex.site/runner/link",
      "https://dep.convex.site/runner/link/start",
      "https://dep.convex.site/runner/link/poll",
      "https://dep.convex.site/runner/token",
    ]);
    expect(calls[1]!.body).toEqual({ host: HOST });
  });

  it("names the backend's own error code, and knows which ones need a new link", async () => {
    const { client } = clientAnswering(() =>
      json(403, { error: { code: "revoked", message: "gone" } }),
    );
    const revoked = await failure(client.exchange({ runnerId: RUNNER_ID, credential: "vrc_a" }));
    expect(revoked).toMatchObject({
      code: "revoked",
      status: 403,
      message: "gone",
      name: "RunnerHttpError",
    });
    expect(revoked.relinkRequired).toBe(true);

    const limited = clientAnswering(() =>
      json(503, { error: { code: "issuer_unconfigured", message: "no" } }),
    );
    const unconfigured = await failure(
      limited.client.exchange({ runnerId: RUNNER_ID, credential: "vrc_a" }),
    );
    expect(unconfigured.code).toBe("issuer_unconfigured");
    expect(unconfigured.relinkRequired).toBe(false);
  });

  it("calls everything else unavailable, to be retried", async () => {
    const cases: (() => Response | Promise<Response>)[] = [
      () => Promise.reject(new Error("ECONNREFUSED")),
      () => new Response("<html>bad gateway</html>", { status: 502 }),
      () => json(500, { message: "Server Error" }),
      () => json(200, { runnerId: "nope" }),
    ];
    for (const answer of cases) {
      const { client } = clientAnswering(answer);
      const error = await failure(client.link({ installToken: "vrt_x", host: HOST, name: null }));
      expect(error.code).toBe("unavailable");
      expect(error.relinkRequired).toBe(false);
    }
  });

  it("uses the platform fetch by default", async () => {
    const fetch = vi.fn(async () => json(200, GRANT));
    vi.stubGlobal("fetch", fetch);
    const client = createRunnerLinkClient({ siteUrl: "https://dep.convex.site" });
    await expect(client.link({ installToken: "vrt_x", host: HOST, name: "n" })).resolves.toEqual(
      GRANT,
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://dep.convex.site/runner/link",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("gives up on a request that never answers", async () => {
    const client = createRunnerLinkClient({
      siteUrl: "https://dep.convex.site",
      fetch: hangingFetch,
      timeoutMs: 10,
    });
    const error = await failure(client.exchange({ runnerId: RUNNER_ID, credential: "vrc_a" }));
    expect(error.code).toBe("unavailable");
  });
});
