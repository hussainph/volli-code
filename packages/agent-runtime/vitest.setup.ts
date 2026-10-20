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
// Anthropic workload identity federation (pi-ai 0.99.2): with these set, Pi
// resolves Anthropic auth from an identity-token file instead of reporting the
// provider unconfigured.
delete process.env.ANTHROPIC_FEDERATION_RULE_ID;
delete process.env.ANTHROPIC_ORGANIZATION_ID;
delete process.env.ANTHROPIC_SERVICE_ACCOUNT_ID;
delete process.env.ANTHROPIC_IDENTITY_TOKEN_FILE;
delete process.env.ANTHROPIC_WORKSPACE_ID;
