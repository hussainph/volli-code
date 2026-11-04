import { NextActionIllustration } from "@renderer/components/ui/next-action-illustration";
import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";
import { cn } from "@renderer/lib/utils";

/** Only a confirmed empty listing gets a demonstration, never pending/error. */
export function SessionListEmpty({ band }: { band: "active" | "previous" }) {
  return (
    <div className={cn(EMPTY_INLINE, "flex flex-col gap-2")}>
      <NextActionIllustration kind={band} className="w-full" />
      <p>{band === "active" ? "No active sessions" : "Nothing yet"}</p>
    </div>
  );
}
