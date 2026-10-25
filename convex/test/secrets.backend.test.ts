import { randomUUID } from "node:crypto";

import { newId } from "@volli/shared/cloud";

import { describe, expect, test } from "vite-plus/test";

import { api, internal } from "../functions/_generated/api";
import { connectBackend } from "../fixture/testing";

const backend = connectBackend();

function person(name: string) {
  const id = randomUUID();
  return backend.client(`user:${id}`, {
    claims: { email: `${name.toLowerCase()}-${id}@example.com`, email_verified: true, name },
  });
}

describe("team secrets on the pinned local backend", () => {
  test("seals in the real runtime and never reads a value back", async () => {
    const ana = person("Ana");
    const { userId } = await ana.mutation(api.accounts.ensureViewer, {});
    await backend.admin(internal.previewAccess.set, { kind: "user", value: userId, enabled: true });
    await ana.mutation(api.accounts.ensureViewer, {});
    const workspaceId = newId("workspace");
    await ana.mutation(api.workspaces.create, { workspaceId, name: "Secrets" });
    const target = { scope: "workspace" as const, workspaceId };
    const value = `sk-live-${randomUUID()}`;
    const first = await ana.action(api.secrets.set, {
      target,
      name: "API_KEY",
      kind: "secret",
      value,
    });
    expect(first).toMatchObject({ created: true, valueVersion: 1 });
    // The second write opens the Workspace's data key under the root key.
    await expect(
      ana.action(api.secrets.set, { target, name: "API_KEY", kind: "secret", value: `${value}!` }),
    ).resolves.toEqual({ secretId: first.secretId, valueVersion: 2, created: false });
    const listed = await ana.query(api.secrets.listWorkspace, { workspaceId });
    expect(listed).toEqual([
      expect.objectContaining({ name: "API_KEY", value: null, last4: value.slice(-3) + "!" }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(value);
  });
});
