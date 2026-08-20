/**
 * Which data source this build talks to, decided once and explicitly.
 *
 * # Why absence is not a choice
 *
 * The first version inferred the mode: no `VITE_ACALYS_API_URL` meant
 * fixtures. That is convenient during a transition and dangerous afterwards,
 * because the failure it permits is silent and confident:
 *
 * ```
 * production deploy
 * → API variable accidentally unset
 * → the app enters fixture mode
 * → plausible, well-formed, entirely fabricated security findings
 * ```
 *
 * Which is worse than the outage-reads-as-clean bug this seam was built to
 * prevent. An outage at least looks like an outage; fabricated data looks like
 * your codebase.
 *
 * So the rule is:
 *
 * > **Fixtures are a deliberately selected data source, never an error
 * > fallback and never a default.**
 *
 * The runtime already obeys the first half — a configured API that fails
 * reports the failure rather than substituting fixtures. This makes it true at
 * configuration time as well.
 */

export type DataMode =
  | { readonly kind: "fixtures" }
  | { readonly kind: "api"; readonly baseUrl: string }
  /**
   * The configuration is incoherent, and the app must say so rather than
   * choosing on its behalf.
   */
  | { readonly kind: "misconfigured"; readonly detail: string };

/**
 * Resolves the mode from the build's environment.
 *
 * `VITE_ACALYS_DATA_MODE` is required to be explicit in production. In dev and
 * test it defaults to `fixtures`, because a developer running `npm run dev`
 * with no backend is asking for the demo and it would be hostile to refuse —
 * but that default never applies to a production bundle.
 */
export function resolveDataMode(
  env: Record<string, unknown> = import.meta.env,
): DataMode {
  const declared =
    typeof env["VITE_ACALYS_DATA_MODE"] === "string"
      ? (env["VITE_ACALYS_DATA_MODE"])
      : undefined;
  const baseUrl =
    typeof env["VITE_ACALYS_API_URL"] === "string" &&
    env["VITE_ACALYS_API_URL"] !== ""
      ? (env["VITE_ACALYS_API_URL"])
      : undefined;
  const isProduction = env["PROD"] === true;
  // A second, separate variable. One misconfigured value should not be able to
  // put fabricated data in front of users; it should take two, and the second
  // one exists for no other purpose.
  const demoAuthorized = env["VITE_ACALYS_ALLOW_DEMO_DATA"] === "true";

  if (declared === "api") {
    return baseUrl === undefined
      ? {
          kind: "misconfigured",
          detail:
            "VITE_ACALYS_DATA_MODE is `api` but VITE_ACALYS_API_URL is not set",
        }
      : { kind: "api", baseUrl };
  }

  if (declared === "fixtures") {
    // Chosen — but in production, choosing is not enough.
    //
    // A demo build is legitimate. A production build serving fabricated
    // security findings because one environment variable said `fixtures` is
    // not, and the difference has to be more than a typo away.
    if (isProduction && !demoAuthorized) {
      return {
        kind: "misconfigured",
        detail:
          "fixtures in a production build require VITE_ACALYS_ALLOW_DEMO_DATA=true",
      };
    }
    return { kind: "fixtures" };
  }

  if (declared !== undefined) {
    return {
      kind: "misconfigured",
      detail: `VITE_ACALYS_DATA_MODE is \`${declared}\`, which is not a data mode`,
    };
  }

  // Nothing declared.
  if (isProduction) {
    // A production bundle will not quietly show fabricated data because a
    // variable went missing.
    return {
      kind: "misconfigured",
      detail: "VITE_ACALYS_DATA_MODE must be set explicitly in production",
    };
  }

  if (baseUrl !== undefined) {
    // A developer who configured an API URL meant to use it. Silently serving
    // fixtures here costs an hour of wondering why backend changes do not
    // appear — and the answer would be that the UI never asked.
    return {
      kind: "misconfigured",
      detail:
        "VITE_ACALYS_API_URL is set but VITE_ACALYS_DATA_MODE is not; set it to `api` or `fixtures`",
    };
  }

  return { kind: "fixtures" };
}
