import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Input";
import { Avatar, Switch } from "@/components/ui/Misc";
import { UnsavedBar, useUnsaved } from "@/components/ui/UnsavedBar";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { useToast } from "@/components/ui/Toast";
import { currentUser } from "@/lib/session";

type NotificationKey =
  | "reviewComplete"
  | "criticalFinding"
  | "weeklyDigest"
  | "productUpdates";

const notificationRows: [NotificationKey, string, string][] = [
  ["reviewComplete", "Review complete", "When a review finishes on a PR you authored."],
  ["criticalFinding", "Critical finding", "As soon as a critical security finding opens."],
  ["weeklyDigest", "Weekly digest", "A Monday summary of last week's review activity."],
  ["productUpdates", "Product updates", "Occasional notes about new Acalys features."],
];

export function SettingsPage() {
  const toast = useToast();
  const { draft, patch, dirty, reset, commit } = useUnsaved({
    name: currentUser.name,
    notifications: {
      reviewComplete: true,
      criticalFinding: true,
      weeklyDigest: false,
      productUpdates: false,
    } as Record<NotificationKey, boolean>,
  });

  return (
    <Page className="max-w-3xl">
      <PageHeader
        title="Settings"
        description="Your personal account. Organization-wide review behaviour lives in Review → Organization Settings."
      />

      <div className="mt-6 space-y-4 pb-16">
        <Card>
          <CardHeader title="Profile" />
          <CardBody className="space-y-4">
            <div className="flex items-center gap-4">
              <Avatar src={currentUser.avatarUrl} name={currentUser.name} size={56} />
              <div>
                <p className="text-sm text-fg">{currentUser.name}</p>
                <p className="mt-0.5 text-xs text-fg-subtle">
                  Synced from your GitHub account
                </p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Display name">
                <Input
                  value={draft.name}
                  onChange={(event) => patch({ name: event.target.value })}
                />
              </Field>
              <Field label="Email" hint="Managed by your identity provider.">
                <Input value={currentUser.email} readOnly className="text-fg-subtle" />
              </Field>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Notifications"
            description="Where Acalys reaches you outside the dashboard."
          />
          <CardBody className="divide-y divide-line py-0">
            {notificationRows.map(([key, title, description]) => (
              <div key={key} className="flex items-start justify-between gap-6 py-3">
                <div>
                  <p className="text-sm text-fg">{title}</p>
                  <p className="mt-0.5 text-xs text-fg-subtle">{description}</p>
                </div>
                <Switch
                  checked={draft.notifications[key]}
                  onChange={(value) =>
                    patch({ notifications: { ...draft.notifications, [key]: value } })
                  }
                  label={title}
                />
              </div>
            ))}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Danger zone"
            description="Leaving removes your access to every repository in this organization."
          />
          <CardBody>
            <Button variant="danger">Leave organization</Button>
          </CardBody>
        </Card>
      </div>

      <UnsavedBar
        open={dirty}
        onReset={reset}
        onSave={() => {
          commit();
          toast({ title: "Profile saved" });
        }}
      />
    </Page>
  );
}
