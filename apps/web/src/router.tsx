import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";

import { ExplorePage } from "@/pages/Explore";
import { LoginPage } from "@/pages/Login";
import { NotFoundPage } from "@/pages/NotFound";
import { ErrorPage } from "@/pages/ErrorPage";

import { DashboardLayout } from "@/pages/analytics/DashboardLayout";
import { AnalyticsSummary } from "@/pages/analytics/Summary";
import { QualityMetrics } from "@/pages/analytics/QualityMetrics";
import { TimeMetrics } from "@/pages/analytics/TimeMetrics";
import { KnowledgeBaseView } from "@/pages/analytics/KnowledgeBase";
import { OrganizationTrends } from "@/pages/analytics/OrganizationTrends";
import { PreMergeChecks } from "@/pages/analytics/PreMergeChecks";
import { Reporting } from "@/pages/analytics/Reporting";
import { DataMetrics } from "@/pages/analytics/DataMetrics";
import { DataExport } from "@/pages/analytics/DataExport";
import { IdeCliSummary } from "@/pages/analytics/IdeCli";
import { PrSecurityReviewsPage } from "@/pages/analytics/PrSecurityReviews";
import { ReportsPage } from "@/pages/reports/ReportsPage";
import { CreateReport } from "@/pages/reports/CreateReport";

import { TriagePage } from "@/pages/review/Triage";
import { RepositoriesPage } from "@/pages/review/Repositories";
import { RepositoryDetailPage } from "@/pages/review/RepositoryDetail";
import { IntegrationsPage } from "@/pages/review/Integrations";
import { LearningsPage } from "@/pages/review/Learnings";
import { CachesPage } from "@/pages/review/Caches";
import { OrganizationSettingsPage } from "@/pages/organization/OrganizationSettings";

import { SecurityOverview } from "@/pages/security/Overview";
import { SecurityRepositoriesPage } from "@/pages/security/SecurityRepositories";
import { AiDeepScanPage } from "@/pages/security/AiDeepScan";
import { PrFindingsPage } from "@/pages/security/PrFindings";
import { SecurityActivityLog } from "@/pages/security/ActivityLog";

import {
  ChatActivity,
  ChatAutomations,
  ChatConnections,
  ChatKnowledgeBase,
  ChatSandbox,
  ChatScopes,
  SlackPrAutoFix,
} from "@/pages/chat/ChatIntegrationPages";

import {
  NewPlan,
  PlanConfigurations,
  PlanDiscover,
  PlansList,
} from "@/pages/plan/PlanPages";

import { SettingsPage } from "@/pages/account/Settings";
import { TeamPage } from "@/pages/account/Team";
import { ApiKeysPage } from "@/pages/account/ApiKeys";

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage />, errorElement: <ErrorPage /> },
  {
    path: "/",
    element: <AppShell />,
    errorElement: <ErrorPage />,
    children: [
      { index: true, element: <ExplorePage /> },

      /* ------------------------------------------------------- Analytics */
      {
        path: "analytics/pr-reviews",
        element: <DashboardLayout />,
        children: [
          { index: true, element: <AnalyticsSummary /> },
          { path: "quality-metrics", element: <QualityMetrics /> },
          { path: "time-metrics", element: <TimeMetrics /> },
          { path: "knowledge-base", element: <KnowledgeBaseView /> },
          { path: "organization-trends", element: <OrganizationTrends /> },
          { path: "pre-merge-checks", element: <PreMergeChecks /> },
          { path: "reporting", element: <Reporting /> },
          { path: "data-metrics", element: <DataMetrics /> },
          { path: "data-export", element: <DataExport /> },
        ],
      },
      {
        path: "analytics/ide-cli-reviews",
        element: <DashboardLayout />,
        children: [
          { index: true, element: <IdeCliSummary /> },
          { path: "organization-trends", element: <OrganizationTrends /> },
          { path: "data-metrics", element: <DataMetrics /> },
        ],
      },
      {
        path: "analytics/pr-security-reviews",
        element: <PrSecurityReviewsPage />,
      },
      {
        path: "analytics/reports",
        element: <Navigate to="/reports" replace />,
      },

      /* --------------------------------------------------------- Reports */
      { path: "reports", element: <ReportsPage /> },
      { path: "reports/recurring/new", element: <CreateReport kind="recurring" /> },
      { path: "reports/ondemand/new", element: <CreateReport kind="ondemand" /> },

      /* ---------------------------------------------------------- Review */
      { path: "review/triage", element: <TriagePage /> },
      { path: "review/repositories", element: <RepositoriesPage /> },
      { path: "review/repositories/:name", element: <RepositoryDetailPage /> },
      { path: "integrations", element: <IntegrationsPage /> },
      {
        path: "review/integrations",
        element: <Navigate to="/integrations" replace />,
      },
      { path: "review/learnings", element: <LearningsPage /> },
      { path: "review/cache", element: <CachesPage /> },
      {
        path: "review/caches",
        element: <Navigate to="/review/cache" replace />,
      },
      {
        path: "review/organization-settings",
        element: <Navigate to="/organization/settings/general" replace />,
      },

      /* --------------------------------------------- Organization settings */
      {
        path: "organization/settings",
        element: <Navigate to="/organization/settings/general" replace />,
      },
      { path: "organization/settings/*", element: <OrganizationSettingsPage /> },

      /* -------------------------------------------------------- Security */
      { path: "security", element: <Navigate to="/security/overview" replace /> },
      { path: "security/overview", element: <SecurityOverview /> },
      { path: "security/repositories", element: <SecurityRepositoriesPage /> },
      { path: "security/ai-deep-scan", element: <AiDeepScanPage /> },
      { path: "security/pr-findings", element: <PrFindingsPage /> },
      { path: "security/activity-log", element: <SecurityActivityLog /> },

      /* ----------------------------------------------------------- Slack */
      { path: "slack/scopes", element: <ChatScopes platform="Slack" /> },
      { path: "slack/automations", element: <ChatAutomations platform="Slack" /> },
      {
        path: "slack/knowledge-base",
        element: <ChatKnowledgeBase platform="Slack" />,
      },
      { path: "slack/connections", element: <ChatConnections platform="Slack" /> },
      { path: "slack/sandbox", element: <ChatSandbox platform="Slack" /> },
      { path: "slack/activity", element: <ChatActivity platform="Slack" /> },
      { path: "slack/pr-auto-fix", element: <SlackPrAutoFix /> },

      /* --------------------------------------------------------- Discord */
      { path: "discord/scopes", element: <ChatScopes platform="Discord" /> },
      {
        path: "discord/connections",
        element: <ChatConnections platform="Discord" />,
      },
      {
        path: "discord/automations",
        element: <ChatAutomations platform="Discord" />,
      },
      {
        path: "discord/knowledge-base",
        element: <ChatKnowledgeBase platform="Discord" />,
      },
      { path: "discord/sandbox", element: <ChatSandbox platform="Discord" /> },
      { path: "discord/activity", element: <ChatActivity platform="Discord" /> },

      /* ------------------------------------------------------------ Plan */
      { path: "plan", element: <Navigate to="/plan/discover" replace /> },
      { path: "plan/discover", element: <PlanDiscover /> },
      { path: "plan/new", element: <NewPlan /> },
      { path: "plan/plans", element: <PlansList /> },
      { path: "plan/configurations", element: <PlanConfigurations /> },

      /* --------------------------------------------------------- Account */
      { path: "settings", element: <SettingsPage /> },
      { path: "settings/team", element: <TeamPage /> },
      { path: "settings/api-keys", element: <ApiKeysPage /> },

      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);
