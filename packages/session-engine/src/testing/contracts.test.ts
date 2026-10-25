// The port contracts against session-engine's own in-memory adapters. host-core
// runs the same suites against SQLite, the transcript file store and its wake
// bus, so a divergence fails on the side that drifted.
import {
  describeCommittedSessionStreamContract,
  describeSessionFollowUpLedgerContract,
  describeSessionLedgerContract,
  describeTranscriptArtifactStoreContract,
} from "./contracts";
import { createSessionEngine } from "../session-engine";
import {
  createCommittedSessionStream,
  createInMemorySessionFollowUpLedger,
  createInMemorySessionLedger,
  createInMemoryTranscriptArtifactStore,
} from "./index";

const nothingToSeed = () => {};
const nothingToRelease = () => {};

describeSessionLedgerContract("in-memory", () => ({
  ledger: createInMemorySessionLedger(),
  seedProject: nothingToSeed,
  dispose: nothingToRelease,
}));

describeSessionFollowUpLedgerContract("in-memory", () => {
  const ledger = createInMemorySessionLedger();
  return {
    ledger,
    followUps: createInMemorySessionFollowUpLedger(ledger),
    seedProject: nothingToSeed,
    dispose: nothingToRelease,
  };
});

describeTranscriptArtifactStoreContract("in-memory", () => ({
  store: createInMemoryTranscriptArtifactStore(),
  dispose: nothingToRelease,
}));

describeCommittedSessionStreamContract("in-memory", () => {
  let id = 0;
  const stream = createCommittedSessionStream(
    createSessionEngine({
      ledger: createInMemorySessionLedger(),
      clock: { now: () => 100 },
      ids: { next: (kind) => `stream-${kind}-${++id}` },
    }),
  );
  return {
    engine: stream.engine,
    subscribe: stream.committed,
    seedProject: nothingToSeed,
    dispose: nothingToRelease,
  };
});
