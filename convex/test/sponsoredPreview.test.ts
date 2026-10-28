/**
 * Sponsored preview access (Amendment 31): an invite also lets its invitee
 * into the invite-only preview, on its sender's allowance, and a link's code
 * pasted at sign-in joins in the same step. This is the preview's security
 * gate: every way an invite could grant more than its sender may give is
 * refused here.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vite-plus/test";

import {
  DEFAULT_PREVIEW_SPONSOR_SEATS,
  MAX_PREVIEW_SPONSOR_SEATS,
  PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
  newId,
  type UserId,
} from "@volli/shared/cloud";

import { api, internal } from "../functions/_generated/api";
import schema from "../functions/schema";
import { redeemPreviewCode } from "../functions/lib/previewAccess";
import { redeemInviteGrant } from "../functions/lib/sponsoredPreview";

const modules = import.meta.glob("../functions/**/*.ts");
const AGREED = { acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION };

const setup = () => convexTest(schema, modules);
type T = ReturnType<typeof setup>;

function person(name: string, options: { verified?: boolean; email?: string | null } = {}) {
  const email = options.email === undefined ? `${name}@example.com` : options.email;
  return {
    subject: `user:${name}`,
    issuer: "https://issuer.test",
    name,
    ...(email === null ? {} : { email, emailVerified: options.verified ?? true }),
  };
}

function code(value: string) {
  return expect.objectContaining({ data: expect.objectContaining({ code: value }) });
}

/** An operator-allowlisted person, signed in and set up, with a team Workspace. */
async function sponsor(t: T, name: string) {
  await t.mutation(internal.previewAccess.set, {
    kind: "email",
    value: `${name}@example.com`,
    enabled: true,
  });
  const client = t.withIdentity(person(name));
  const { userId } = await client.mutation(api.accounts.ensureViewer, AGREED);
  const workspaceId = newId("workspace");
  await client.mutation(api.workspaces.create, { workspaceId, name: `${name}'s team` });
  return { client, userId, workspaceId };
}

async function grants(t: T) {
  return await t.run((ctx) => ctx.db.query("previewAccess").collect());
}

async function grantFor(t: T, inviteId: string) {
  return (await grants(t)).find((grant) => grant.inviteId === inviteId) ?? null;
}

async function viewerOf(t: T, userId: string) {
  const user = await t.run((ctx) =>
    ctx.db
      .query("users")
      .withIndex("by_uuid", (q) => q.eq("id", userId))
      .unique(),
  );
  return { userId: userId as UserId, user: user! };
}

async function memberships(t: T, userId: string) {
  return (
    await t.run((ctx) =>
      ctx.db
        .query("workspaceMembers")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect(),
    )
  ).map((row) => row.workspaceId);
}

describe("an email invite", () => {
  test("sponsors its verified address; signing in binds the grant and joining keeps it", async () => {
    const t = setup();
    const alice = await sponsor(t, "alice");
    const invite = await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: " Carol@Example.com ",
      role: "member",
    });
    expect(invite.preview).toBe("sponsored");
    const grant = await grantFor(t, invite.inviteId);
    expect(grant).toMatchObject({
      kind: "email",
      key: "carol@example.com",
      sponsorUserId: alice.userId,
      redeemedByUserId: null,
      expiresAt: invite.expiresAt,
    });
    await expect(
      alice.client.query(api.invites.list, { workspaceId: alice.workspaceId }),
    ).resolves.toMatchObject([{ inviteId: invite.inviteId, preview: "sponsored" }]);
    const sponsored = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .withIndex("by_target", (q) => q.eq("targetKind", "invite").eq("targetId", invite.inviteId))
        .collect(),
    );
    expect(sponsored.map((row) => row.kind)).toEqual(["invite.created", "preview.sponsored"]);
    expect(sponsored[1]!.actor).toEqual({ kind: "person", userId: alice.userId });

    const carol = t.withIdentity(person("carol"));
    // Without the agreement the grant is not used yet: it still lapses with the invite.
    expect(await carol.mutation(api.accounts.ensureViewer, {})).toMatchObject({
      previewAccess: "granted",
      previewAgreementAccepted: false,
      joinedWorkspaceId: null,
    });
    expect((await grantFor(t, invite.inviteId))!.redeemedByUserId).toBeNull();
    const signedIn = await carol.mutation(api.accounts.ensureViewer, AGREED);
    expect(signedIn).toMatchObject({ previewAccess: "granted", joinedWorkspaceId: null });
    expect(await grantFor(t, invite.inviteId)).toMatchObject({
      redeemedByUserId: signedIn.userId,
      expiresAt: null,
    });
    // An email invite asks: signing in sets up a personal Workspace and offers the team one.
    expect(await carol.query(api.workspaces.listMine, {})).toHaveLength(1);
    await expect(carol.query(api.invites.listMine, {})).resolves.toMatchObject([
      { inviteId: invite.inviteId },
    ]);
    await carol.mutation(api.invites.accept, { inviteId: invite.inviteId });
    expect(await memberships(t, signedIn.userId)).toContain(alice.workspaceId);
    // Used: revoking the sponsor's other invites or a lapse of time no longer matters.
    expect((await carol.query(api.accounts.viewer, {}))?.previewAccess).toBe("granted");
  });

  test("an unverified address never matches the grant, at sign-in or by code", async () => {
    const t = setup();
    const alice = await sponsor(t, "alice");
    const invite = await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: "carol@example.com",
      role: "member",
    });
    const unverified = t.withIdentity(person("carol", { verified: false }));
    expect((await unverified.mutation(api.accounts.ensureViewer, AGREED)).previewAccess).toBe(
      "waitlisted",
    );
    await expect(unverified.query(api.invites.listMine, {})).rejects.toThrow(
      code("preview_waitlisted"),
    );
    // The invite's own token does not help: the address must be theirs, verified.
    await expect(
      unverified.mutation(api.accounts.ensureViewer, { inviteCode: invite.token, ...AGREED }),
    ).rejects.toThrow(code("invite_email_mismatch"));
    expect((await grantFor(t, invite.inviteId))!.redeemedByUserId).toBeNull();
    // An enrolled person with no address binds nothing.
    const noEmail = t.withIdentity(person("nobody", { email: null }));
    const { userId } = await noEmail.mutation(api.accounts.ensureViewer, {});
    await t.mutation(internal.previewAccess.set, { kind: "user", value: userId, enabled: true });
    await noEmail.mutation(api.accounts.ensureViewer, AGREED);
    expect((await grantFor(t, invite.inviteId))!.redeemedByUserId).toBeNull();
  });

  test("someone else pasting an email invite's token gets nothing", async () => {
    const t = setup();
    const alice = await sponsor(t, "alice");
    const invite = await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: "carol@example.com",
      role: "member",
    });
    const mallory = t.withIdentity(person("mallory"));
    await expect(
      mallory.mutation(api.accounts.ensureViewer, { inviteCode: invite.token, ...AGREED }),
    ).rejects.toThrow(code("invite_email_mismatch"));
    // The refusal rolled the whole sign-in back: no account, no redemption.
    const users = await t.run((ctx) => ctx.db.query("users").collect());
    expect(users.map((user) => user.primaryEmail)).not.toContain("mallory@example.com");
    expect((await grantFor(t, invite.inviteId))!.redeemedByUserId).toBeNull();
  });

  test("a granted invitee pasting their own email invite's code joins at sign-in", async () => {
    const t = setup();
    const alice = await sponsor(t, "alice");
    const invite = await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: "carol@example.com",
      role: "admin",
    });
    const carol = t.withIdentity(person("carol"));
    const signedIn = await carol.mutation(api.accounts.ensureViewer, {
      inviteCode: invite.token,
      ...AGREED,
    });
    expect(signedIn).toMatchObject({
      previewAccess: "granted",
      joinedWorkspaceId: alice.workspaceId,
    });
    expect(await memberships(t, signedIn.userId)).toHaveLength(2);
    expect((await grantFor(t, invite.inviteId))!.redeemedByUserId).toBe(signedIn.userId);
  });

  test("a bound grant serves only the person who used it", async () => {
    const t = setup();
    const alice = await sponsor(t, "alice");
    await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: "carol@example.com",
      role: "member",
    });
    await t.withIdentity(person("carol")).mutation(api.accounts.ensureViewer, AGREED);
    // A second account that later verifies the same address is not carol.
    const other = t.withIdentity({ ...person("carol"), subject: "user:carol-again" });
    expect((await other.mutation(api.accounts.ensureViewer, AGREED)).previewAccess).toBe(
      "waitlisted",
    );
  });

  test("an address that already has access uses no seat", async () => {
    const t = setup();
    const alice = await sponsor(t, "alice");
    await sponsor(t, "bob");
    const byGrant = await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: "bob@example.com",
      role: "member",
    });
    expect(byGrant.preview).toBe("already_granted");
    // An unverified account at an address has no claim on it…
    await t
      .withIdentity({ ...person("zed"), subject: "user:zed-shadow", emailVerified: false })
      .mutation(api.accounts.ensureViewer, {});
    // …but access by user id, not by the address, is someone already in the preview.
    const zed = t.withIdentity(person("zed"));
    const { userId } = await zed.mutation(api.accounts.ensureViewer, {});
    await t.mutation(internal.previewAccess.set, { kind: "user", value: userId, enabled: true });
    const byUser = await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: "zed@example.com",
      role: "member",
    });
    expect(byUser.preview).toBe("already_granted");
    expect((await grants(t)).filter((grant) => grant.sponsorUserId !== undefined)).toEqual([]);
    await expect(
      alice.client.query(api.invites.list, { workspaceId: alice.workspaceId }),
    ).resolves.toMatchObject([{ preview: "already_granted" }, { preview: "already_granted" }]);
  });

  test("never takes over an address Volli withdrew", async () => {
    const t = setup();
    const alice = await sponsor(t, "alice");
    await t.mutation(internal.previewAccess.set, {
      kind: "email",
      value: "frank@example.com",
      enabled: false,
    });
    const invite = await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: "frank@example.com",
      role: "member",
    });
    expect(invite.preview).toBe("needs_access");
    // The invite still exists: Frank can join once Volli lets him in.
    await expect(
      alice.client.query(api.invites.list, { workspaceId: alice.workspaceId }),
    ).resolves.toMatchObject([{ inviteId: invite.inviteId, preview: "needs_access" }]);
    expect(await grantFor(t, invite.inviteId)).toBeNull();
  });

  test("a grant that lapsed unused may be sponsored again, by anyone", async () => {
    const t = setup();
    const alice = await sponsor(t, "alice");
    const bob = await sponsor(t, "bob");
    const first = await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: "gina@example.com",
      role: "member",
    });
    const lapsed = (await grantFor(t, first.inviteId))!;
    await t.run((ctx) => ctx.db.patch(lapsed._id, { expiresAt: Date.now() - 1 }));
    expect(
      (await alice.client.query(api.invites.list, { workspaceId: alice.workspaceId }))[0]!.preview,
    ).toBe("needs_access");
    const second = await bob.client.mutation(api.invites.create, {
      workspaceId: bob.workspaceId,
      email: "gina@example.com",
      role: "member",
    });
    expect(second.preview).toBe("sponsored");
    expect(await t.run((ctx) => ctx.db.get(lapsed._id))).toMatchObject({
      sponsorUserId: bob.userId,
      inviteId: second.inviteId,
      expiresAt: second.expiresAt,
    });
    // The earlier invite now reads the address as granted another way.
    expect(
      (await alice.client.query(api.invites.list, { workspaceId: alice.workspaceId }))[0]!.preview,
    ).toBe("already_granted");
  });
});

describe("the allowance", () => {
  test("five people by default; the sixth invite is still made, without access", async () => {
    const t = setup();
    const alice = await sponsor(t, "alice");
    const made = [];
    for (let index = 0; index <= DEFAULT_PREVIEW_SPONSOR_SEATS; index += 1) {
      made.push(
        await alice.client.mutation(api.invites.create, {
          workspaceId: alice.workspaceId,
          // Links and addresses draw on the same allowance.
          email: index % 2 === 0 ? null : `person${index}@example.com`,
          role: "member",
        }),
      );
    }
    expect(made.map((invite) => invite.preview)).toEqual([
      ...Array.from({ length: DEFAULT_PREVIEW_SPONSOR_SEATS }, () => "sponsored"),
      "needs_access",
    ]);
    // Seats are counted across every Workspace the sponsor invites into.
    const other = newId("workspace");
    await alice.client.mutation(api.workspaces.create, { workspaceId: other, name: "Other" });
    expect(
      (
        await alice.client.mutation(api.invites.create, {
          workspaceId: other,
          email: null,
          role: "member",
        })
      ).preview,
    ).toBe("needs_access");
    // A revoked invite frees its seat.
    await alice.client.mutation(api.invites.revoke, { inviteId: made[0]!.inviteId });
    expect(await grantFor(t, made[0]!.inviteId)).toBeNull();
    expect(
      (
        await alice.client.mutation(api.invites.create, {
          workspaceId: other,
          email: null,
          role: "member",
        })
      ).preview,
    ).toBe("sponsored");
  });

  test("an operator's allowance replaces the default; 0 turns sponsoring off", async () => {
    const t = setup();
    const alice = await sponsor(t, "alice");
    await expect(
      t.mutation(internal.previewAccess.setSponsorSeats, {
        email: "ALICE@example.com",
        seats: 0,
      }),
    ).resolves.toEqual({ userId: alice.userId, seats: 0 });
    const off = await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: "carol@example.com",
      role: "member",
    });
    expect(off.preview).toBe("needs_access");
    expect(await grants(t)).toHaveLength(1);
    const carol = t.withIdentity(person("carol"));
    expect((await carol.mutation(api.accounts.ensureViewer, AGREED)).previewAccess).toBe(
      "waitlisted",
    );
    await t.mutation(internal.previewAccess.setSponsorSeats, { userId: alice.userId, seats: 1 });
    // A reissue sponsors again, now that there is a seat.
    const again = await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: "carol@example.com",
      role: "member",
    });
    expect(again).toMatchObject({ reissued: true, preview: "sponsored" });
    expect(
      (
        await alice.client.mutation(api.invites.create, {
          workspaceId: alice.workspaceId,
          email: null,
          role: "member",
        })
      ).preview,
    ).toBe("needs_access");
  });

  test("a used grant keeps its seat after its invite is revoked or gone", async () => {
    const t = setup();
    const alice = await sponsor(t, "alice");
    await t.mutation(internal.previewAccess.setSponsorSeats, { userId: alice.userId, seats: 1 });
    const invite = await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: "carol@example.com",
      role: "member",
    });
    const carol = t.withIdentity(person("carol"));
    await carol.mutation(api.accounts.ensureViewer, AGREED);
    await alice.client.mutation(api.invites.revoke, { inviteId: invite.inviteId });
    expect((await carol.query(api.accounts.viewer, {}))?.previewAccess).toBe("granted");
    expect(
      (
        await alice.client.mutation(api.invites.create, {
          workspaceId: alice.workspaceId,
          email: null,
          role: "member",
        })
      ).preview,
    ).toBe("needs_access");
  });

  test("operator inputs are checked", async () => {
    const t = setup();
    const alice = await sponsor(t, "alice");
    await t
      .withIdentity(person("twin-a", { email: "twin@example.com" }))
      .mutation(api.accounts.ensureViewer, {});
    await t
      .withIdentity(person("twin-b", { email: "twin@example.com" }))
      .mutation(api.accounts.ensureViewer, {});
    for (const args of [
      { seats: 1 },
      { userId: alice.userId, email: "alice@example.com", seats: 1 },
      { userId: alice.userId, seats: -1 },
      { userId: alice.userId, seats: 1.5 },
      { userId: alice.userId, seats: MAX_PREVIEW_SPONSOR_SEATS + 1 },
      { userId: "not-a-uuid", seats: 1 },
      { email: "not-an-email", seats: 1 },
      { email: "twin@example.com", seats: 1 },
    ]) {
      await expect(t.mutation(internal.previewAccess.setSponsorSeats, args)).rejects.toThrow(
        code("invalid_argument"),
      );
    }
    for (const args of [
      { userId: newId("user"), seats: 1 },
      { email: "nobody@example.com", seats: 1 },
    ]) {
      await expect(t.mutation(internal.previewAccess.setSponsorSeats, args)).rejects.toThrow(
        code("not_found"),
      );
    }
    await expect(
      t.mutation(internal.previewAccess.setSponsorSeats, {
        userId: alice.userId,
        seats: MAX_PREVIEW_SPONSOR_SEATS,
      }),
    ).resolves.toMatchObject({ seats: MAX_PREVIEW_SPONSOR_SEATS });
  });
});

describe("revoking", () => {
  test("revoking an invite withdraws its unused grant", async () => {
    const t = setup();
    const alice = await sponsor(t, "alice");
    const invite = await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: "carol@example.com",
      role: "member",
    });
    await alice.client.mutation(api.invites.revoke, { inviteId: invite.inviteId });
    expect(await grantFor(t, invite.inviteId)).toBeNull();
    const carol = t.withIdentity(person("carol"));
    expect((await carol.mutation(api.accounts.ensureViewer, AGREED)).previewAccess).toBe(
      "waitlisted",
    );
  });

  test("a revoked sponsor keeps their people (not cascaded); revokeSponsoredBy withdraws them for good", async () => {
    const t = setup();
    const alice = await sponsor(t, "alice");
    const bob = await sponsor(t, "bob");
    await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: "carol@example.com",
      role: "member",
    });
    const unused = await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: null,
      role: "member",
    });
    const lapsed = await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: "lapsed@example.com",
      role: "member",
    });
    const lapsedGrant = (await grantFor(t, lapsed.inviteId))!;
    await t.run((ctx) => ctx.db.patch(lapsedGrant._id, { expiresAt: Date.now() - 1 }));
    const carol = t.withIdentity(person("carol"));
    await carol.mutation(api.accounts.ensureViewer, AGREED);
    await t.mutation(internal.previewAccess.set, {
      kind: "email",
      value: "alice@example.com",
      enabled: false,
    });
    // Alice is out: she can no longer invite, but carol stays in.
    await expect(
      alice.client.mutation(api.invites.create, {
        workspaceId: alice.workspaceId,
        email: "dave@example.com",
        role: "member",
      }),
    ).rejects.toThrow(code("preview_waitlisted"));
    expect((await carol.query(api.accounts.viewer, {}))?.previewAccess).toBe("granted");

    await expect(
      t.mutation(internal.previewAccess.revokeSponsoredBy, { userId: alice.userId }),
    ).resolves.toEqual({ revoked: 2 });
    expect((await carol.query(api.accounts.viewer, {}))?.previewAccess).toBe("waitlisted");
    expect((await grantFor(t, unused.inviteId))!.revokedAt).not.toBeNull();
    // A lapsed grant was not live, so it is left free for someone else to sponsor.
    expect((await grantFor(t, lapsed.inviteId))!.revokedAt).toBeNull();
    expect((await viewerOf(t, alice.userId)).user.previewSponsorSeats).toBe(0);
    // Another sponsor cannot revive what the operator withdrew.
    const revived = await bob.client.mutation(api.invites.create, {
      workspaceId: bob.workspaceId,
      email: "carol@example.com",
      role: "member",
    });
    expect(revived.preview).toBe("needs_access");
    await expect(
      t.withIdentity(person("erin")).mutation(api.accounts.ensureViewer, {
        inviteCode: unused.token,
        ...AGREED,
      }),
    ).rejects.toThrow(code("preview_waitlisted"));
    // The operator can: their grant replaces the sponsored one and takes no seat.
    await t.mutation(internal.previewAccess.set, {
      kind: "email",
      value: "carol@example.com",
      enabled: true,
    });
    const restored = (await grants(t)).find((grant) => grant.key === "carol@example.com")!;
    expect(restored).toMatchObject({ revokedAt: null, expiresAt: null });
    expect(restored.sponsorUserId).toBeUndefined();
    expect(restored.inviteId).toBeUndefined();
    expect((await carol.query(api.accounts.viewer, {}))?.previewAccess).toBe("granted");
    await expect(
      t.mutation(internal.previewAccess.revokeSponsoredBy, { userId: newId("user") }),
    ).rejects.toThrow(code("not_found"));
  });
});

describe("a person Volli withdrew", () => {
  test("is never sponsored back in, by address or by code", async () => {
    const t = setup();
    const alice = await sponsor(t, "alice");
    // Withdrawn by user id: their address has no grant row at all.
    const zed = t.withIdentity(person("zed"));
    const { userId: zedId } = await zed.mutation(api.accounts.ensureViewer, {});
    await t.mutation(internal.previewAccess.set, { kind: "user", value: zedId, enabled: true });
    await zed.mutation(api.accounts.ensureViewer, AGREED);
    await t.mutation(internal.previewAccess.set, { kind: "user", value: zedId, enabled: false });
    const byAddress = await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: "zed@example.com",
      role: "member",
    });
    expect(byAddress.preview).toBe("needs_access");
    const link = await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: null,
      role: "member",
    });
    await expect(
      zed.mutation(api.accounts.ensureViewer, { inviteCode: link.token, ...AGREED }),
    ).rejects.toThrow(code("preview_waitlisted"));
    // Withdrawn by a code they had redeemed: the same.
    const operatorCode = "operator-preview-code-7654321";
    await t.mutation(internal.previewAccess.set, {
      kind: "code",
      value: operatorCode,
      enabled: true,
    });
    const yan = t.withIdentity(person("yan", { email: null }));
    await yan.mutation(api.accounts.ensureViewer, { inviteCode: operatorCode, ...AGREED });
    await t.mutation(internal.previewAccess.set, {
      kind: "code",
      value: operatorCode,
      enabled: false,
    });
    await expect(
      yan.mutation(api.accounts.ensureViewer, { inviteCode: link.token, ...AGREED }),
    ).rejects.toThrow(code("preview_waitlisted"));
    expect((await grantFor(t, link.inviteId))!.redeemedByUserId).toBeNull();
    // Someone Volli never withdrew still joins with the same link.
    await expect(
      t.withIdentity(person("xia")).mutation(api.accounts.ensureViewer, {
        inviteCode: link.token,
        ...AGREED,
      }),
    ).resolves.toMatchObject({ joinedWorkspaceId: alice.workspaceId });
  });

  test("a Member already in never takes the code meant for someone else", async () => {
    const t = setup();
    const alice = await sponsor(t, "alice");
    const first = await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: null,
      role: "member",
    });
    const wes = t.withIdentity(person("wes"));
    const joined = await wes.mutation(api.accounts.ensureViewer, {
      inviteCode: first.token,
      ...AGREED,
    });
    // Wes's access lapses (its grant expires), then he pastes a code meant for someone else.
    const used = (await grantFor(t, first.inviteId))!;
    await t.run((ctx) => ctx.db.patch(used._id, { expiresAt: Date.now() - 1 }));
    const meant = await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: null,
      role: "member",
    });
    await expect(
      wes.mutation(api.accounts.ensureViewer, { inviteCode: meant.token, ...AGREED }),
    ).rejects.toThrow(code("preview_waitlisted"));
    expect((await grantFor(t, meant.inviteId))!.redeemedByUserId).toBeNull();
    expect(await memberships(t, joined.userId)).toContain(alice.workspaceId);
  });
});

describe("reissuing", () => {
  test("extends the grant with the invite, under whoever reissued it", async () => {
    const t = setup();
    const alice = await sponsor(t, "alice");
    const bob = await sponsor(t, "bob");
    const { token } = await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: null,
      role: "admin",
    });
    await bob.client.mutation(api.invites.acceptLink, { token });
    const first = await bob.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: "carol@example.com",
      role: "member",
    });
    const before = (await grantFor(t, first.inviteId))!;
    await t.run((ctx) => ctx.db.patch(before._id, { expiresAt: Date.now() + 1000 }));
    const again = await bob.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: "carol@example.com",
      role: "member",
    });
    expect(again).toMatchObject({ reissued: true, preview: "sponsored" });
    expect(await grantFor(t, first.inviteId)).toMatchObject({
      sponsorUserId: bob.userId,
      expiresAt: again.expiresAt,
    });
    // The owner reissues it: the seat moves to her.
    await t.mutation(internal.previewAccess.setSponsorSeats, { userId: alice.userId, seats: 0 });
    const byOwner = await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: "carol@example.com",
      role: "member",
    });
    expect(byOwner).toMatchObject({ reissued: true, preview: "needs_access" });
    expect(await grantFor(t, first.inviteId)).toBeNull();
  });

  test("a member cannot move someone else's invite, or its grant", async () => {
    const t = setup();
    const alice = await sponsor(t, "alice");
    const mallory = await sponsor(t, "mallory");
    const { token } = await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: null,
      role: "member",
    });
    await mallory.client.mutation(api.invites.acceptLink, { token });
    const invite = await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: "carol@example.com",
      role: "member",
    });
    await expect(
      mallory.client.mutation(api.invites.create, {
        workspaceId: alice.workspaceId,
        email: "carol@example.com",
        role: "member",
      }),
    ).rejects.toThrow(code("already_invited"));
    await expect(
      mallory.client.mutation(api.invites.revoke, { inviteId: invite.inviteId }),
    ).rejects.toThrow(code("forbidden"));
    expect((await grantFor(t, invite.inviteId))!.sponsorUserId).toBe(alice.userId);
  });
});

describe("a team code at sign-in", () => {
  test("a new person joins with a link's code: granted, set up and a Member in one step", async () => {
    const t = setup();
    const alice = await sponsor(t, "alice");
    const link = await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: null,
      role: "member",
    });
    expect(link.preview).toBe("sponsored");
    const dave = t.withIdentity(person("dave"));
    const joined = await dave.mutation(api.accounts.ensureViewer, {
      inviteCode: link.token,
      ...AGREED,
    });
    expect(joined).toMatchObject({
      previewAccess: "granted",
      previewAgreementAccepted: true,
      created: true,
      joinedWorkspaceId: alice.workspaceId,
    });
    // A personal Workspace too (D9), and the team one.
    expect(await memberships(t, joined.userId)).toHaveLength(2);
    expect(await grantFor(t, link.inviteId)).toMatchObject({
      kind: "code",
      redeemedByUserId: joined.userId,
      expiresAt: null,
    });
    // Retrying on the same account is harmless.
    await expect(
      dave.mutation(api.accounts.ensureViewer, { inviteCode: link.token, ...AGREED }),
    ).resolves.toMatchObject({ joinedWorkspaceId: alice.workspaceId, created: false });
    // A code is used once: the second person is refused, and nothing of theirs is kept.
    const erin = t.withIdentity(person("erin"));
    await expect(
      erin.mutation(api.accounts.ensureViewer, { inviteCode: link.token, ...AGREED }),
    ).rejects.toThrow(code("invite_invalid"));
    const users = await t.run((ctx) => ctx.db.query("users").collect());
    expect(users.map((user) => user.primaryEmail)).not.toContain("erin@example.com");
    // Nor can the operator-code path redeem a link's grant without joining.
    const daveViewer = await viewerOf(t, joined.userId);
    await expect(t.run((ctx) => redeemPreviewCode(ctx, daveViewer, link.token))).rejects.toThrow(
      code("preview_waitlisted"),
    );
  });

  test("never redeems without the agreement", async () => {
    const t = setup();
    const alice = await sponsor(t, "alice");
    const link = await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: null,
      role: "member",
    });
    const dave = t.withIdentity(person("dave"));
    await expect(
      dave.mutation(api.accounts.ensureViewer, { inviteCode: link.token }),
    ).rejects.toThrow(code("preview_agreement_required"));
    expect((await grantFor(t, link.inviteId))!.redeemedByUserId).toBeNull();
    await expect(
      alice.client.query(api.invites.list, { workspaceId: alice.workspaceId }),
    ).resolves.toHaveLength(1);
  });

  test("a link that carries no access lets nobody in", async () => {
    const t = setup();
    const alice = await sponsor(t, "alice");
    await t.mutation(internal.previewAccess.setSponsorSeats, { userId: alice.userId, seats: 0 });
    const link = await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: null,
      role: "member",
    });
    expect(link.preview).toBe("needs_access");
    await expect(
      t.withIdentity(person("dave")).mutation(api.accounts.ensureViewer, {
        inviteCode: link.token,
        ...AGREED,
      }),
    ).rejects.toThrow(code("preview_waitlisted"));
    // Someone already in the preview can still join with it.
    const bob = await sponsor(t, "bob");
    await expect(
      bob.client.mutation(api.accounts.ensureViewer, { inviteCode: link.token, ...AGREED }),
    ).resolves.toMatchObject({ joinedWorkspaceId: alice.workspaceId });
  });

  test("an existing preview person joining with a code frees the seat it would have used", async () => {
    const t = setup();
    const alice = await sponsor(t, "alice");
    const bob = await sponsor(t, "bob");
    const atSignIn = await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: null,
      role: "member",
    });
    const bySwitcher = await bob.client.mutation(api.invites.create, {
      workspaceId: bob.workspaceId,
      email: null,
      role: "member",
    });
    await expect(
      bob.client.mutation(api.accounts.ensureViewer, { inviteCode: atSignIn.token, ...AGREED }),
    ).resolves.toMatchObject({ joinedWorkspaceId: alice.workspaceId });
    expect(await grantFor(t, atSignIn.inviteId)).toBeNull();
    await alice.client.mutation(api.invites.acceptLink, { token: bySwitcher.token });
    expect(await grantFor(t, bySwitcher.inviteId)).toBeNull();
  });

  test("refuses an expired, revoked, deleted or suspended join before granting anything", async () => {
    const t = setup();
    const alice = await sponsor(t, "alice");
    const bob = await sponsor(t, "bob");
    const make = () =>
      alice.client.mutation(api.invites.create, {
        workspaceId: alice.workspaceId,
        email: null,
        role: "member",
      });
    const signIn = (who: string, token: string) =>
      t.withIdentity(person(who)).mutation(api.accounts.ensureViewer, {
        inviteCode: token,
        ...AGREED,
      });

    const expired = await make();
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("workspaceInvites").collect()).find(
        (invite) => invite.id === expired.inviteId,
      )!;
      await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
    });
    await expect(signIn("dave", expired.token)).rejects.toThrow(code("invite_expired"));

    const revoked = await make();
    await alice.client.mutation(api.invites.revoke, { inviteId: revoked.inviteId });
    await expect(signIn("dave", revoked.token)).rejects.toThrow(code("invite_invalid"));

    // Bob joins, is suspended, then tries another code.
    const first = await make();
    await bob.client.mutation(api.invites.acceptLink, { token: first.token });
    await alice.client.mutation(api.members.suspend, {
      workspaceId: alice.workspaceId,
      userId: bob.userId,
    });
    const second = await make();
    await expect(
      bob.client.mutation(api.accounts.ensureViewer, { inviteCode: second.token, ...AGREED }),
    ).rejects.toThrow(code("suspended"));

    const gone = await make();
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("workspaces").collect()).find(
        (workspace) => workspace.id === alice.workspaceId,
      )!;
      await ctx.db.patch(row._id, { deletedAt: Date.now() });
    });
    await expect(signIn("dave", gone.token)).rejects.toThrow(code("invite_invalid"));
    expect((await grantFor(t, gone.inviteId))!.redeemedByUserId).toBeNull();
  });

  test("an operator code still works, and is never mistaken for a team code", async () => {
    const t = setup();
    const operatorCode = "operator-preview-code-1234567";
    await t.mutation(internal.previewAccess.set, {
      kind: "code",
      value: operatorCode,
      enabled: true,
    });
    await expect(
      t.withIdentity(person("dave")).mutation(api.accounts.ensureViewer, {
        inviteCode: operatorCode,
        ...AGREED,
      }),
    ).resolves.toMatchObject({ previewAccess: "granted", joinedWorkspaceId: null });
  });

  test("the grant helpers refuse what the flow never asks of them", async () => {
    const t = setup();
    const alice = await sponsor(t, "alice");
    const email = await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: "carol@example.com",
      role: "member",
    });
    const link = await alice.client.mutation(api.invites.create, {
      workspaceId: alice.workspaceId,
      email: null,
      role: "member",
    });
    const dave = t.withIdentity(person("dave"));
    const { userId } = await dave.mutation(api.accounts.ensureViewer, {});
    const viewer = await viewerOf(t, userId);
    const invites = await t.run((ctx) => ctx.db.query("workspaceInvites").collect());
    const byId = (id: string) => invites.find((invite) => invite.id === id)!;
    // An email invite never carries a code grant.
    await expect(
      t.run((ctx) => redeemInviteGrant(ctx, viewer, byId(email.inviteId))),
    ).rejects.toThrow(code("preview_waitlisted"));
    // A code grant bound to someone else is not theirs to redeem.
    const grant = (await grantFor(t, link.inviteId))!;
    await t.run((ctx) => ctx.db.patch(grant._id, { redeemedByUserId: alice.userId }));
    await expect(
      t.run((ctx) => redeemInviteGrant(ctx, viewer, byId(link.inviteId))),
    ).rejects.toThrow(code("preview_waitlisted"));
    // Nor is a code grant that belongs to another invite.
    await t.run((ctx) =>
      ctx.db.patch(grant._id, { redeemedByUserId: null, inviteId: newId("invite") }),
    );
    await expect(
      t.run((ctx) => redeemInviteGrant(ctx, viewer, byId(link.inviteId))),
    ).rejects.toThrow(code("preview_waitlisted"));
  });
});
