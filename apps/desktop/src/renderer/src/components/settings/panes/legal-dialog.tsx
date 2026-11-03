/** Display the actual shipped licence and generated notices, never a hand-authored dependency list. */
import * as React from "react";
import { BookOpenIcon } from "@phosphor-icons/react/dist/csr/BookOpen";
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@renderer/components/ui/dialog";
import { LoadingLabel } from "@renderer/components/ui/loading-label";
import { Notice } from "@renderer/components/ui/notice";
export function LegalDialog({ kind }: { kind: "licence" | "acknowledgements" }) {
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  const title = kind === "licence" ? "Licence" : "Acknowledgements";
  React.useEffect(() => {
    if (!open) return;
    let current = true;
    setFailed(false);
    const load =
      kind === "licence"
        ? import("../../../../../../../../LICENSE?raw")
        : import("../../../../../../THIRD-PARTY-NOTICES?raw");
    void load
      .then((module) => {
        if (current) setText(module.default);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [open, kind]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost">
          <BookOpenIcon />
          {title}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {kind === "licence"
              ? "Volli is licensed under Apache 2.0."
              : "The open-source work included with this build."}
          </DialogDescription>
        </DialogHeader>
        {failed ? (
          <Notice tone="error" title="Couldn't read the notice. Close and reopen to try again." />
        ) : text === null ? (
          <LoadingLabel>Reading notice</LoadingLabel>
        ) : (
          <pre className="max-h-[60vh] overflow-auto font-sans text-ui whitespace-pre-wrap [overflow-wrap:anywhere]">
            {text}
          </pre>
        )}
      </DialogContent>
    </Dialog>
  );
}
