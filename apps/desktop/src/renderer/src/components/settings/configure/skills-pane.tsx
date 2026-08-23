/**
 * Configure → Skills: what this project's agents can reach, and what they are
 * told about unprompted.
 *
 * THE MODE COLUMN IS THE POINT OF THIS PANE. A fresh Session's Volli-composed
 * prompt measures ~10,400 tokens and ~9,800 of them are the metadata-only
 * skills index — one name/path/description row per disclosed skill, re-sent as
 * the stable prefix of *every* turn. So a skill is not free merely because it
 * is unused; being *discoverable* is what it charges for.
 *
 * That makes three states, not a switch:
 *
 *   Auto     in the index. The model finds it without being asked.
 *   Manual   out of the index, still `/slug`-invokable. Costs nothing idle.
 *   Off      gone.
 *
 * A `Select` rather than three pills: `docs/DESIGN.md` reserves the pill for a
 * control that acts, and this is one-of-N repeated down a column, where a
 * segmented control per row would be the second control language `ui/segmented`
 * warns against.
 *
 * Writes are optimistic and the whole map goes at once — the surface holds
 * every rule on screen, so a per-row write would turn one visible state into N
 * that can land out of order.
 */
import * as React from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { BookOpenIcon } from "@phosphor-icons/react/dist/csr/BookOpen";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import {
  resolveSkillMode,
  type Project,
  type SkillMode,
  type SkillModes,
  type SkillReference,
} from "@volli/shared";

import {
  AsyncSection,
  CONTROL_W,
  Cell,
  DataTable,
  RowAction,
  SectionAction,
} from "@renderer/components/settings/kit";
import { useAgentIndex } from "@renderer/components/settings/use-agent-index";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { writeThrough } from "@renderer/stores/mutate";
import { useProjectsStore } from "@renderer/stores/projects";

/** What each mode is called, and the one line explaining what it costs. */
const MODE_LABEL: Record<SkillMode, string> = {
  auto: "Auto",
  manual: "Manual",
  off: "Off",
};

/**
 * A skill's tier, read off the root path the loader spelled. Project skills are
 * workspace-relative (`.agents/skills/…`); personal ones are absolute.
 */
function skillScope(skill: SkillReference): "project" | "personal" {
  return skill.root.startsWith(".") ? "project" : "personal";
}

export function SkillsPane({ project }: { project: Project }) {
  const { state, reload } = useAgentIndex(project.id);
  const [filter, setFilter] = React.useState("all");

  return (
    <AsyncSection
      title="Skills"
      icon={BookOpenIcon}
      hint={
        <>
          Auto costs prompt budget every turn. Manual keeps <code>/name</code> working.
        </>
      }
      action={<SectionAction label="Reload" icon={FolderOpenIcon} onAct={reload} />}
      fill
      state={state}
      isEmpty={(data) => data.skills.length === 0}
      empty="No skills yet. Add one to .agents/skills."
    >
      {(data) => (
        <SkillsTable project={project} skills={data.skills} filter={filter} onFilter={setFilter} />
      )}
    </AsyncSection>
  );
}

/**
 * The modes map after ruling `slugs`.
 *
 * `auto` DELETES rather than storing "auto", because the map holds only
 * departures from the frontmatter default — storing the default would make
 * "never touched" and "set back to normal" two states that behave alike and
 * read differently.
 *
 * Pure, and at module scope so one bulk write and one row write share exactly
 * the same rule rather than two that agree today.
 */
function ruled(current: SkillModes, slugs: readonly string[], mode: SkillMode): SkillModes {
  const targeted = new Set(slugs);
  const kept = Object.entries(current).filter(([key]) => !targeted.has(key));
  return mode === "auto"
    ? Object.fromEntries(kept)
    : { ...Object.fromEntries(kept), ...Object.fromEntries(slugs.map((slug) => [slug, mode])) };
}

function SkillsTable({
  project,
  skills,
  filter,
  onFilter,
}: {
  project: Project;
  skills: readonly SkillReference[];
  filter: string;
  onFilter: (next: string) => void;
}) {
  const adoptProject = useProjectsStore((store) => store.adoptProject);
  // Optimistic: the control IS the state, and a Select that waits a round trip
  // to move reads as one that did not take. The write's answer settles it.
  const [pending, setPending] = React.useState<SkillModes | null>(null);
  const modes = pending ?? project.skillModes ?? {};

  const shown = React.useMemo(
    () => (filter === "all" ? skills : skills.filter((skill) => skillScope(skill) === filter)),
    [skills, filter],
  );

  async function write(next: SkillModes): Promise<void> {
    setPending(next);
    const saved = await writeThrough("update this project's skills", () =>
      window.api.projects.setSkillModes({ id: project.id, modes: next }),
    );
    setPending(null);
    if (saved !== null) adoptProject(saved.project);
  }

  const setMode = (slug: string, mode: SkillMode): Promise<void> =>
    write(ruled(modes, [slug], mode));

  /**
   * ONE write for the whole set, not one per skill. Sixty sequential round
   * trips would leave the table visibly rippling, and any failure among them
   * would strand the project half-ruled with no way to say which half.
   */
  const setAllModes = (targets: readonly SkillReference[], mode: SkillMode): Promise<void> =>
    write(
      ruled(
        modes,
        targets.map((skill) => skill.name),
        mode,
      ),
    );

  return (
    <DataTable
      label="Skills available to this project"
      items={shown}
      keyOf={(skill) => `${skillScope(skill)}/${skill.name}`}
      rows="fill"
      search={(skill) => `${skill.name} ${skill.description}`}
      placeholder="Search skills"
      bulk={(matched) => <BulkMode skills={matched} onApply={setAllModes} />}
      filter={{
        label: "Filter by source",
        value: filter,
        isFiltering: filter !== "all",
        onChange: onFilter,
        options: [
          { value: "all", label: "All sources" },
          { value: "project", label: "This project" },
          { value: "personal", label: "Personal" },
        ],
      }}
      empty="No skills yet. Add one to .agents/skills."
      noResults="No skills match."
      columns={[
        { key: "name", header: "Skill", width: "20%", cell: (skill) => <Cell>{skill.name}</Cell> },
        {
          key: "description",
          header: "Description",
          cell: (skill) => <Cell muted>{skill.description}</Cell>,
        },
        {
          key: "source",
          header: "Source",
          width: "7rem",
          cell: (skill) => (
            <Cell muted>{skillScope(skill) === "project" ? "This project" : "Personal"}</Cell>
          ),
        },
        {
          key: "open",
          header: "Open",
          width: "2.5rem",
          align: "end",
          headerHidden: true,
          cell: (skill) => (
            <RowAction
              label={`Reveal ${skill.name} in Finder`}
              hint="Reveal in Finder"
              icon={ArrowSquareOutIcon}
              onAct={() => void revealSkill(project, skill)}
            />
          ),
        },
        {
          key: "mode",
          header: "Mode",
          width: "6.5rem",
          align: "end",
          cell: (skill) => (
            <Select
              value={resolveSkillMode(modes, skill)}
              onValueChange={(next) => void setMode(skill.name, next as SkillMode)}
            >
              <SelectTrigger
                size="sm"
                className={CONTROL_W.sm}
                // The scope is named, because a PERSONAL skill ruled from a
                // project page is otherwise ambiguous: off here, or off
                // everywhere? This one writes to the project.
                aria-label={`${skill.name} in this project`}
                data-testid={`skill-mode-${skill.name}`}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["auto", "manual", "off"] as const).map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {MODE_LABEL[mode]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ),
        },
      ]}
    />
  );
}

/** Opens the skill's own directory. The file is the real interface to a skill. */
async function revealSkill(project: Project, skill: SkillReference): Promise<void> {
  const path = skill.root.startsWith(".") ? `${project.path}/${skill.root}` : skill.root;
  await writeThrough("reveal the skill", () => window.api.fs.revealInFinder(path));
}

/**
 * Set the mode of every skill the table is currently listing.
 *
 * A SELECT THAT DOES NOT KEEP ITS VALUE. It reads "Set all to…" again the
 * moment it has acted, because it is a verb, not a setting: the rows below
 * hold the state, and a bulk control left sitting on "Manual" would claim a
 * uniformity that the next single-row change immediately breaks.
 *
 * The count is in the label, and it counts what is ON SCREEN — filter a source
 * or type in the search and this narrows with it, so "all" always means the
 * rows you can see.
 */
function BulkMode({
  skills,
  onApply,
}: {
  skills: readonly SkillReference[];
  onApply: (targets: readonly SkillReference[], mode: SkillMode) => Promise<void>;
}) {
  const [busy, setBusy] = React.useState(false);
  const label = `Set all ${skills.length} to…`;

  return (
    <Select
      value=""
      disabled={busy || skills.length === 0}
      onValueChange={(next) => {
        setBusy(true);
        void onApply(skills, next as SkillMode).finally(() => setBusy(false));
      }}
    >
      <SelectTrigger size="sm" className={CONTROL_W.md} aria-label={label}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {(["auto", "manual", "off"] as const).map((mode) => (
          <SelectItem key={mode} value={mode}>
            {MODE_LABEL[mode]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
