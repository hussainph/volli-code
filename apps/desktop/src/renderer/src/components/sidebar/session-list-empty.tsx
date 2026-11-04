import { EMPTY_INLINE } from "@renderer/components/ui/empty-classes";

/** Only a confirmed empty listing gets a demonstration, never pending/error. */
export function SessionListEmpty({ band }: { band: "active" | "previous" }) {
  return <p className={EMPTY_INLINE}>{band === "active" ? "No active sessions" : "Nothing yet"}</p>;
}
