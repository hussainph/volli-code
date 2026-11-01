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
  backendUrl: string | null;
  siteUrl: string | null;
  packagedBackendUrl: string | null;
  packagedSiteUrl: string | null;
  deployment?: string;
}): { appVersion: string; server: string | null; site: string | null } | null {
  if (
    input.deployment === "local" ||
    input.appVersion === null ||
    input.backendUrl === null ||
    input.siteUrl === null
  )
    return null;
  try {
    const server = origin(input.backendUrl);
    const site = origin(input.siteUrl);
    const packagedServer =
      input.packagedBackendUrl === null ? null : origin(input.packagedBackendUrl);
    const packagedSite = input.packagedSiteUrl === null ? null : origin(input.packagedSiteUrl);
    // Use the generator's own validation before enabling the sheet. This is not
    // a real token; creating one remains an explicit person action.
    runnerInstallCommand({
      appVersion: input.appVersion,
      server,
      site,
      token: "validation-only",
      name: "",
    });
    const packaged = server === packagedServer && site === packagedSite;
    return {
      appVersion: input.appVersion,
      server: packaged ? null : server,
      site: packaged ? null : site,
    };
  } catch {
    return null;
  }
}
