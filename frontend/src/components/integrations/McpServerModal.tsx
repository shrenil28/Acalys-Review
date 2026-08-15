import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils";

type AuthMethod = "none" | "oauth" | "api-key";

const authHelp: Record<AuthMethod, string> = {
  none: "No credentials are sent with requests to this server",
  oauth: "You'll be redirected to authenticate via OAuth",
  "api-key": "Provide an API key (sent as Authorization: Bearer <key>)",
};

const submitLabel: Record<AuthMethod, string> = {
  none: "Connect",
  oauth: "Connect with OAuth",
  "api-key": "Connect with API Token",
};

function Radio({ checked, label, onSelect }: { checked: boolean; label: string; onSelect: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={checked} onClick={onSelect}
      className="flex items-center gap-2 text-sm text-fg">
      <span className={cn("flex h-4 w-4 items-center justify-center rounded-full border transition-colors",
        checked ? "border-brand bg-brand" : "border-line-strong")}>
        {checked && <span className="h-1.5 w-1.5 rounded-full bg-canvas" />}
      </span>
      {label}
    </button>
  );
}

/** Prefilled when opened from a listed server, blank from "New MCP Server". */
export function McpServerModal({ open, onClose, preset }: {
  open: boolean; onClose: () => void; preset?: { name: string; host: string } | null;
}) {
  const toast = useToast();
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [guidance, setGuidance] = useState("");
  const [auth, setAuth] = useState<AuthMethod>("oauth");
  const [apiKey, setApiKey] = useState("");
  const [headers, setHeaders] = useState("");

  useEffect(() => {
    if (!open) return;
    setLabel(preset?.name ?? "");
    setUrl(preset ? `https://${preset.host}/mcp` : "");
    setGuidance(""); setApiKey(""); setHeaders(""); setAuth("oauth");
  }, [open, preset]);

  const submit = () => {
    if (!label.trim() || !url.trim()) {
      toast({ title: "Label and server URL are required", tone: "error" });
      return;
    }
    toast({
      title: `${label.trim()} connected`,
      description: `Authenticated with ${auth === "api-key" ? "an API key" : auth === "oauth" ? "OAuth" : "no credentials"}.`,
    });
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Add MCP Server"
      description="Connect to an MCP server by selecting your preferred authentication method."
      size="md"
      footer={<>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button variant="secondary" onClick={submit}>{submitLabel[auth]}</Button>
      </>}>
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-sm font-medium text-fg">Label</span>
            <Input value={label} onChange={(e) => setLabel(e.target.value)}
              placeholder="Server name" wrapperClassName="mt-1.5" />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-fg">Server URL</span>
            <Input value={url} onChange={(e) => setUrl(e.target.value)}
              placeholder="https://" wrapperClassName="mt-1.5" />
          </label>
        </div>

        <div>
          <span className="text-sm font-medium text-fg">
            Usage guidance <span className="text-fg-subtle">(Optional)</span>
          </span>
          <Textarea rows={3} maxLength={10000} value={guidance}
            onChange={(e) => setGuidance(e.target.value)} className="mt-1.5"
            placeholder="Outline how your team uses the information available through this server and how the context gathering agent can best leverage it." />
          <div className="mt-1.5 flex items-center justify-between text-xs text-fg-subtle">
            <span>Provide guidance for how to use this server</span>
            <span className="tabular-nums">{guidance.length}/10000</span>
          </div>
        </div>

        <div>
          <span className="text-sm font-medium text-fg">Authentication Method</span>
          <div role="radiogroup" className="mt-2 flex items-center gap-5">
            <Radio checked={auth === "none"} label="None" onSelect={() => setAuth("none")} />
            <Radio checked={auth === "oauth"} label="OAuth" onSelect={() => setAuth("oauth")} />
            <Radio checked={auth === "api-key"} label="API key" onSelect={() => setAuth("api-key")} />
          </div>
          <p className="mt-2 text-xs text-fg-subtle">{authHelp[auth]}</p>
        </div>

        {auth === "api-key" && (
          <label className="block">
            <span className="text-sm font-medium text-fg">API key</span>
            <Input value={apiKey} type="password" onChange={(e) => setApiKey(e.target.value)}
              placeholder="API key (without 'Bearer' prefix)" wrapperClassName="mt-1.5" />
          </label>
        )}

        <div>
          <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
            Additional Headers <span className="text-fg-subtle">(Optional)</span>
            <span title="Sent with every request to this server." className="inline-flex">
              <Info className="h-3 w-3 text-fg-faint" />
            </span>
          </span>
          <Textarea rows={3} value={headers} onChange={(e) => setHeaders(e.target.value)}
            className="mt-1.5 font-mono text-xs"
            placeholder={'{"x-api-key": "your-key", "X-API-Version": "v2"}'} />
          <p className="mt-1.5 text-xs leading-relaxed text-fg-subtle">
            Provide additional headers as a JSON object. Example:{" "}
            <code className="font-mono">{'{ "x-api-key": "key", "X-Version": "v2" }'}</code>.
            Max 8KB. Some headers are blocked for security.
          </p>
        </div>
      </div>
    </Modal>
  );
}
