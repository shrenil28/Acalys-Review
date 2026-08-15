import { isRouteErrorResponse, useNavigate, useRouteError } from "react-router-dom";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";

/**
 * Route-level error boundary. Without this React Router renders a raw stack
 * trace, which is not something anyone should meet in the product.
 */
export function ErrorPage() {
  const error = useRouteError();
  const navigate = useNavigate();

  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : "Something went wrong.";

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-16">
      <div className="w-full max-w-md text-center">
        <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-danger/15 text-danger">
          <TriangleAlert className="h-5 w-5" />
        </span>
        <h1 className="mt-4 text-lg font-semibold text-fg">
          This page hit an error
        </h1>
        <p className="mt-1.5 text-sm leading-relaxed text-fg-subtle">
          The rest of the app is still fine — reload this page, or head back and
          try again.
        </p>

        <pre className="mt-4 overflow-x-auto rounded-md border border-line bg-canvas p-3 text-left font-mono text-xs text-fg-muted">
          {message}
        </pre>

        <div className="mt-5 flex items-center justify-center gap-2">
          <Button
            variant="secondary"
            icon={<RefreshCw className="h-3.5 w-3.5" />}
            onClick={() => window.location.reload()}
          >
            Reload page
          </Button>
          <Button variant="outline" onClick={() => navigate("/")}>
            Back to Explore
          </Button>
        </div>
      </div>
    </div>
  );
}
