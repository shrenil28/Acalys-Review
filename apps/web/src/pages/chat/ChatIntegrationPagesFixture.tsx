import { useState, type ReactNode } from "react";
import { Slack } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { EmptyState, Switch } from "@/components/ui/Misc";
import { UnsavedBar, useUnsaved } from "@/components/ui/UnsavedBar";
import { useToast } from "@/components/ui/Toast";
import { Table, TableEmpty, TableShell, Th } from "@/components/ui/Table";
import { Textarea } from "@/components/ui/Input";
import { DiscordIcon } from "@/components/icons";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { TopBarActions } from "@/components/layout/TopBar";
import { chatAutomations, chatScopes } from "@/data/account";

type Platform = "Slack" | "Discord";

const marks: Record<Platform, (props: { className?: string }) => JSX.Element> = {
  Slack: (props) => <Slack {...props} />,
  Discord: DiscordIcon,
};

/**
 * Slack and Discord share one surface set. Until the workspace is connected
 * every sub-page shows the same connect gate rather than an empty table.
 */
function ConnectGate({
  platform,
  surface,
  children,
}: {
  platform: Platform;
  surface: string;
  children?: ReactNode;
}) {
  const Mark = marks[platform];
  return (
    <EmptyState
      icon={<Mark className="h-5 w-5" />}
      title={`Connect ${platform} to use ${surface}`}
      description={
        children ??
        `Acalys needs access to your ${platform} workspace before it can manage ${surface.toLowerCase()}. Connecting takes about a minute and can be revoked at any time.`
      }
      action={
        <Button variant="brand" icon={<Mark className="h-3.5 w-3.5" />}>
          Connect {platform}
        </Button>
      }
    />
  );
}

function ChatPage({
  platform,
  title,
  description,
  children,
}: {
  platform: Platform;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const Mark = marks[platform];
  return (
    <Page>
      <TopBarActions>
        <Badge tone="neutral" dot>
          Not connected
        </Badge>
        <Button size="sm" variant="brand" icon={<Mark className="h-3.5 w-3.5" />}>
          Connect {platform}
        </Button>
      </TopBarActions>
      <PageHeader title={title} description={description} />
      <div className="mt-6">{children}</div>
    </Page>
  );
}

export function ChatScopes({ platform }: { platform: Platform }) {
  const toast = useToast();
  const { draft, patch, dirty, reset, commit } = useUnsaved<Record<string, boolean>>(
    Object.fromEntries(chatScopes.map((scope) => [scope.id, scope.id === "reviews"])),
  );

  return (
    <ChatPage
      platform={platform}
      title="Scopes"
      description={`Choose what Acalys is allowed to do from ${platform}. Scopes take effect the moment the workspace is connected.`}
    >
      <Card>
        <CardHeader
          title="Permissions"
          description="Least privilege by default — grant only what your team needs."
        />
        <CardBody className="divide-y divide-line py-0">
          {chatScopes.map((scope) => (
            <div
              key={scope.id}
              className="flex items-start justify-between gap-6 py-3"
            >
              <div>
                <p className="text-sm text-fg">{scope.label}</p>
                <p className="mt-0.5 text-xs text-fg-subtle">{scope.description}</p>
              </div>
              <Switch
                checked={draft[scope.id]}
                onChange={(value) => patch({ [scope.id]: value })}
                label={scope.label}
              />
            </div>
          ))}
        </CardBody>
      </Card>

      <UnsavedBar
        open={dirty}
        onReset={reset}
        onSave={() => {
          commit();
          toast({ title: "Scopes saved" });
        }}
      />
    </ChatPage>
  );
}

export function ChatAutomations({ platform }: { platform: Platform }) {
  const [automations, setAutomations] = useState(chatAutomations);

  return (
    <ChatPage
      platform={platform}
      title="Automations"
      description={`Rules that post to ${platform} when something happens in a review.`}
    >
      <div className="space-y-2">
        {automations.map((automation) => (
          <Card key={automation.id}>
            <CardBody className="flex flex-wrap items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg">{automation.name}</p>
                <p className="mt-1 text-xs text-fg-subtle">
                  <span className="text-fg-faint">When</span> {automation.trigger}
                  <span className="mx-1.5 text-fg-faint">→</span>
                  <span className="text-fg-faint">then</span> {automation.action}
                </p>
              </div>
              <Switch
                checked={automation.enabled}
                disabled
                onChange={(value) =>
                  setAutomations((current) =>
                    current.map((entry) =>
                      entry.id === automation.id
                        ? { ...entry, enabled: value }
                        : entry,
                    ),
                  )
                }
                label={automation.name}
              />
            </CardBody>
          </Card>
        ))}
      </div>
      <p className="mt-3 text-xs text-fg-subtle">
        Automations stay switched off until {platform} is connected.
      </p>
    </ChatPage>
  );
}

export function ChatKnowledgeBase({ platform }: { platform: Platform }) {
  return (
    <ChatPage
      platform={platform}
      title="Knowledge base"
      description={`Let Acalys read pinned messages and channel history so answers in ${platform} match how your team actually works.`}
    >
      <Card>
        <CardHeader
          title="Indexed sources"
          description="Channels and threads Acalys reads before answering."
        />
        <CardBody>
          <ConnectGate platform={platform} surface="the knowledge base" />
        </CardBody>
      </Card>
    </ChatPage>
  );
}

export function ChatConnections({ platform }: { platform: Platform }) {
  return (
    <ChatPage
      platform={platform}
      title="Connections"
      description={`Map ${platform} channels to repositories so review activity lands where the right people are watching.`}
    >
      <TableShell>
        <Table>
          <thead>
            <tr>
              <Th>Channel</Th>
              <Th>Repository</Th>
              <Th>Events</Th>
              <Th align="right">Status</Th>
            </tr>
          </thead>
          <tbody>
            <TableEmpty colSpan={4}>
              No channels connected. Connect {platform} to map a channel to a
              repository.
            </TableEmpty>
          </tbody>
        </Table>
      </TableShell>
    </ChatPage>
  );
}

export function ChatSandbox({ platform }: { platform: Platform }) {
  const [prompt, setPrompt] = useState("");

  return (
    <ChatPage
      platform={platform}
      title="Sandbox"
      description={`Try a command against your real data without posting anything to ${platform}.`}
    >
      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader title="Prompt" description="What you would type in the channel." />
          <CardBody className="space-y-3">
            <Textarea
              rows={5}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="@Acalys what changed in acalys this week?"
            />
            <div className="flex justify-end">
              <Button variant="brand" disabled={!prompt.trim()}>
                Run in sandbox
              </Button>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Response" />
          <CardBody>
            <p className="py-8 text-center text-sm text-fg-subtle">
              Run a prompt to see the response Acalys would post.
            </p>
          </CardBody>
        </Card>
      </div>
    </ChatPage>
  );
}

export function ChatActivity({ platform }: { platform: Platform }) {
  return (
    <ChatPage
      platform={platform}
      title="Activity"
      description={`Every message Acalys has sent to or received from ${platform}.`}
    >
      <TableShell>
        <Table>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Channel</Th>
              <Th>Trigger</Th>
              <Th>Message</Th>
              <Th align="right">Status</Th>
            </tr>
          </thead>
          <tbody>
            <TableEmpty colSpan={5}>
              No activity yet. Once {platform} is connected, messages appear here.
            </TableEmpty>
          </tbody>
        </Table>
      </TableShell>
    </ChatPage>
  );
}

export function SlackPrAutoFix() {
  return (
    <ChatPage
      platform="Slack"
      title="PR auto fix"
      description="Ask Acalys in Slack to open a pull request that fixes a finding, and review the diff before it lands."
    >
      <div className="grid gap-3 lg:grid-cols-3">
        {[
          {
            step: "Ask",
            body: "React to a finding with :wrench: or reply `@Acalys fix this` in the thread.",
          },
          {
            step: "Review",
            body: "Acalys posts the proposed diff in Slack before touching the repository.",
          },
          {
            step: "Ship",
            body: "Approve in the thread and Acalys opens the pull request against the source branch.",
          },
        ].map((entry) => (
          <Card key={entry.step}>
            <CardBody>
              <p className="text-xs font-medium uppercase tracking-wide text-brand">
                {entry.step}
              </p>
              <p className="mt-2 text-sm leading-relaxed text-fg-muted">{entry.body}</p>
            </CardBody>
          </Card>
        ))}
      </div>
      <div className="mt-4">
        <ConnectGate platform="Slack" surface="PR auto fix" />
      </div>
    </ChatPage>
  );
}
