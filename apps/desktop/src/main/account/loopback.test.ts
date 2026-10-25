import { describe, expect, it } from "vite-plus/test";

import { CALLBACK_PATH, CallbackAbortedError, listenForCallback } from "./loopback";

describe("the loopback callback", () => {
  it("listens on 127.0.0.1 and settles with the code for this flow's state only", async () => {
    const callback = await listenForCallback({ state: "s1", timeoutMs: 10_000 });
    const url = new URL(callback.redirectUri);
    expect(url.protocol).toBe("http:");
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.pathname).toBe(CALLBACK_PATH);

    // A stale tab, a guess, another path: refused, and the flow keeps waiting.
    const wrongState = await fetch(`${callback.redirectUri}?code=x&state=other`);
    expect(wrongState.status).toBe(400);
    const wrongPath = await fetch(`${url.origin}/elsewhere?code=x&state=s1`);
    expect(wrongPath.status).toBe(400);
    const wrongMethod = await fetch(`${callback.redirectUri}?code=x&state=s1`, { method: "POST" });
    expect(wrongMethod.status).toBe(400);

    const answer = await fetch(`${callback.redirectUri}?code=the-code&state=s1`);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await answer.text()).toContain("Signed in");
    await expect(callback.result).resolves.toEqual({ kind: "code", code: "the-code" });
    // Closed after the first answer.
    await expect(fetch(`${callback.redirectUri}?code=again&state=s1`)).rejects.toThrow();
  });

  it("reports the provider's error", async () => {
    const callback = await listenForCallback({ state: "s2", timeoutMs: 10_000 });
    await fetch(`${callback.redirectUri}?error=access_denied&error_description=No&state=s2`);
    await expect(callback.result).resolves.toEqual({
      kind: "error",
      error: "access_denied",
      description: "No",
    });
  });

  it("ends on cancel and on timeout", async () => {
    const abort = new AbortController();
    const cancelled = await listenForCallback({
      state: "s3",
      timeoutMs: 10_000,
      signal: abort.signal,
    });
    abort.abort();
    await expect(cancelled.result).rejects.toMatchObject({ reason: "cancelled" });

    const late = await listenForCallback({ state: "s4", timeoutMs: 20 });
    const error = await late.result.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CallbackAbortedError);
    expect(error).toMatchObject({ reason: "timed-out" });

    const closed = await listenForCallback({ state: "s5", timeoutMs: 10_000 });
    closed.close();
    await expect(closed.result).rejects.toMatchObject({ reason: "cancelled" });

    const already = new AbortController();
    already.abort();
    const never = await listenForCallback({
      state: "s6",
      timeoutMs: 10_000,
      signal: already.signal,
    });
    await expect(never.result).rejects.toMatchObject({ reason: "cancelled" });
  });
});
