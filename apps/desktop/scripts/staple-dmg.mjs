// afterAllArtifactBuild hook (wired in electron-builder.yml).
//
// electron-builder notarizes and staples the .app during packing, but never
// notarizes the dmg artifact itself. Without this, `stapler validate` on the
// dmg fails (VC-23's acceptance check) and Gatekeeper needs network access to
// assess the download. This hook submits each dmg for its own notarization
// ticket and staples it.
//
// Credentials: the same App Store Connect API key env vars the main notarize
// step uses (APPLE_API_KEY = path to .p8, APPLE_API_KEY_ID, APPLE_API_ISSUER).
// When they are absent this is a silent-ish no-op so credential-less local
// builds keep working. Note: only the API-key flavor is supported here — if
// you switch the main build to APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD, extend
// this hook to match.
//
// Failure mode: if notarization is rejected, `stapler staple` finds no ticket
// and exits non-zero, which fails the build — that is deliberate. Debug with:
//   xcrun notarytool log <submission-id> --key "$APPLE_API_KEY" \
//     --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER"
import { execFileSync } from "node:child_process";

export default async function stapleDmgs(buildResult) {
  const dmgs = buildResult.artifactPaths.filter((p) => p.endsWith(".dmg"));
  if (dmgs.length === 0) {
    return [];
  }

  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
  if (!(APPLE_API_KEY && APPLE_API_KEY_ID && APPLE_API_ISSUER)) {
    console.log(
      "  • staple-dmg: APPLE_API_* env vars not set — skipping dmg notarization/stapling",
    );
    return [];
  }

  for (const dmg of dmgs) {
    console.log(`  • staple-dmg: submitting for notarization: ${dmg}`);
    execFileSync(
      "xcrun",
      [
        "notarytool",
        "submit",
        dmg,
        "--key",
        APPLE_API_KEY,
        "--key-id",
        APPLE_API_KEY_ID,
        "--issuer",
        APPLE_API_ISSUER,
        "--wait",
      ],
      { stdio: "inherit" },
    );
    console.log(`  • staple-dmg: stapling: ${dmg}`);
    execFileSync("xcrun", ["stapler", "staple", dmg], { stdio: "inherit" });
  }

  return [];
}
