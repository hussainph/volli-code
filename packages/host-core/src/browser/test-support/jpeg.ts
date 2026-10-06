/** A JPEG's pixel size, read from its start-of-frame marker; null for bytes that are not one. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    // SOF0-SOF3: baseline, extended, progressive, lossless.
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: (bytes[at + 5]! << 8) | bytes[at + 6]!,
        width: (bytes[at + 7]! << 8) | bytes[at + 8]!,
      };
    }
    at += 2 + length;
  }
  return null;
}
