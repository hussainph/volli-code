import { randomUUID } from "node:crypto";

import { PREVIEW_ENROLLMENT_AGREEMENT_VERSION, newId } from "@volli/shared/cloud";

import { describe, expect, test } from "vite-plus/test";

import { api, internal } from "../functions/_generated/api";
import { connectBackend } from "../fixture/testing";

const backend = connectBackend();

// The backend is shared by every file in the run: each test signs in as fresh people.
function person(name: string) {
  const id = randomUUID();
  const email = `${name.toLowerCase()}-${id}@example.com`;
  const client = backend.client(`user:${id}`, {
    claims: { email, email_verified: true, name },
  });
  return { client, email };
}

function code(value: string) {
  return expect.objectContaining({ data: expect.objectContaining({ code: value }) });
}

/** VC-936: deployment-admin allowlisting, the way an operator invites someone to the preview. */
async function allow(email: string) {
  await backend.admin(internal.previewAccess.set, { kind: "email", value: email, enabled: true });
}

describe("workspaces on the pinned local backend", () => {
  test("sign-up, invite, join, manage and leave, end to end", async () => {
    const ana = person("Ana");
    const ben = person("Ben");
    const cy = person("Cy");
    // VC-936: only allowlisted accounts get a personal Workspace and may accept an invite,
    // and signing up accepts the current Preview Agreement.
    for (const someone of [ana, ben, cy]) await allow(someone.email);
    const acceptance = { acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION };
    const { userId: anaId } = await ana.client.mutation(api.accounts.ensureViewer, acceptance);
    const { userId: benId } = await ben.client.mutation(api.accounts.ensureViewer, acceptance);
    await cy.client.mutation(api.accounts.ensureViewer, acceptance);

    // Every account starts with its own Workspace, named after the person.
    const [personal] = await ana.client.query(api.workspaces.listMine, {});
    expect(personal).toMatchObject({
      name: "Ana",
      role: "owner",
      planKey: "free",
      activeMemberCount: 1,
    });

    const workspaceId = newId("workspace");
    await ana.client.mutation(api.workspaces.create, { workspaceId, name: "Ana & Co" });

    // An email invite, seen by Ben at sign-in and accepted by id.
    const emailInvite = await ana.client.mutation(api.invites.create, {
      workspaceId,
      email: ben.email.toUpperCase(),
      role: "admin",
    });
    const offered = await ben.client.query(api.invites.listMine, {});
    expect(offered).toEqual([
      expect.objectContaining({
        inviteId: emailInvite.inviteId,
        workspaceName: "Ana & Co",
        role: "admin",
      }),
    ]);
    await expect(
      cy.client.mutation(api.invites.accept, { inviteId: emailInvite.inviteId }),
    ).rejects.toThrow(code("invite_email_mismatch"));
    await expect(
      ben.client.mutation(api.invites.accept, { inviteId: emailInvite.inviteId }),
    ).resolves.toEqual({ workspaceId, role: "admin", alreadyMember: false });

    // A link invite from the admin, accepted by Cy with the token.
    const link = await ben.client.mutation(api.invites.create, {
      workspaceId,
      email: null,
      role: "member",
    });
    await expect(
      cy.client.query(api.invites.preview, { token: link.token }),
    ).resolves.toMatchObject({
      status: "valid",
      workspaceName: "Ana & Co",
      invitedByName: "Ben",
    });
    await cy.client.mutation(api.invites.acceptLink, { token: link.token });

    const switcher = await cy.client.query(api.workspaces.listMine, {});
    expect(switcher.map((row) => [row.name, row.role])).toEqual([
      ["Cy", "owner"],
      ["Ana & Co", "member"],
    ]);
    expect((await ana.client.query(api.workspaces.get, { workspaceId })).activeMemberCount).toBe(3);

    // Roles: a member manages nobody; an admin cannot touch the owner; the last owner stays.
    const { userId: cyId } = await cy.client.mutation(api.accounts.ensureViewer, {});
    await expect(
      cy.client.mutation(api.members.suspend, { workspaceId, userId: benId }),
    ).rejects.toThrow(code("forbidden"));
    await expect(
      ben.client.mutation(api.members.setRole, { workspaceId, userId: anaId, role: "member" }),
    ).rejects.toThrow(code("forbidden"));
    await expect(ana.client.mutation(api.members.leave, { workspaceId })).rejects.toThrow(
      code("last_owner"),
    );

    // Suspend drops the seat and the access; unsuspend restores both.
    await ben.client.mutation(api.members.suspend, { workspaceId, userId: cyId });
    expect((await ana.client.query(api.workspaces.get, { workspaceId })).activeMemberCount).toBe(2);
    await expect(cy.client.query(api.members.list, { workspaceId })).rejects.toThrow(
      code("not_a_member"),
    );
    await ben.client.mutation(api.members.unsuspend, { workspaceId, userId: cyId });
    expect((await ana.client.query(api.workspaces.get, { workspaceId })).activeMemberCount).toBe(3);

    // Policy: admins only, revisioned.
    await expect(
      cy.client.mutation(api.workspaces.setPolicy, { workspaceId, shareAll: true }),
    ).rejects.toThrow(code("forbidden"));
    await expect(
      ben.client.mutation(api.workspaces.setPolicy, {
        workspaceId,
        whoCanInvite: "admins",
        expectedRevision: 0,
      }),
    ).resolves.toMatchObject({ whoCanInvite: "admins", revision: 1 });
    await expect(
      cy.client.mutation(api.invites.create, { workspaceId, email: null, role: "member" }),
    ).rejects.toThrow(code("forbidden"));

    // Remove ends the membership; an invite brings the same person back.
    await ben.client.mutation(api.members.remove, { workspaceId, userId: cyId });
    await expect(cy.client.query(api.workspaces.get, { workspaceId })).rejects.toThrow(
      code("not_a_member"),
    );
    expect((await ana.client.query(api.workspaces.get, { workspaceId })).activeMemberCount).toBe(2);
    const back = await ben.client.mutation(api.invites.create, {
      workspaceId,
      email: cy.email,
      role: "member",
    });
    await expect(
      cy.client.mutation(api.invites.accept, { inviteId: back.inviteId }),
    ).resolves.toEqual({
      workspaceId,
      role: "member",
      alreadyMember: false,
    });

    // Hand the Workspace on, then the first owner may leave.
    await ana.client.mutation(api.members.setRole, { workspaceId, userId: benId, role: "owner" });
    await expect(ana.client.mutation(api.members.leave, { workspaceId })).resolves.toMatchObject({
      status: "left",
    });
    const roster = await ben.client.query(api.members.list, { workspaceId });
    expect(roster.map((row) => [row.userId, row.role])).toEqual([
      [benId, "owner"],
      [cyId, "member"],
    ]);
  });

  test("anonymous callers are refused with a typed error", async () => {
    await expect(backend.client().query(api.workspaces.listMine, {})).rejects.toThrow(
      code("unauthenticated"),
    );
    await expect(
      backend.client().mutation(api.invites.acceptLink, { token: "x".repeat(43) }),
    ).rejects.toThrow(code("unauthenticated"));
  });
});
