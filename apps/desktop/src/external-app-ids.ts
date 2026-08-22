/**
 * Runtime-safe identifiers for the external-app allowlist.
 *
 * The IPC contract deliberately remains type-only so preload and renderer never
 * load it at runtime. This small vocabulary is safe in both processes: it has
 * no Electron, Node, or DOM dependency, and lets persisted renderer state
 * reject ids that this build cannot launch.
 */
export const EXTERNAL_APP_IDS = [
  "vscode",
  "cursor",
  "zed",
  "xcode",
  "android-studio",
  "terminal",
  "iterm2",
  "ghostty",
  "warp",
] as const;

export type ExternalAppId = (typeof EXTERNAL_APP_IDS)[number];

export function isKnownExternalAppId(value: unknown): value is ExternalAppId {
  return typeof value === "string" && EXTERNAL_APP_IDS.some((id) => id === value);
}
