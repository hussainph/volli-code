import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { fingerprintPiBundle } from "./pi-bundle-integrity";
import {
  piCliTarget,
  resolvePiCliResource,
  piLoginLaunch,
  verifiedPiCliResource,
} from "./pi-cli-resource";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("bundled Pi CLI resource", () => {
  it("maps only the two supported macOS targets", () => {
    expect(piCliTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(piCliTarget("darwin", "x64")).toBe("darwin-x64");
    expect(() => piCliTarget("linux", "x64")).toThrow("Unsupported Pi CLI target");
  });

  it("resolves the intact Pi directory in development and packaged apps", () => {
    expect(
      resolvePiCliResource({
        platform: "darwin",
        arch: "arm64",
        appPath: "/repo/apps/desktop",
        resourcesPath: "/App/Contents/Resources",
        isPackaged: false,
      }),
    ).toBe("/repo/apps/desktop/resources/pi-cli/darwin-arm64/pi/pi");
    expect(
      resolvePiCliResource({
        platform: "darwin",
        arch: "x64",
        appPath: "/ignored",
        resourcesPath: "/App/Contents/Resources",
        isPackaged: true,
      }),
    ).toBe("/App/Contents/Resources/pi-cli/darwin-x64/pi/pi");
  });

  it("builds a fixed offline login launch with Pi's credential directory", () => {
    expect(
      piLoginLaunch({
        binaryPath: "/Applications/Volli's App/pi/pi",
        authFilePath: "/Users/me/.pi/agent/auth.json",
      }),
    ).toEqual({
      command:
        "'/Applications/Volli'\\''s App/pi/pi' --no-session --no-tools --no-extensions --no-skills --no-prompt-templates --no-context-files --no-themes --no-approve",
      env: {
        PI_CODING_AGENT_DIR: "/Users/me/.pi/agent",
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
      },
    });
  });

  it("pins a relative credential path to main's absolute location before changing terminal cwd", () => {
    expect(
      piLoginLaunch({
        binaryPath: "/Applications/Volli Code/pi/pi",
        authFilePath: "runtime-data/pi/auth.json",
      }).env.PI_CODING_AGENT_DIR,
    ).toBe(resolve("runtime-data/pi"));
  });

  it("exposes a bundled login executable only while its tree matches the trusted release", async () => {
    const appPath = await mkdtemp(`${tmpdir()}/volli-pi-resource-`);
    temporaryDirectories.push(appPath);
    const destination = `${appPath}/resources/pi-cli/darwin-arm64`;
    const piDirectory = `${destination}/pi`;
    const binaryPath = `${piDirectory}/pi`;
    await mkdir(piDirectory, { recursive: true });
    await writeFile(binaryPath, "official binary");
    await chmod(binaryPath, 0o755);
    const treeSha256 = await fingerprintPiBundle(piDirectory);
    const expected = {
      version: "test",
      target: "darwin-arm64",
      sha256: "archive",
      treeSha256,
    };
    await writeFile(`${destination}/.volli-pi-bundle.json`, JSON.stringify(expected));
    const input = {
      platform: "darwin" as const,
      arch: "arm64" as const,
      appPath,
      resourcesPath: "/ignored",
      isPackaged: false,
    };

    await expect(verifiedPiCliResource(input, expected)).resolves.toBe(binaryPath);

    await writeFile(binaryPath, "tampered binary");
    await chmod(binaryPath, 0o755);
    await writeFile(
      `${destination}/.volli-pi-bundle.json`,
      JSON.stringify({ ...expected, treeSha256: await fingerprintPiBundle(piDirectory) }),
    );
    await expect(verifiedPiCliResource(input, expected)).resolves.toBeNull();
  });
});
