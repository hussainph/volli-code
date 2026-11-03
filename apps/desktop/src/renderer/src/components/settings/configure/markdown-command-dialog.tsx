/** Create a real project command file and hand its contents to the app editor. */
import * as React from "react";
import { FileCodeIcon } from "@phosphor-icons/react/dist/csr/FileCode";
import { isWritablePromptTemplateName } from "@volli/shared";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { LoadingLabel } from "@renderer/components/ui/loading-label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
  DialogFooter,
} from "@renderer/components/ui/dialog";
import { openProjectSettingFile } from "../open-project-setting-file";
export function MarkdownCommandDialog({
  projectId,
  onCreated,
}: {
  projectId: string;
  onCreated(): void;
}) {
  const [open, setOpen] = React.useState(false),
    [name, setName] = React.useState(""),
    [busy, setBusy] = React.useState(false),
    [error, setError] = React.useState<string | null>(null);
  const latch = React.useRef(false);
  const slug = name.trim().replace(/^\//, "");
  const valid = isWritablePromptTemplateName(slug);
  async function create() {
    if (!valid || latch.current) return;
    latch.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await window.api.files.create({
        projectId,
        relPath: `.volli/commands/${slug}.md`,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      onCreated();
      openProjectSettingFile(projectId, result.relPath);
    } catch {
      setError("Couldn't create the command file. Try again.");
    } finally {
      latch.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
        if (next) {
          setName("");
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="xs">
          <FileCodeIcon />
          Write a markdown file
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Write a command</DialogTitle>
          <DialogDescription>
            Create a project command file and write its prompt in the editor.
          </DialogDescription>
        </DialogHeader>
        <label htmlFor="markdown-command-name" className="text-ui font-medium">
          Command name
        </label>
        <Input
          id="markdown-command-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="review"
          disabled={busy}
        />
        {error && (
          <p role="alert" className="text-ui text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy || !valid} onClick={() => void create()}>
            {busy ? <LoadingLabel>Creating</LoadingLabel> : "Create and open"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
