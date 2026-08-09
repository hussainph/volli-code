import { dirname, join, resolve } from "node:path";
import { shellSingleQuote } from "@volli/shared";
import piCliManifest from "../../resources/pi-cli/manifest.json";

import { verifiedPiBundleCache, type PiBundleMarkerIdentity } from "./pi-bundle-integrity";

export type PiCliTarget = "darwin-arm64" | "darwin-x64";

export interface PiCliResourceInput {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  appPath: string;
  resourcesPath: string;
  isPackaged: boolean;
}

export interface PiLoginLaunch {
  command: string;
  env: Readonly<Record<string, string>>;
}

const RESTRICTED_LOGIN_FLAGS = [
  "--no-session",
  "--no-tools",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--no-themes",
  "--no-approve",
] as const;

export function piCliTarget(platform: NodeJS.Platform, arch: NodeJS.Architecture): PiCliTarget {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    return `darwin-${arch}`;
  }
  throw new Error(`Unsupported Pi CLI target: ${platform}-${arch}`);
}

/** The binary stays beside Pi's full official resource directory. */
export function resolvePiCliResource(input: PiCliResourceInput): string {
  return join(piCliDestination(input), "pi", "pi");
}

/** Resolves the login executable only after its complete tree matches the compiled release pin. */
export async function verifiedPiCliResource(
  input: PiCliResourceInput,
  expected = piCliReleaseIdentity(piCliTarget(input.platform, input.arch)),
): Promise<string | null> {
  const target = piCliTarget(input.platform, input.arch);
  if (expected.target !== target) return null;
  return (await verifiedPiBundleCache(piCliDestination(input), expected))
    ? resolvePiCliResource(input)
    : null;
}

/** Main-owned launch policy for the manual provider sign-in terminal. */
export function piLoginLaunch(input: { binaryPath: string; authFilePath: string }): PiLoginLaunch {
  return {
    command: [shellSingleQuote(input.binaryPath), ...RESTRICTED_LOGIN_FLAGS].join(" "),
    env: {
      PI_CODING_AGENT_DIR: resolve(dirname(input.authFilePath)),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
    },
  };
}

function piCliDestination(input: PiCliResourceInput): string {
  const root = input.isPackaged ? input.resourcesPath : join(input.appPath, "resources");
  return join(root, "pi-cli", piCliTarget(input.platform, input.arch));
}

function piCliReleaseIdentity(target: PiCliTarget): PiBundleMarkerIdentity {
  const artifact = piCliManifest.targets[target];
  return {
    version: piCliManifest.version,
    target,
    sha256: artifact.sha256,
    treeSha256: artifact.treeSha256,
  };
}
