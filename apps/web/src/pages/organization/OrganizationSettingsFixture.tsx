import { currentUser } from "@/lib/session";
import { defaultOrgConfig } from "@/features/review-settings/model";
import { OrganizationSettingsEditor } from "./OrganizationSettingsEditor";

export function OrganizationSettingsPage() {
  return (
    <OrganizationSettingsEditor
      initialConfig={defaultOrgConfig}
      repositoryLabel="shrenil28"
      previewAuthor={{ name: currentUser.handle, avatarUrl: currentUser.avatarUrl }}
    />
  );
}
