// Hermetic offline environment for the deterministic suite: no startup network,
// no ~/.pi, and no ambient provider credentials that could make an
// "unauthenticated" assertion pass or fail by accident on a developer machine.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_OFFLINE = "1";
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "volli-pi-agent-"));

delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.ANTHROPIC_OAUTH_TOKEN;
