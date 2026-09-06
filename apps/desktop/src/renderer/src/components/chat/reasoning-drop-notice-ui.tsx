import * as React from "react";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { reasoningDropNoticeCopy, type TranscriptReasoningDrop } from "@volli/session-presentation";

/** A quiet durable transcript fact. The Turn succeeded and needs no action. */
export const ReasoningDropNotice = React.memo(function ReasoningDropNotice({
  drop,
}: {
  drop: TranscriptReasoningDrop;
}) {
  return (
    <div className="not-prose flex min-w-0 items-center gap-2 text-ui text-muted-foreground">
      <WarningIcon aria-hidden className="size-3.5 shrink-0" />
      <p>{reasoningDropNoticeCopy(drop)}</p>
    </div>
  );
});
