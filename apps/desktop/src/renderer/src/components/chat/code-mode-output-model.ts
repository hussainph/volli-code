import { MCP_RESULT_IMAGE_MAX_BYTES } from "@volli/shared";
import type { DynamicToolUIPart } from "ai";
import { activityDescriptor } from "@volli/session-presentation";

export type CodeModeContent =
  | { type: "text"; text: string }
  | { type: "image"; data?: unknown; mimeType?: unknown; picture?: unknown; caption?: string };

/** Read committed content, not CodeModeDetails or a live nested tool's card. */
export function codeModeImageContent(part: DynamicToolUIPart): CodeModeContent[] | null {
  if (activityDescriptor(part).nativeToolName !== "codemode") return null;
  const output: unknown =
    "output" in part
      ? part.output
      : isRecord(part.input)
        ? part.input["volli.activity.output"]
        : undefined;
  if (!isRecord(output) || !Array.isArray(output.content)) return null;
  const content: CodeModeContent[] = [];
  for (const block of output.content as unknown[]) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      content.push({
        type: "image",
        data: block.data,
        mimeType: block.mimeType,
        ...(Object.hasOwn(block, "picture") ? { picture: block.picture } : {}),
        ...(typeof block.caption === "string" &&
        block.caption.length > 0 &&
        block.caption.length <= 1024
          ? { caption: block.caption }
          : {}),
      });
    }
  }
  return content.some((block) => block.type === "image") ? content : null;
}

/** Historical placeholders and truncated payloads must not become broken images. */
export function codeModeImageDataUrl(
  block: Extract<CodeModeContent, { type: "image" }>,
): string | null {
  return typeof block.mimeType === "string" &&
    /^image\/(png|jpeg|gif|webp|bmp)$/.test(block.mimeType) &&
    typeof block.data === "string" &&
    block.data.length > 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(block.data)
    ? `data:${block.mimeType};base64,${block.data}`
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read bounded host chunks; do not put image bytes back into transcript frames. */
export async function readCodeModePicture(
  query: (input: {
    sessionId: string;
    pictureId: string;
    offset?: number;
  }) => Promise<{ data: string | null; mimeType: string | null; nextOffset: number | null }>,
  sessionId: string,
  pictureId: string,
): Promise<string | null> {
  let offset = 0;
  let mimeType: string | null = null;
  let length = 0;
  const parts: string[] = [];
  for (let chunks = 0; chunks < 128; chunks += 1) {
    const result = await query({ sessionId, pictureId, offset });
    if (
      typeof result.data !== "string" ||
      result.data.length === 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(result.data) ||
      typeof result.mimeType !== "string" ||
      !/^image\/(png|jpeg|gif|webp|bmp)$/.test(result.mimeType) ||
      (mimeType !== null && mimeType !== result.mimeType)
    )
      return null;
    mimeType = result.mimeType;
    length += result.data.length;
    if (length > MCP_RESULT_IMAGE_MAX_BYTES) return null;
    parts.push(result.data);
    if (result.nextOffset === null) return `data:${mimeType};base64,${parts.join("")}`;
    if (
      !Number.isSafeInteger(result.nextOffset) ||
      result.nextOffset <= offset ||
      result.nextOffset % 3 !== 0 ||
      result.data.includes("=")
    )
      return null;
    offset = result.nextOffset;
  }
  return null;
}
