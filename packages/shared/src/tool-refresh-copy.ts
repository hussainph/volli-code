/** Versioned tool copy: a warm reattach must still render the birth wording. */
import { verbEntry, type VerbToolKey } from "./verb-registry";

const INSTALL_OLD =
  "The tools you select do NOT appear in this Session. A Session's tool list is frozen when it is created, so they become usable in the next Session created after the install.";
const INSTALL_NEW =
  "Selected tools routed only through Code Mode become usable in this Session before the next program, announced in an appended message. Other additions arrive when the prompt cache is cold, at compaction or at a model switch. Existing tools are never removed.";

/** The existing declarations changed by this versioned, schema-preserving copy update. */
export const REFRESH_DESCRIPTION_TOOL_IDS = [
  "mcp.install",
  "mcp.enable",
  "mcp.disable",
  "mcp.tools",
  "mcp.remove",
  "session.delegate",
] as const;

/** Preserve legacy description bytes until a new birth or a compatible cold refresh. */
export function sessionVerbToolDescription(
  key: VerbToolKey,
  refreshCopy?: true,
): string | undefined {
  const description = verbEntry(key)?.tool?.description;
  if (description === undefined || refreshCopy !== true) return description;
  switch (key) {
    case "mcp.install":
      return description.replace(INSTALL_OLD, INSTALL_NEW);
    case "mcp.enable":
      return description
        .replace(
          "so its selected tools are offered to Sessions created after this call.",
          "so its selected tools are available to new Sessions and as additions to existing Sessions.",
        )
        .replace(
          "It connects to nothing, and it does not change any Session that already exists.",
          "It connects to nothing. Code-Mode-only additions arrive before the next program; other additions wait for a cold cache, compaction or a model switch.",
        );
    case "mcp.disable":
      return description.replace("tools they were born with", "tools they already hold");
    case "mcp.tools":
      return description.replace(
        "Sessions created after this call get the new selection; existing Sessions are unchanged.",
        "New Sessions get the selection. Existing Sessions keep every tool they already hold and gain additions: code-only tools before the next program, other tools at a cold cache, compaction or a model switch.",
      );
    case "mcp.remove":
      return description.replace(
        "Any older Session that was born holding one of this server's tools will fail to reattach afterwards, because the transport its frozen tool needs is gone.",
        "Sessions keep their tool names and can still reattach, but calls to this server's tools return a named unavailable error.",
      );
    case "session.delegate":
      return `${description} A delegate inherits this Session's current recorded MCP tools, including refreshed additions, not the project's later selection. A running delegate gains additions by the same cache-safe rules, bounded by its parent.`;
    default:
      return description;
  }
}
