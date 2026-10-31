/**
 * An explicit legal-version exception, not an older-app consent bypass.
 *
 * The frozen data-plane tests all enroll in their setup. With owner approval,
 * only their prepared tree's agreement CONSTANT is adapted as a SIMULATED
 * current-consent fixture. No frozen test body or production function changes.
 * A separate, mandatory live probe sends the ORIGINAL value through that
 * tree's own Convex client and requires the typed refusal, then proves that
 * explicitly accepting the current text works. No failure is counted as a pass.
 * The adaptation is restored after the run and expires with the next newer tag.
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareVersions, parseVersion } from "./tags.mjs";

const MODULE = "packages/shared/src/cloud/preview-access.ts";
const PROBE = "apps/desktop/src/main/legal-consent.exception.live.test.ts";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** Exact build + version, automatically inactive once any newer version tag exists. */
export function selectLegalException(entries, { tag, commit, latestTag, currentVersion }) {
  if (!Array.isArray(entries)) throw new Error("Live exceptions must be an array");
  for (const entry of entries) {
    if (
      !parseVersion(entry.tag) ||
      entry.expiresAfterTag !== entry.tag ||
      !/^[a-f0-9]{40}$/.test(entry.commit ?? "") ||
      !/^[A-Z]+-\d+$/.test(entry.ticket ?? "") ||
      typeof entry.reason !== "string" ||
      !entry.reason.trim() ||
      typeof entry.fromVersion !== "string" ||
      !entry.fromVersion ||
      typeof entry.toVersion !== "string" ||
      !entry.toVersion ||
      entry.fromVersion === entry.toVersion ||
      entry.refusalCode !== "preview_agreement_required" ||
      !/^[a-f0-9]{64}$/.test(entry.moduleSha256 ?? "")
    ) {
      throw new Error(
        "Live exceptions require an exact build, reason, ticket, versions and expiry",
      );
    }
  }
  const selected = entries.filter((entry) => entry.tag === tag);
  if (selected.length > 1) throw new Error(`Duplicate live exceptions for ${tag}`);
  if (selected.length === 0) return null;
  const entry = selected[0];
  const latest = parseVersion(latestTag);
  if (!latest) throw new Error("The newest released version tag is required for expiry");
  if (compareVersions(latest, parseVersion(entry.expiresAfterTag)) > 0) return null;
  if (latestTag !== tag || entry.commit !== commit || entry.toVersion !== currentVersion) {
    throw new Error("Live legal exception does not match the selected build and backend version");
  }
  return entry;
}

/** This source runs with the OLDER tree's SDK, generated API and test issuer. */
function probeSource(entry) {
  return `// Generated ${entry.ticket} probe; never a replacement for the frozen data-plane suites.
import { randomUUID } from "node:crypto";
import { expect, it } from "vite-plus/test";
import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { api } from "@volli/convex/api";
import { DEV_AUDIENCE, DEV_ISSUER, DEV_KEY_ID } from "./account/dev-issuer";
import { signEs256Jwt } from "./account/jwt";
import { inviteTestEmail } from "./test-helpers/preview";

it(${JSON.stringify(`${entry.ticket}: old agreement is a typed refusal, not enrollment or a crash`)}, async () => {
  const url = process.env["VOLLI_CONVEX_URL"]!;
  const key = process.env["VOLLI_CONVEX_TEST_PRIVATE_KEY"]!;
  if (!url || !key) throw new Error("The consent probe requires the local backend fixture");
  const subject = "legal-exception-" + randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const token = signEs256Jwt(key, DEV_KEY_ID, {
    iss: DEV_ISSUER, aud: DEV_AUDIENCE, sub: subject, iat: now, exp: now + 3600,
    name: "Legal fixture", email: subject + "@example.com", email_verified: true,
  });
  await inviteTestEmail(url, subject + "@example.com");
  const person = new ConvexHttpClient(url);
  person.setAuth(token);
  const refusal = await person.mutation(api.accounts.ensureViewer, {
    acceptedAgreementVersion: ${JSON.stringify(entry.fromVersion)},
  }).then(() => { throw new Error("The backend enrolled an outdated agreement"); }, error => error);
  expect(refusal).toBeInstanceOf(ConvexError);
  expect(refusal.data).toEqual({
    code: ${JSON.stringify(entry.refusalCode)},
    message: "Update Volli to accept the current Preview Agreement.",
  });
  expect(await person.query(api.accounts.viewer, {})).toBeNull();
  // SIMULATED current-consent fixture, not consent supplied by the older UI.
  const accepted = await person.mutation(api.accounts.ensureViewer, {
    acceptedAgreementVersion: ${JSON.stringify(entry.toVersion)},
  });
  expect(accepted.previewAgreementAccepted).toBe(true);
  expect(accepted.previewAccess).toBe("granted");
});
`;
}

/** Own temporary prepared-tree writes only; never touch a checkout or overwrite another run. */
export function installLegalFixture(tree, entry, backendUrl) {
  const backend = new URL(backendUrl);
  if (
    backend.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(backend.hostname) ||
    backend.username ||
    backend.password
  ) {
    throw new Error("Legal fixture adaptation is restricted to the loopback backend");
  }
  const path = join(tree, MODULE);
  const probe = join(tree, PROBE);
  const lock = join(tree, ".legal-fixture.lock");
  const fd = openSync(lock, "wx");
  closeSync(fd);
  let original;
  let adapted;
  let wroteModule = false;
  let wroteProbe = false;
  const generated = probeSource(entry);
  const restore = () => {
    const errors = [];
    // A concurrent change is not ours to overwrite or remove. Still clean
    // each other owned artifact and release our lock before reporting failure.
    try {
      if (wroteModule) {
        if (readFileSync(path, "utf8") !== adapted)
          throw new Error("Prepared consent fixture changed during the run");
        writeFileSync(path, original);
        wroteModule = false;
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      if (wroteProbe) {
        if (readFileSync(probe, "utf8") !== generated)
          throw new Error("Generated consent probe changed during the run");
        rmSync(probe);
        wroteProbe = false;
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      rmSync(lock);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) {
      throw new AggregateError(
        errors,
        `Consent fixture cleanup failed: ${errors.map((error) => error.message).join("; ")}`,
      );
    }
  };
  try {
    original = readFileSync(path, "utf8");
    if (sha256(original) !== entry.moduleSha256)
      throw new Error("The frozen agreement module does not match its exception hash");
    const before = `export const PREVIEW_ENROLLMENT_AGREEMENT_VERSION = ${JSON.stringify(entry.fromVersion)};`;
    const after = `export const PREVIEW_ENROLLMENT_AGREEMENT_VERSION = ${JSON.stringify(entry.toVersion)};`;
    if (original.split(before).length !== 2)
      throw new Error("The exact frozen agreement declaration is missing or duplicated");
    if (existsSync(probe)) throw new Error("Refusing to overwrite an existing consent probe");
    adapted = original.replace(before, after);
    writeFileSync(probe, generated, { flag: "wx" });
    wroteProbe = true;
    writeFileSync(path, adapted);
    wroteModule = true;
    return { suite: PROBE, restore };
  } catch (error) {
    try {
      restore();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Consent fixture setup and cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}
