import { useState } from "react";
import { Copy, ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";

export function CircleCiModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [token, setToken] = useState("");

  return (
    <Modal open={open} onClose={onClose} title="Connect CircleCI" size="md"
      footer={<>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button variant="secondary" disabled={!token.trim()}
          onClick={() => { toast({ title: "CircleCI connected" }); setToken(""); onClose(); }}>
          Connect
        </Button>
      </>}>
      <p className="text-sm text-fg-muted">
        Generate a CircleCI Personal API Token and paste it below to connect.
      </p>
      <label className="mt-5 block">
        <span className="text-sm font-medium text-fg">API Token</span>
        <Input value={token} type="password" onChange={(e) => setToken(e.target.value)}
          placeholder="Enter your CircleCI API token" wrapperClassName="mt-1.5" />
      </label>
      <p className="mt-2.5 text-xs leading-relaxed text-fg-subtle">
        Create one at{" "}
        <a href="https://app.circleci.com/settings/user/tokens" target="_blank" rel="noreferrer"
          className="text-brand hover:underline">CircleCI User Settings → Personal API Tokens</a>.
        Give it any name (e.g. "Acalys Integration") and copy the generated token here.
      </p>
    </Modal>
  );
}

/** Secret is regenerated each time the dialog opens, mirroring the 15-minute TTL. */
export function JiraInstallModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [secret] = useState(
    () => `acl_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`,
  );

  const steps = [
    "Copy the secret above.",
    "Open Atlassian Installation and install the Acalys Forge app.",
    "In your App Admin Settings → Acalys, paste the secret and complete setup.",
    "Come back and refresh status to confirm.",
  ];

  return (
    <Modal open={open} onClose={onClose} title="Install Jira Cloud Integration" size="md"
      footer={<>
        <Button variant="outline" onClick={onClose}>Close</Button>
        <Button size="icon" variant="ghost" aria-label="Refresh status"
          onClick={() => toast({ title: "Status refreshed", description: "Still awaiting installation.", tone: "info" })}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        <a href="https://developer.atlassian.com/console/myapps/" target="_blank" rel="noreferrer"
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--cr-hover)] px-3 text-sm font-medium text-fg transition-colors hover:bg-[var(--cr-active)]">
          <ExternalLink className="h-3.5 w-3.5" />
          Open Atlassian Installation
        </a>
      </>}>
      <p className="text-sm text-fg-muted">
        Install the Acalys Forge app in Atlassian, then return here to refresh your
        integration status.
      </p>

      <div className="mt-5">
        <span className="text-sm font-medium text-fg">Installation Secret</span>
        <div className="mt-1.5 flex items-center gap-2">
          <Input value={secret} readOnly className="font-mono text-xs" wrapperClassName="flex-1" />
          <Button size="icon" variant="outline" aria-label="Copy installation secret"
            onClick={() => {
              navigator.clipboard?.writeText(secret);
              toast({ title: "Secret copied" });
            }}>
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </div>
        <p className="mt-2 text-xs text-fg-subtle">
          Expires in 15 minutes. Paste this in the Acalys app's settings inside Jira
          after installation.
        </p>
      </div>

      <ol className="mt-4 space-y-1.5 text-sm text-fg-muted">
        {steps.map((step, index) => (
          <li key={step} className="flex gap-2">
            <span className="tabular-nums text-fg-subtle">{index + 1}.</span>
            {step}
          </li>
        ))}
      </ol>
    </Modal>
  );
}
