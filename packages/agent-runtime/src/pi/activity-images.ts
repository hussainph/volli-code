/** Project Code Mode pictures before the activity text budget/redaction sees binary data. */
import { MCP_RESULT_IMAGE_MAX_BYTES, MCP_RESULT_MAX_IMAGES } from "@volli/shared";

export type ActivityImagePersistence = (image: { data: string; mimeType: string }) => string | null;

/** Only this tool's returned content carries pictures; direct tools keep their existing projection. */
export function projectCodeModePictures(
  output: unknown,
  persist: ActivityImagePersistence | undefined,
): unknown {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return output;
  const record = output as Record<string, unknown>;
  if (!Array.isArray(record.content)) return output;
  let count = 0;
  let bytes = 0;
  const content: unknown[] = [];
  for (const block of record.content.slice(0, 64) as unknown[]) {
    if (typeof block !== "object" || block === null || Array.isArray(block)) {
      content.push(block);
      continue;
    }
    const image = block as Record<string, unknown>;
    if (image.type !== "image") {
      content.push(block);
      continue;
    }
    let picture: string | null = null;
    let reason = "picture storage is unavailable";
    if (
      typeof image.data === "string" &&
      image.data.length > 0 &&
      image.data.length % 4 === 0 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(image.data) &&
      typeof image.mimeType === "string" &&
      /^image\/(png|jpeg|gif|webp|bmp)$/.test(image.mimeType)
    ) {
      if (
        ++count <= MCP_RESULT_MAX_IMAGES &&
        bytes + image.data.length <= MCP_RESULT_IMAGE_MAX_BYTES
      ) {
        bytes += image.data.length;
        try {
          picture = persist?.({ data: image.data, mimeType: image.mimeType }) ?? null;
        } catch {
          reason = "picture storage failed";
        }
      } else {
        reason = "the run's picture limit was exceeded";
      }
    } else {
      reason = "the image payload is invalid";
    }
    // N−1 sees text, not a corrupt base64 string or a dead-end card. Keep this
    // fallback immediately before the picture so it survives generic presenters.
    content.push({
      type: "text",
      text:
        picture === null
          ? `Code Mode image omitted from the transcript: ${reason}.`
          : "Code Mode image saved. Display requires Volli 0.2.2 or newer; older builds omit it.",
    });
    content.push({
      type: "image",
      mimeType:
        typeof image.mimeType === "string" &&
        /^image\/(png|jpeg|gif|webp|bmp)$/.test(image.mimeType)
          ? image.mimeType
          : null,
      picture,
    });
  }
  if (record.content.length > 64)
    content.push({
      type: "text",
      text: "Additional Code Mode content omitted from the transcript: the activity content limit was exceeded.",
    });
  return { ...record, content };
}
