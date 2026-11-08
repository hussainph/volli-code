/** Additive stop receipt. Keep the evidence path and the actual cleanup facts
 * distinct: a path alone cannot prove a graceful close or clean guard record.
 */
export function stopResult(manifest, { manifestPath, evidence }) {
  return {
    manifest: manifestPath,
    evidence,
    leftovers: manifest?.leftovers ?? [],
    cleanup: manifest,
  };
}
