/** Durable discovery receipts live on the message itself, in Pi's JSON sidecar.
 * No separate marker can lag a successful append. Pi preserves message extras;
 * the receipt is not prompt content. Collapse-prone models defer the message
 * until a cold boundary, because pi-ai would fold it into the leading prompt.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, SystemMessage } from "@earendil-works/pi-ai";
import type { RuntimeToolRefreshAnnouncement } from "@volli/shared";
import { MCP_UNTRUSTED_DATA_WARNING } from "./tools";

export type ToolRefreshMessage = SystemMessage & { volliToolRefreshId?: string };

/** Same opt-in as pi-ai's resolveTranscript; absent/unknown compatibility is cold-only.
 * Google/Vertex have no compat declaration; Bedrock's compat has no such flag.
 * Never infer support from a model id or provider name.
 */
export function canAnnounceToolRefresh(model: Pick<Model<Api>, "compat">, warm: boolean): boolean {
  const compat = model.compat;
  return (
    !warm ||
    (compat !== undefined &&
      "supportsMidConvoSystemMessages" in compat &&
      compat.supportsMidConvoSystemMessages === true)
  );
}

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
