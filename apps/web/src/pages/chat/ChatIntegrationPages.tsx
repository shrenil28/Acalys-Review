import { lazy, type ReactNode } from "react";
import { DeferredFeaturePage } from "@/components/live/DeferredFeaturePage";

type Platform = "Slack" | "Discord";
const fixtureModule = () => import("./ChatIntegrationPagesFixture");
const FixtureScopes = lazy(() => fixtureModule().then((module) => ({ default: module.ChatScopes })));
const FixtureAutomations = lazy(() => fixtureModule().then((module) => ({ default: module.ChatAutomations })));
const FixtureKnowledge = lazy(() => fixtureModule().then((module) => ({ default: module.ChatKnowledgeBase })));
const FixtureConnections = lazy(() => fixtureModule().then((module) => ({ default: module.ChatConnections })));
const FixtureSandbox = lazy(() => fixtureModule().then((module) => ({ default: module.ChatSandbox })));
const FixtureActivity = lazy(() => fixtureModule().then((module) => ({ default: module.ChatActivity })));
const FixtureAutoFix = lazy(() => fixtureModule().then((module) => ({ default: module.SlackPrAutoFix })));

function deferred(platform: Platform, feature: string, fixture: ReactNode) {
  return <DeferredFeaturePage title={`${platform} ${feature}`} description={`${platform} integration surface.`} owner="Phase 7 + Phase 12" reason="Chat runtime behavior belongs to Phase 7 and provider-connection expansion belongs to Phase 12." fixture={fixture} />;
}
export function ChatScopes({ platform }: { platform: Platform }) { return deferred(platform, "scopes", <FixtureScopes platform={platform} />); }
export function ChatAutomations({ platform }: { platform: Platform }) { return deferred(platform, "automations", <FixtureAutomations platform={platform} />); }
export function ChatKnowledgeBase({ platform }: { platform: Platform }) { return deferred(platform, "knowledge base", <FixtureKnowledge platform={platform} />); }
export function ChatConnections({ platform }: { platform: Platform }) { return deferred(platform, "connections", <FixtureConnections platform={platform} />); }
export function ChatSandbox({ platform }: { platform: Platform }) { return deferred(platform, "sandbox", <FixtureSandbox platform={platform} />); }
export function ChatActivity({ platform }: { platform: Platform }) { return deferred(platform, "activity", <FixtureActivity platform={platform} />); }
export function SlackPrAutoFix() { return <DeferredFeaturePage title="Slack PR auto-fix" description="Slack-triggered pull-request repair automation." owner="Phase 7 + Phase 12" reason="Command/runtime execution and Slack integration expansion are later-owned capabilities." fixture={<FixtureAutoFix />} />; }
