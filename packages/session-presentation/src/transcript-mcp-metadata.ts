import type { McpServerRecord, McpToolDefinition } from "@volli/shared";
import type { ChatSessionFrame } from "./transcript";
import { humanToolName } from "./tool-presentation";

/** Display metadata joins by exact recorded MCP identity, never by a guessed hash. */
export function transcriptMcpNames(
  frames: readonly ChatSessionFrame[],
  servers: readonly McpServerRecord[],
): ReadonlyMap<string, { server: string; tool: string; url: string | null }> {
  const names = new Map<string, { server: string; tool: string; url: string | null }>();
  const byId = new Map(servers.map((server) => [server.id, server]));
  const add = (definition: McpToolDefinition) => {
    const server = byId.get(definition.serverId);
    if (!server) return;
    const catalog = server.catalog.find((tool) => tool.name === definition.toolName);
    names.set(definition.providerName, {
      server: server.name,
      tool: catalog?.hints?.title ?? humanToolName(definition.toolName),
      url: server.transport.type === "streamable-http" ? server.transport.url : null,
    });
  };
  for (const server of servers)
    for (const tool of server.catalog) if (tool.definition) add(tool.definition);
  // Renderer refresh facts deliberately omit MCP definitions. An old renamed
  // alias without its birth definition stays on the recorded-name fallback;
  // joining a guessed provider hash would attribute it to an unproven server.
  for (const frame of frames) {
    const payload = frame.event?.payload;
    const definitions =
      payload?.kind === "session.input.recorded" && payload.input.kind === "tool-surface"
        ? payload.input.mcpTools
        : undefined;
    for (const definition of definitions ?? []) add(definition);
  }
  return names;
}
