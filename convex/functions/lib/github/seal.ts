/**
 * Sealing a person's GitHub tokens under their own data key (`u:{userId}`,
 * `lib/sealing.ts`), the key personal secrets use. Each token is bound to
 * its owner and its role (access or refresh), so a ciphertext copied onto
 * another person's row, or the refresh token into the access slot, fails to
 * open.
 *
 * Only actions seal and open. The writing mutation stores a data key the
 * action had to mint ({@link storePersonKey}); a concurrent first mint loses
 * and the caller seals again under the winner's key.
 */

import type { GenericDatabaseReader, GenericDatabaseWriter } from "convex/server";

import { newId } from "@volli/shared/cloud";

import type { DataModel } from "../../_generated/dataModel.js";
import { dataKeyContext, newDataKey, openValue, rootKeyProvider, sealValue } from "../sealing";

/** A data key as stored: wrapped under the deployment's root key. */
export interface PersonKey {
  readonly id: string;
  readonly rootKid: string;
  readonly wrapped: ArrayBuffer;
}

export interface NewPersonKey extends PersonKey {
  readonly owner: string;
}

export interface SealedToken {
  readonly kid: string;
  readonly ciphertext: ArrayBuffer;
}

function personKeyOwner(userId: string): string {
  return `u:${userId}`;
}

/** The additional data a token is sealed with. Frozen. */
function githubTokenContext(userId: string, role: "access" | "refresh"): string {
  return `volli:github-token:v1:${userId}:${role}`;
}

export async function readPersonKey(
  db: GenericDatabaseReader<DataModel>,
  userId: string,
): Promise<PersonKey | null> {
  const key = await db
    .query("secretKeys")
    .withIndex("by_owner", (q) => q.eq("owner", personKeyOwner(userId)))
    .unique();
  return key === null ? null : { id: key.id, rootKid: key.rootKid, wrapped: key.wrapped };
}

/** Seals both tokens, minting the person's data key when they have none yet. */
export async function sealTokens(
  userId: string,
  key: PersonKey | null,
  tokens: { accessToken: string; refreshToken: string },
): Promise<{ access: SealedToken; refresh: SealedToken; newKey: NewPersonKey | null }> {
  const provider = rootKeyProvider();
  const owner = personKeyOwner(userId);
  let dataKey: Uint8Array;
  let newKey: NewPersonKey | null = null;
  let kid: string;
  if (key === null) {
    kid = newId("secretKey");
    dataKey = newDataKey();
    const wrapped = await provider.wrap(dataKey, dataKeyContext(kid, owner));
    newKey = { id: kid, owner, rootKid: wrapped.rootKid, wrapped: wrapped.wrapped };
  } else {
    kid = key.id;
    dataKey = await provider.unwrap(key.rootKid, key.wrapped, dataKeyContext(kid, owner));
  }
  return {
    access: {
      kid,
      ciphertext: await sealValue(
        dataKey,
        tokens.accessToken,
        githubTokenContext(userId, "access"),
      ),
    },
    refresh: {
      kid,
      ciphertext: await sealValue(
        dataKey,
        tokens.refreshToken,
        githubTokenContext(userId, "refresh"),
      ),
    },
    newKey,
  };
}

export async function openToken(
  userId: string,
  key: PersonKey,
  sealed: SealedToken,
  role: "access" | "refresh",
): Promise<string> {
  const owner = personKeyOwner(userId);
  const dataKey = await rootKeyProvider().unwrap(
    key.rootKid,
    key.wrapped,
    dataKeyContext(key.id, owner),
  );
  return openValue(dataKey, sealed.ciphertext, githubTokenContext(userId, role));
}

/**
 * Stores the data key an action minted, or checks that the key it sealed
 * under is still the person's. `false` when another write won the race.
 */
export async function storePersonKey(
  db: GenericDatabaseWriter<DataModel>,
  userId: string,
  kid: string,
  newKey: NewPersonKey | null,
): Promise<boolean> {
  const owner = personKeyOwner(userId);
  const existing = await db
    .query("secretKeys")
    .withIndex("by_owner", (q) => q.eq("owner", owner))
    .unique();
  if (newKey === null) return existing !== null && existing.id === kid;
  if (existing !== null || newKey.owner !== owner || newKey.id !== kid) return false;
  await db.insert("secretKeys", {
    id: newKey.id,
    owner,
    rootKid: newKey.rootKid,
    wrapped: newKey.wrapped,
    createdAt: Date.now(),
    rewrappedAt: null,
  });
  return true;
}
