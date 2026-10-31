import { runnerInstallCommand } from "./runner-install-command";

function origin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("Invalid runner deployment");
  return url.origin;
}

/** Only explicit launch metadata can select the deployment a new box links to. */
export function runnerInstallTarget(input: {
  appVersion: string | null;
  siteUrl: string | null;
  packagedSiteUrl: string | null;
  deployment?: string;
}): { appVersion: string; server: string | null } | null {
  if (input.deployment === "local" || input.appVersion === null || input.siteUrl === null)
    return null;
  try {
    const server = origin(input.siteUrl);
    const packaged = input.packagedSiteUrl === null ? null : origin(input.packagedSiteUrl);
    // Use the generator's own validation before enabling the sheet. This is not
    // a real token; creating one remains an explicit person action.
    runnerInstallCommand({
      appVersion: input.appVersion,
      server,
      token: "validation-only",
      name: "",
    });
    return { appVersion: input.appVersion, server: server === packaged ? null : server };
  } catch {
    return null;
  }
}
