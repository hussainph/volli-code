import { describe, expect, it } from "vite-plus/test";

import { BackendRefusedError } from "../account/backend";
import { BackendUnreachableError, convexMacRunnerBackend } from "./backend";

const HOST = {
  hostname: "danas-mac",
  platform: { os: "darwin", distro: null, kernel: "25.0.0", arch: "arm64", glibc: null },
  installMode: "app" as const,
};
const GRANT = {
  runnerId: "22222222-2222-4222-8222-222222222222",
  name: "danas-mac",
  credential: "vrc_secret",
  generation: 1,
};

function answering(status: number, body: unknown) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
  return { requests, backend: convexMacRunnerBackend({ url: "https://x.convex.cloud/", fetch }) };
}

describe("the Mac runner's calls as the person", () => {
  it("registers through the HTTP actions API with the person's token", async () => {
    const { requests, backend } = answering(200, { status: "success", value: GRANT });
    await expect(
      backend.registerThisMac("person", {
        host: HOST,
        name: "Dana's Mac",
        replacesRunnerId: null,
        registrationId: "reg-1",
      }),
    ).resolves.toEqual(GRANT);
    await backend.registerThisMac("person", {
      host: HOST,
      name: null,
      replacesRunnerId: GRANT.runnerId,
      registrationId: "reg-1",
    });
    expect(requests[0]!.url).toBe("https://x.convex.cloud/api/action");
    expect(new Headers(requests[0]!.init.headers).get("authorization")).toBe("Bearer person");
    expect(JSON.parse(requests[0]!.init.body as string)).toEqual({
      path: "runners:registerThisMac",
      args: { host: HOST, name: "Dana's Mac", registrationId: "reg-1" },
      format: "json",
    });
    expect(JSON.parse(requests[1]!.init.body as string).args.replacesRunnerId).toBe(GRANT.runnerId);
  });

  it("removes through the mutation API", async () => {
    const { requests, backend } = answering(200, { status: "success", value: null });
    await backend.removeRunner("person", GRANT.runnerId);
    expect(requests[0]!.url).toBe("https://x.convex.cloud/api/mutation");
    expect(JSON.parse(requests[0]!.init.body as string)).toMatchObject({
      path: "runners:remove",
      args: { runnerId: GRANT.runnerId },
    });
  });

  it("reads one runner's status from the person's list", async () => {
    const listed = answering(200, {
      status: "success",
      value: [{ id: GRANT.runnerId, status: "revoked", statusReason: "credential_reuse" }, {}],
    });
    await expect(listed.backend.runnerStatus("p", GRANT.runnerId)).resolves.toEqual({
      status: "revoked",
      statusReason: "credential_reuse",
    });
    await expect(listed.backend.runnerStatus("p", "other")).resolves.toBeNull();
    expect(listed.requests[0]!.url).toBe("https://x.convex.cloud/api/query");
    const odd = answering(200, { status: "success", value: [{ id: "r", status: 1 }] }).backend;
    await expect(odd.runnerStatus("p", "r")).resolves.toEqual({
      status: "unknown",
      statusReason: null,
    });
    const unreadable = answering(200, { status: "success", value: {} }).backend;
    await expect(unreadable.runnerStatus("p", "r")).rejects.toBeInstanceOf(BackendUnreachableError);
  });

  it("tells a refusal from an outage", async () => {
    const refused = answering(400, {
      status: "error",
      errorMessage: "x",
      errorData: { code: "account_deleted", message: "This account is being deleted." },
    }).backend;
    await expect(refused.removeRunner("p", "r")).rejects.toMatchObject({
      code: "account_deleted",
      message: "This account is being deleted.",
    });
    const plain = answering(400, { status: "error", errorMessage: "Nope" }).backend;
    await expect(plain.removeRunner("p", "r")).rejects.toBeInstanceOf(BackendRefusedError);
    const unauthorized = answering(401, "no").backend;
    await expect(unauthorized.removeRunner("p", "r")).rejects.toMatchObject({
      code: "unauthenticated",
    });
    const down = answering(502, "bad gateway").backend;
    await expect(down.removeRunner("p", "r")).rejects.toBeInstanceOf(BackendUnreachableError);
    const unreadable = answering(200, { status: "success", value: { runnerId: "x" } }).backend;
    await expect(
      unreadable.registerThisMac("p", {
        host: HOST,
        name: null,
        replacesRunnerId: null,
        registrationId: "reg-1",
      }),
    ).rejects.toBeInstanceOf(BackendUnreachableError);
    const offline = convexMacRunnerBackend({
      url: "https://x.convex.cloud",
      fetch: (async () => Promise.reject(new Error("ENOTFOUND"))) as unknown as typeof fetch,
    });
    await expect(offline.removeRunner("p", "r")).rejects.toBeInstanceOf(BackendUnreachableError);
  });
});
