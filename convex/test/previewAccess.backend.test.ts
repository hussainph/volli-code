import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vite-plus/test";
import { api, internal } from "../functions/_generated/api";
import { connectBackend } from "../fixture/testing";
const backend = connectBackend();

describe("preview access over the real transport", () => {
  test("a client cannot grant itself access through an internal admin function", async () => {
    const client = backend.client(`user:${randomUUID()}`);
    await expect(
      client.mutation(
        internal.previewAccess.set as never,
        { kind: "email", value: "self@example.com", enabled: true } as never,
      ),
    ).rejects.toThrow();
    expect((await client.mutation(api.accounts.ensureViewer, {})).previewAccess).toBe("waitlisted");
  });
  test("concurrent code redemption grants only one account and revocation is immediate", async () => {
    const code = randomUUID();
    await backend.admin(internal.previewAccess.set, { kind: "code", value: code, enabled: true });
    const clients = [
      backend.client(`user:${randomUUID()}`),
      backend.client(`user:${randomUUID()}`),
    ];
    const results = await Promise.allSettled(
      clients.map((client) => client.mutation(api.accounts.ensureViewer, { inviteCode: code })),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = clients[results.findIndex((result) => result.status === "fulfilled")]!;
    expect((await winner.query(api.accounts.viewer, {}))?.previewAccess).toBe("granted");
    await backend.admin(internal.previewAccess.set, { kind: "code", value: code, enabled: false });
    expect((await winner.query(api.accounts.viewer, {}))?.previewAccess).toBe("waitlisted");
  });
});
