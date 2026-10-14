/** Durable discovery receipts live on the message itself, in Pi's JSON sidecar.
 * No separate marker can lag a successful append. Pi preserves message extras;
 * the receipt is not prompt content and changes no provider prefix bytes.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SystemMessage } from "@earendil-works/pi-ai";
import type { RuntimeToolRefreshAnnouncement } from "@volli/shared";
import { MCP_UNTRUSTED_DATA_WARNING } from "./tools";

export type ToolRefreshMessage = SystemMessage & { volliToolRefreshId?: string };

export function toolRefreshId(message: AgentMessage): string | undefined {
  if (message.role !== "system") return undefined;
  const id = (message as ToolRefreshMessage).volliToolRefreshId;
  return typeof id === "string" ? id : undefined;
}

export function toolRefreshMessage(
  namespaces: RuntimeToolRefreshAnnouncement["namespaces"],
  timestamp: number,
  id?: string,
): ToolRefreshMessage {
  return {
    role: "system",
    timestamp,
    ...(id === undefined ? {} : { volliToolRefreshId: id }),
    content: `Tools added through Code Mode: ${namespaces
      .map(({ name, count }) => `${name} (${count})`)
      .join(", ")}. Find them with searchTools() and describeTool().${
      namespaces.some(({ name }) => name.startsWith("mcp:")) ? ` ${MCP_UNTRUSTED_DATA_WARNING}` : ""
    }`,
  };
}
