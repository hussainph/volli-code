/**
 * Private, one-shot raster decoder. Only bounded image bytes cross this worker
 * boundary; never page HTML, URLs, credentials or Session data. The host owns
 * acquisition/queuing and must terminate the worker on cancellation or after
 * one second (including startup). No decoder runs on the host's event loop.
 *
 * This is not the provider image fitter: even tiny icons are decoded and
 * re-encoded, stripping metadata and rejecting animated/non-raster content.
 */
import { parentPort } from "node:worker_threads";

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_INPUT_PIXELS = 1_000_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_EDGE = 64;

type RasterFormat = "png" | "jpeg" | "webp";

/** Check complete PNG chunk framing, including animation control chunks. */
function staticPng(bytes: Buffer): boolean {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return false;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "acTL" || type === "fcTL" || type === "fdAT") return false;
    if (type === "IEND") return length === 0 && end === bytes.length;
    offset = end;
  }
  return false;
}

/** RIFF chunk boundaries, not a substring search through compressed pixels. */
function staticWebp(bytes: Buffer): boolean {
  if (bytes.length < 20 || bytes.readUInt32LE(4) + 8 !== bytes.length) return false;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + length + (length % 2);
    if (end > bytes.length) return false;
    if (type === "ANIM" || type === "ANMF") return false;
    if (type === "VP8X" && (length !== 10 || (bytes[offset + 8]! & 0x02) !== 0)) return false;
    offset = end;
  }
  return offset === bytes.length;
}

function formatOf(bytes: Buffer, mime: unknown): RasterFormat | null {
  if (
    mime === "image/png" &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    staticPng(bytes)
  ) {
    return "png";
  }
  if (mime === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (
    mime === "image/webp" &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP" &&
    staticWebp(bytes)
  ) {
    return "webp";
  }
  return null;
}

async function decode(input: unknown): Promise<Uint8Array | null> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (!(record.bytes instanceof Uint8Array)) return null;
  if (record.bytes.byteLength === 0 || record.bytes.byteLength > MAX_INPUT_BYTES) return null;
  const bytes = Buffer.from(record.bytes);
  const format = formatOf(bytes, record.mime);
  if (format === null) return null;
  try {
    const { default: sharp } = await import("sharp");
    const options = { limitInputPixels: MAX_INPUT_PIXELS, failOn: "warning" as const };
    const metadata = await sharp(bytes, options).metadata();
    if (
      metadata.format !== format ||
      (metadata.pages ?? 1) !== 1 ||
      metadata.width === undefined ||
      metadata.height === undefined ||
      metadata.width < 1 ||
      metadata.height < 1 ||
      metadata.width * metadata.height > MAX_INPUT_PIXELS
    ) {
      return null;
    }
    // A fresh pipeline: never an original-byte fast path or withMetadata().
    // libvips also gets its own native-operation deadline; the host still owns
    // the wall-clock deadline, including import/metadata and worker startup.
    const { data, info } = await sharp(bytes, options)
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .png()
      .timeout({ seconds: 1 })
      .toBuffer({ resolveWithObject: true });
    if (
      info.format !== "png" ||
      info.width < 1 ||
      info.height < 1 ||
      info.width > MAX_EDGE ||
      info.height > MAX_EDGE ||
      data.byteLength > MAX_OUTPUT_BYTES
    ) {
      return null;
    }
    // Own backing storage, not Node's Buffer pool. The wire carries exactly
    // these bytes, regardless of the original allocation's offset or size.
    return Uint8Array.from(data);
  } catch {
    // Optional decoration: no decoder/server text crosses back to the host.
    return null;
  }
}

if (parentPort === null) throw new Error("Source icons decode only inside a worker thread");
const port = parentPort;
port.once("message", (input: unknown) => {
  void decode(input).then((bytes) => {
    port.postMessage(bytes === null ? { type: "omitted" } : { type: "ready", bytes });
    port.close();
  });
});
