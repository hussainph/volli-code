/** Mac-side admission before any project source can leave for the paired box. */
import { hostError } from "@volli/host-protocol";
import { HostLinkError } from "@volli/host-protocol/client-link";
import { gitUrlProblem } from "@volli/shared";

/** The public input grammar is still the host's; URL secrets must never reach it. */
export function admitHostCreateSource(input: unknown): void {
  if (typeof input !== "object" || input === null || !("source" in input)) {
    throw new HostLinkError(
      hostError("verb-refused", "A project needs a folder or repository source."),
    );
  }
  const source = input.source;
  if (typeof source !== "object" || source === null) {
    throw new HostLinkError(
      hostError("verb-refused", "A project needs a folder or repository source."),
    );
  }
  if (
    "gitUrl" in source &&
    (typeof source.gitUrl !== "string" || gitUrlProblem(source.gitUrl) !== null)
  ) {
    throw new HostLinkError(
      hostError(
        "verb-refused",
        "Use the repository’s plain HTTPS or SSH URL. Store tokens in Sign-ins, never in the URL.",
      ),
    );
  }
}
