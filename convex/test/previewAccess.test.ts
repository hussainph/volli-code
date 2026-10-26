import { convexTest } from "convex-test";
import { describe, expect, test } from "vite-plus/test";
import { PREVIEW_ENROLLMENT_AGREEMENT_VERSION, newId } from "@volli/shared/cloud";
import { api, internal } from "../functions/_generated/api";
import schema from "../functions/schema";

const modules = import.meta.glob("../functions/**/*.ts");
const person = (subject: string, emailVerified = true) => ({
  subject,
  issuer: "https://issuer.test",
  email: `${subject}@example.com`,
  emailVerified,
});
const refused = expect.objectContaining({
  data: expect.objectContaining({ code: "preview_waitlisted" }),
});
const setup = () => convexTest(schema, modules);

describe("preview access", () => {
  test("waitlists a new account without creating a Workspace; a later grant sets it up once", async () => {
    const t = setup();
    const client = t.withIdentity(person("alice"));
    const first = await client.mutation(api.accounts.ensureViewer, {
      acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
    });
    expect(first.previewAccess).toBe("waitlisted");
    await expect(client.query(api.workspaces.listMine, {})).rejects.toThrow(refused);
    await expect(
      client.mutation(api.workspaces.create, { workspaceId: newId("workspace"), name: "No" }),
    ).rejects.toThrow(refused);
    await t.mutation(internal.previewAccess.set, {
      kind: "email",
      value: " Alice@Example.com ",
      enabled: true,
    });
    expect(
      (
        await client.mutation(api.accounts.ensureViewer, {
          acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
        })
      ).previewAccess,
    ).toBe("granted");
    await client.mutation(api.accounts.ensureViewer, {
      acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
    });
    expect(await client.query(api.workspaces.listMine, {})).toHaveLength(1);
    await t.mutation(internal.previewAccess.set, {
      kind: "email",
      value: "alice@example.com",
      enabled: false,
    });
    expect(
      (
        await client.mutation(api.accounts.ensureViewer, {
          acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
        })
      ).previewAccess,
    ).toBe("waitlisted");
    await expect(
      client.mutation(api.workspaces.create, { workspaceId: newId("workspace"), name: "No" }),
    ).rejects.toThrow(refused);
    await t.mutation(internal.previewAccess.set, {
      kind: "user",
      value: first.userId,
      enabled: true,
    });
    expect((await client.query(api.accounts.viewer, {}))?.previewAccess).toBe("granted");
    expect(
      (await client.mutation(api.accounts.ensureViewer, { inviteCode: "bad" })).previewAccess,
    ).toBe("granted");
    const changedEmail = t.withIdentity({ ...person("alice"), email: "changed@example.com" });
    await t.mutation(internal.previewAccess.set, {
      kind: "user",
      value: first.userId,
      enabled: false,
    });
    await t.mutation(internal.previewAccess.set, {
      kind: "email",
      value: "alice@example.com",
      enabled: true,
    });
    expect(
      (
        await changedEmail.mutation(api.accounts.ensureViewer, {
          acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
        })
      ).previewAccess,
    ).toBe("waitlisted");
    await client.mutation(api.accounts.requestDeletion, {});
    expect((await client.query(api.accounts.viewer, {}))?.previewAccess).toBe("waitlisted");
  });

  test("requires a verified email; accepts explicit UUID grants without an email", async () => {
    const t = setup();
    await t.mutation(internal.previewAccess.set, {
      kind: "email",
      value: "bob@example.com",
      enabled: true,
    });
    const unverified = t.withIdentity(person("bob", false));
    expect(
      (
        await unverified.mutation(api.accounts.ensureViewer, {
          acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
        })
      ).previewAccess,
    ).toBe("waitlisted");
    const noEmail = t.withIdentity({ subject: "no-email", issuer: "https://issuer.test" });
    const { userId } = await noEmail.mutation(api.accounts.ensureViewer, {
      acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
    });
    // Nullable tombstone-compatible profile fields never manufacture an email grant.
    await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_uuid", (q) => q.eq("id", userId))
        .unique();
      await ctx.db.patch(user!._id, { emailVerified: true });
    });
    expect((await noEmail.query(api.accounts.viewer, {}))?.previewAccess).toBe("waitlisted");
    await t.mutation(internal.previewAccess.set, { kind: "user", value: userId, enabled: true });
    expect(
      (
        await noEmail.mutation(api.accounts.ensureViewer, {
          acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
        })
      ).previewAccess,
    ).toBe("granted");
    await t.mutation(internal.previewAccess.set, { kind: "user", value: userId, enabled: false });
    expect(
      (
        await noEmail.mutation(api.accounts.ensureViewer, {
          acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
        })
      ).previewAccess,
    ).toBe("waitlisted");
  });

  test("codes are hashed, single-use, retryable by the same account, expiring and revocable", async () => {
    const t = setup();
    const code = "preview-test-code-123456789";
    await t.mutation(internal.previewAccess.set, {
      kind: "code",
      value: code,
      enabled: true,
      expiresAt: Date.now() + 60_000,
    });
    const alice = t.withIdentity(person("alice"));
    const bob = t.withIdentity(person("bob"));
    const first = await alice.mutation(api.accounts.ensureViewer, {
      inviteCode: code,
      acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
    });
    expect(first.previewAccess).toBe("granted");
    expect(
      (
        await alice.mutation(api.accounts.ensureViewer, {
          inviteCode: code,
          acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
        })
      ).userId,
    ).toBe(first.userId);
    await expect(
      bob.mutation(api.accounts.ensureViewer, {
        inviteCode: code,
        acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
      }),
    ).rejects.toThrow(refused);
    const rows = await t.run((ctx) => ctx.db.query("previewAccess").collect());
    expect(rows[0]!.key).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(code);
    await t.run((ctx) => ctx.db.patch(rows[0]!._id, { expiresAt: 0 }));
    expect((await alice.query(api.accounts.viewer, {}))?.previewAccess).toBe("waitlisted");
    await expect(
      alice.mutation(api.accounts.ensureViewer, {
        inviteCode: code,
        acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
      }),
    ).rejects.toThrow(refused);
    await t.mutation(internal.previewAccess.set, {
      kind: "code",
      value: code,
      enabled: true,
      expiresAt: Date.now() + 60_000,
    });
    expect((await alice.query(api.accounts.viewer, {}))?.previewAccess).toBe("granted");
    await t.mutation(internal.previewAccess.set, { kind: "code", value: code, enabled: false });
    await expect(
      alice.mutation(api.accounts.ensureViewer, {
        inviteCode: code,
        acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
      }),
    ).rejects.toThrow(refused);
    for (const invalid of ["short", "x".repeat(129), "missing-code-123456789"]) {
      await expect(
        bob.mutation(api.accounts.ensureViewer, {
          inviteCode: invalid,
          acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
        }),
      ).rejects.toThrow(refused);
    }
  });

  test("every Workspace acceptance, including a replay, rechecks the grant", async () => {
    const t = setup();
    const alice = t.withIdentity(person("alice"));
    const bob = t.withIdentity(person("bob"));
    for (const name of ["alice", "bob"])
      await t.mutation(internal.previewAccess.set, {
        kind: "email",
        value: `${name}@example.com`,
        enabled: true,
      });
    await alice.mutation(api.accounts.ensureViewer, {
      acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
    });
    await bob.mutation(api.accounts.ensureViewer, {
      acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
    });
    const workspaceId = newId("workspace");
    await alice.mutation(api.workspaces.create, { workspaceId, name: "Team" });
    const link = await alice.mutation(api.invites.create, {
      workspaceId,
      email: null,
      role: "member",
    });
    const email = await alice.mutation(api.invites.create, {
      workspaceId,
      email: "bob@example.com",
      role: "member",
    });
    await t.mutation(internal.previewAccess.set, {
      kind: "email",
      value: "bob@example.com",
      enabled: false,
    });
    await expect(bob.mutation(api.invites.accept, { inviteId: email.inviteId })).rejects.toThrow(
      refused,
    );
    await expect(bob.mutation(api.invites.acceptLink, { token: link.token })).rejects.toThrow(
      refused,
    );
    await t.mutation(internal.previewAccess.set, {
      kind: "email",
      value: "bob@example.com",
      enabled: true,
    });
    await bob.mutation(api.invites.acceptLink, { token: link.token });
    await t.mutation(internal.previewAccess.set, {
      kind: "email",
      value: "bob@example.com",
      enabled: false,
    });
    await expect(bob.mutation(api.invites.acceptLink, { token: link.token })).rejects.toThrow(
      refused,
    );
    await expect(
      alice.mutation(api.workspaces.create, { workspaceId, name: "Team" }),
    ).resolves.toMatchObject({ created: false });
    await t.mutation(internal.previewAccess.set, {
      kind: "email",
      value: "alice@example.com",
      enabled: false,
    });
    await expect(
      alice.mutation(api.workspaces.create, { workspaceId, name: "Team" }),
    ).rejects.toThrow(refused);
  });

  test("validates admin inputs", async () => {
    const t = setup();
    for (const args of [
      { kind: "email" as const, value: "bad", enabled: true },
      { kind: "email" as const, value: `${"x".repeat(255)}@example.com`, enabled: true },
      { kind: "user" as const, value: "not-a-uuid", enabled: true },
      { kind: "code" as const, value: "short", enabled: true },
      { kind: "email" as const, value: "ok@example.com", enabled: true, expiresAt: 0 },
      { kind: "email" as const, value: "ok@example.com", enabled: true, expiresAt: Infinity },
    ])
      await expect(t.mutation(internal.previewAccess.set, args)).rejects.toThrow();
    await t.mutation(internal.previewAccess.set, {
      kind: "email",
      value: "ok@example.com",
      enabled: false,
    });
    expect(await t.run((ctx) => ctx.db.query("previewAccess").collect())).toHaveLength(1);
  });
});

describe("explicit preview agreement acceptance", () => {
  test("does not infer acceptance from invitation or token refresh, then records server time before setup", async () => {
    const t = setup();
    const client = t.withIdentity(person("consent"));
    await t.mutation(internal.previewAccess.set, {
      kind: "email",
      value: "consent@example.com",
      enabled: true,
    });
    const initial = await client.mutation(api.accounts.ensureViewer, {});
    expect(initial).toMatchObject({ previewAccess: "granted", previewAgreementAccepted: false });
    await client.mutation(api.accounts.ensureViewer, {});
    await expect(client.query(api.workspaces.listMine, {})).rejects.toThrow(
      expect.objectContaining({
        data: expect.objectContaining({ code: "preview_agreement_required" }),
      }),
    );
    await expect(
      client.mutation(api.workspaces.create, {
        workspaceId: newId("workspace"),
        name: "No consent",
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        data: expect.objectContaining({ code: "preview_agreement_required" }),
      }),
    );
    const before = await t.run((ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_uuid", (q) => q.eq("id", initial.userId))
        .unique(),
    );
    expect(before!.previewAgreementAcceptedAt).toBeUndefined();
    await expect(
      client.mutation(api.accounts.ensureViewer, { acceptedAgreementVersion: "old-version" }),
    ).rejects.toThrow(
      expect.objectContaining({
        data: expect.objectContaining({ code: "preview_agreement_required" }),
      }),
    );
    await expect(
      client.mutation(api.accounts.ensureViewer, {
        acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
        acceptedAt: 1,
      } as never),
    ).rejects.toThrow();
    const earliest = Date.now();
    const accepted = await client.mutation(api.accounts.ensureViewer, {
      acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
    });
    expect(accepted.previewAgreementAccepted).toBe(true);
    const stored = await t.run((ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_uuid", (q) => q.eq("id", initial.userId))
        .unique(),
    );
    expect(stored!.previewAgreementVersion).toBe(PREVIEW_ENROLLMENT_AGREEMENT_VERSION);
    expect(stored!.previewAgreementAcceptedAt).toBeGreaterThanOrEqual(earliest);
    expect(stored!.previewAgreementAcceptedAt).toBeLessThanOrEqual(Date.now());
    expect(await client.query(api.workspaces.listMine, {})).toHaveLength(1);
    await client.mutation(api.accounts.ensureViewer, {});
    await client.mutation(api.accounts.ensureViewer, {
      acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
    });
    const replay = await t.run((ctx) => ctx.db.get(stored!._id));
    expect(replay!.previewAgreementAcceptedAt).toBe(stored!.previewAgreementAcceptedAt);
    expect(await client.query(api.workspaces.listMine, {})).toHaveLength(1);
  });

  test("never records waitlisted acceptance and requires reacceptance of stale or incomplete receipts", async () => {
    const t = setup();
    const client = t.withIdentity(person("waitlisted-consent"));
    const result = await client.mutation(api.accounts.ensureViewer, {
      acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
    });
    expect(result.previewAgreementAccepted).toBe(false);
    const user = await t.run((ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_uuid", (q) => q.eq("id", result.userId))
        .unique(),
    );
    expect(user!.previewAgreementVersion).toBeUndefined();
    await t.mutation(internal.previewAccess.set, {
      kind: "user",
      value: result.userId,
      enabled: true,
    });
    expect((await client.mutation(api.accounts.ensureViewer, {})).previewAgreementAccepted).toBe(
      false,
    );
    await t.run((ctx) =>
      ctx.db.patch(user!._id, { previewAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION }),
    );
    expect((await client.mutation(api.accounts.ensureViewer, {})).previewAgreementAccepted).toBe(
      false,
    );
    await t.run((ctx) =>
      ctx.db.patch(user!._id, {
        previewAgreementVersion: "old-version",
        previewAgreementAcceptedAt: 1,
      }),
    );
    expect((await client.mutation(api.accounts.ensureViewer, {})).previewAgreementAccepted).toBe(
      false,
    );
    const accepted = await client.mutation(api.accounts.ensureViewer, {
      acceptedAgreementVersion: PREVIEW_ENROLLMENT_AGREEMENT_VERSION,
    });
    expect(accepted.previewAgreementAccepted).toBe(true);
    const stored = await t.run((ctx) => ctx.db.get(user!._id));
    expect(stored!.previewAgreementAcceptedAt).toBeGreaterThan(1);
  });
});
