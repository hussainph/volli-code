/**
 * How one opened file's edits reach disk (CONCEPT #49: code edits save
 * explicitly, document edits keep autosave). The single place that decision is
 * made — Project Files, ticket file tabs, and any future editor surface all ask
 * this rather than re-deriving it from "is this markdown?", which stopped being
 * the right question once repository Markdown joined the code checkout's
 * explicit-save contract.
 */
import { classifyFileKind, isArtifactRelPath } from "./file-ref";

/** How a document's edits reach disk (CONCEPT #49). */
export type FileSavePolicy = "read-only" | "explicit" | "autosave";

export interface FileSavePolicyInput {
  /** Project-relative path of the file. */
  relPath: string;
  /** True when the read hit the binary sniff or is an image — no text editor. */
  binary: boolean;
  /** True when the read was capped (past the 1 MiB text cap). */
  truncated: boolean;
}

/**
 * The save contract for one opened file, in precedence order: an unreadable or
 * partially-read file gets no editor at all, then a Markdown Artifact
 * autosaves, then everything else saves explicitly.
 */
export function fileSavePolicy(input: FileSavePolicyInput): FileSavePolicy {
  const kind = classifyFileKind(input.relPath);
  // `binary` is the reader's verdict; the image extension is checked too so a
  // caller that forgets the flag still can't be handed a text editor over a
  // PNG — the one case where guessing from the path is strictly safer.
  if (input.binary || kind === "image") return "read-only";
  // A truncated read holds only the prefix, so saving it back would delete
  // everything past the cap. Read-only outranks every content rule below.
  if (input.truncated) return "read-only";
  // The only autosaving file on disk: a Markdown Artifact. Everything else —
  // repository Markdown included — participates in the code checkout and takes
  // its explicit ⌘S contract, as does unknown/extensionless text.
  if (kind === "markdown" && isArtifactRelPath(input.relPath)) return "autosave";
  return "explicit";
}
