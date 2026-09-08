#!/usr/bin/env node

import { resolve } from "node:path";

import { computeSessionStorageContentDigestAtPath } from "../src/main/db/session-storage-digest.ts";

const [dbPath] = process.argv.slice(2).filter((argument) => argument !== "--");
if (!dbPath) {
  console.error("Usage: pnpm --filter @volli/desktop digest:session-storage -- <database-path>");
  process.exitCode = 2;
} else {
  const digest = computeSessionStorageContentDigestAtPath(resolve(dbPath));
  process.stdout.write(`${JSON.stringify(digest, null, 2)}\n`);
}
