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
 * EACH PROJECT MODE IS THE COMPLETE MATRIX (VC-181): Auto opens model and user
 * routes, Manual keeps only the user routes, and Off closes both. An author's
 * `user-invocable: false` is the fourth, model-only combination only while the
 * Project has no rule. Settings displays that state as “Model only (author)”;
 * choosing any real mode then overrides both axes rather than preserving a
 * hidden author veto.
 *
 * A `Select` rather than three pills: `docs/DESIGN.md` reserves the pill for a
 * control that acts, and this is one-of-N repeated down a column, where a
 * segmented control per row would be the second control language `ui/segmented`
 * warns against.
 *
 * Writes are optimistic and the whole map goes at once — the surface holds
 * every rule on screen, so a per-row write would turn one visible state into N
 * that can land out of order.
 *
 * THE LIST IS UNRULED (`ruled: false`). Every installed skill is a row here,
 * `off` ones included — this pane is where a rule is changed, so the ruled
 * read the composer takes would make `off` a one-way door: the skill would
 * vanish from the only surface able to turn it back on.
 */
import * as React from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { BookOpenIcon } from "@phosphor-icons/react/dist/csr/BookOpen";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import {
  AUTHOR_MODEL_ONLY_MODE,
  authorSkillMode,
  resolveSkillMode,
  skillModeMatchesAuthor,
  SKILL_MODES,
  type Project,
  type SkillMode,
  type SkillModeReadout,
  type SkillModes,
  type SkillReference,
} from "@volli/shared";

import { formatTokens } from "@volli/session-presentation";
import {
  AsyncSection,
  CONTROL_W,
  Cell,
  DataTable,
  RowAction,
  SectionAction,
} from "@renderer/components/settings/kit";
import { useAgentIndex } from "@renderer/components/settings/use-agent-index";
import { skillBodyTokens, skillsIndexTokens } from "./skills-budget";
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
 * The modes a row's picker may offer — all three, for every skill (VC-181).
 *
 * This used to hide "Auto" from a skill whose frontmatter withheld itself from
 * the model, because `parseSkillModes` dropped an `auto` rule and the Select
 * snapped straight back to Manual the moment it was picked. That was the UI
 * working around a storage bug: an override the pane could not keep was an
 * override it had to stop offering. Storage now keeps all three modes, so a
 * project can promote an author-manual skill into its index and the answer
 * holds — which is what "the Project overrides the author in both directions"
 * has to mean to be worth anything.
 */
export function offerableModes(_skill: SkillReference): readonly SkillMode[] {
  return SKILL_MODES;
}

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

  /**
   * The standing charge, in the `(i)` — the popover that answers "what is
   * Auto costing me right now". Live once the list has loaded; before that
   * the hint states the rule without a number rather than a number that lies.
   */
  const indexTokens =
    state.status === "ready"
      ? skillsIndexTokens(state.data.skills, project.skillModes ?? {})
      : null;

  return (
    <AsyncSection
      title="Skills"
      icon={BookOpenIcon}
      hint={
        indexTokens === null ? (
          <>
            Auto costs prompt budget every turn. Manual keeps <code>/name</code> working.
          </>
        ) : (
          <>Auto entries add ~{formatTokens(indexTokens)} tokens to every turn.</>
        )
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
 * The modes map after ruling `targets`.
 *
 * THE MAP HOLDS DEPARTURES, AND THIS IS THE LAYER THAT KNOWS WHAT FROM
 * (VC-181). A rule equal to the skill's own author default is deleted rather
 * than stored, so "never touched" and "set back to what the file says" stay
 * one state; a rule that departs is stored whatever it is, `auto` included.
 *
 * The comparison needs each skill's frontmatter policy, which is exactly why
 * it lives here and not in `parseSkillModes`: the parser reads a project row
 * with no skill list in hand and used to approximate the rule by dropping
 * every `auto`, which threw away the one override that mattered. Minimality is
 * the writer's job because the writer is the layer holding both halves.
 *
 * Pure, and at module scope so one bulk write and one row write share exactly
 * the same rule rather than two that agree today.
 */
export function ruled(
  current: SkillModes,
  targets: readonly SkillReference[],
  mode: SkillModeReadout,
): SkillModes {
  const targeted = new Set(targets.map((skill) => skill.name));
  const kept = Object.entries(current).filter(([key]) => !targeted.has(key));
  if (mode === AUTHOR_MODEL_ONLY_MODE) return Object.fromEntries(kept);
  const departures = targets
    .filter((skill) => !skillModeMatchesAuthor(mode, skill))
    .map((skill) => [skill.name, mode] as const);
  return { ...Object.fromEntries(kept), ...Object.fromEntries(departures) };
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

  const setMode = (skill: SkillReference, mode: SkillModeReadout): Promise<void> =>
    write(ruled(modes, [skill], mode));

  /**
   * ONE write for the whole set, not one per skill. Sixty sequential round
   * trips would leave the table visibly rippling, and any failure among them
   * would strand the project half-ruled with no way to say which half.
   */
  const setAllModes = (targets: readonly SkillReference[], mode: SkillMode): Promise<void> =>
    write(ruled(modes, targets, mode));

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
        {
          key: "name",
          header: "Skill",
          width: "20%",
          cell: (skill) => (
            <Cell strong>
              <span className="inline-flex items-center gap-1">
                {skill.name}
                {/*
                 * A declared policy Volli could not take at face value — two
                 * spellings that disagree, or a flag that is not a boolean.
                 * It belongs on the row rather than in a log because the
                 * symptom is invisible: the skill simply behaves as though the
                 * author had written nothing, and nothing on screen would
                 * otherwise say why.
                 */}
                {skill.policyDiagnostic === null ? null : (
                  <WarningIcon
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-label={`${skill.name}: ${skill.policyDiagnostic}`}
                  >
                    <title>{skill.policyDiagnostic}</title>
                  </WarningIcon>
                )}
              </span>
            </Cell>
          ),
        },
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
          // The skill's own size — what activating it will read into context.
          // An estimate, and marked as one; the honest precision is "pamphlet
          // or book", not a count.
          key: "size",
          header: "Size",
          width: "4.5rem",
          align: "end",
          cell: (skill) => <Cell muted>~{formatTokens(skillBodyTokens(skill))}</Cell>,
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
          width: "8.5rem",
          cell: (skill) => {
            const readout = resolveSkillMode(modes, skill);
            const hasAuthorModelOnly =
              authorSkillMode(skill.authorPolicy) === AUTHOR_MODEL_ONLY_MODE;
            return (
              <Select
                value={readout}
                onValueChange={(next) => void setMode(skill, next as SkillModeReadout)}
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
                  {hasAuthorModelOnly ? (
                    <SelectItem value={AUTHOR_MODEL_ONLY_MODE}>Model only (author)</SelectItem>
                  ) : null}
                  {offerableModes(skill).map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {MODE_LABEL[mode]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            );
          },
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
        {SKILL_MODES.map((mode) => (
          <SelectItem key={mode} value={mode}>
            {MODE_LABEL[mode]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
