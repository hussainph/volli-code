/** Shared transcript copy feedback, independent of any hover or tooltip. */
export const COPY_FEEDBACK_MS = 1200;
type ClipboardWriter = Pick<Clipboard, "writeText">;

export async function copyText(
  value: string,
  clipboard: ClipboardWriter | undefined = navigator.clipboard,
): Promise<"copied" | "failed"> {
  try {
    if (!clipboard) return "failed";
    await clipboard.writeText(value);
    return "copied";
  } catch {
    return "failed";
  }
}
