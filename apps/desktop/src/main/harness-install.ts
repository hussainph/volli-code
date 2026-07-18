import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { managedWriteDecision, mergeFencedSection, type InstallAction } from "@volli/shared";

interface ManifestEntry {
  kind: InstallAction["kind"];
  hash: string;
}

type InstallManifest = Record<string, ManifestEntry>;

export interface HarnessInstallResult {
  written: string[];
  skipped: string[];
  conflicts: string[];
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function textAt(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
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

async function writeManagedFile(
  action: Extract<InstallAction, { kind: "write" }>,
  manifest: InstallManifest,
  result: HarnessInstallResult,
): Promise<void> {
  const current = await textAt(action.path);
  const desiredHash = hash(action.content);
  const decision = managedWriteDecision({
    currentHash: current === null ? null : hash(current),
    recordedHash: manifest[action.path]?.hash ?? null,
    desiredHash,
  });
  if (decision === "conflict") {
    result.conflicts.push(action.path);
    return;
  }
  manifest[action.path] = { kind: action.kind, hash: desiredHash };
  if (decision === "skip") {
    result.skipped.push(action.path);
    return;
  }
  await mkdir(dirname(action.path), { recursive: true });
  await writeFile(action.path, action.content, "utf8");
  result.written.push(action.path);
}

async function writeManagedSymlink(
  action: Extract<InstallAction, { kind: "symlink" }>,
  manifest: InstallManifest,
  result: HarnessInstallResult,
): Promise<void> {
  const desiredHash = hash(action.target);
  let currentHash: string | null = null;
  try {
    const entry = await lstat(action.path);
    currentHash = entry.isSymbolicLink()
      ? hash(await readlink(action.path))
      : hash("not-a-symlink");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const decision = managedWriteDecision({
    currentHash,
    recordedHash: manifest[action.path]?.hash ?? null,
    desiredHash,
  });
  if (decision === "conflict") {
    result.conflicts.push(action.path);
    return;
  }
  manifest[action.path] = { kind: action.kind, hash: desiredHash };
  if (decision === "skip") {
    result.skipped.push(action.path);
    return;
  }
  await mkdir(dirname(action.path), { recursive: true });
  await rm(action.path, { force: true });
  await symlink(action.target, action.path, "dir");
  result.written.push(action.path);
}

function fencedBody(content: string): string | null {
  const match = content.match(/<!-- volli:begin v=\d+ -->\n([\s\S]*?)\n<!-- volli:end -->/);
  return match?.[1] ?? null;
}

async function writeManagedFence(
  action: Extract<InstallAction, { kind: "fenced" }>,
  manifest: InstallManifest,
  result: HarnessInstallResult,
): Promise<void> {
  const current = (await textAt(action.path)) ?? "";
  const currentBody = fencedBody(current);
  const desiredHash = hash(action.content);
  const decision = managedWriteDecision({
    currentHash: currentBody === null ? null : hash(currentBody),
    recordedHash: manifest[action.path]?.hash ?? null,
    desiredHash,
  });
  if (decision === "conflict") {
    result.conflicts.push(action.path);
    return;
  }
  manifest[action.path] = { kind: action.kind, hash: desiredHash };
  const merged = mergeFencedSection(current, action.content, action.version);
  if (decision === "skip" && !merged.changed) {
    result.skipped.push(action.path);
    return;
  }
  await mkdir(dirname(action.path), { recursive: true });
  await writeFile(action.path, merged.content, "utf8");
  result.written.push(action.path);
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
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return result;
}

/** Removes exactly the plan's managed files, links, and fenced blocks; user custom files survive. */
export async function uninstallHarnessPlan(
  plan: readonly InstallAction[],
  manifestPath: string,
): Promise<void> {
  for (const action of plan) {
    if (action.kind === "fenced") {
      const current = await textAt(action.path);
      if (current === null) continue;
      const withoutBlock = current.replace(
        /\n?<!-- volli:begin v=\d+ -->[\s\S]*?<!-- volli:end -->\n?/,
        "\n",
      );
      await writeFile(action.path, withoutBlock, "utf8");
    } else {
      await rm(action.path, { force: true });
    }
  }
  await rm(manifestPath, { force: true });
}
