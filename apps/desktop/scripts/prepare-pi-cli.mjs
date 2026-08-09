import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fingerprintPiBundle, verifiedPiBundleCache } from "../src/main/pi-bundle-integrity.ts";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resourceRoot = join(desktopDir, "resources", "pi-cli");
const manifest = JSON.parse(await readFile(join(resourceRoot, "manifest.json"), "utf8"));
const targets = process.argv.includes("--all")
  ? Object.keys(manifest.targets)
  : [`${process.platform}-${process.arch}`];

for (const target of targets) {
  const artifact = manifest.targets[target];
  if (!artifact) throw new Error(`Pi CLI has no official bundle for ${target}`);
  const destination = join(resourceRoot, target);
  if (
    await verifiedPiBundleCache(destination, {
      version: manifest.version,
      target,
      sha256: artifact.sha256,
      treeSha256: artifact.treeSha256,
    })
  )
    continue;

  const temporary = await mkdtemp(join(tmpdir(), `volli-pi-${target}-`));
  try {
    const archivePath = join(temporary, artifact.archive);
    const url = `https://github.com/earendil-works/pi/releases/download/v${manifest.version}/${artifact.archive}`;
    await download(url, archivePath);
    const archiveStat = await stat(archivePath);
    if (archiveStat.size !== artifact.size) {
      throw new Error(
        `Pi CLI size mismatch for ${target}: expected ${artifact.size}, got ${archiveStat.size}`,
      );
    }
    const actual = await sha256(archivePath);
    if (actual !== artifact.sha256) {
      throw new Error(
        `Pi CLI checksum mismatch for ${target}: expected ${artifact.sha256}, got ${actual}`,
      );
    }
    const extracted = join(temporary, "extracted");
    await mkdir(extracted);
    await run("tar", ["-xzf", archivePath, "-C", extracted]);
    const binary = join(extracted, "pi", "pi");
    if (!existsSync(binary))
      throw new Error(`Pi CLI archive for ${target} has no pi/pi executable`);
    await chmod(binary, 0o755);
    const treeSha256 = await fingerprintPiBundle(join(extracted, "pi"));
    if (treeSha256 !== artifact.treeSha256) {
      throw new Error(
        `Pi CLI tree checksum mismatch for ${target}: expected ${artifact.treeSha256}, got ${treeSha256}`,
      );
    }
    await writeFile(
      join(extracted, ".volli-pi-bundle.json"),
      `${JSON.stringify({ version: manifest.version, target, sha256: artifact.sha256, treeSha256 }, null, 2)}\n`,
    );
    await mkdir(dirname(destination), { recursive: true });
    await rm(destination, { recursive: true, force: true });
    await rename(extracted, destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function download(url, path) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || response.body === null) {
    throw new Error(`Could not download Pi CLI: ${response.status} ${response.statusText}`);
  }
  const file = await import("node:fs").then(({ createWriteStream }) => createWriteStream(path));
  const { Readable } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");
  await pipeline(Readable.fromWeb(response.body), file);
}

function sha256(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} exited with ${code ?? "unknown"}`));
    });
  });
}
