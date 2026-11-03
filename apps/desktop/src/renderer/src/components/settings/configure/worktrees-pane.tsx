/** Creation defaults keep real project writes; branch options come from the host, never fixtures. */
import * as React from "react";
import { FileCodeIcon } from "@phosphor-icons/react/dist/csr/FileCode";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { TreeStructureIcon } from "@phosphor-icons/react/dist/csr/TreeStructure";
import type { Project, WorktreeBranchListing } from "@volli/shared";
import {
  PrefRow,
  PrefSection,
  ItemRow,
  SectionIconAction,
} from "@renderer/components/settings/kit";
import { Button } from "@renderer/components/ui/button";
import { Textarea } from "@renderer/components/ui/textarea";
import { LoadingLabel } from "@renderer/components/ui/loading-label";
import { Notice } from "@renderer/components/ui/notice";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { useProjectsStore } from "@renderer/stores/projects";
import { openProjectSettingFile } from "../open-project-setting-file";

export function WorktreesPane({ project }: { project: Project }) {
  const updateBaseBranch = useProjectsStore((s) => s.updateBaseBranch);
  const updateSetupCommand = useProjectsStore((s) => s.updateSetupCommand);
  const [listing, setListing] = React.useState<WorktreeBranchListing | null>(null);
  const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading");
  const [revision, reload] = React.useReducer((n) => n + 1, 0);
  const [draft, setDraft] = React.useState(project.setupCommand ?? "");
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => {
    setDraft(project.setupCommand ?? "");
  }, [project.id, project.setupCommand]);
  React.useEffect(() => {
    let current = true;
    setStatus("loading");
    setListing(null);
    void (async () => {
      try {
        const result = await window.api.worktree.branches(project.id);
        if (!current) return;
        if (!result.ok) throw new Error("Unavailable");
        setListing(result);
        setStatus("ready");
      } catch {
        if (current) setStatus("error");
      }
    })();
    return () => {
      current = false;
    };
  }, [project.id, revision]);
  const branches = Array.from(
    new Set(
      [project.baseBranch, ...(listing?.branches ?? []), ...(listing?.remotes ?? [])].filter(
        (v): v is string => Boolean(v),
      ),
    ),
  );
  const dirty = draft !== (project.setupCommand ?? "");
  return (
    <>
      <PrefSection
        title="New worktrees"
        icon={TreeStructureIcon}
        action={
          <SectionIconAction label="Refresh branches" busy={status === "loading"} onAct={reload} />
        }
      >
        <PrefRow
          label="Branch from"
          icon={TreeStructureIcon}
          htmlFor="project-base-branch"
          description="New ticket checkouts start from this branch."
        >
          <Select
            value={project.baseBranch ?? "__default"}
            disabled={status !== "ready" || saving}
            onValueChange={(next) => {
              setSaving(true);
              void updateBaseBranch(project.id, next === "__default" ? null : next).finally(() =>
                setSaving(false),
              );
            }}
          >
            <SelectTrigger id="project-base-branch" className="w-56 max-w-full">
              <SelectValue>
                {project.baseBranch ?? listing?.current ?? "Current branch"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default">
                {listing?.current ? `Current branch · ${listing.current}` : "Current branch"}
              </SelectItem>
              {branches.map((branch) => (
                <SelectItem key={branch} value={branch}>
                  {branch}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {status === "loading" ? <LoadingLabel>Reading branches</LoadingLabel> : null}
        </PrefRow>
        {status === "error" ? (
          <Notice
            className="m-4"
            tone="error"
            announce
            title="Couldn’t read branches"
            actions={
              <Button size="sm" variant="outline" onClick={reload}>
                Retry branch read
              </Button>
            }
          />
        ) : null}
        <div className="space-y-2 border-t border-border px-4 py-4" data-slot="pref-row">
          <label
            data-slot="pref-row-label"
            htmlFor="project-setup-command"
            className="flex items-center gap-2 text-ui font-medium"
          >
            <TerminalWindowIcon aria-hidden className="size-4 text-muted-foreground" />
            Setup command
          </label>
          <p className="text-ui text-muted-foreground">
            Runs in each new worktree before its first session.
          </p>
          <Textarea
            id="project-setup-command"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="pnpm install"
            spellCheck={false}
            className="min-h-24 font-mono text-ui"
            disabled={saving}
          />
          <div className="flex items-center justify-end gap-2">
            {dirty && <span className="text-label text-muted-foreground">Unsaved</span>}
            <Button
              size="sm"
              variant="outline"
              disabled={!dirty || saving}
              onClick={() => {
                setSaving(true);
                void updateSetupCommand(project.id, draft.trim() || null).finally(() =>
                  setSaving(false),
                );
              }}
            >
              {saving ? <LoadingLabel>Saving</LoadingLabel> : "Save command"}
            </Button>
          </div>
        </div>
      </PrefSection>
      <PrefSection
        title="Copied files"
        icon={FileCodeIcon}
        hint={<>A .worktreeinclude file replaces these defaults.</>}
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => openProjectSettingFile(project.id, ".worktreeinclude")}
          >
            <FileCodeIcon />
            Edit .worktreeinclude
          </Button>
        }
      >
        <ItemRow name=".env*" leading={<FileCodeIcon className="size-4" />} meta="Default" />
        <ItemRow
          name=".claude/settings.local.json"
          leading={<FileCodeIcon className="size-4" />}
          meta="Default"
        />
      </PrefSection>
    </>
  );
}
