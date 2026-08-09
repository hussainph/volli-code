import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

export interface PiBundleMarkerIdentity {
  version: string;
  target: string;
  sha256: string;
  treeSha256: string;
}

/** Hashes every shipped path and byte under Pi's official resource directory. */
export async function fingerprintPiBundle(piDirectory: string): Promise<string> {
  const files = await bundleFiles(piDirectory, piDirectory);
  const hash = createHash("sha256");
  for (const file of files) {
    const path = relative(piDirectory, file);
    const metadata = await stat(file);
    hash.update(`${JSON.stringify(path)}\0${metadata.size}\0`);
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** A cache hit is trusted only after its complete tree and executable are re-verified. */
export async function verifiedPiBundleCache(
  destination: string,
  expected: PiBundleMarkerIdentity,
): Promise<boolean> {
  try {
    const marker = JSON.parse(
      await readFile(join(destination, ".volli-pi-bundle.json"), "utf8"),
    ) as unknown;
    if (!isRecord(marker)) return false;
    if (
      marker.version !== expected.version ||
      marker.target !== expected.target ||
      marker.sha256 !== expected.sha256 ||
      marker.treeSha256 !== expected.treeSha256
    ) {
      return false;
    }
    const binary = await stat(join(destination, "pi", "pi"));
    if (!binary.isFile() || (binary.mode & 0o111) === 0) return false;
    return (await fingerprintPiBundle(join(destination, "pi"))) === expected.treeSha256;
  } catch {
    return false;
  }
}

async function bundleFiles(root: string, directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.toSorted((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await bundleFiles(root, path)));
    } else if (entry.isFile()) {
      files.push(path);
    } else {
      throw new Error(`Pi bundle contains unsupported entry: ${relative(root, path)}`);
    }
  }
  return files;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
