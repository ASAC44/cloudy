"use client";

import { useState, useTransition, type FormEvent, type ReactNode } from "react";
import { ArrowRight, Check, Copy, Download, KeyRound, Plus, Trash2 } from "lucide-react";
import Link from "next/link";

import {
  createAutomationKey,
  revokeAutomationKey,
} from "@/app/(dashboard)/actions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AutomationKey } from "@/types/api";

const requestBody = `{
  "title": "Approve production deploy",
  "source": "CI pipeline",
  "summary": "Deploy revision abc123 to production.",
  "risk": "high",
  "warnings": ["Customer-facing change"],
  "expires_in_minutes": 15,
  "callback_url": "https://example.com/cloudy/callbacks/run-123",
  "action": {
    "type": "deploy",
    "environment": "production",
    "revision": "abc123"
  }
}`;

const workflowSteps = [
  { label: "Your system", detail: "Prepare the exact action" },
  { label: "Cloudy approval", detail: "Send the exact payload", active: true },
  { label: "Callback", detail: "Receive terminal status" },
  { label: "Continue", detail: "Run only when approved" },
];

export function AutomationsManager({
  initialKeys,
  initialError,
  apiBaseUrl,
}: {
  initialKeys: AutomationKey[];
  initialError?: string;
  apiBaseUrl: string;
}) {
  const [keys, setKeys] = useState(initialKeys);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<AutomationKey | null>(null);
  const [notice, setNotice] = useState(initialError ?? "");
  const [noticeError, setNoticeError] = useState(Boolean(initialError));
  const [copied, setCopied] = useState("");
  const [pending, startTransition] = useTransition();
  const endpoint = `${apiBaseUrl}/v1/automation/approvals`;

  function changeCreateOpen(open: boolean) {
    if (pending) return;
    setCreateOpen(open);
    if (!open) {
      setName("");
      setCreatedToken(null);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const result = await createAutomationKey(name);
      if (result.error || !result.key || !result.token) {
        setNoticeError(true);
        setNotice(result.error ?? "Key could not be created");
        return;
      }
      setKeys((current) => [result.key!, ...current]);
      setCreatedToken(result.token);
      setNoticeError(false);
      setNotice(`${result.key.name} is ready.`);
    });
  }

  function revoke() {
    if (!revoking) return;
    startTransition(async () => {
      const result = await revokeAutomationKey(revoking.id);
      if (result.error) {
        setNoticeError(true);
        setNotice(result.error);
        return;
      }
      setKeys((current) => current.filter(({ id }) => id !== revoking.id));
      setNoticeError(false);
      setNotice(`${revoking.name} revoked.`);
      setRevoking(null);
    });
  }

  async function copy(value: string, id: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(id);
    } catch {
      setNoticeError(true);
      setNotice("Copy failed. Select the value and copy it manually.");
    }
  }

  return (
    <>
      <section className="border-b border-border py-10" aria-labelledby="workflow-title">
        <div className="mb-6 flex items-end justify-between gap-6">
          <div>
            <h2 id="workflow-title" className="font-sans text-lg font-medium">
              One decision, four steps
            </h2>
            <p className="mt-2 text-muted-foreground">
              Any HTTPS client can create an approval; Cloudy calls its private callback after the decision.
            </p>
          </div>
          <span className="hidden font-mono text-caption text-muted-foreground sm:block">
            POST → WAIT → RESUME
          </span>
        </div>
        <ol className="flex min-w-max items-stretch overflow-x-auto border-y border-border" aria-label="Automation approval flow">
          {workflowSteps.map((step, index) => (
            <li key={step.label} className="flex items-stretch">
              <div
                className={step.active
                  ? "min-w-44 border-l-2 border-clay bg-clay/8 px-5 py-5"
                  : "min-w-44 px-5 py-5"}
              >
                <span className="font-mono text-caption text-muted-foreground">0{index + 1}</span>
                <p className="mt-2 font-medium">{step.label}</p>
                <p className="mt-1 text-sm text-muted-foreground">{step.detail}</p>
              </div>
              {index < workflowSteps.length - 1 ? (
                <span
                  className={createdToken && index === 1
                    ? "automation-connector-pulse flex w-10 items-center justify-center text-clay"
                    : "flex w-10 items-center justify-center text-muted-foreground"}
                  aria-hidden="true"
                >
                  <ArrowRight className="size-4" />
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </section>

      {notice ? (
        <p
          className={noticeError
            ? "border-b border-destructive/30 py-4 text-sm text-destructive"
            : "border-b border-border py-4 text-sm text-clay"}
          role={noticeError ? "alert" : "status"}
        >
          {notice}
        </p>
      ) : null}

      <section className="grid gap-8 border-b border-border py-10 md:grid-cols-[minmax(0,0.7fr)_minmax(22rem,1.3fr)] md:gap-16" aria-labelledby="access-keys-title">
        <div>
          <h2 id="access-keys-title" className="font-sans text-lg font-medium">Access keys</h2>
          <p className="mt-2 max-w-sm leading-6 text-muted-foreground">
            Give each environment or automation system its own key so one integration can be revoked independently.
          </p>
          <Button className="mt-5" onClick={() => setCreateOpen(true)}>
            <Plus data-icon="inline-start" />
            Generate key
          </Button>
        </div>

        <div className="border-y border-border">
          {keys.length ? (
            <ul className="divide-y divide-border">
              {keys.map((key) => (
                <li key={key.id} className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground" aria-hidden="true">
                    <KeyRound className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{key.name}</p>
                    <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{key.prefix}••••••••</p>
                  </div>
                  <div className="text-sm text-muted-foreground sm:text-right">
                    <p>Created {formatDate(key.created_at)}</p>
                    <p className="mt-1">{key.last_used_at ? `Used ${formatDate(key.last_used_at)}` : "Never used"}</p>
                  </div>
                  <Button size="icon-sm" variant="ghost" aria-label={`Revoke ${key.name}`} onClick={() => setRevoking(key)}>
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="py-8">
              <p className="font-medium">No automation keys yet.</p>
              <p className="mt-1 text-sm text-muted-foreground">Generate one before making an approval API request.</p>
            </div>
          )}
        </div>
      </section>

      <section className="grid gap-8 border-b border-border py-10 md:grid-cols-[minmax(0,0.7fr)_minmax(22rem,1.3fr)] md:gap-16" aria-labelledby="n8n-title">
        <div>
          <p className="font-mono text-caption tracking-[0.14em] text-muted-foreground uppercase">Ready to import</p>
          <h2 id="n8n-title" className="mt-2 font-sans text-lg font-medium">n8n approval workflow</h2>
          <p className="mt-2 max-w-sm leading-6 text-muted-foreground">
            Start with the complete create, wait, approve-only branch, and safe-stop flow. The real action stays a placeholder until you finish the acceptance test.
          </p>
          <a
            className={buttonVariants({ variant: "outline", className: "mt-5" })}
            href="/examples/cloudy-n8n-approval.json"
            download
          >
            <Download data-icon="inline-start" />
            Download workflow
          </a>
        </div>

        <ol className="divide-y divide-border border-y border-border">
          <SetupStep number="01" title="Import and connect">
            <p className="text-sm leading-6 text-muted-foreground">
              Replace the example API host, then select a Header Auth credential whose <code className="font-mono text-foreground">Authorization</code> value is <code className="font-mono text-foreground">Bearer YOUR_CLOUDY_KEY</code>.
            </p>
          </SetupStep>
          <SetupStep number="02" title="Expose the Wait webhook">
            <p className="text-sm leading-6 text-muted-foreground">
              n8n must generate a public HTTPS resume URL. Self-hosted instances behind a proxy need <code className="font-mono text-foreground">WEBHOOK_URL</code> and <code className="font-mono text-foreground">N8N_PROXY_HOPS=1</code>.
            </p>
          </SetupStep>
          <SetupStep number="03" title="Test before adding the action">
            <p className="text-sm leading-6 text-muted-foreground">
              Run the workflow, decide on the Pod, and confirm only an approved callback reaches <strong className="font-medium text-foreground">Approved exact action</strong>. Then replace that placeholder with the real node.
            </p>
          </SetupStep>
        </ol>
      </section>

      <section className="grid gap-8 py-10 md:grid-cols-[minmax(0,0.7fr)_minmax(22rem,1.3fr)] md:gap-16" aria-labelledby="setup-title">
        <div>
          <h2 id="setup-title" className="font-sans text-lg font-medium">HTTP API setup</h2>
          <p className="mt-2 max-w-sm leading-6 text-muted-foreground">
            Use the same three-step contract from n8n, Zapier, Make, CI, an agent, or your own service.
          </p>
          <p className="mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
            See the <Link className="text-foreground underline underline-offset-4" href="/docs/development/automations">automation recipes</Link> for complete examples.
          </p>
        </div>

        <div className="divide-y divide-border border-y border-border">
          <SetupStep number="01" title="Authenticate">
            <p className="text-sm leading-6 text-muted-foreground">
              Store the generated key in your platform’s secret manager and send it as a bearer token.
            </p>
            <CopyRow label="Header name" value="Authorization" copied={copied === "header"} onCopy={() => copy("Authorization", "header")} />
            <CopyRow label="Header value" value="Bearer YOUR_CLOUDY_KEY" copied={copied === "credential"} onCopy={() => copy("Bearer YOUR_CLOUDY_KEY", "credential")} />
          </SetupStep>

          <SetupStep number="02" title="Send the approval">
            <p className="text-sm leading-6 text-muted-foreground">
              POST the exact action as JSON. Set <code className="font-mono text-foreground">Idempotency-Key</code> to a stable execution or job ID so retries cannot create duplicate approvals.
            </p>
            <CopyRow label="Endpoint" value={endpoint} copied={copied === "endpoint"} onCopy={() => copy(endpoint, "endpoint")} />
            <CodeBlock label="JSON body" value={requestBody} copied={copied === "body"} onCopy={() => copy(requestBody, "body")} />
          </SetupStep>

          <SetupStep number="03" title="Handle the result">
            <p className="text-sm leading-6 text-muted-foreground">
              Accept Cloudy’s POST at the private callback URL and continue only for <code className="font-mono text-foreground">approved</code>. Stop safely for rejected, expired, or cancelled results.
            </p>
            <CopyRow label="Status field" value="status" copied={copied === "status"} onCopy={() => copy("status", "status")} />
          </SetupStep>
        </div>
      </section>

      <Dialog open={createOpen} onOpenChange={changeCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{createdToken ? "Save your automation key" : "Generate an automation key"}</DialogTitle>
            <DialogDescription>
              {createdToken
                ? "This is the only time Cloudy will show the complete key. Save it in your secret manager before closing."
                : "Use a name that identifies the environment or automation system."}
            </DialogDescription>
          </DialogHeader>
          {createdToken ? (
            <div className="border-y border-border py-4">
              <div className="flex items-start gap-2">
                <code className="min-w-0 flex-1 break-all rounded-lg bg-muted px-3 py-3 font-mono text-xs leading-5">{createdToken}</code>
                <Button size="icon" variant="outline" aria-label="Copy automation key" onClick={() => copy(createdToken, "token")}>
                  {copied === "token" ? <Check /> : <Copy />}
                </Button>
              </div>
              <p className="mt-3 text-sm font-medium text-clay">Copy this key now. It cannot be recovered.</p>
            </div>
          ) : (
            <form id="create-automation-key" onSubmit={submit}>
              <Label htmlFor="automation-key-name">Key name</Label>
              <Input
                id="automation-key-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={80}
                autoFocus
                placeholder="Production CI"
                className="mt-3"
              />
            </form>
          )}
          <DialogFooter>
            {createdToken ? (
              <Button onClick={() => changeCreateOpen(false)}>I saved the key</Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => changeCreateOpen(false)} disabled={pending}>Cancel</Button>
                <Button type="submit" form="create-automation-key" disabled={pending || !name.trim()}>
                  {pending ? "Generating…" : "Generate key"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(revoking)} onOpenChange={(open) => !open && !pending && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {revoking?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Workflows using this key will immediately lose access. Existing pending approvals are not deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep key</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={pending} onClick={revoke}>
              {pending ? "Revoking…" : "Revoke key"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function SetupStep({ number, title, children }: { number: string; title: string; children: ReactNode }) {
  return (
    <div className="grid gap-4 py-6 sm:grid-cols-[3rem_1fr]">
      <span className="font-mono text-caption text-muted-foreground">{number}</span>
      <div>
        <h3 className="font-sans text-base font-medium">{title}</h3>
        <div className="mt-3 grid gap-3">{children}</div>
      </div>
    </div>
  );
}

function CopyRow({ label, value, copied, onCopy }: { label: string; value: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-3 border-t border-border pt-3">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-xs">{value}</code>
      <Button size="icon-xs" variant="ghost" aria-label={`Copy ${label}`} onClick={onCopy}>
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

function CodeBlock({ label, value, copied, onCopy }: { label: string; value: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="border-t border-border pt-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <Button size="xs" variant="ghost" onClick={onCopy}>
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-lg bg-muted p-4 font-mono text-xs leading-5"><code>{value}</code></pre>
    </div>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value));
}
