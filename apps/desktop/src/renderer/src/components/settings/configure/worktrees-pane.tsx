/** Creation defaults keep real project writes; branch options come from the host, never fixtures. */
import * as React from "react";
import { CodeFileIcon, TerminalIcon, TreeIcon } from "@renderer/components/ui/icon";

import { isValidBranchName, type Project, type WorktreeBranchListing } from "@volli/shared";
import {
  PrefRow,
  PrefSection,
  ItemRow,
  SectionIconAction,
  CommitField,
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
  const [customBranch, setCustomBranch] = React.useState(false);
  const draftRef = React.useRef(draft);
  const accepted = React.useRef(project.setupCommand ?? "");
  const committingSetup = React.useRef(false);
  const saveSetup = React.useCallback(async () => {
    const next = draftRef.current.trim();
    if (committingSetup.current || next === accepted.current.trim()) return;
    committingSetup.current = true;
    setSaving(true);
    try {
      if (await updateSetupCommand(project.id, next || null)) accepted.current = next;
    } finally {
      committingSetup.current = false;
      setSaving(false);
    }
  }, [project.id, updateSetupCommand]);
  React.useEffect(() => {
    if (draftRef.current === accepted.current) {
      draftRef.current = project.setupCommand ?? "";
      setDraft(draftRef.current);
    }
    accepted.current = project.setupCommand ?? "";
  }, [project.setupCommand]);
  // Blur handles pointer navigation; teardown also covers keyboard/deep-link navigation.
  React.useEffect(
    () => () => {
      void saveSetup();
    },
    [saveSetup],
  );
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
        icon={TreeIcon}
        action={
          <SectionIconAction label="Refresh branches" busy={status === "loading"} onAct={reload} />
        }
      >
        <PrefRow label="Branch from" icon={TreeIcon} htmlFor="project-base-branch">
          <Select
            value={project.baseBranch ?? "__default"}
            disabled={saving}
            onValueChange={(next) => {
              if (next === "__custom") {
                setCustomBranch(true);
                return;
              }
              setCustomBranch(false);
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
              <SelectItem value="__custom">Other branch</SelectItem>
            </SelectContent>
          </Select>
          {customBranch ? (
            <CommitField
              ariaLabel="Custom branch"
              value={project.baseBranch ?? ""}
              placeholder="Branch name"
              disabled={saving}
              validate={(next) =>
                !next.trim() || isValidBranchName(next.trim()) ? null : "Not a valid branch name."
              }
              onCommit={async (next) => {
                const trimmed = next.trim();
                const ok = await updateBaseBranch(project.id, trimmed || null);
                if (ok) setCustomBranch(false);
                return ok
                  ? { ok: true, value: trimmed }
                  : { ok: false, error: "Couldn't save branch." };
              }}
            />
          ) : null}
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
            <TerminalIcon aria-hidden className="size-4 text-muted-foreground" />
            Setup command
          </label>
          <Textarea
            id="project-setup-command"
            value={draft}
            onChange={(e) => {
              draftRef.current = e.target.value;
              setDraft(e.target.value);
            }}
            onBlur={() => void saveSetup()}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void saveSetup();
              }
              if (e.key === "Escape") {
                draftRef.current = accepted.current;
                setDraft(accepted.current);
              }
            }}
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
              title="Save command (⌘Enter)"
              onClick={() => void saveSetup()}
            >
              {saving ? <LoadingLabel>Saving</LoadingLabel> : "Save command"}
            </Button>
          </div>
        </div>
      </PrefSection>
      <PrefSection
        title="Copied files"
        icon={CodeFileIcon}
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => openProjectSettingFile(project.id, ".worktreeinclude")}
          >
            <CodeFileIcon />
            Edit .worktreeinclude
          </Button>
        }
      >
        <ItemRow name=".env*" leading={<CodeFileIcon className="size-4" />} meta="Default" />
        <ItemRow
          name=".claude/settings.local.json"
          leading={<CodeFileIcon className="size-4" />}
          meta="Default"
        />
      </PrefSection>
    </>
  );
}
