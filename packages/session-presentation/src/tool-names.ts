/** Display-only fallback; exact MCP identity always comes from recorded metadata. */
function legacyMcpName(name: string): { server: string; tool: string } | null {
  const end = name.length;
  for (let index = 5; index < end; index += 1) {
    const code = name.charCodeAt(index);
    if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) return null;
  }
  // Preserve the first nonempty legacy split, including overlapping `__`.
  const delimiter = name.indexOf("__", 6);
  const toolStart = delimiter + 2;
  if (delimiter < 0 || toolStart >= end) return null;
  let toolEnd = end;
  const suffix = end - 10;
  if (suffix > toolStart && name.startsWith("__", suffix)) {
    let hex = true;
    for (let index = end - 8; index < end; index += 1) {
      const code = name.charCodeAt(index);
      if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102))) {
        hex = false;
        break;
      }
    }
    if (hex) toolEnd = suffix;
  }
  return { server: name.slice(5, delimiter), tool: name.slice(toolStart, toolEnd) };
}

export function humanToolName(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase())
    .replace(/\b(api|url|sql)\b/gi, (word) => word.toUpperCase());
}

/** Shared by the activity fallback and specialized MCP rows, never an identity join. */
export function humanMcpToolName(name: string): { server: string; tool: string } {
  const legacy = legacyMcpName(name);
  return {
    server: legacy ? humanToolName(legacy.server) : "MCP server",
    tool: legacy ? humanToolName(legacy.tool) : "Tool",
  };
}
