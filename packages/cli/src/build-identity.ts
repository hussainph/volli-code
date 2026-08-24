// oxlint-disable no-underscore-dangle -- Vite `define` constants use the
// double-underscore convention so plain identifiers are never rewritten.
import type { AgentBuildIdentity } from "@volli/shared";

declare const __VOLLI_CLI_VERSION__: string;
declare const __VOLLI_RELEASE_VERSION__: string;
declare const __VOLLI_SOURCE_REVISION__: string;
declare const __VOLLI_BUILD_ID__: string;

/**
 * Values are replaced by the CLI pack build. Source-mode tests use explicit,
 * truthful labels rather than pretending a package version identifies a build.
 */
export const CLI_BUILD_IDENTITY: AgentBuildIdentity = {
  cliVersion:
    typeof __VOLLI_CLI_VERSION__ === "string" ? __VOLLI_CLI_VERSION__ : "0.0.1 (source mode)",
  releaseVersion:
    typeof __VOLLI_RELEASE_VERSION__ === "string"
      ? __VOLLI_RELEASE_VERSION__
      : "0.1.0 (source mode)",
  sourceRevision:
    typeof __VOLLI_SOURCE_REVISION__ === "string" ? __VOLLI_SOURCE_REVISION__ : "unbundled-source",
  buildId: typeof __VOLLI_BUILD_ID__ === "string" ? __VOLLI_BUILD_ID__ : "unbundled-process",
};
