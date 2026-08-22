/**
 * Configure → Commands: the `/name` prompt templates this project can run.
 *
 * A table rather than a stack of rows for `DataTable`'s stated reason — it is
 * a homogeneous collection with a shared attribute (which tier it came from),
 * and that attribute belongs in a column where it aligns, not in a pill
 * repeated down every line.
 *
 * The list is already merged project-over-personal by the reader, so a name
 * appears once. Which tier won it is what Source says.
 */
import { CommandIcon } from "@phosphor-icons/react/dist/csr/Command";
import type { Project, PromptTemplate } from "@volli/shared";

import { AsyncSection, Cell, DataTable } from "@renderer/components/settings/kit";
import { useAgentIndex } from "@renderer/components/settings/use-agent-index";

import { NewCommandDialog } from "./new-command-dialog";

export function CommandsPane({ project }: { project: Project }) {
  const { state, reload } = useAgentIndex(project.id);

  return (
    <AsyncSection
      title="Commands"
      icon={CommandIcon}
      hint={<>Type the name in any composer. Project overrides personal.</>}
      action={<NewCommandDialog projectId={project.id} onCreated={reload} />}
      state={state}
      isEmpty={(data) => data.templates.length === 0}
      empty="No commands yet."
    >
      {(data) => <CommandsTable templates={data.templates} />}
    </AsyncSection>
  );
}

/**
 * NO SOURCE COLUMN, and that is an honest gap rather than an oversight.
 *
 * `loadPromptTemplates` merges the two tiers and hands back a list with no
 * tier on it, so which directory won a name is genuinely not recoverable here.
 * The Skills table beside this one CAN say it, because a skill carries its own
 * root path; a template carries only name, description and content.
 *
 * Making it knowable means widening `PromptTemplate`, whose shape
 * `prompt-template-parity.test.ts` pins against Pi's own. Worth doing — and
 * not worth doing quietly inside a redesign, so the column is absent rather
 * than guessing.
 */
function CommandsTable({ templates }: { templates: readonly PromptTemplate[] }) {
  return (
    <DataTable
      label="Commands available to this project"
      items={templates}
      keyOf={(command) => command.name}
      rows={8}
      search={(command) => `${command.name} ${command.description}`}
      placeholder="Search commands"
      empty="No commands yet."
      noResults="No commands match."
      columns={[
        {
          key: "name",
          header: "Command",
          width: "10rem",
          cell: (command) => <Cell>/{command.name}</Cell>,
        },
        {
          key: "description",
          header: "Description",
          cell: (command) => <Cell muted>{command.description || "No description"}</Cell>,
        },
      ]}
    />
  );
}
