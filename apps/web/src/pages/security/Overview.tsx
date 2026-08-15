import { Link } from "react-router-dom";
import {
  Boxes,
  FileStack,
  GitPullRequestArrow,
  KeyRound,
  Layers,
  ScanSearch,
} from "lucide-react";
import { buttonClass } from "@/components/ui/Button";
import { Card, CardBody } from "@/components/ui/Card";
import { StatPanel } from "@/components/charts/Panel";
import { Page } from "@/components/layout/PageHeader";
import { ScanRepositoryButton } from "@/components/layout/SecurityBanner";
import { TopBarActions } from "@/components/layout/TopBar";
import { deepScanFindings, scanCoverage } from "@/data/security";
import { repositories } from "@/data/repos";

const coverageIcons = [ScanSearch, GitPullRequestArrow, KeyRound, Layers, Boxes, FileStack];

export function SecurityOverview() {
  const open = deepScanFindings.filter((finding) => finding.status === "Open");
  const criticalHigh = open.filter(
    (finding) => finding.severity === "Critical" || finding.severity === "High",
  );
  const neverScanned = repositories.filter(
    (repo) => repo.security.lastScanAt === null,
  ).length;

  return (
    <Page>
      <TopBarActions>
        <ScanRepositoryButton />
      </TopBarActions>

      <section className="overflow-hidden rounded-lg border border-line bg-surface shadow-card">
        <div className="relative px-6 py-10 sm:px-10 sm:py-14">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 opacity-[0.06] grid-lines"
          />
          <div className="relative max-w-2xl">
            <h1 className="text-3xl font-semibold tracking-[-0.02em] text-fg sm:text-[38px] sm:leading-[1.1]">
              Fix security issues before they ship
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-fg-muted sm:text-base">
              Acalys provides AI Deep Scans, Security PR Review, dependency
              vulnerability scans, SBOM generation, and secrets detection.
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              <Link to="/security/repositories" className={buttonClass("brand", "lg")}>
                Scan a repository
              </Link>
              <a
                href="https://docs.coderabbit.ai/guides/security"
                target="_blank"
                rel="noreferrer"
                className={buttonClass("outline", "lg")}
              >
                View documentation
              </a>
            </div>
          </div>
        </div>
      </section>

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatPanel title="Open findings" value={open.length} tone="danger" />
        <StatPanel
          title="Critical & high"
          value={criticalHigh.length}
          tone="danger"
          footer="Across 4 repositories"
        />
        <StatPanel
          title="Repositories scanned"
          value={repositories.length - neverScanned}
          tone="info"
          footer={`${neverScanned} never scanned`}
        />
        <StatPanel
          title="Fixed this month"
          value={deepScanFindings.filter((f) => f.status === "Fixed").length}
          tone="ok"
        />
      </div>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-fg">What Acalys scans</h2>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-fg-subtle">
          Along with scans, you get one view to monitor all security findings in
          your PRs and repositories.
        </p>

        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {scanCoverage.map((item, index) => {
            const Icon = coverageIcons[index] ?? ScanSearch;
            return (
              <Card key={item.title}>
                <CardBody className="space-y-2.5">
                  <span className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-soft text-brand">
                    <Icon className="h-4 w-4" />
                  </span>
                  <h3 className="text-sm font-medium text-fg">{item.title}</h3>
                  <p className="text-xs leading-relaxed text-fg-subtle">
                    {item.description}
                  </p>
                </CardBody>
              </Card>
            );
          })}
        </div>
      </section>
    </Page>
  );
}
