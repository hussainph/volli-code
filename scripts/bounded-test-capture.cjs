const { appendFileSync, renameSync, rmSync, writeFileSync } = require("node:fs");

/** Two byte-bounded generations, retaining the most recent output. The caller
 * owns these paths. Whole-record mode never retains a partial JSONL record. */
function createBoundedCapture(path, { maxBytes, marker, wholeRecords = false }) {
  const markerBytes = Buffer.from(marker);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= markerBytes.length) {
    throw new RangeError("Capture bound must exceed its truncation marker.");
  }
  const previous = `${path}.previous`;
  rmSync(previous, { force: true });
  writeFileSync(path, "");
  let size = 0;
  const rotate = () => {
    renameSync(path, previous);
    writeFileSync(path, markerBytes);
    size = markerBytes.length;
  };
  return (value) => {
    let bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (bytes.length > maxBytes - markerBytes.length) {
      rotate();
      if (wholeRecords) return; // Explicit marker replaces an oversized record.
      bytes = bytes.subarray(bytes.length - (maxBytes - markerBytes.length));
    } else if (size + bytes.length > maxBytes) {
      rotate();
    }
    appendFileSync(path, bytes);
    size += bytes.length;
  };
}

module.exports = { createBoundedCapture };
