import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { newId } from "@volli/shared/cloud";

import { api } from "../functions/_generated/api";
import schema from "../functions/schema";

const modules = import.meta.glob("../functions/**/*.ts");

type T = ReturnType<typeof convexTest>;
type Client = ReturnType<T["withIdentity"]>;

const ISSUER = "https://issuer.test";

function person(name: string, options: { email?: string | null; verified?: boolean } = {}) {
  const email = options.email === undefined ? `${name.toLowerCase()}@example.com` : options.email;
  return {
    subject: `user:${name.toLowerCase()}`,
    issuer: ISSUER,
    name,
    ...(email === null ? {} : { email, emailVerified: options.verified ?? true }),
  };
}

function code(value: string) {
  return expect.objectContaining({ data: expect.objectContaining({ code: value }) });
}

async function signIn(t: T, identity: ReturnType<typeof person>) {
  const client = t.withIdentity(identity);
  const { userId } = await client.mutation(api.accounts.ensureViewer, {});
  return { client, userId };
}

/** Invites by link and accepts: the quickest way to add a Member. */
async function addMember(
  inviter: Client,
  invitee: Client,
  workspaceId: string,
  role: "owner" | "admin" | "member",
) {
  const { token } = await inviter.mutation(api.invites.create, { workspaceId, email: null, role });
  await invitee.mutation(api.invites.acceptLink, { token });
}

/**
 * A team Workspace with one person in each position the matrix needs: the
 * owner (Alice), an admin (Bob), a member (Carol), a suspended member (Dave),
 * a removed member (Erin), a signed-in outsider (Olga) and an anonymous caller.
 */
async function team(t: T) {
  const owner = await signIn(t, person("Alice"));
  const admin = await signIn(t, person("Bob"));
  const member = await signIn(t, person("Carol"));
  const suspended = await signIn(t, person("Dave"));
  const left = await signIn(t, person("Erin"));
  const outsider = await signIn(t, person("Olga"));
  const workspaceId = newId("workspace");
  await owner.client.mutation(api.workspaces.create, { workspaceId, name: "Acme" });
  await addMember(owner.client, admin.client, workspaceId, "admin");
  await addMember(owner.client, member.client, workspaceId, "member");
  await addMember(owner.client, suspended.client, workspaceId, "member");
  await addMember(owner.client, left.client, workspaceId, "member");
  await owner.client.mutation(api.members.suspend, { workspaceId, userId: suspended.userId });
  await owner.client.mutation(api.members.remove, { workspaceId, userId: left.userId });
  return { workspaceId, owner, admin, member, suspended, left, outsider, anonymous: t };
}

type Team = Awaited<ReturnType<typeof team>>;
type Position = "owner" | "admin" | "member" | "suspended" | "left" | "outsider" | "anonymous";

const POSITIONS: Position[] = [
  "owner",
  "admin",
  "member",
  "suspended",
  "left",
  "outsider",
  "anonymous",
];

function caller(world: Team, position: Position) {
  return position === "anonymous" ? world.anonymous : world[position].client;
}

/** What a caller outside the active membership gets, whatever the operation. */
const OUTSIDE: Record<"suspended" | "left" | "outsider" | "anonymous", string> = {
  suspended: "not_a_member",
  left: "not_a_member",
  outsider: "not_a_member",
  anonymous: "unauthenticated",
};

async function runOp(
  c: Client | T,
  op: "setRole" | "suspend" | "unsuspend" | "remove",
  workspaceId: string,
  userId: string,
) {
  if (op === "setRole") {
    return await c.mutation(api.members.setRole, { workspaceId, userId, role: "admin" });
  }
  return await c.mutation(api.members[op], { workspaceId, userId });
}
afterEach(() => {
  vi.useRealTimers();
});

describe("sign-up", () => {
  test("creates a personal Workspace named after the person, with them as its one owner", async () => {
    const t = convexTest(schema, modules);
    const { client, userId } = await signIn(t, person("Dana"));
    const mine = await client.query(api.workspaces.listMine, {});
    expect(mine).toEqual([
      expect.objectContaining({
        name: "Dana",
        slug: "dana",
        planKey: "free",
        role: "owner",
        activeMemberCount: 1,
      }),
    ]);
    const workspaceId = mine[0]!.workspaceId;
    await expect(client.query(api.workspaces.policy, { workspaceId })).resolves.toMatchObject({
      shareAll: false,
      whoCanInvite: "members",
      revision: 0,
    });
    await expect(client.query(api.members.list, { workspaceId })).resolves.toEqual([
      expect.objectContaining({ userId, role: "owner", status: "active", billingTier: "free" }),
    ]);
    const kinds = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).map((row) => [row.kind, row.actor]),
    );
    expect(kinds).toEqual([
      ["workspace.created", { kind: "person", userId }],
      ["member.joined", { kind: "person", userId }],
    ]);
  });

  test("a second ensureViewer creates nothing more", async () => {
    const t = convexTest(schema, modules);
    const { client } = await signIn(t, person("Dana"));
    await client.mutation(api.accounts.ensureViewer, {});
    expect(await t.run((ctx) => ctx.db.query("workspaces").collect())).toHaveLength(1);
  });

  test("a person with no name still gets a named Workspace, and slugs never collide", async () => {
    const t = convexTest(schema, modules);
    const a = await signIn(t, { subject: "user:a", issuer: ISSUER } as ReturnType<typeof person>);
    const b = await signIn(t, { subject: "user:b", issuer: ISSUER } as ReturnType<typeof person>);
    const [wa] = await a.client.query(api.workspaces.listMine, {});
    const [wb] = await b.client.query(api.workspaces.listMine, {});
    expect(wa!.name).toBe("Volli user");
    expect(wb!.name).toBe("Volli user");
    expect(wa!.slug).toBe("volli-user");
    expect(wb!.slug).toMatch(/^volli-user-[0-9a-f]{6}$/);
  });
});

describe("workspaces.create", () => {
  test("is idempotent on the client's id, and refuses the id for anything else", async () => {
    const t = convexTest(schema, modules);
    const alice = await signIn(t, person("Alice"));
    const bob = await signIn(t, person("Bob"));
    const workspaceId = newId("workspace");
    const first = await alice.client.mutation(api.workspaces.create, {
      workspaceId,
      name: "  Side project ",
    });
    expect(first).toEqual({ workspaceId, slug: "side-project", created: true });
    await expect(
      alice.client.mutation(api.workspaces.create, { workspaceId, name: "Side project" }),
    ).resolves.toEqual({ ...first, created: false });
    // The same creator retrying is the same intent, whatever the name says now.
    await expect(
      alice.client.mutation(api.workspaces.create, { workspaceId, name: "Other" }),
    ).resolves.toMatchObject({ created: false });
    await expect(
      bob.client.mutation(api.workspaces.create, { workspaceId, name: "Side project" }),
    ).rejects.toThrow(code("id_taken"));
    const mine = await alice.client.query(api.workspaces.listMine, {});
    expect(mine.map((row) => row.name)).toEqual(["Alice", "Side project"]);
  });

  test("checks the id and the name", async () => {
    const t = convexTest(schema, modules);
    const { client } = await signIn(t, person("Alice"));
    await expect(
      client.mutation(api.workspaces.create, { workspaceId: "nope", name: "X" }),
    ).rejects.toThrow(code("invalid_argument"));
    for (const name of ["", "   ", "x".repeat(65), "bad\u0007name"]) {
      await expect(
        client.mutation(api.workspaces.create, { workspaceId: newId("workspace"), name }),
      ).rejects.toThrow(code("invalid_argument"));
    }
  });

  test("needs a signed-in, set-up person", async () => {
    const t = convexTest(schema, modules);
    const args = { workspaceId: newId("workspace"), name: "X" };
    await expect(t.mutation(api.workspaces.create, args)).rejects.toThrow(code("unauthenticated"));
    await expect(
      t.withIdentity(person("New")).mutation(api.workspaces.create, args),
    ).rejects.toThrow(code("no_viewer"));
  });
});

describe("slugs", () => {
  test("lowercase ASCII words joined by dashes, kept unique", async () => {
    const t = convexTest(schema, modules);
    const { client } = await signIn(t, person("Alice"));
    const slugOf = async (name: string) =>
      (await client.mutation(api.workspaces.create, { workspaceId: newId("workspace"), name }))
        .slug;
    expect(await slugOf("Acme, Inc.")).toBe("acme-inc");
    expect(await slugOf("Ça va — très bien")).toBe("ca-va-tres-bien");
    expect(await slugOf("日本")).toBe("workspace");
    expect(await slugOf(`${"a".repeat(39)} b`)).toBe("a".repeat(39));
    expect(await slugOf("Acme Inc")).toMatch(/^acme-inc-[0-9a-f]{6}$/);
  });
});

describe("the authorization matrix", () => {
  const reads = [
    [
      "workspaces.get",
      (c: Client | T, w: string) => c.query(api.workspaces.get, { workspaceId: w }),
    ],
    [
      "workspaces.policy",
      (c: Client | T, w: string) => c.query(api.workspaces.policy, { workspaceId: w }),
    ],
    ["members.list", (c: Client | T, w: string) => c.query(api.members.list, { workspaceId: w })],
    ["invites.list", (c: Client | T, w: string) => c.query(api.invites.list, { workspaceId: w })],
  ] as const;

  test.each(reads)("%s: every active Member reads; nobody else", async (_name, read) => {
    const t = convexTest(schema, modules);
    const world = await team(t);
    for (const position of POSITIONS) {
      const result = read(caller(world, position), world.workspaceId);
      if (position === "owner" || position === "admin" || position === "member") {
        await expect(result).resolves.toBeDefined();
      } else {
        await expect(result).rejects.toThrow(code(OUTSIDE[position]));
      }
    }
  });

  const managed = [
    [
      "workspaces.rename",
      (c: Client | T, w: string) =>
        c.mutation(api.workspaces.rename, { workspaceId: w, name: "Acme 2" }),
    ],
    [
      "workspaces.setPolicy",
      (c: Client | T, w: string) =>
        c.mutation(api.workspaces.setPolicy, { workspaceId: w, shareAll: true }),
    ],
    [
      "invites.create as admin",
      (c: Client | T, w: string) =>
        c.mutation(api.invites.create, { workspaceId: w, email: null, role: "admin" }),
    ],
  ] as const;

  test.each(managed)("%s: owners and admins only", async (_name, write) => {
    const t = convexTest(schema, modules);
    const world = await team(t);
    for (const position of POSITIONS) {
      const result = write(caller(world, position), world.workspaceId);
      if (position === "owner" || position === "admin") await expect(result).resolves.toBeDefined();
      else if (position === "member") await expect(result).rejects.toThrow(code("forbidden"));
      else await expect(result).rejects.toThrow(code(OUTSIDE[position]));
    }
  });

  test("invites.create: whoCanInvite decides whether a member invites; nobody grants above their own role", async () => {
    const t = convexTest(schema, modules);
    const world = await team(t);
    const invite = (position: Position, role: "owner" | "admin" | "member") =>
      caller(world, position).mutation(api.invites.create, {
        workspaceId: world.workspaceId,
        email: null,
        role,
      });
    for (const position of POSITIONS) {
      const result = invite(position, "member");
      if (position === "owner" || position === "admin" || position === "member") {
        await expect(result).resolves.toBeDefined();
      } else {
        await expect(result).rejects.toThrow(code(OUTSIDE[position]));
      }
    }
    await expect(invite("owner", "owner")).resolves.toBeDefined();
    await expect(invite("admin", "owner")).rejects.toThrow(code("forbidden"));
    await expect(invite("member", "admin")).rejects.toThrow(code("forbidden"));

    await world.owner.client.mutation(api.workspaces.setPolicy, {
      workspaceId: world.workspaceId,
      whoCanInvite: "admins",
    });
    await expect(invite("member", "member")).rejects.toThrow(code("forbidden"));
    await expect(invite("admin", "member")).resolves.toBeDefined();
  });

  const memberOps = [
    ["setRole", { kind: "setRole" as const }],
    ["suspend", { kind: "suspend" as const }],
    ["remove", { kind: "remove" as const }],
  ] as const;

  test.each(memberOps)(
    "members.%s on a member: owners and admins only",
    async (_name, { kind }) => {
      for (const position of POSITIONS) {
        // A fresh world per caller: a successful change must not shape the next attempt.
        const t = convexTest(schema, modules);
        const world = await team(t);
        const result = runOp(caller(world, position), kind, world.workspaceId, world.member.userId);
        if (position === "owner" || position === "admin") {
          await expect(result).resolves.toMatchObject({ changed: true });
        } else if (position === "member") {
          await expect(result).rejects.toThrow(code("forbidden"));
        } else {
          await expect(result).rejects.toThrow(code(OUTSIDE[position]));
        }
      }
    },
  );

  test("members.unsuspend: owners and admins only", async () => {
    for (const position of POSITIONS) {
      const t = convexTest(schema, modules);
      const world = await team(t);
      const result = runOp(
        caller(world, position),
        "unsuspend",
        world.workspaceId,
        world.suspended.userId,
      );
      if (position === "owner" || position === "admin") {
        await expect(result).resolves.toMatchObject({ changed: true, status: "active" });
      } else if (position === "member") {
        await expect(result).rejects.toThrow(code("forbidden"));
      } else {
        await expect(result).rejects.toThrow(code(OUTSIDE[position]));
      }
    }
  });

  test.each([...memberOps, ["unsuspend", { kind: "unsuspend" as const }] as const])(
    "members.%s on an owner: owners only",
    async (_name, { kind }) => {
      const t = convexTest(schema, modules);
      const world = await team(t);
      const second = await signIn(t, person("Fay"));
      await addMember(world.owner.client, second.client, world.workspaceId, "owner");
      await expect(
        runOp(world.admin.client, kind, world.workspaceId, second.userId),
      ).rejects.toThrow(code("forbidden"));
      const result = runOp(world.owner.client, kind, world.workspaceId, second.userId);
      await expect(result).resolves.toBeDefined();
    },
  );

  test("members.leave: any active Member, never the last owner", async () => {
    for (const position of POSITIONS) {
      const t = convexTest(schema, modules);
      const world = await team(t);
      const result = caller(world, position).mutation(api.members.leave, {
        workspaceId: world.workspaceId,
      });
      if (position === "owner") await expect(result).rejects.toThrow(code("last_owner"));
      else if (position === "admin" || position === "member") {
        await expect(result).resolves.toMatchObject({ status: "left", changed: true });
      } else await expect(result).rejects.toThrow(code(OUTSIDE[position]));
    }
  });

  test("invites.revoke: the sender, or an owner or admin", async () => {
    const t = convexTest(schema, modules);
    const world = await team(t);
    const fresh = () =>
      world.member.client.mutation(api.invites.create, {
        workspaceId: world.workspaceId,
        email: null,
        role: "member",
      });
    for (const position of POSITIONS) {
      const { inviteId } = await fresh();
      const result = caller(world, position).mutation(api.invites.revoke, { inviteId });
      if (position === "owner" || position === "admin" || position === "member") {
        await expect(result).resolves.toEqual({ inviteId, revoked: true });
      } else await expect(result).rejects.toThrow(code(OUTSIDE[position]));
    }
    // Another plain member did not send it.
    const other = await signIn(t, person("Gus"));
    await addMember(world.owner.client, other.client, world.workspaceId, "member");
    const { inviteId } = await fresh();
    await expect(other.client.mutation(api.invites.revoke, { inviteId })).rejects.toThrow(
      code("forbidden"),
    );
  });
});

describe("members", () => {
  test("only an owner grants owner; the last active owner stays", async () => {
    const t = convexTest(schema, modules);
    const world = await team(t);
    const { workspaceId, owner, admin } = world;
    await expect(
      admin.client.mutation(api.members.setRole, {
        workspaceId,
        userId: admin.userId,
        role: "owner",
      }),
    ).rejects.toThrow(code("forbidden"));
    await expect(
      owner.client.mutation(api.members.setRole, {
        workspaceId,
        userId: owner.userId,
        role: "admin",
      }),
    ).rejects.toThrow(code("last_owner"));

    await owner.client.mutation(api.members.setRole, {
      workspaceId,
      userId: admin.userId,
      role: "owner",
    });
    // With a second owner the first may step down, and then the second is the last.
    await expect(
      owner.client.mutation(api.members.setRole, {
        workspaceId,
        userId: owner.userId,
        role: "member",
      }),
    ).resolves.toMatchObject({ role: "member", changed: true });
    await expect(
      admin.client.mutation(api.members.suspend, { workspaceId, userId: admin.userId }),
    ).rejects.toThrow(code("self"));
    await expect(admin.client.mutation(api.members.leave, { workspaceId })).rejects.toThrow(
      code("last_owner"),
    );
  });

  test("a suspended owner does not count as the Workspace's owner", async () => {
    const t = convexTest(schema, modules);
    const world = await team(t);
    const { workspaceId, owner } = world;
    const fay = await signIn(t, person("Fay"));
    await addMember(owner.client, fay.client, workspaceId, "owner");
    await owner.client.mutation(api.members.suspend, { workspaceId, userId: fay.userId });
    await expect(owner.client.mutation(api.members.leave, { workspaceId })).rejects.toThrow(
      code("last_owner"),
    );
  });

  test("suspend: no access, no seat, history kept; unsuspend restores both", async () => {
    const t = convexTest(schema, modules);
    const world = await team(t);
    const { workspaceId, owner, member } = world;
    const seats = async () =>
      (await owner.client.query(api.workspaces.get, { workspaceId })).activeMemberCount;
    expect(await seats()).toBe(3);

    await owner.client.mutation(api.members.suspend, { workspaceId, userId: member.userId });
    expect(await seats()).toBe(2);
    await expect(member.client.query(api.workspaces.get, { workspaceId })).rejects.toThrow(
      code("not_a_member"),
    );
    expect(
      (await member.client.query(api.workspaces.listMine, {})).map((row) => row.workspaceId),
    ).not.toContain(workspaceId);
    const roster = await owner.client.query(api.members.list, { workspaceId });
    expect(roster.find((row) => row.userId === member.userId)).toMatchObject({
      status: "suspended",
      displayName: "Carol",
      email: "carol@example.com",
    });
    // Repeating it changes nothing.
    await expect(
      owner.client.mutation(api.members.suspend, { workspaceId, userId: member.userId }),
    ).resolves.toMatchObject({ changed: false });

    await owner.client.mutation(api.members.unsuspend, { workspaceId, userId: member.userId });
    expect(await seats()).toBe(3);
    await expect(member.client.query(api.workspaces.get, { workspaceId })).resolves.toMatchObject({
      role: "member",
    });
    await expect(
      owner.client.mutation(api.members.unsuspend, { workspaceId, userId: member.userId }),
    ).resolves.toMatchObject({ changed: false });
  });

  test("remove and leave end the membership; the roster no longer lists them", async () => {
    const t = convexTest(schema, modules);
    const world = await team(t);
    const { workspaceId, owner, member, admin, left } = world;
    await member.client.mutation(api.members.leave, { workspaceId });
    await owner.client.mutation(api.members.remove, {
      workspaceId,
      userId: world.suspended.userId,
    });
    const roster = await owner.client.query(api.members.list, { workspaceId });
    expect(roster.map((row) => row.userId)).toEqual([owner.userId, admin.userId]);
    expect((await owner.client.query(api.workspaces.get, { workspaceId })).activeMemberCount).toBe(
      2,
    );
    await expect(
      owner.client.mutation(api.members.remove, { workspaceId, userId: left.userId }),
    ).rejects.toThrow(code("not_found"));
    await expect(
      owner.client.mutation(api.members.setRole, {
        workspaceId,
        userId: newId("user"),
        role: "admin",
      }),
    ).rejects.toThrow(code("not_found"));
    await expect(
      owner.client.mutation(api.members.remove, { workspaceId, userId: "nope" }),
    ).rejects.toThrow(code("invalid_argument"));
  });

  test("every change is audited with the person who made it", async () => {
    const t = convexTest(schema, modules);
    const world = await team(t);
    const { workspaceId, owner, member } = world;
    await owner.client.mutation(api.members.setRole, {
      workspaceId,
      userId: member.userId,
      role: "admin",
    });
    const rows = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .withIndex("by_workspace_at", (q) => q.eq("workspaceId", workspaceId))
        .collect(),
    );
    expect(rows.map((row) => row.kind)).toEqual([
      "workspace.created",
      "member.joined",
      ...Array.from({ length: 4 }, () => [
        "invite.created",
        "invite.accepted",
        "member.joined",
      ]).flat(),
      "member.suspended",
      "member.removed",
      "member.role_changed",
    ]);
    expect(rows.at(-1)).toMatchObject({
      actor: { kind: "person", userId: owner.userId },
      detail: { userId: member.userId, from: "member", to: "admin" },
    });
  });
});

describe("invites", () => {
  test("an email invite is offered to that verified address and accepted by id", async () => {
    const t = convexTest(schema, modules);
    const alice = await signIn(t, person("Alice"));
    const [personal] = await alice.client.query(api.workspaces.listMine, {});
    const workspaceId = personal!.workspaceId;
    const created = await alice.client.mutation(api.invites.create, {
      workspaceId,
      email: "  Bob@Example.com ",
      role: "admin",
    });
    expect(created).toMatchObject({ reissued: false, expiresAt: expect.any(Number) });
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const stored = await t.run(async (ctx) => (await ctx.db.query("workspaceInvites").first())!);
    expect(stored.email).toBe("bob@example.com");
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.tokenHash).not.toContain(created.token);
    const listed = await alice.client.query(api.invites.list, { workspaceId });
    expect(listed).toEqual([
      expect.objectContaining({
        inviteId: created.inviteId,
        email: "bob@example.com",
        role: "admin",
        invitedByName: "Alice",
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(created.token);

    const bob = await signIn(t, person("Bob"));
    await expect(bob.client.query(api.invites.listMine, {})).resolves.toEqual([
      expect.objectContaining({
        inviteId: created.inviteId,
        workspaceName: "Alice",
        role: "admin",
      }),
    ]);
    await expect(
      bob.client.mutation(api.invites.accept, { inviteId: created.inviteId }),
    ).resolves.toEqual({ workspaceId, role: "admin", alreadyMember: false });
    // A replay is a no-op.
    await expect(
      bob.client.mutation(api.invites.accept, { inviteId: created.inviteId }),
    ).resolves.toEqual({ workspaceId, role: "admin", alreadyMember: true });
    await expect(bob.client.query(api.invites.listMine, {})).resolves.toEqual([]);
    await expect(alice.client.query(api.invites.list, { workspaceId })).resolves.toEqual([]);
    const member = (await alice.client.query(api.members.list, { workspaceId })).find(
      (row) => row.userId === bob.userId,
    );
    expect(member).toMatchObject({ role: "admin", status: "active", billingTier: "free" });
  });

  test("an email invite refuses anyone without that verified address", async () => {
    const t = convexTest(schema, modules);
    const alice = await signIn(t, person("Alice"));
    const workspaceId = (await alice.client.query(api.workspaces.listMine, {}))[0]!.workspaceId;
    const { inviteId, token } = await alice.client.mutation(api.invites.create, {
      workspaceId,
      email: "bob@example.com",
      role: "member",
    });
    const mallory = await signIn(t, person("Mallory"));
    const unverified = await signIn(
      t,
      person("Bob2", { email: "bob@example.com", verified: false }),
    );
    for (const { client } of [mallory, unverified]) {
      await expect(client.query(api.invites.listMine, {})).resolves.toEqual([]);
      await expect(client.mutation(api.invites.accept, { inviteId })).rejects.toThrow(
        code("invite_email_mismatch"),
      );
      await expect(client.mutation(api.invites.acceptLink, { token })).rejects.toThrow(
        code("invite_email_mismatch"),
      );
      await expect(client.query(api.invites.preview, { token })).resolves.toMatchObject({
        status: "email_mismatch",
      });
    }
  });

  test("a link invite is single-use, and never accepted by its id", async () => {
    const t = convexTest(schema, modules);
    const alice = await signIn(t, person("Alice"));
    const workspaceId = (await alice.client.query(api.workspaces.listMine, {}))[0]!.workspaceId;
    const { inviteId, token } = await alice.client.mutation(api.invites.create, {
      workspaceId,
      email: null,
      role: "member",
    });
    const bob = await signIn(t, person("Bob"));
    const carol = await signIn(t, person("Carol"));
    await expect(bob.client.mutation(api.invites.accept, { inviteId })).rejects.toThrow(
      code("not_found"),
    );
    await expect(bob.client.query(api.invites.preview, { token })).resolves.toMatchObject({
      status: "valid",
      workspaceName: "Alice",
      invitedByName: "Alice",
      email: null,
    });
    await expect(bob.client.mutation(api.invites.acceptLink, { token })).resolves.toEqual({
      workspaceId,
      role: "member",
      alreadyMember: false,
    });
    await expect(bob.client.mutation(api.invites.acceptLink, { token })).resolves.toMatchObject({
      alreadyMember: true,
    });
    await expect(carol.client.mutation(api.invites.acceptLink, { token })).rejects.toThrow(
      code("invite_invalid"),
    );
    await expect(carol.client.query(api.invites.preview, { token })).resolves.toMatchObject({
      status: "accepted",
    });
    for (const bad of ["short", "x".repeat(43)]) {
      await expect(carol.client.query(api.invites.preview, { token: bad })).resolves.toEqual({
        status: "invalid",
      });
      await expect(carol.client.mutation(api.invites.acceptLink, { token: bad })).rejects.toThrow(
        code("invite_invalid"),
      );
    }
  });

  test("an existing Member is not consumed by a link and cannot be invited by email", async () => {
    const t = convexTest(schema, modules);
    const world = await team(t);
    const { workspaceId, owner, member, suspended } = world;
    const { token } = await owner.client.mutation(api.invites.create, {
      workspaceId,
      email: null,
      role: "admin",
    });
    await expect(member.client.query(api.invites.preview, { token })).resolves.toMatchObject({
      status: "already_member",
    });
    await expect(member.client.mutation(api.invites.acceptLink, { token })).resolves.toEqual({
      workspaceId,
      role: "member",
      alreadyMember: true,
    });
    // Still pending, for whoever it was meant for.
    expect(await owner.client.query(api.invites.list, { workspaceId })).toHaveLength(1);
    // A suspended Member is restored by unsuspend, not by an invite.
    await expect(suspended.client.mutation(api.invites.acceptLink, { token })).rejects.toThrow(
      code("suspended"),
    );
    for (const email of ["carol@example.com", "dave@example.com"]) {
      await expect(
        owner.client.mutation(api.invites.create, { workspaceId, email, role: "member" }),
      ).rejects.toThrow(code("already_member"));
    }
    await expect(
      owner.client.mutation(api.invites.create, {
        workspaceId,
        email: "not an email",
        role: "member",
      }),
    ).rejects.toThrow(code("invalid_argument"));
  });

  test("a removed Member comes back through an invite, on the same row, with the invite's role", async () => {
    const t = convexTest(schema, modules);
    const world = await team(t);
    const { workspaceId, owner, left } = world;
    const before = await t.run(async (ctx) =>
      (await ctx.db.query("workspaceMembers").collect()).find(
        (row) => row.userId === left.userId && row.workspaceId === workspaceId,
      ),
    );
    const { inviteId } = await owner.client.mutation(api.invites.create, {
      workspaceId,
      email: "erin@example.com",
      role: "admin",
    });
    await left.client.mutation(api.invites.accept, { inviteId });
    const after = await t.run(async (ctx) =>
      (await ctx.db.query("workspaceMembers").collect()).filter(
        (row) => row.userId === left.userId && row.workspaceId === workspaceId,
      ),
    );
    expect(after).toEqual([
      expect.objectContaining({ id: before!.id, role: "admin", status: "active", leftAt: null }),
    ]);
  });

  test("inviting a pending address again reissues it; the old link dies", async () => {
    const t = convexTest(schema, modules);
    const world = await team(t);
    const { workspaceId, owner, admin } = world;
    const first = await owner.client.mutation(api.invites.create, {
      workspaceId,
      email: "zoe@example.com",
      role: "member",
    });
    const second = await admin.client.mutation(api.invites.create, {
      workspaceId,
      email: "zoe@example.com",
      role: "admin",
    });
    expect(second).toMatchObject({ inviteId: first.inviteId, reissued: true });
    expect(second.token).not.toBe(first.token);
    expect(await owner.client.query(api.invites.list, { workspaceId })).toEqual([
      expect.objectContaining({
        email: "zoe@example.com",
        role: "admin",
        invitedByUserId: admin.userId,
      }),
    ]);
    const zoe = await signIn(t, person("Zoe"));
    await expect(
      zoe.client.mutation(api.invites.acceptLink, { token: first.token }),
    ).rejects.toThrow(code("invite_invalid"));
    await expect(
      zoe.client.mutation(api.invites.acceptLink, { token: second.token }),
    ).resolves.toMatchObject({ role: "admin" });
  });

  test("a revoked or expired invite is refused", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const t = convexTest(schema, modules);
    const alice = await signIn(t, person("Alice"));
    const workspaceId = (await alice.client.query(api.workspaces.listMine, {}))[0]!.workspaceId;
    const revoked = await alice.client.mutation(api.invites.create, {
      workspaceId,
      email: "bob@example.com",
      role: "member",
    });
    await alice.client.mutation(api.invites.revoke, { inviteId: revoked.inviteId });
    await expect(
      alice.client.mutation(api.invites.revoke, { inviteId: revoked.inviteId }),
    ).resolves.toEqual({ inviteId: revoked.inviteId, revoked: false });
    const bob = await signIn(t, person("Bob"));
    await expect(bob.client.query(api.invites.listMine, {})).resolves.toEqual([]);
    await expect(
      bob.client.mutation(api.invites.accept, { inviteId: revoked.inviteId }),
    ).rejects.toThrow(code("invite_invalid"));
    await expect(
      bob.client.query(api.invites.preview, { token: revoked.token }),
    ).resolves.toMatchObject({
      status: "revoked",
    });

    const expiring = await alice.client.mutation(api.invites.create, {
      workspaceId,
      email: null,
      role: "member",
    });
    vi.setSystemTime(expiring.expiresAt);
    await expect(
      bob.client.mutation(api.invites.acceptLink, { token: expiring.token }),
    ).rejects.toThrow(code("invite_expired"));
    await expect(alice.client.query(api.invites.list, { workspaceId })).resolves.toEqual([]);
    // An expired email invite does not block a fresh one.
    const fresh = await alice.client.mutation(api.invites.create, {
      workspaceId,
      email: "bob@example.com",
      role: "member",
    });
    expect(fresh.reissued).toBe(false);
  });

  test("an accepted invite cannot be revoked, and a missing one is not found", async () => {
    const t = convexTest(schema, modules);
    const world = await team(t);
    const accepted = await t.run(async (ctx) =>
      (await ctx.db.query("workspaceInvites").collect()).find((row) => row.acceptedAt !== null),
    );
    await expect(
      world.owner.client.mutation(api.invites.revoke, { inviteId: accepted!.id }),
    ).rejects.toThrow(code("invite_invalid"));
    await expect(
      world.owner.client.mutation(api.invites.revoke, { inviteId: newId("invite") }),
    ).rejects.toThrow(code("not_found"));
  });
});

describe("policy", () => {
  test("changes are revisioned, audited, and a stale write is refused", async () => {
    const t = convexTest(schema, modules);
    const world = await team(t);
    const { workspaceId, owner, admin, member } = world;
    const first = await owner.client.mutation(api.workspaces.setPolicy, {
      workspaceId,
      shareAll: true,
      expectedRevision: 0,
    });
    expect(first).toMatchObject({
      shareAll: true,
      whoCanInvite: "members",
      revision: 1,
      updatedByUserId: owner.userId,
    });
    await expect(
      admin.client.mutation(api.workspaces.setPolicy, {
        workspaceId,
        whoCanInvite: "admins",
        expectedRevision: 0,
      }),
    ).rejects.toThrow(code("revision_conflict"));
    // Writing what is already there changes nothing.
    await expect(
      admin.client.mutation(api.workspaces.setPolicy, { workspaceId, shareAll: true }),
    ).resolves.toMatchObject({ revision: 1 });
    await expect(
      member.client.query(api.workspaces.policy, { workspaceId }),
    ).resolves.toMatchObject({
      shareAll: true,
      revision: 1,
    });
    const rows = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).filter((row) => row.kind === "policy.updated"),
    );
    expect(rows).toEqual([
      expect.objectContaining({
        actor: { kind: "person", userId: owner.userId },
        detail: {
          before: { shareAll: false, whoCanInvite: "members" },
          after: { shareAll: true, whoCanInvite: "members" },
          revision: 1,
        },
      }),
    ]);
  });

  test("a Workspace with no policy row reads the defaults and gets one on the first write", async () => {
    const t = convexTest(schema, modules);
    const alice = await signIn(t, person("Alice"));
    const workspaceId = (await alice.client.query(api.workspaces.listMine, {}))[0]!.workspaceId;
    await t.run(async (ctx) => {
      const row = await ctx.db.query("workspacePolicies").first();
      await ctx.db.delete(row!._id);
    });
    await expect(alice.client.query(api.workspaces.policy, { workspaceId })).resolves.toEqual({
      shareAll: false,
      whoCanInvite: "members",
      revision: 0,
      updatedByUserId: null,
      updatedAt: null,
    });
    await expect(
      alice.client.mutation(api.workspaces.setPolicy, { workspaceId, whoCanInvite: "admins" }),
    ).resolves.toMatchObject({ whoCanInvite: "admins", revision: 1 });
    expect(await t.run((ctx) => ctx.db.query("workspacePolicies").collect())).toHaveLength(1);
  });

  test("rename keeps the slug and audits only a real change", async () => {
    const t = convexTest(schema, modules);
    const alice = await signIn(t, person("Alice"));
    const workspaceId = (await alice.client.query(api.workspaces.listMine, {}))[0]!.workspaceId;
    await alice.client.mutation(api.workspaces.rename, { workspaceId, name: "Studio" });
    await alice.client.mutation(api.workspaces.rename, { workspaceId, name: " Studio " });
    await expect(alice.client.query(api.workspaces.get, { workspaceId })).resolves.toMatchObject({
      name: "Studio",
      slug: "alice",
    });
    const renames = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).filter((row) => row.kind === "workspace.renamed"),
    );
    expect(renames).toHaveLength(1);
  });
});

describe("a deleted Workspace", () => {
  test("drops out of the switcher and refuses everything", async () => {
    const t = convexTest(schema, modules);
    const alice = await signIn(t, person("Alice"));
    const workspaceId = (await alice.client.query(api.workspaces.listMine, {}))[0]!.workspaceId;
    const { token } = await alice.client.mutation(api.invites.create, {
      workspaceId,
      email: null,
      role: "member",
    });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("workspaces").first();
      await ctx.db.patch(row!._id, { deletedAt: 1 });
    });
    await expect(alice.client.query(api.workspaces.listMine, {})).resolves.toEqual([]);
    await expect(alice.client.query(api.workspaces.get, { workspaceId })).rejects.toThrow(
      code("not_found"),
    );
    const bob = await signIn(t, person("Bob"));
    await expect(bob.client.query(api.invites.preview, { token })).resolves.toEqual({
      status: "invalid",
    });
    await expect(bob.client.mutation(api.invites.acceptLink, { token })).rejects.toThrow(
      code("invite_invalid"),
    );
  });
});

describe("review follow-ups", () => {
  test("listMine and invites.listMine: anyone signed in, each seeing only their own", async () => {
    const t = convexTest(schema, modules);
    const world = await team(t);
    for (const position of POSITIONS) {
      const mine = caller(world, position).query(api.workspaces.listMine, {});
      const invites = caller(world, position).query(api.invites.listMine, {});
      if (position === "anonymous") {
        await expect(mine).rejects.toThrow(code("unauthenticated"));
        await expect(invites).rejects.toThrow(code("unauthenticated"));
        continue;
      }
      const ids = (await mine).map((row) => row.workspaceId);
      const active = position === "owner" || position === "admin" || position === "member";
      expect(ids.includes(world.workspaceId)).toBe(active);
      await expect(invites).resolves.toEqual([]);
    }
  });

  test("preview and accept agree, for every position", async () => {
    const t = convexTest(schema, modules);
    const world = await team(t);
    const { token } = await world.owner.client.mutation(api.invites.create, {
      workspaceId: world.workspaceId,
      email: null,
      role: "member",
    });
    const expected: Record<Exclude<Position, "anonymous">, [string, string | null]> = {
      owner: ["already_member", null],
      admin: ["already_member", null],
      member: ["already_member", null],
      suspended: ["suspended", "suspended"],
      left: ["valid", null],
      outsider: ["accepted", "invite_invalid"],
    };
    for (const [position, [status, acceptError]] of Object.entries(expected)) {
      const client = caller(world, position as Position);
      await expect(client.query(api.invites.preview, { token })).resolves.toMatchObject({
        status,
      });
      const accepting = client.mutation(api.invites.acceptLink, { token });
      // `left` uses the link first; the outsider then finds it spent.
      if (acceptError === null) await expect(accepting).resolves.toBeDefined();
      else await expect(accepting).rejects.toThrow(code(acceptError));
    }
    await expect(world.anonymous.query(api.invites.preview, { token })).rejects.toThrow(
      code("unauthenticated"),
    );
  });

  test("a member cannot take over someone else's pending invite", async () => {
    const t = convexTest(schema, modules);
    const world = await team(t);
    const { workspaceId, owner, member, admin } = world;
    const first = await owner.client.mutation(api.invites.create, {
      workspaceId,
      email: "zoe@example.com",
      role: "admin",
    });
    await expect(
      member.client.mutation(api.invites.create, {
        workspaceId,
        email: "zoe@example.com",
        role: "member",
      }),
    ).rejects.toThrow(code("already_invited"));
    // An admin may replace a member-level invite, but not an owner-level one.
    await owner.client.mutation(api.invites.create, {
      workspaceId,
      email: "yan@example.com",
      role: "owner",
    });
    await expect(
      admin.client.mutation(api.invites.create, {
        workspaceId,
        email: "yan@example.com",
        role: "member",
      }),
    ).rejects.toThrow(code("already_invited"));
    const zoe = await signIn(t, person("Zoe"));
    await expect(
      zoe.client.mutation(api.invites.accept, { inviteId: first.inviteId }),
    ).resolves.toMatchObject({ role: "admin" });
  });

  test("an invite dies with its sender's right to send it", async () => {
    const t = convexTest(schema, modules);
    const world = await team(t);
    const { workspaceId, owner, admin, member } = world;
    const fromMember = await member.client.mutation(api.invites.create, {
      workspaceId,
      email: null,
      role: "member",
    });
    const fromAdmin = await admin.client.mutation(api.invites.create, {
      workspaceId,
      email: null,
      role: "admin",
    });
    // The policy change stops members' invites; the demotion stops the admin's.
    await owner.client.mutation(api.workspaces.setPolicy, { workspaceId, whoCanInvite: "admins" });
    await owner.client.mutation(api.members.setRole, {
      workspaceId,
      userId: admin.userId,
      role: "member",
    });
    const newcomer = await signIn(t, person("Nia"));
    for (const { token } of [fromMember, fromAdmin]) {
      await expect(newcomer.client.query(api.invites.preview, { token })).resolves.toMatchObject({
        status: "sender_cannot_invite",
      });
      await expect(newcomer.client.mutation(api.invites.acceptLink, { token })).rejects.toThrow(
        code("invite_invalid"),
      );
    }
    // A suspended sender's invites stop too.
    await owner.client.mutation(api.workspaces.setPolicy, { workspaceId, whoCanInvite: "members" });
    const again = await member.client.mutation(api.invites.create, {
      workspaceId,
      email: null,
      role: "member",
    });
    await owner.client.mutation(api.members.suspend, { workspaceId, userId: member.userId });
    await expect(
      newcomer.client.mutation(api.invites.acceptLink, { token: again.token }),
    ).rejects.toThrow(code("invite_invalid"));
  });

  test("joining settles the other pending email invites to that address", async () => {
    const t = convexTest(schema, modules);
    const world = await team(t);
    const { workspaceId, owner } = world;
    const byEmail = await owner.client.mutation(api.invites.create, {
      workspaceId,
      email: "zoe@example.com",
      role: "member",
    });
    const link = await owner.client.mutation(api.invites.create, {
      workspaceId,
      email: null,
      role: "member",
    });
    const zoe = await signIn(t, person("Zoe"));
    await zoe.client.mutation(api.invites.acceptLink, { token: link.token });
    await expect(owner.client.query(api.invites.list, { workspaceId })).resolves.toEqual([]);
    await expect(
      zoe.client.mutation(api.invites.accept, { inviteId: byEmail.inviteId }),
    ).resolves.toMatchObject({ alreadyMember: true });
    const log = JSON.stringify(await t.run((ctx) => ctx.db.query("auditLog").collect()));
    expect(log).not.toContain(byEmail.token);
    expect(log).not.toContain(link.token);
  });

  test("create replays after a rename, but not once the creator has left", async () => {
    const t = convexTest(schema, modules);
    const alice = await signIn(t, person("Alice"));
    const bob = await signIn(t, person("Bob"));
    const workspaceId = newId("workspace");
    await alice.client.mutation(api.workspaces.create, { workspaceId, name: "One" });
    await alice.client.mutation(api.workspaces.rename, { workspaceId, name: "Two" });
    await expect(
      alice.client.mutation(api.workspaces.create, { workspaceId, name: "One" }),
    ).resolves.toMatchObject({ created: false });
    await addMember(alice.client, bob.client, workspaceId, "owner");
    await alice.client.mutation(api.members.leave, { workspaceId });
    await expect(
      alice.client.mutation(api.workspaces.create, { workspaceId, name: "One" }),
    ).rejects.toThrow(code("id_taken"));
  });

  test("a display name the rename rules would refuse still makes a valid personal Workspace", async () => {
    const t = convexTest(schema, modules);
    const { client } = await signIn(t, {
      ...person("x"),
      name: `\u0007${"😀".repeat(70)}`,
    });
    const [personal] = await client.query(api.workspaces.listMine, {});
    expect(Array.from(personal!.name)).toHaveLength(64);
    expect(personal!.name.startsWith("😀")).toBe(true);
    const only = await signIn(t, { ...person("y"), name: "\u0007\u0008" });
    // profileFromIdentity keeps the control characters, so the fallback applies.
    const [fallback] = await only.client.query(api.workspaces.listMine, {});
    expect(fallback!.name).toBe("My workspace");
  });

  test("unsuspend sets the tier from the current plan", async () => {
    const t = convexTest(schema, modules);
    const world = await team(t);
    const { workspaceId, owner, suspended } = world;
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("workspaces")
        .withIndex("by_uuid", (q) => q.eq("id", workspaceId))
        .unique();
      await ctx.db.patch(row!._id, { planKey: "team" });
    });
    await owner.client.mutation(api.members.unsuspend, { workspaceId, userId: suspended.userId });
    const roster = await owner.client.query(api.members.list, { workspaceId });
    expect(roster.find((row) => row.userId === suspended.userId)?.billingTier).toBe("team");
  });

  test("an argument is checked after the identity", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.members.suspend, { workspaceId: newId("workspace"), userId: "nope" }),
    ).rejects.toThrow(code("unauthenticated"));
    await expect(t.mutation(api.invites.revoke, { inviteId: "nope" })).rejects.toThrow(
      code("unauthenticated"),
    );
  });
});
