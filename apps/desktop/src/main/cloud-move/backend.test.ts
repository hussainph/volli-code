import { describe, expect, it, vi } from "vite-plus/test";
import { personMoveBackend } from "./backend";

function setup(response: Response, over: { enabled?: boolean; token?: string | null } = {}) {
  const request = vi.fn(async () => response);
  const lost = vi.fn();
  const token = vi.fn(async () => (over.token === undefined ? "person-token" : over.token));
  const backend = personMoveBackend({
    url: "https://example.invalid/",
    enabled: () => over.enabled ?? true,
    accessToken: token,
    onSignInLost: lost,
    fetch: request,
  });
  return { backend, request, lost, token };
}
describe("person-authorized move HTTP boundary", () => {
  it("uses the person's current access token and the real Convex envelope", async () => {
    const f = setup(Response.json({ status: "success", value: { accepted: 2 } }));
    await expect(f.backend.mutation("projectImports:begin", { moveId: "move" })).resolves.toEqual({
      accepted: 2,
    });
    expect(f.request).toHaveBeenCalledWith(
      "https://example.invalid/api/mutation",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer person-token" },
        body: JSON.stringify({
          path: "projectImports:begin",
          args: { moveId: "move" },
          format: "json",
        }),
      }),
    );
  });
  it("keeps refusals as data.code, without backend prose or arbitrary fields", async () => {
    const f = setup(
      Response.json({
        status: "error",
        errorMessage: "private body",
        errorData: {
          code: "changed_since_commit",
          boardChanges: 4,
          sessionActive: true,
          private: "private",
        },
      }),
    );
    const error = await f.backend
      .mutation("projectImports:uncommit", {})
      .catch((refusal: unknown) => refusal);
    expect(error).toMatchObject({
      data: { code: "changed_since_commit", boardChanges: 4, sessionActive: true },
    });
    expect(JSON.stringify(error)).not.toContain("private");
    expect(f.lost).not.toHaveBeenCalled();
  });
  it("classifies only the missing optional re-arm query without exposing backend prose", async () => {
    const body = {
      status: "error",
      errorMessage:
        "Could not find public function for projectImports:rearmList private deployment details",
    };
    const old = setup(Response.json(body));
    await expect(
      old.backend.query("projectImports:rearmList", { moveId: "move" }),
    ).rejects.toMatchObject({ data: { code: "feature_unavailable" } });
    const other = setup(Response.json(body));
    await expect(other.backend.query("projectImports:begin", {})).rejects.not.toHaveProperty(
      "data",
    );
    expect(old.lost).not.toHaveBeenCalled();
  });
  it("pauses an expired sign-in rather than triggering data rollback", async () => {
    const f = setup(new Response("unauthorized", { status: 401 }));
    const failure = await f.backend
      .query("workspaces:listMine", {})
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "move_signed_out" });
    expect(failure).not.toHaveProperty("data");
    expect(f.lost).toHaveBeenCalledOnce();
  });
  it.each([
    new Response("forbidden", { status: 403 }),
    Response.json({ status: "error", errorData: { code: "forbidden" } }, { status: 403 }),
  ])("keeps a permission refusal distinct from a lost sign-in", async (response) => {
    const f = setup(response);
    await expect(f.backend.mutation("projectImports:begin", {})).rejects.toMatchObject({
      data: { code: "forbidden" },
    });
    expect(f.lost).not.toHaveBeenCalled();
  });
  it("aborts an in-flight request when the move is interrupted or the service stops", async () => {
    const caller = new AbortController();
    const request = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const backend = personMoveBackend({
      url: "https://example.invalid",
      enabled: () => true,
      accessToken: async () => "person",
      signal: () => caller.signal,
      fetch: request,
    });
    const first = backend.query("x:y", {});
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    caller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    backend.dispose();
    await expect(backend.query("x:y", {})).rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledOnce();
  });
  it("does not send anything with the flag off or without a token", async () => {
    const off = setup(Response.json({}), { enabled: false });
    await expect(off.backend.query("x:y", {})).rejects.toThrow("off");
    expect(off.token).not.toHaveBeenCalled();
    const out = setup(Response.json({}), { token: null });
    await expect(out.backend.query("x:y", {})).rejects.toThrow("Sign in");
    expect(out.request).not.toHaveBeenCalled();
  });
  it("does not mistake unreadable/network responses for application refusals", async () => {
    const f = setup(new Response("unreadable", { status: 502 }));
    await expect(f.backend.action("x:y", {})).rejects.not.toHaveProperty("data");
  });
});
