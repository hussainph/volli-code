import { CodeIcon, TerminalWindowIcon } from "@phosphor-icons/react";

/** Recognizable glyphs for the supported external applications; no icon IPC or asset bundle. */
export function AppGlyph({ name }: { name: string }) {
  const normalized = name.toLowerCase();
  if (normalized === "visual studio code" || normalized === "vscode")
    return (
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        className="size-4 shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      >
        <path d="M17 2 22 4v16l-5 2L6 13l-3 3-2-2 3-3-3-3 2-2 3 3L17 2Z" />
        <path d="m17 7-7 5 7 5V7Z" />
      </svg>
    );
  if (normalized === "cursor")
    return (
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        className="size-4 shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      >
        <path d="m4 3 15 10-7 1-4 7L4 3Z" />
        <path d="m13 14 5 7" />
      </svg>
    );
  if (["terminal", "iterm2", "ghostty", "warp"].includes(normalized))
    return <TerminalWindowIcon aria-hidden className="size-4 shrink-0" />;
  return <CodeIcon aria-hidden className="size-4 shrink-0" />;
}
export function isAppName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    [
      "visual studio code",
      "vscode",
      "cursor",
      "zed",
      "xcode",
      "android studio",
      "terminal",
      "iterm2",
      "ghostty",
      "warp",
    ].includes(name.toLowerCase())
  );
}
