/** Session-owned correlation context; a native call id alone cannot identify a call. */
export interface SessionToolCallScope {
  attachmentId: string;
  turnId: string;
}

export const SESSION_TOOL_CALL_SCOPE_METADATA_KEY = "volli.tool-call-scope";

/** Read portable transcript metadata without trusting its shape or native id format. */
export function readSessionToolCallScope(metadata: unknown): SessionToolCallScope | null {
  try {
    if (!isPlainRecord(metadata)) return null;
    const scope = metadata[SESSION_TOOL_CALL_SCOPE_METADATA_KEY];
    if (!isPlainRecord(scope)) return null;
    const { attachmentId, turnId } = scope;
    if (
      typeof attachmentId !== "string" ||
      attachmentId.length === 0 ||
      typeof turnId !== "string" ||
      turnId.length === 0
    ) {
      return null;
    }
    return { attachmentId, turnId };
  } catch {
    // Unknown inputs can include throwing accessors or revoked proxies.
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
