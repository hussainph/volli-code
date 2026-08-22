/**
 * Configure → Sessions: what a new Session in this project starts as.
 *
 * The two rows here are the redesign's worked example of `OverrideControl`.
 * Neither carries a scope switch: the surface already says "this project", so
 * the only thing left to say is whether a row has diverged from the app-wide
 * value — which the revert button says, on exactly the rows where it is true.
 *
 * `null` means inherit, and the override IS the presence of a value. There is
 * no separate mode flag, which is what let an earlier pass's two pills per row
 * disappear entirely.
 *
 * Harness inventory lives in Settings → About, not here: a project cannot
 * register or revoke a harness, so the LIST is app-wide and only the CHOICE is
 * scoped. Inlining the picker's second view here is what retires
 * `harness-settings.tsx`.
 */
import * as React from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { BookOpenIcon } from "@phosphor-icons/react/dist/csr/BookOpen";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { DEFAULT_HARNESS_ID, harnessLabel, type Project } from "@volli/shared";

import { useHarnessListings } from "@renderer/components/pages/harness-picker";
import {
  CONTROL_W,
  ItemRow,
  OverrideControl,
  PrefRow,
  PrefSection,
  SectionAction,
} from "@renderer/components/settings/kit";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { writeThrough } from "@renderer/stores/mutate";
import { useProjectsStore } from "@renderer/stores/projects";

export function SessionsPane({ project }: { project: Project }) {
  const listings = useHarnessListings();
  const adoptProject = useProjectsStore((store) => store.adoptProject);
  const [saving, setSaving] = React.useState(false);

  const harness = project.sessionHarness ?? null;
  const model = project.sessionModel ?? null;
  const inheritedHarness = harnessLabel(DEFAULT_HARNESS_ID);

  async function save(next: { harness: string | null; model: typeof model }): Promise<void> {
    if (saving) return;
    setSaving(true);
    const saved = await writeThrough("save this project's session defaults", () =>
      window.api.projects.setSessionDefaults({ id: project.id, ...next }),
    );
    setSaving(false);
    if (saved !== null) adoptProject(saved.project);
  }

  return (
    <>
      <PrefSection
        title="New sessions"
        icon={CpuIcon}
        // The precedence table, as one hint rather than a paragraph under the
        // header — available to whoever wants it, invisible to everyone else.
        hint={<>Composer choice wins, then this project, then Settings.</>}
      >
        <PrefRow label="Harness" htmlFor="project-harness" testId="project-session-harness">
          <OverrideControl
            label="Harness"
            inheritedValue={inheritedHarness}
            overridden={harness !== null}
            onRevert={() => void save({ harness: null, model })}
          >
            <Select
              value={harness ?? DEFAULT_HARNESS_ID}
              disabled={saving}
              onValueChange={(next) => void save({ harness: next, model })}
            >
              <SelectTrigger id="project-harness" className={CONTROL_W.md}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {listings.map((listing) => (
                  <SelectItem key={listing.id} value={listing.id}>
                    {listing.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </OverrideControl>
        </PrefRow>

        {/*
         * The model row is deliberately NOT a picker yet.
         *
         * A per-project model needs the catalogue, which lives behind the
         * Model Access client and is an async read this pane does not do. The
         * COLUMN is real and writable (migration 023) — what is missing is the
         * list to choose from. Showing an empty picker would be worse than
         * showing where the setting will be, so the row states what it
         * resolves to and the revert works for a value set elsewhere.
         */}
        <PrefRow label="Model" testId="project-session-model">
          <OverrideControl
            label="Model"
            inheritedValue="the app-wide default"
            overridden={model !== null}
            onRevert={() => void save({ harness, model: null })}
          >
            <span className="text-ui text-muted-foreground">
              {model === null ? "From Settings → Models" : `${model.modelId} · ${model.providerId}`}
            </span>
          </OverrideControl>
        </PrefRow>
      </PrefSection>

      <PrefSection
        title="Instructions"
        icon={BookOpenIcon}
        hint={<>Read before every session&rsquo;s first turn.</>}
        action={
          <SectionAction
            label="Reveal"
            icon={ArrowSquareOutIcon}
            onAct={() => void reveal(`${project.path}/AGENTS.md`)}
          />
        }
      >
        <ItemRow name="AGENTS.md" meta="repo root" />
        <ItemRow name="CLAUDE.md" meta="repo root" />
      </PrefSection>
    </>
  );
}

async function reveal(path: string): Promise<void> {
  await writeThrough("reveal the file", () => window.api.fs.revealInFinder(path));
}
