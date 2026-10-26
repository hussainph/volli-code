/**
 * Team secrets: env vars and secrets set once at a Workspace, a project or for
 * one person, and delivered to the runner that holds a Session's claim
 * (`secretsDelivery.ts`). The rules are in `@volli/shared/cloud` (`secrets.ts`).
 *
 * - **Reads return metadata only.** No query returns a secret's value, or its
 *   ciphertext; an env var's value is shown (it is plain by kind).
 * - **Writes are sealed in an action.** `set` is an action because sealing may
 *   need the root key provider's network (`lib/sealing.ts`): it plans under the
 *   caller's identity, seals, and writes in one mutation that checks access
 *   again, so a role change between the two cannot slip a write through.
 * - **Every change leaves an audit row** (`secret.*`) naming its Actor, the
 *   name, scope, kind and exposure, never a value.
 */

import { v } from "convex/values";

import {
  DEFAULT_SECRET_EXPOSURE,
  MAX_SCOPE_BYTES,
  MAX_SECRETS_PER_SCOPE,
  secretBytes,
  newId,
  secretLast4,
  secretScopeKey,
  secretValueProblem,
  secretWinners,
  type SecretLayer,
  type SecretTarget,
} from "@volli/shared/cloud";

import { internal } from "./_generated/api";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel.js";
import { audit, type AuditKind } from "./lib/audit";
import { authError, requireIdentity, requireViewer, type Viewer } from "./lib/auth";
import {
  dataKeyContext,
  newDataKey,
  rootKeyProvider,
  sealValue,
  sealedValueBytes,
  valueContext,
} from "./lib/sealing";
import {
  exposureArg,
  findSecret,
  keyOwnerOf,
  kindArg,
  layeredSecrets,
  nameArg,
  requireReadable,
  requireWritable,
  rowTarget,
  secretIdArg,
  secretsAt,
  secretsError,
  summarize,
  targetArg,
  targetFor,
  type SecretSummary,
  type TargetPlace,
} from "./lib/secrets";
import { nullable } from "./lib/validators";
import { personActor } from "./lib/workspaces";

const byName = (a: SecretSummary, b: SecretSummary) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

// ── reads ──────────────────────────────────────────────────────────────────

/** A Workspace's own secrets, for any active Member. */
export const listWorkspace = query({
  args: { workspaceId: v.string() },
  handler: async (ctx, args): Promise<SecretSummary[]> => {
    const viewer = await requireViewer(ctx);
    const target = targetFor(viewer, { scope: "workspace", workspaceId: args.workspaceId });
    await requireReadable(ctx, viewer, target);
    return (await secretsAt(ctx, secretScopeKey(target))).map(summarize).toSorted(byName);
  },
});

/**
 * All of the viewer's personal secrets: the ones that follow them into every
 * project (`projectId: null`) and the ones for one project, including
 * projects they can no longer see, so they can always remove their own.
 */
export const listPersonal = query({
  args: {},
  handler: async (ctx): Promise<SecretSummary[]> => {
    const viewer = await requireViewer(ctx);
    const key = secretScopeKey(targetFor(viewer, { scope: "personal", projectId: null }));
    // `u:{userId}` and `u:{userId}/p:…`: a user id is a fixed-length UUID, and
    // "/" sorts before "0", so this range holds exactly the viewer's keys.
    const rows = await ctx.db
      .query("secrets")
      .withIndex("by_scope_name", (q) => q.gte("scopeKey", key).lt("scopeKey", `${key}0`))
      .collect();
    return rows.map(summarize).toSorted(byName);
  },
});

export type ProjectSecretSummary = SecretSummary & {
  /** The higher level whose value a Session of the viewer's gets instead, or `null` when this one wins. */
  overriddenBy: SecretLayer | null;
};

/**
 * Everything that applies to the viewer's Sessions in a project: the
 * Workspace's, the project's, and the viewer's own personal secrets (for
 * every project, and for this one). Other Members' personal secrets are never
 * listed. Each row says whether a higher level overrides it.
 */
export const listProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args): Promise<ProjectSecretSummary[]> => {
    const viewer = await requireViewer(ctx);
    const target = targetFor(viewer, { scope: "project", projectId: args.projectId });
    const place = await requireReadable(ctx, viewer, target);
    const rows = await layeredSecrets(ctx, {
      userId: viewer.userId,
      projectId: place.projectId!,
      workspaceId: place.workspaceId!,
    });
    const winners = new Map(secretWinners(rows).map((row) => [row.name, row]));
    return rows
      .map((row) => {
        const winner = winners.get(row.name)!;
        return Object.assign(summarize(row), {
          overriddenBy: winner.id === row.id ? null : winner.layer,
        });
      })
      .toSorted(byName);
  },
});

// ── set: plan, seal, write ─────────────────────────────────────────────────

const sealedArg = v.object({ kid: v.string(), ciphertext: v.bytes() });
const newKeyArg = v.object({
  id: v.string(),
  owner: v.string(),
  rootKid: v.string(),
  wrapped: v.bytes(),
});

/** What sealing a value for `target` needs: the row's id, and the data key if one exists. */
export const planWrite = internalQuery({
  args: { target: targetArg, name: v.string() },
  handler: async (ctx, args) => {
    const viewer = await requireViewer(ctx);
    const target = targetFor(viewer, args.target);
    const place = await requireWritable(ctx, viewer, target);
    const scopeKey = secretScopeKey(target);
    const owner = keyOwnerOf(target, place);
    const existing = await findSecret(ctx, scopeKey, nameArg(args.name));
    const key = await ctx.db
      .query("secretKeys")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .unique();
    return {
      secretId: existing?.id ?? null,
      scopeKey,
      owner,
      dataKey: key === null ? null : { id: key.id, rootKid: key.rootKid, wrapped: key.wrapped },
    };
  },
});

export type SetSecretResult = { secretId: string; valueVersion: number; created: boolean };

/**
 * Sets a secret's value (creating it, or replacing the value at the same
 * scope and name). `exposure` defaults to `session` for a new secret and
 * keeps the current one for an existing secret.
 */
export const set = action({
  args: {
    target: targetArg,
    name: v.string(),
    kind: kindArg,
    value: v.string(),
    exposure: v.optional(exposureArg),
  },
  handler: async (ctx, args): Promise<SetSecretResult> => {
    await requireIdentity(ctx);
    const name = nameArg(args.name);
    const problem = secretValueProblem(args.value);
    if (problem !== null) throw secretsError("invalid_argument", problem);
    // A concurrent first write for the same Workspace key, or the same new
    // name, loses the race once and plans again against the winner.
    for (let attempt = 1; ; attempt += 1) {
      const plan = await ctx.runQuery(internal.secrets.planWrite, { target: args.target, name });
      const secretId = plan.secretId ?? newId("secret");
      let sealed: { kid: string; ciphertext: ArrayBuffer } | null = null;
      let newKey: { id: string; owner: string; rootKid: string; wrapped: ArrayBuffer } | null =
        null;
      if (args.kind === "secret") {
        const provider = rootKeyProvider();
        let dataKey: Uint8Array;
        let keyId: string;
        if (plan.dataKey === null) {
          keyId = newId("secretKey");
          dataKey = newDataKey();
          const { rootKid, wrapped } = await provider.wrap(
            dataKey,
            dataKeyContext(keyId, plan.owner),
          );
          newKey = { id: keyId, owner: plan.owner, rootKid, wrapped };
        } else {
          keyId = plan.dataKey.id;
          dataKey = await provider.unwrap(
            plan.dataKey.rootKid,
            plan.dataKey.wrapped,
            dataKeyContext(keyId, plan.owner),
          );
        }
        sealed = {
          kid: keyId,
          ciphertext: await sealValue(
            dataKey,
            args.value,
            valueContext(secretId, plan.scopeKey, name),
          ),
        };
      }
      try {
        return await ctx.runMutation(internal.secrets.write, {
          target: args.target,
          name,
          kind: args.kind,
          exposure: args.exposure ?? null,
          secretId,
          plain: args.kind === "env" ? args.value : null,
          sealed,
          last4: secretLast4(args.kind, args.value),
          newKey,
        });
      } catch (error) {
        if (attempt >= 2 || !isConflict(error)) throw error;
      }
    }
  },
});

function conflict() {
  return secretsError("conflict", "This secret changed while it was being saved. Try again.");
}

function isConflict(error: unknown): boolean {
  const data = (error as { data?: unknown }).data;
  return (
    typeof data === "object" && data !== null && (data as { code?: unknown }).code === "conflict"
  );
}

/** The write half of {@link set}: access checked again, the key and row written, the change audited. */
export const write = internalMutation({
  args: {
    target: targetArg,
    name: v.string(),
    kind: kindArg,
    exposure: nullable(exposureArg),
    secretId: v.string(),
    plain: nullable(v.string()),
    sealed: nullable(sealedArg),
    last4: nullable(v.string()),
    newKey: nullable(newKeyArg),
  },
  handler: async (ctx, args): Promise<SetSecretResult> => {
    const viewer = await requireViewer(ctx);
    const target = targetFor(viewer, args.target);
    const place = await requireWritable(ctx, viewer, target);
    const scopeKey = secretScopeKey(target);
    const name = nameArg(args.name);
    if (args.sealed !== null) {
      const owner = keyOwnerOf(target, place);
      if (args.newKey !== null) {
        const existingKey = await ctx.db
          .query("secretKeys")
          .withIndex("by_owner", (q) => q.eq("owner", owner))
          .unique();
        if (
          existingKey !== null ||
          args.newKey.owner !== owner ||
          args.newKey.id !== args.sealed.kid
        ) {
          throw conflict();
        }
        await ctx.db.insert("secretKeys", {
          id: args.newKey.id,
          owner,
          rootKid: args.newKey.rootKid,
          wrapped: args.newKey.wrapped,
          createdAt: Date.now(),
          rewrappedAt: null,
        });
      } else {
        // The key the action sealed under must still be this target's key
        // (a project that moved Workspace in between seals again).
        const key = await ctx.db
          .query("secretKeys")
          .withIndex("by_uuid", (q) => q.eq("id", args.sealed!.kid))
          .unique();
        if (key === null || key.owner !== owner) throw conflict();
      }
    }
    const existing = await findSecret(ctx, scopeKey, name);
    if (existing !== null ? existing.id !== args.secretId : await idTaken(ctx, args.secretId)) {
      throw conflict();
    }
    // Every level's set lands in every process of every Member's Sessions:
    // bound it, so one scope cannot push a spawn past the environment limit.
    const others = (await secretsAt(ctx, scopeKey)).filter((row) => row.name !== name);
    if (others.length >= MAX_SECRETS_PER_SCOPE) {
      throw secretsError(
        "limit_exceeded",
        `A scope holds at most ${MAX_SECRETS_PER_SCOPE} secrets. Remove one first.`,
      );
    }
    const bytes = [...others, args].reduce((sum, row) => sum + rowBytes(row), 0);
    if (bytes > MAX_SCOPE_BYTES) {
      throw secretsError(
        "limit_exceeded",
        `A scope's names and values come to at most ${MAX_SCOPE_BYTES / 1024} KiB.`,
      );
    }
    const now = Date.now();
    const fields = {
      kind: args.kind,
      plain: args.plain,
      sealed: args.sealed,
      last4: args.last4,
      updatedAt: now,
    };
    let row: Doc<"secrets">;
    if (existing === null) {
      const docId = await ctx.db.insert("secrets", {
        id: args.secretId,
        scope: target.scope,
        scopeKey,
        name,
        exposure: args.exposure ?? DEFAULT_SECRET_EXPOSURE,
        requestedBySessionId: null,
        createdBy: personActor(viewer),
        lastUsedAt: null,
        valueVersion: 1,
        ...fields,
      });
      row = (await ctx.db.get(docId))!;
    } else {
      await ctx.db.patch(existing._id, {
        ...fields,
        exposure: args.exposure ?? existing.exposure,
        valueVersion: existing.valueVersion + 1,
      });
      row = (await ctx.db.get(existing._id))!;
    }
    await auditSecret(
      ctx,
      viewer,
      place,
      existing === null ? "secret.created" : "secret.updated",
      row,
    );
    return { secretId: row.id, valueVersion: row.valueVersion, created: existing === null };
  },
});

function rowBytes(row: {
  name: string;
  plain: string | null;
  sealed: { ciphertext: ArrayBuffer } | null;
}): number {
  return row.sealed === null
    ? secretBytes(row.name, row.plain ?? "")
    : secretBytes(row.name, "") + sealedValueBytes(row.sealed.ciphertext);
}

async function idTaken(ctx: MutationCtx, secretId: string): Promise<boolean> {
  const row = await ctx.db
    .query("secrets")
    .withIndex("by_uuid", (q) => q.eq("id", secretIdArg(secretId)))
    .unique();
  return row !== null;
}

// ── exposure and removal ───────────────────────────────────────────────────

async function writableRow(
  ctx: MutationCtx,
  viewer: Viewer,
  secretId: string,
): Promise<{ row: Doc<"secrets">; target: SecretTarget; place: TargetPlace }> {
  const row = await ctx.db
    .query("secrets")
    .withIndex("by_uuid", (q) => q.eq("id", secretIdArg(secretId)))
    .unique();
  if (row === null) throw authError("not_found", "That secret does not exist.");
  const target = rowTarget(row);
  if (target.scope === "personal" && target.userId === viewer.userId) {
    // Your own: yours to narrow or remove even after leaving the project's
    // Workspace, or after the project is gone.
    return {
      row,
      target,
      place: { workspaceId: null, projectId: target.projectId, membership: null },
    };
  }
  return { row, target, place: await requireWritable(ctx, viewer, target) };
}

/** Narrows or widens where a secret reaches. Idempotent: the same exposure changes nothing. */
export const setExposure = mutation({
  args: { secretId: v.string(), exposure: exposureArg },
  handler: async (ctx, args): Promise<{ changed: boolean }> => {
    const viewer = await requireViewer(ctx);
    const { row, place } = await writableRow(ctx, viewer, args.secretId);
    if (row.exposure === args.exposure) return { changed: false };
    await ctx.db.patch(row._id, { exposure: args.exposure, updatedAt: Date.now() });
    await auditSecret(ctx, viewer, place, "secret.exposure_changed", {
      ...row,
      exposure: args.exposure,
    });
    return { changed: true };
  },
});

/** Removes a secret. Its history stays in the audit log, never its value. */
export const remove = mutation({
  args: { secretId: v.string() },
  handler: async (ctx, args): Promise<{ removed: true }> => {
    const viewer = await requireViewer(ctx);
    const { row, place } = await writableRow(ctx, viewer, args.secretId);
    await ctx.db.delete(row._id);
    await auditSecret(ctx, viewer, place, "secret.removed", row);
    return { removed: true };
  },
});

async function auditSecret(
  ctx: MutationCtx,
  viewer: Viewer,
  place: TargetPlace,
  kind: AuditKind,
  row: Doc<"secrets">,
): Promise<void> {
  await audit(ctx, {
    // A personal secret is the person's: it never enters a Workspace's trail.
    workspaceId: row.scope === "personal" ? null : place.workspaceId,
    actor: personActor(viewer),
    kind,
    targetKind: "secret",
    targetId: row.id,
    at: Date.now(),
    detail: {
      name: row.name,
      scope: row.scope,
      projectId: place.projectId,
      kind: row.kind,
      exposure: row.exposure,
      valueVersion: row.valueVersion,
    },
  });
}
