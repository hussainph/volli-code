/** App-owned Settings identity marks, independent of the user's accent. */
const COLOURS: Readonly<Record<string, string>> = Object.freeze({
  general: "#6d727c",
  appearance: "#2a6ae6",
  notifications: "#e5383b",
  skills: "#7754f0",
  mcp: "#7754f0",
  "mcp-servers": "#7754f0",
  models: "#7754f0",
  agents: "#e8652a",
  "web-search": "#12969a",
  integrations: "#22a15a",
  storage: "#6d727c",
  privacy: "#2a6ae6",
  experimental: "#e8457f",
  updates: "#6d727c",
  about: "#6d727c",
});
export function settingsIconColor(key: string): string {
  const name = key.split(":").at(-1)!;
  return Object.hasOwn(COLOURS, name) ? COLOURS[name]! : COLOURS.general!;
}
