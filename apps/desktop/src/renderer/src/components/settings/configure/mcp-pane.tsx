/**
 * Configure → MCP Servers — designed, not yet plumbed.
 *
 * `grep -rn "mcp" apps/desktop/src/main/` finds nothing. What stands between
 * this layout and a working pane is a per-project config reader, a stdio
 * spawner, an HTTP client, a per-server tools cache, health monitoring, IPC
 * for list/add/remove/start/stop — and, the actual work, Agent Runtime
 * injection of those tools into the model's tool set. Days, not hours.
 *
 * So it ships inert (see `kit/unavailable.tsx`): the shape is visible, nothing
 * in it can be operated, and the notice says so before anyone waits on it.
 * The table renders its genuine empty state rather than plausible fake
 * servers — a fixture here would be indistinguishable from real servers that
 * had gone wrong, and someone would screenshot it.
 *
 * THE ASYMMETRY WORTH KNOWING. Web search is app-wide (one account, one key)
 * while this is per-project (a process and a config file per repo). That is
 * deliberate, and the hint below points at the other surface so nobody hunts
 * for a search provider in here. If per-project web keys are ever wanted,
 * this is the seam that moves.
 */
import { PlugsConnectedIcon } from "@phosphor-icons/react/dist/csr/PlugsConnected";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";

import {
  Cell,
  DataTable,
  PrefSection,
  SectionAction,
  Unavailable,
} from "@renderer/components/settings/kit";

/** The shape a server row will have. Empty today — see the module header. */
interface Server {
  name: string;
  tools: string;
  scope: string;
  status: string;
}

const NO_SERVERS: readonly Server[] = [];

export function McpPane() {
  return (
    <Unavailable
      fill
      what="MCP servers"
      meanwhile="Agents can already read, edit, write, and run commands without MCP."
    >
      <PrefSection
        fill
        title="Servers"
        icon={PlugsConnectedIcon}
        hint={<>Web search applies to every project. Change it in Settings.</>}
        action={<SectionAction label="Add server" icon={PlusIcon} />}
      >
        <DataTable
          label="MCP servers"
          items={NO_SERVERS}
          keyOf={(server) => server.name}
          rows="fill"
          empty="No MCP servers yet."
          columns={[
            { key: "name", header: "Server", cell: (server) => <Cell>{server.name}</Cell> },
            {
              key: "tools",
              header: "Tools",
              width: "6rem",
              cell: (server) => <Cell muted>{server.tools}</Cell>,
            },
            {
              key: "source",
              header: "Source",
              width: "7rem",
              cell: (server) => <Cell muted>{server.scope}</Cell>,
            },
            {
              key: "status",
              header: "Status",
              width: "8rem",
              cell: (server) => <Cell muted>{server.status}</Cell>,
            },
          ]}
        />
      </PrefSection>
    </Unavailable>
  );
}
