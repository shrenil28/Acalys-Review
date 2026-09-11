import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { LiveMisconfiguredState } from "@/components/live/LiveDataState";
import { useLocation } from "react-router-dom";
import { AcalysMark, GitHubIcon, GitLabIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { githubLoginStartUrl, gitlabLoginStartUrl, loadAuthConfig } from "@/lib/api/dashboardAdmin";
import { resolveDataConfig } from "@/lib/api/config";

const FixtureLogin = lazy(() => import("./LoginFixture").then((module) => ({ default: module.LoginPage })));

export function LoginPage() {
  const config = resolveDataConfig();
  if (config.kind === "fixtures") return <Suspense fallback={null}><FixtureLogin /></Suspense>;
  if (config.kind === "misconfigured") return <div className="mx-auto max-w-lg px-6 py-16"><LiveMisconfiguredState detail={config.detail} /></div>;
  return <LiveLogin baseUrl={config.baseUrl} />;
}

function LiveLogin({ baseUrl }: { baseUrl: string }) {
  const location = useLocation();
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const returnTo = params.get("returnTo") || "/";
  const invite = params.get("invite") || undefined;
  const error = params.get("error");
  const [githubEnabled, setGithubEnabled] = useState<boolean | null>(null);
  const [gitlabEnabled, setGitlabEnabled] = useState<boolean | null>(null);
  const [organizationName, setOrganizationName] = useState("your organization");

  useEffect(() => {
    const controller = new AbortController();
    void loadAuthConfig(controller.signal).then((result) => {
      if (result.kind === "ok") {
        setGithubEnabled(result.value.githubEnabled);
        setGitlabEnabled(result.value.gitlabEnabled);
        setOrganizationName(result.value.organization.name);
      } else if (!controller.signal.aborted) { setGithubEnabled(false); setGitlabEnabled(false); }
    });
    return () => controller.abort();
  }, []);

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center">
          <AcalysMark className="h-11 w-11" />
          <h1 className="mt-4 text-xl font-semibold tracking-[-0.01em] text-fg">Sign in to Acalys</h1>
          <p className="mt-1.5 text-sm text-fg-subtle">{invite ? `Redeem your ${organizationName} invitation with a verified provider email.` : `Use a provisioned ${organizationName} membership.`}</p>
        </div>
        {error && <div className="mt-5 rounded-md border border-line bg-surface px-3 py-2 text-xs text-fg-muted">{error === "membership_required" ? "Your GitHub identity does not have a live Acalys membership for this organization." : error === "invitation_email_mismatch" ? "The provider account did not verify the email address this invitation was issued to." : error === "invitation_identity_conflict" ? "That verified email already belongs to a different Acalys identity. Account linking is intentionally blocked." : error === "invitation_already_member" ? "That provider identity already has a membership. Sign in without the invitation link." : error === "invitation_invalid" ? "This invitation is invalid, expired, cancelled, or already redeemed." : "Provider sign-in could not be completed. Start again to get a fresh one-time login state."}</div>}
        <div className="mt-7 space-y-2">
          <Button
            variant="secondary"
            size="lg"
            className="w-full"
            icon={<GitHubIcon className="h-4 w-4" />}
            disabled={githubEnabled !== true}
            onClick={() => window.location.assign(githubLoginStartUrl(baseUrl, returnTo, invite))}
          >
            {githubEnabled === null ? "Checking GitHub sign-in…" : githubEnabled ? "Continue with GitHub" : "GitHub sign-in unavailable"}
          </Button>
          <Button
            variant="secondary" size="lg" className="w-full" icon={<GitLabIcon className="h-4 w-4" />}
            disabled={gitlabEnabled !== true}
            onClick={() => window.location.assign(gitlabLoginStartUrl(baseUrl, returnTo, invite))}
          >
            {gitlabEnabled === null ? "Checking GitLab sign-in…" : gitlabEnabled ? "Continue with GitLab" : "GitLab sign-in unavailable"}
          </Button>
        </div>
        <p className="mt-6 text-center text-xs leading-relaxed text-fg-subtle">Membership onboarding is explicit: invitations require a provider-verified email. SAML SSO is not part of the current dashboard-auth contract.</p>
      </div>
    </div>
  );
}
