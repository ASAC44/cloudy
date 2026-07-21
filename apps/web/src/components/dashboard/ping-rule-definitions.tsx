"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Activity, CircleAlert, Pause, Pencil, Play, Plus, Trash2 } from "lucide-react";

import { deletePingRule, getPingRuleActivity, updatePingRuleStatus } from "@/app/(dashboard)/actions";
import { ProviderLogo } from "@/components/dashboard/connections/provider-logo";
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
import type { PingRuleSummary, RuleActivity } from "@/types/api";

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function PingRuleDefinitions({ initialRules }: { initialRules: PingRuleSummary[] }) {
  const [rules, setRules] = useState(initialRules);
  const [removing, setRemoving] = useState<PingRuleSummary | null>(null);
  const [error, setError] = useState("");
  const [activity, setActivity] = useState<{ ruleId: string; value: RuleActivity } | null>(null);
  const [activityLoading, setActivityLoading] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function remove() {
    if (!removing) return;
    const rule = removing;
    setError("");
    startTransition(async () => {
      const result = await deletePingRule(rule.id);
      if (result.error) {
        setError(result.error);
        return;
      }
      setRules((current) => current.filter(({ id }) => id !== rule.id));
      setRemoving(null);
      router.refresh();
    });
  }

  function changeStatus(rule: PingRuleSummary) {
    const status = rule.status === "active" ? "paused" : "active";
    setError("");
    startTransition(async () => {
      const result = await updatePingRuleStatus(rule.id, rule.revision, status);
      if (!result.rule) return setError(result.error ?? "The Ping status could not be changed.");
      setRules((current) => current.map((item) => item.id === rule.id
        ? { ...item, status: result.rule!.status, revision: result.rule!.revision, activated_at: result.rule!.activated_at }
        : item));
      router.refresh();
    });
  }

  function showActivity(rule: PingRuleSummary) {
    if (activity?.ruleId === rule.id) return setActivity(null);
    setActivityLoading(rule.id);
    startTransition(async () => {
      const result = await getPingRuleActivity(rule.id);
      setActivityLoading(null);
      if (!result.activity) return setError(result.error ?? "Activity could not be loaded.");
      setActivity({ ruleId: rule.id, value: result.activity });
    });
  }

  return (
    <section className="grid gap-8 border-b border-border py-10 md:grid-cols-[minmax(0,0.7fr)_minmax(22rem,1.3fr)] md:gap-16" aria-labelledby="ping-definitions-title">
      <div>
        <h2 id="ping-definitions-title" className="font-sans text-lg font-medium">Ping definitions</h2>
        <p className="mt-2 max-w-sm leading-6 text-muted-foreground">
          Active, paused, and attention-needed automations. Every write still waits for an exact Pod approval.
        </p>
        <Button className="mt-5" size="sm" nativeButton={false} render={<Link href="/home?chat=new" />}>
          <Plus />Add definition
        </Button>
      </div>

      <div>
        {error ? <p className="mb-4 border-y border-destructive/30 py-3 text-sm text-destructive">{error}</p> : null}
        <div className="divide-y divide-border border-y border-border">
          {rules.length ? rules.map((rule) => (
            <article key={rule.id} className="py-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-medium">{rule.title}</p>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">{rule.intent_summary}</p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="icon-sm" aria-label={`${rule.status === "active" ? "Pause" : "Resume"} ${rule.title}`} onClick={() => changeStatus(rule)} disabled={pending || rule.status === "needs_attention" || rule.schema_version !== 2}>
                    {rule.status === "active" ? <Pause /> : <Play />}
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`View activity for ${rule.title}`} onClick={() => showActivity(rule)} disabled={activityLoading === rule.id}>
                    <Activity />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`Edit ${rule.title}`} nativeButton={false} render={<Link href={`/home?edit=${rule.id}`} />}>
                    <Pencil />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`Delete ${rule.title}`} onClick={() => setRemoving(rule)}>
                    <Trash2 />
                  </Button>
                </div>
              </div>
              <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                <div className="flex items-center gap-2">
                  <ProviderLogo provider={rule.source.provider} className="size-4" />
                  <div className="min-w-0">
                    <dt className="text-caption uppercase tracking-[0.12em] text-muted-foreground">Source</dt>
                    <dd className="truncate">{rule.source.name}{rule.source.account_label ? ` · ${rule.source.account_label}` : ""}</dd>
                  </div>
                </div>
                <div>
                  <dt className="text-caption uppercase tracking-[0.12em] text-muted-foreground">Capability</dt>
                  <dd>{rule.capability_name}</dd>
                </div>
                <div>
                  <dt className="text-caption uppercase tracking-[0.12em] text-muted-foreground">Destination</dt>
                  <dd>{rule.destination.name}{rule.destination.available ? "" : " · unavailable"}</dd>
                </div>
                <div>
                  <dt className="text-caption uppercase tracking-[0.12em] text-muted-foreground">Status</dt>
                  <dd className={rule.status === "active" ? "text-emerald-700 dark:text-emerald-400" : rule.status === "needs_attention" ? "text-amber-700 dark:text-amber-300" : ""}>
                    {statusLabel(rule.status)}
                  </dd>
                </div>
                <div>
                  <dt className="text-caption uppercase tracking-[0.12em] text-muted-foreground">Last event</dt>
                  <dd>{rule.runtime?.last_event_at ? dateTime.format(new Date(rule.runtime.last_event_at)) : "None yet"}</dd>
                </div>
                <div>
                  <dt className="text-caption uppercase tracking-[0.12em] text-muted-foreground">Next check</dt>
                  <dd>{rule.status === "active" && rule.runtime?.next_run_at ? dateTime.format(new Date(rule.runtime.next_run_at)) : "—"}</dd>
                </div>
              </dl>
              <p className="mt-4 text-caption text-muted-foreground">
                {rule.action_capability_name ? `${rule.action_capability_name} only after Pod approval · ` : "Notification only · "}
                Updated {dateTime.format(new Date(rule.updated_at))}
              </p>
              {rule.status === "needs_attention" ? (
                <p className="mt-3 flex items-start gap-2 text-sm text-amber-700 dark:text-amber-300"><CircleAlert className="mt-0.5 size-4 shrink-0" />{rule.runtime?.last_error ?? "This Ping needs review before it can continue."}</p>
              ) : null}
              {activity?.ruleId === rule.id ? <ActivityTimeline activity={activity.value} /> : null}
            </article>
          )) : (
            <div className="py-8 text-center">
              <p className="font-medium">No definitions saved.</p>
              <p className="mt-1 text-sm text-muted-foreground">Describe what Cloudy should watch from Home.</p>
            </div>
          )}
        </div>
      </div>

      <AlertDialog open={Boolean(removing)} onOpenChange={(nextOpen) => { if (!nextOpen) setRemoving(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {removing?.title}?</AlertDialogTitle>
            <AlertDialogDescription>This stops the Ping, cancels pending requests, and removes its retained activity. Connected credentials stay in place.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep definition</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={remove} disabled={pending}>{pending ? "Deleting…" : "Delete"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function statusLabel(status: PingRuleSummary["status"]) {
  return status === "active" ? "Active" : status === "needs_attention" ? "Needs attention" : "Paused";
}

function ActivityTimeline({ activity }: { activity: RuleActivity }) {
  const items = [
    ...activity.events.map((event) => ({ id: event.id, at: event.occurred_at, label: `Event ${event.status.replaceAll("_", " ")}`, error: event.last_error })),
    ...activity.runs.map((run) => ({ id: run.id, at: run.created_at, label: `${run.stage} · ${run.outcome}`, error: run.error_message })),
  ].sort((left, right) => right.at.localeCompare(left.at)).slice(0, 12);
  return (
    <div className="mt-5 border-y border-border py-4">
      <p className="mb-3 text-caption font-medium uppercase tracking-[0.12em] text-muted-foreground">Recent activity</p>
      {items.length ? <ol className="space-y-3">{items.map((item) => (
        <li key={item.id} className="grid gap-1 text-sm sm:grid-cols-[10rem_1fr]">
          <time className="text-muted-foreground">{dateTime.format(new Date(item.at))}</time>
          <span>{item.label}{item.error ? ` · ${item.error}` : ""}</span>
        </li>
      ))}</ol> : <p className="text-sm text-muted-foreground">No events or runs yet.</p>}
    </div>
  );
}
