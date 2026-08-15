import { Link } from "react-router-dom";
import { buttonClass } from "@/components/ui/Button";
import { Page } from "@/components/layout/PageHeader";

export function NotFoundPage() {
  return (
    <Page>
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
        <p className="font-mono text-sm text-fg-faint">404</p>
        <h1 className="text-xl font-semibold text-fg">This page does not exist</h1>
        <p className="max-w-sm text-sm text-fg-subtle">
          The link may be out of date, or the page may have moved. Everything else
          is still in the sidebar.
        </p>
        <Link to="/" className={`${buttonClass("secondary", "md")} mt-2`}>
          Back to Explore
        </Link>
      </div>
    </Page>
  );
}
