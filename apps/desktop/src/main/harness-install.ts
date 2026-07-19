import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  managedWriteDecision,
  mergeFencedSection,
  type InstallAction,
  type ManagedWriteDecision,
} from "@volli/shared";

interface ManifestEntry {
  kind: InstallAction["kind"];
  hash: string;
}

type InstallManifest = Record<string, ManifestEntry>;

/**
 * A managed file left untouched because it no longer matches what the installer
 * recorded (the user hand-edited it). Carries enough to render a readable diff
 * in the warning dialog (spec decision 12: "warn + diff"). `currentContent` /
 * `desiredContent` are the diffable forms — file text for writes, the fenced
 * body for fences, the link target for symlinks.
 */
export interface ManagedConflict {
  path: string;
  currentContent: string;
  desiredContent: string;
}

export interface HarnessInstallResult {
  written: string[];
  skipped: string[];
  conflicts: ManagedConflict[];
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function textAt(path: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const entry = await handle.stat();
    if (!entry.isFile()) throw new Error(`Refusing to manage non-regular file ${path}`);
    return await handle.readFile({ encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`Refusing to manage non-regular file ${path}`, { cause: error });
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

/** Replaces one managed file without following destination symlinks or using a predictable temp. */
async function writeTextAtomically(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let mode = 0o600;
  try {
    const entry = await lstat(path);
    if (!entry.isFile()) throw new Error(`Refusing to manage non-regular file ${path}`);
    mode = entry.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporaryPath = `${path}.volli-${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function readManifest(path: string): Promise<InstallManifest> {
  const content = await textAt(path);
  if (content === null) return {};
  try {
    const parsed = JSON.parse(content) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as InstallManifest) : {};
  } catch {
    return {};
  }
}

/**
 * One managed-write engine shared by every action kind. Each kind supplies only
 * the two things that differ: how to read the current on-disk state (as a hash
 * plus its diffable content) and how to apply the change. The choreography —
 * decision, conflict short-circuit, skip/written bookkeeping, and manifest
 * recording — lives here once.
 *
 * The manifest entry is recorded only *after* `apply` resolves, so a failed
 * write never persists a hash that falsely claims the file matches the plan.
 */
interface ManagedKindOps {
  readCurrent(): Promise<{ hash: string | null; content: string }>;
  desiredHash: string;
  desiredContent: string;
  /** Applies the change; returns `true` if it wrote, `false` if it was a no-op. */
  apply(decision: ManagedWriteDecision): Promise<boolean>;
}

async function applyManagedAction(
  path: string,
  manifestKind: InstallAction["kind"],
  ops: ManagedKindOps,
  manifest: InstallManifest,
  result: HarnessInstallResult,
): Promise<void> {
  const current = await ops.readCurrent();
  const decision = managedWriteDecision({
    currentHash: current.hash,
    recordedHash: manifest[path]?.hash ?? null,
    desiredHash: ops.desiredHash,
  });
  if (decision === "conflict") {
    result.conflicts.push({
      path,
      currentContent: current.content,
      desiredContent: ops.desiredContent,
    });
    return;
  }
  const wrote = await ops.apply(decision);
  manifest[path] = { kind: manifestKind, hash: ops.desiredHash };
  if (wrote) result.written.push(path);
  else result.skipped.push(path);
}

function writeManagedFile(
  action: Extract<InstallAction, { kind: "write" }>,
  manifest: InstallManifest,
  result: HarnessInstallResult,
): Promise<void> {
  return applyManagedAction(
    action.path,
    action.kind,
    {
      async readCurrent() {
        const current = await textAt(action.path);
        return { hash: current === null ? null : hash(current), content: current ?? "" };
      },
      desiredHash: hash(action.content),
      desiredContent: action.content,
      async apply(decision) {
        if (decision === "skip") return false;
        await writeTextAtomically(action.path, action.content);
        return true;
      },
    },
    manifest,
    result,
  );
}

function writeManagedSymlink(
  action: Extract<InstallAction, { kind: "symlink" }>,
  manifest: InstallManifest,
  result: HarnessInstallResult,
): Promise<void> {
  return applyManagedAction(
    action.path,
    action.kind,
    {
      async readCurrent() {
        try {
          const entry = await lstat(action.path);
          if (entry.isSymbolicLink()) {
            const target = await readlink(action.path);
            return { hash: hash(target), content: target };
          }
          return { hash: hash("not-a-symlink"), content: "not-a-symlink" };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return { hash: null, content: "" };
        }
      },
      desiredHash: hash(action.target),
      desiredContent: action.target,
      async apply(decision) {
        if (decision === "skip") return false;
        await mkdir(dirname(action.path), { recursive: true });
        await rm(action.path, { force: true });
        await symlink(action.target, action.path, "dir");
        return true;
      },
    },
    manifest,
    result,
  );
}

function fencedBody(content: string): string | null {
  // Tolerate CRLF and a missing newline adjacent to either marker: a strict
  // `\n` requirement makes the body null on Windows-edited or trailing-newline-
  // stripped files, which fails the guard open (null → "write" → silent
  // overwrite of user edits). Normalize CRLF→LF so the same logical body hashes
  // identically regardless of the file's line-ending convention.
  const match = content.match(/<!-- volli:begin v=\d+ -->\r?\n?([\s\S]*?)\r?\n?<!-- volli:end -->/);
  return match ? match[1].replace(/\r\n/g, "\n") : null;
}

async function writeManagedFence(
  action: Extract<InstallAction, { kind: "fenced" }>,
  manifest: InstallManifest,
  result: HarnessInstallResult,
): Promise<void> {
  const current = (await textAt(action.path)) ?? "";
  const currentBody = fencedBody(current);
  const merged = mergeFencedSection(current, action.content, action.version);
  await applyManagedAction(
    action.path,
    action.kind,
    {
      readCurrent() {
        return Promise.resolve({
          hash: currentBody === null ? null : hash(currentBody),
          content: currentBody ?? "",
        });
      },
      desiredHash: hash(action.content),
      desiredContent: action.content,
      async apply(decision) {
        // Body hash can match (skip) while the surrounding file still needs the
        // version marker refreshed, so re-check merged.changed before no-op.
        if (decision === "skip" && !merged.changed) return false;
        await writeTextAtomically(action.path, merged.content);
        return true;
      },
    },
    manifest,
    result,
  );
}

/** Applies a declarative adapter plan with per-managed-file hash protection. */
export async function applyHarnessInstallPlan(
  plan: readonly InstallAction[],
  manifestPath: string,
): Promise<HarnessInstallResult> {
  const manifest = await readManifest(manifestPath);
  const result: HarnessInstallResult = { written: [], skipped: [], conflicts: [] };
  for (const action of plan) {
    if (action.kind === "write") await writeManagedFile(action, manifest, result);
    else if (action.kind === "symlink") await writeManagedSymlink(action, manifest, result);
    else await writeManagedFence(action, manifest, result);
  }
  await writeTextAtomically(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return result;
}

export interface HarnessUninstallResult {
  /** Managed files, links, and fenced blocks actually removed. */
  removed: string[];
  /** Managed files left in place because the user had edited them (hash mismatch). */
  preserved: string[];
}

/**
 * Removes exactly the plan's managed files, links, and fenced blocks — but a
 * managed file the user has since edited is preserved, not destroyed (install
 * already protects such files as conflicts; uninstall must honor the same
 * boundary). "Write" files are removed only when the on-disk hash still matches
 * the manifest; symlinks only when the link still points at our target; fenced
 * blocks are excised in place, leaving surrounding user content. `custom/` is
 * never in a plan, so it is never touched.
 */
export async function uninstallHarnessPlan(
  plan: readonly InstallAction[],
  manifestPath: string,
): Promise<HarnessUninstallResult> {
  const manifest = await readManifest(manifestPath);
  const result: HarnessUninstallResult = { removed: [], preserved: [] };
  for (const action of plan) {
    if (action.kind === "write") {
      const current = await textAt(action.path);
      if (current === null) continue; // already gone
      const recordedHash = manifest[action.path]?.hash ?? null;
      if (recordedHash !== null && hash(current) === recordedHash) {
        await rm(action.path, { force: true });
        result.removed.push(action.path);
      } else {
        result.preserved.push(action.path); // user-edited or unverifiable — keep it
      }
    } else if (action.kind === "symlink") {
      let target: string | null = null;
      try {
        const entry = await lstat(action.path);
        if (entry.isSymbolicLink()) target = await readlink(action.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (target === action.target) {
        await rm(action.path, { force: true });
        result.removed.push(action.path);
      } else if (target !== null) {
        result.preserved.push(action.path); // repointed by the user — leave it
      }
      // absent → nothing to remove
    } else {
      const current = await textAt(action.path);
      if (current === null) continue;
      const withoutBlock = current.replace(
        /\n?<!-- volli:begin v=\d+ -->[\s\S]*?<!-- volli:end -->\n?/,
        "\n",
      );
      if (withoutBlock !== current) {
        await writeTextAtomically(action.path, withoutBlock);
        result.removed.push(action.path);
      }
    }
  }
  await rm(manifestPath, { force: true });
  return result;
}
