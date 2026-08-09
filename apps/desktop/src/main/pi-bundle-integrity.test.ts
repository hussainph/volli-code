import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { fingerprintPiBundle, verifiedPiBundleCache } from "./pi-bundle-integrity";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("prepared Pi bundle integrity", () => {
  it("uses host-independent code-unit ordering for the release fingerprint", async () => {
    const piDirectory = await mkdtemp(join(tmpdir(), "volli-pi-ordering-"));
    temporaryDirectories.push(piDirectory);
    await Promise.all([
      writeFile(join(piDirectory, "!"), "!"),
      writeFile(join(piDirectory, "_"), "_"),
      writeFile(join(piDirectory, "-"), "-"),
      writeFile(join(piDirectory, "0"), "0"),
      writeFile(join(piDirectory, "@"), "@"),
    ]);

    await expect(fingerprintPiBundle(piDirectory)).resolves.toBe(
      "018ce859a3116a4eb63e49e6820ea8053e03bc0c4dc697ad4704868fa6a38036",
    );
  });

  it("accepts an executable tree only while every cached byte matches its marker", async () => {
    const destination = await mkdtemp(join(tmpdir(), "volli-pi-integrity-"));
    temporaryDirectories.push(destination);
    const piDirectory = join(destination, "pi");
    const binary = join(piDirectory, "pi");
    await mkdir(join(piDirectory, "node_modules"), { recursive: true });
    await writeFile(binary, "official binary");
    await chmod(binary, 0o755);
    const library = join(piDirectory, "node_modules", "runtime.js");
    await writeFile(library, "official library");
    const treeSha256 = await fingerprintPiBundle(piDirectory);
    await writeFile(
      join(destination, ".volli-pi-bundle.json"),
      JSON.stringify({ version: "0.84.1", target: "darwin-arm64", sha256: "archive", treeSha256 }),
    );
    const expected = {
      version: "0.84.1",
      target: "darwin-arm64",
      sha256: "archive",
      treeSha256,
    };

    await expect(verifiedPiBundleCache(destination, expected)).resolves.toBe(true);

    await writeFile(library, "tampered library");
    await expect(verifiedPiBundleCache(destination, expected)).resolves.toBe(false);

    await writeFile(
      join(destination, ".volli-pi-bundle.json"),
      JSON.stringify({ ...expected, treeSha256: await fingerprintPiBundle(piDirectory) }),
    );
    await expect(verifiedPiBundleCache(destination, expected)).resolves.toBe(false);
  });

  it("rejects a matching marker when the Pi entry point is not executable", async () => {
    const destination = await mkdtemp(join(tmpdir(), "volli-pi-integrity-"));
    temporaryDirectories.push(destination);
    const piDirectory = join(destination, "pi");
    const binary = join(piDirectory, "pi");
    await mkdir(piDirectory, { recursive: true });
    await writeFile(binary, "not executable");
    await chmod(binary, 0o644);
    const treeSha256 = await fingerprintPiBundle(piDirectory);
    await writeFile(
      join(destination, ".volli-pi-bundle.json"),
      JSON.stringify({ version: "0.84.1", target: "darwin-arm64", sha256: "archive", treeSha256 }),
    );

    await expect(
      verifiedPiBundleCache(destination, {
        version: "0.84.1",
        target: "darwin-arm64",
        sha256: "archive",
        treeSha256,
      }),
    ).resolves.toBe(false);
  });
});
