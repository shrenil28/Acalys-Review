import { ValidationError } from "@acalys/contracts/domain";

export class JiraIntegrationService {
  public validateInstallation(input: {
    readonly siteUrl: string;
    readonly cloudId: string;
    readonly installationToken: string;
  }): {
    readonly config: Readonly<Record<string, unknown>>;
    readonly credential: object;
  } {
    let site: URL;
    try {
      site = new URL(input.siteUrl);
    } catch {
      throw new ValidationError("Jira Cloud site URL is invalid");
    }
    const hostname = site.hostname.toLowerCase().replace(/\.$/u, "");
    if (
      site.protocol !== "https:" ||
      (site.port !== "" && site.port !== "443") ||
      site.username !== "" ||
      site.password !== "" ||
      site.search !== "" ||
      site.hash !== "" ||
      hostname === "atlassian.net" ||
      !hostname.endsWith(".atlassian.net")
    ) {
      throw new ValidationError(
        "Jira installation must target an HTTPS *.atlassian.net site",
      );
    }
    if (
      input.installationToken.trim() === "" ||
      input.installationToken.length > 16_384
    ) {
      throw new ValidationError("Jira installation token is invalid");
    }
    return {
      config: {
        siteOrigin: `https://${hostname}`,
        cloudId: input.cloudId,
      },
      credential: { installationToken: input.installationToken },
    };
  }
}
