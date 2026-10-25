// The shared transcript artifact store contract against the cloud spool, as
// the signed-out file store and the in-memory twin run it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeTranscriptArtifactStoreContract } from "@volli/session-engine/testing/contracts";
import { SpoolTranscriptArtifactStore } from "./artifact-spool";

describeTranscriptArtifactStoreContract("spool", () => {
  const directory = mkdtempSync(join(tmpdir(), "volli-spool-contract-"));
  return {
    store: new SpoolTranscriptArtifactStore(join(directory, "spool")),
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
});
