// The shared transcript artifact store contract against the production file
// store. session-engine runs the same suite against its in-memory twin.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeTranscriptArtifactStoreContract } from "@volli/session-engine/testing/contracts";
import { createFileTranscriptArtifactStore } from "./transcript-artifacts";

describeTranscriptArtifactStoreContract("file", () => {
  const directory = mkdtempSync(join(tmpdir(), "volli-transcript-contract-"));
  return {
    store: createFileTranscriptArtifactStore(join(directory, "session-transcripts")),
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
});
