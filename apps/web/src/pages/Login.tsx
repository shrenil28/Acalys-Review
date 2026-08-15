import { useNavigate } from "react-router-dom";
import { AcalysMark, GitHubIcon, GitLabIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";

const providers = [
  { id: "github", label: "Continue with GitHub", Icon: GitHubIcon },
  { id: "gitlab", label: "Continue with GitLab", Icon: GitLabIcon },
];

export function LoginPage() {
  const navigate = useNavigate();

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center">
          <AcalysMark className="h-11 w-11" />
          <h1 className="mt-4 text-xl font-semibold tracking-[-0.01em] text-fg">
            Sign in to Acalys
          </h1>
          <p className="mt-1.5 text-sm text-fg-subtle">
            Reviews start as soon as you connect a repository.
          </p>
        </div>

        <div className="mt-7 space-y-2">
          {providers.map((provider) => (
            <Button
              key={provider.id}
              variant="secondary"
              size="lg"
              className="w-full"
              icon={<provider.Icon className="h-4 w-4" />}
              onClick={() => navigate("/")}
            >
              {provider.label}
            </Button>
          ))}
        </div>

        <div className="my-5 flex items-center gap-3">
          <span className="h-px flex-1 bg-line" />
          <span className="text-2xs uppercase tracking-wide text-fg-faint">
            Self-hosted
          </span>
          <span className="h-px flex-1 bg-line" />
        </div>

        <Button variant="outline" className="w-full" onClick={() => navigate("/")}>
          Sign in with SAML SSO
        </Button>

        <p className="mt-6 text-center text-xs leading-relaxed text-fg-subtle">
          By signing in you agree to the{" "}
          <a
            href="https://coderabbit.ai/terms"
            target="_blank"
            rel="noreferrer"
            className="text-fg-muted underline underline-offset-2 hover:text-fg"
          >
            terms of service
          </a>{" "}
          and{" "}
          <a
            href="https://coderabbit.ai/privacy"
            target="_blank"
            rel="noreferrer"
            className="text-fg-muted underline underline-offset-2 hover:text-fg"
          >
            privacy policy
          </a>
          .
        </p>
      </div>
    </div>
  );
}
