import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vite-plus/test";
import { PREVIEW_ENROLLMENT_AGREEMENT_VERSION } from "@volli/shared/cloud";
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
    expect(
      (
        await client.mutation(api.accounts.ensureViewer, {
          acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
        })
      ).previewAccess,
    ).toBe("waitlisted");
  });
  test("concurrent code redemption grants only one account and revocation is immediate", async () => {
    const code = randomUUID();
    await backend.admin(internal.previewAccess.set, { kind: "code", value: code, enabled: true });
    const clients = [
      backend.client(`user:${randomUUID()}`),
      backend.client(`user:${randomUUID()}`),
    ];
    const results = await Promise.allSettled(
      clients.map((client) =>
        client.mutation(api.accounts.ensureViewer, {
          inviteCode: code,
          acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = clients[results.findIndex((result) => result.status === "fulfilled")]!;
    expect((await winner.query(api.accounts.viewer, {}))?.previewAccess).toBe("granted");
    await backend.admin(internal.previewAccess.set, { kind: "code", value: code, enabled: false });
    expect((await winner.query(api.accounts.viewer, {}))?.previewAccess).toBe("waitlisted");
  });
});

test("the real backend requires explicit current agreement acceptance, never token refresh", async () => {
  const email = `${randomUUID()}@example.com`;
  const client = backend.client(`user:${randomUUID()}`, {
    claims: { email, email_verified: true },
  });
  await backend.admin(internal.previewAccess.set, { kind: "email", value: email, enabled: true });
  expect(await client.mutation(api.accounts.ensureViewer, {})).toMatchObject({
    previewAccess: "granted",
    previewAgreementAccepted: false,
  });
  expect((await client.mutation(api.accounts.ensureViewer, {})).previewAgreementAccepted).toBe(
    false,
  );
  await expect(
    client.mutation(api.workspaces.create, { workspaceId: randomUUID(), name: "Not accepted" }),
  ).rejects.toMatchObject({ data: { code: "preview_agreement_required" } });
  expect(
    (
      await client.mutation(api.accounts.ensureViewer, {
        acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
      })
    ).previewAgreementAccepted,
  ).toBe(true);
  expect((await client.mutation(api.accounts.ensureViewer, {})).previewAgreementAccepted).toBe(
    true,
  );
  await expect(
    client.mutation(api.accounts.ensureViewer, { acceptedAgreementVersion: "old-version" }),
  ).rejects.toMatchObject({ data: { code: "preview_agreement_required" } });
});

test("a team code joins one new person at sign-in over the real transport; a second is refused", async () => {
  const inviterEmail = `${randomUUID()}@example.com`;
  const inviter = backend.client(`user:${randomUUID()}`, {
    claims: { email: inviterEmail, email_verified: true },
  });
  await backend.admin(internal.previewAccess.set, {
    kind: "email",
    value: inviterEmail,
    enabled: true,
  });
  await inviter.mutation(api.accounts.ensureViewer, {
    acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
  });
  const workspaceId = randomUUID();
  await inviter.mutation(api.workspaces.create, { workspaceId, name: "Team" });
  const link = await inviter.mutation(api.invites.create, {
    workspaceId,
    email: null,
    role: "member",
  });
  expect(link.preview).toBe("sponsored");
  const clients = [backend.client(`user:${randomUUID()}`), backend.client(`user:${randomUUID()}`)];
  const results = await Promise.allSettled(
    clients.map((client) =>
      client.mutation(api.accounts.ensureViewer, {
        inviteCode: link.token,
        acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
      }),
    ),
  );
  const joined = results.filter((result) => result.status === "fulfilled");
  expect(joined).toHaveLength(1);
  expect(joined[0]!.value).toMatchObject({
    previewAccess: "granted",
    joinedWorkspaceId: workspaceId,
  });
  const loser = clients[results.findIndex((result) => result.status === "rejected")]!;
  expect((await loser.query(api.accounts.viewer, {})) ?? null).toBeNull();
  const winner = clients[results.findIndex((result) => result.status === "fulfilled")]!;
  expect((await winner.query(api.workspaces.listMine, {})).map((row) => row.workspaceId)).toContain(
    workspaceId,
  );
  await expect(inviter.query(api.invites.list, { workspaceId })).resolves.toEqual([]);
});
