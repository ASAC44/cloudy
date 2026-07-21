"use client";

import { useState, useTransition, type FormEvent, type ReactNode } from "react";
import { ArrowRight, Check, Copy, KeyRound, Plus, Trash2 } from "lucide-react";

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
import { Button } from "@/components/ui/button";
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
  "title": "Approve {{$json.action}}",
  "summary": "{{$json.summary}}",
  "risk": "medium",
  "warnings": [],
  "expires_in_minutes": 15,
  "callback_url": "{{$execution.resumeUrl}}",
  "action": {{$json}}
}`;

const workflowSteps = [
  { label: "n8n action", detail: "Prepare the write" },
  { label: "Cloudy approval", detail: "Send the exact payload", active: true },
  { label: "Wait", detail: "Pause on webhook" },
  { label: "Continue", detail: "Branch on status" },
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
              n8n supplies a private resume URL; Cloudy calls it after your decision.
            </p>
          </div>
          <span className="hidden font-mono text-caption text-muted-foreground sm:block">
            POST → WAIT → RESUME
          </span>
        </div>
        <ol className="flex min-w-max items-stretch overflow-x-auto border-y border-border" aria-label="n8n approval flow">
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
            Give each n8n environment its own key so you can revoke access without disturbing another workflow.
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
              <p className="mt-1 text-sm text-muted-foreground">Generate one before configuring the HTTP Request node.</p>
            </div>
          )}
        </div>
      </section>

      <section className="grid gap-8 py-10 md:grid-cols-[minmax(0,0.7fr)_minmax(22rem,1.3fr)] md:gap-16" aria-labelledby="setup-title">
        <div>
          <h2 id="setup-title" className="font-sans text-lg font-medium">n8n setup</h2>
          <p className="mt-2 max-w-sm leading-6 text-muted-foreground">
            Configure three built-in nodes. Expressions keep every field connected to the current execution.
          </p>
          <p className="mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
            Self-hosted n8n must set <code className="font-mono text-foreground">WEBHOOK_URL</code> to its public HTTPS origin.
          </p>
        </div>

        <div className="divide-y divide-border border-y border-border">
          <SetupStep number="01" title="Create the credential">
            <p className="text-sm leading-6 text-muted-foreground">
              Add a Header Auth credential. Name it Cloudy, set the header to <code className="font-mono text-foreground">Authorization</code>, and use <code className="font-mono text-foreground">Bearer YOUR_CLOUDY_KEY</code> as its value.
            </p>
            <CopyRow label="Header name" value="Authorization" copied={copied === "header"} onCopy={() => copy("Authorization", "header")} />
            <CopyRow label="Header value" value="Bearer YOUR_CLOUDY_KEY" copied={copied === "credential"} onCopy={() => copy("Bearer YOUR_CLOUDY_KEY", "credential")} />
          </SetupStep>

          <SetupStep number="02" title="Send the approval">
            <p className="text-sm leading-6 text-muted-foreground">
              Add an HTTP Request node with POST, the Cloudy credential, JSON body mode, and an <code className="font-mono text-foreground">Idempotency-Key</code> header set to <code className="font-mono text-foreground">{"{{$execution.id}}"}</code>.
            </p>
            <CopyRow label="Endpoint" value={endpoint} copied={copied === "endpoint"} onCopy={() => copy(endpoint, "endpoint")} />
            <CodeBlock label="JSON body" value={requestBody} copied={copied === "body"} onCopy={() => copy(requestBody, "body")} />
          </SetupStep>

          <SetupStep number="03" title="Wait, then branch">
            <p className="text-sm leading-6 text-muted-foreground">
              Add a Wait node set to On Webhook Call, POST, and Respond Immediately. Then add a Switch node using <code className="font-mono text-foreground">{"{{$json.body.status}}"}</code> for approved, rejected, expired, and cancelled paths.
            </p>
            <CopyRow label="Switch expression" value="{{$json.body.status}}" copied={copied === "switch"} onCopy={() => copy("{{$json.body.status}}", "switch")} />
          </SetupStep>
        </div>
      </section>

      <Dialog open={createOpen} onOpenChange={changeCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{createdToken ? "Save your automation key" : "Generate an automation key"}</DialogTitle>
            <DialogDescription>
              {createdToken
                ? "This is the only time Cloudy will show the complete key. Save it in n8n before closing."
                : "Use a name that identifies the n8n environment or workflow group."}
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
                placeholder="Production n8n"
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
