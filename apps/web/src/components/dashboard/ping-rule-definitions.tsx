"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Trash2 } from "lucide-react";

import { deletePingRule } from "@/app/(dashboard)/actions";
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
import type { PingRuleSummary } from "@/lib/api";

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function PingRuleDefinitions({ initialRules }: { initialRules: PingRuleSummary[] }) {
  const [rules, setRules] = useState(initialRules);
  const [removing, setRemoving] = useState<PingRuleSummary | null>(null);
  const [error, setError] = useState("");
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

  return (
    <section className="grid gap-8 border-b border-border py-10 md:grid-cols-[minmax(0,0.7fr)_minmax(22rem,1.3fr)] md:gap-16" aria-labelledby="ping-definitions-title">
      <div>
        <h2 id="ping-definitions-title" className="font-sans text-lg font-medium">Ping definitions</h2>
        <p className="mt-2 max-w-sm leading-6 text-muted-foreground">
          Saved monitoring intent and connected capabilities. These definitions are not running yet.
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
                  <dd>Saved · Not running yet</dd>
                </div>
              </dl>
              <p className="mt-4 text-caption text-muted-foreground">
                {rule.capability_safety === "unannotated" ? "MCP read behavior unverified · " : "Read capability verified · "}
                Updated {dateTime.format(new Date(rule.updated_at))}
              </p>
            </article>
          )) : (
            <div className="py-8 text-center">
              <p className="font-medium">No definitions saved.</p>
              <p className="mt-1 text-sm text-muted-foreground">Describe what Podex should watch from Home.</p>
            </div>
          )}
        </div>
      </div>

      <AlertDialog open={Boolean(removing)} onOpenChange={(nextOpen) => { if (!nextOpen) setRemoving(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {removing?.title}?</AlertDialogTitle>
            <AlertDialogDescription>This removes the saved definition. No external service data or credentials are deleted.</AlertDialogDescription>
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
