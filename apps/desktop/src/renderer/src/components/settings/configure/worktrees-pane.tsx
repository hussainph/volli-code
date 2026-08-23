/**
 * Configure → Worktrees: what a new ticket checkout in this project starts as.
 *
 * Orphan cleanup is NOT here, and that is a boundary rather than a layout
 * choice: `sweepOrphans` walks every project in the db, and its disk-vs-git
 * pass reports directories git no longer attributes to any project at all. It
 * cannot be scoped, so it lives in Settings → Storage. Showing it here would
 * let project A delete project B's uncommitted work.
 *
 * Both fields save on blur through `CommitField`, and the base branch REFUSES
 * a name git would not accept — the branch is what every future worktree is
 * cut from, so a typo here is a project whose next ticket cannot start.
 */
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { TreeStructureIcon } from "@phosphor-icons/react/dist/csr/TreeStructure";
import { isValidBranchName, type Project } from "@volli/shared";

import { Badge } from "@renderer/components/ui/badge";
import {
  CommitField,
  ItemRow,
  PrefRow,
  PrefSection,
  type CommitResult,
} from "@renderer/components/settings/kit";
import { useProjectsStore } from "@renderer/stores/projects";

export function WorktreesPane({ project }: { project: Project }) {
  const updateBaseBranch = useProjectsStore((store) => store.updateBaseBranch);
  const updateSetupCommand = useProjectsStore((store) => store.updateSetupCommand);

  return (
    <>
      <PrefSection title="New worktrees" icon={TreeStructureIcon}>
        <PrefRow label="Branch from" htmlFor="project-base-branch">
          <CommitField
            id="project-base-branch"
            value={project.baseBranch ?? ""}
            placeholder="main"
            width="md"
            // Local, because git's rule is knowable here and a round trip to
            // be told "that is not a branch name" is a round trip wasted.
            validate={(next) =>
              next.trim() === "" || isValidBranchName(next.trim())
                ? null
                : "Not a valid branch name."
            }
            onCommit={async (next): Promise<CommitResult> => {
              const trimmed = next.trim();
              const ok = await updateBaseBranch(project.id, trimmed === "" ? null : trimmed);
              return ok ? { ok: true, value: trimmed } : { ok: false, error: "Couldn't save." };
            }}
          />
        </PrefRow>
        <PrefRow label="Then run" htmlFor="project-setup-command">
          <CommitField
            id="project-setup-command"
            value={project.setupCommand ?? ""}
            placeholder="pnpm install"
            width="lg"
            onCommit={async (next): Promise<CommitResult> => {
              const trimmed = next.trim();
              const ok = await updateSetupCommand(project.id, trimmed === "" ? null : trimmed);
              return ok ? { ok: true, value: trimmed } : { ok: false, error: "Couldn't save." };
            }}
          />
        </PrefRow>
      </PrefSection>

      {/*
       * The copy set, as rows rather than the two paragraphs of prose this
       * replaces. `.worktreeinclude` is not readable from the renderer, so the
       * defaults are stated and the hint carries the one rule that is not
       * obvious — creating the file REPLACES them rather than extending them.
       */}
      <PrefSection
        title="Copied files"
        icon={TerminalWindowIcon}
        hint={<>A .worktreeinclude file in your repo replaces these defaults.</>}
        action={
          <span className="text-ui text-muted-foreground">
            <PlusIcon aria-hidden className="inline size-3.5" /> .worktreeinclude
          </span>
        }
      >
        <ItemRow name=".env*" badges={<Badge variant="outline">Default</Badge>} />
        <ItemRow
          name=".claude/settings.local.json"
          badges={<Badge variant="outline">Default</Badge>}
        />
      </PrefSection>
    </>
  );
}
