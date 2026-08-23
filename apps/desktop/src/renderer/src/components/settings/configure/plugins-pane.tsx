/**
 * Configure → Plugins — designed, not yet plumbed, and less decided than MCP.
 *
 * MCP at least has a specification to build against. A plugin here would be a
 * bundle of skills and commands updated together, and nothing about it is
 * settled: no format, no manifest, no store, no source. Listing it is a
 * roadmap entry, so the pane says exactly that and offers nothing to press.
 *
 * It stays on the rail rather than being hidden until the day it lands,
 * because the neighbouring categories only make sense as a set: Skills and
 * Commands are the things a plugin would BE a bundle of, and a reader looking
 * at those two should be able to see where the third goes.
 */
import { PuzzlePieceIcon } from "@phosphor-icons/react/dist/csr/PuzzlePiece";

import {
  Cell,
  DataTable,
  PrefSection,
  SectionAction,
  Unavailable,
} from "@renderer/components/settings/kit";

/** The shape a plugin row will have. Empty today — see the module header. */
interface Plugin {
  name: string;
  contents: string;
  scope: string;
}

const NO_PLUGINS: readonly Plugin[] = [];

export function PluginsPane() {
  return (
    <Unavailable
      fill
      what="Plugins"
      meanwhile="To add capabilities now, put skills in .agents/skills and commands in .volli/commands."
    >
      <PrefSection
        fill
        title="Installed plugins"
        icon={PuzzlePieceIcon}
        hint={<>A bundle of skills and commands, updated together.</>}
        action={<SectionAction label="Browse…" />}
      >
        <DataTable
          label="Installed plugins"
          items={NO_PLUGINS}
          keyOf={(plugin) => plugin.name}
          rows="fill"
          empty="No plugins installed."
          columns={[
            { key: "name", header: "Plugin", cell: (plugin) => <Cell>{plugin.name}</Cell> },
            {
              key: "contents",
              header: "Contents",
              width: "11rem",
              cell: (plugin) => <Cell muted>{plugin.contents}</Cell>,
            },
            {
              key: "source",
              header: "Source",
              width: "7rem",
              cell: (plugin) => <Cell muted>{plugin.scope}</Cell>,
            },
          ]}
        />
      </PrefSection>
    </Unavailable>
  );
}
