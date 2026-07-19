import Link from "next/link";

import { NewPingChat } from "@/components/dashboard/new-ping-button";
import { DashboardRefresh } from "@/components/dashboard/dashboard-refresh";
import { PairPodButton } from "@/components/dashboard/pair-pod-form";
import { PendingPingsTable } from "@/components/dashboard/pending-pings-table";
import { PodActionsMenu } from "@/components/dashboard/pod-actions-menu";
import { ScreenLayoutBoard } from "@/components/dashboard/screen-layout-board";
import { TestPingButton } from "@/components/dashboard/test-ping-button";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import type { ApprovalRequest, Pod } from "@/types/api";
import { relativeTime } from "@/lib/relative-time";
import { createClient } from "@/lib/supabase/server";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ chat?: string; connection?: string; edit?: string }>;
}) {
  const query = await searchParams;
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  const metadata = claims?.user_metadata;
  const metadataName = metadata?.full_name;
  const displayName =
    typeof metadataName === "string"
      ? metadataName
      : typeof claims?.email === "string"
        ? claims.email
        : "there";
  const userAvatarUrl = typeof metadata?.avatar_url === "string"
    ? metadata.avatar_url
    : typeof metadata?.picture === "string"
      ? metadata.picture
      : undefined;

  let pod: Pod | undefined;
  let pending: ApprovalRequest[] = [];
  let apiError = "";
  const [podsResult, requestsResult] = await Promise.allSettled([
    apiFetch<{ pods: Pod[] }>("/v1/pods"),
    apiFetch<{ requests: ApprovalRequest[] }>("/v1/requests?status=pending"),
  ]);
  if (podsResult.status === "fulfilled") pod = podsResult.value.pods[0];
  if (requestsResult.status === "fulfilled") pending = requestsResult.value.requests;
  const coreError = podsResult.status === "rejected"
    ? podsResult.reason
    : requestsResult.status === "rejected"
      ? requestsResult.reason
      : null;
  if (coreError) apiError = coreError instanceof Error ? coreError.message : "Podex API unavailable";
  const podOnline = Boolean(pod?.online);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 pt-16 pb-8 md:px-8 md:py-8">
      <DashboardRefresh />
      <header className="mb-6 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <h1 className="font-heading text-heading">Welcome, {displayName}!</h1>
        {pod ? (
          <NewPingChat
            podName={pod.name}
            userName={displayName}
            userAvatarUrl={userAvatarUrl}
            initialOpen={Boolean(query.chat || query.edit)}
            initialSessionId={query.chat && query.chat !== "new" ? query.chat : undefined}
            editingRuleId={query.edit}
            resumeError={query.connection === "error"}
          />
        ) : !apiError ? <PairPodButton /> : null}
      </header>

      {apiError ? (
        <p className="mb-6 border-y border-destructive/30 py-3 text-sm text-destructive">
          {apiError}. Check the API environment and Supabase migration.
        </p>
      ) : null}

      {pod ? (
        <div className="mb-10">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-muted/30 px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
              <span className="font-medium">{podOnline ? "Online" : "Offline"}</span>
              <span className="text-muted-foreground">{pod.name}</span>
              <span className="text-muted-foreground">
                {pod.last_seen_at ? (podOnline ? "Polling now" : "Not polling") : "Waiting for first poll"}
              </span>
              <span className="text-muted-foreground">
                {pod.last_seen_at ? `Last seen ${relativeTime(pod.last_seen_at)}` : "Not seen yet"}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <TestPingButton />
              <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/configure" />}>
                Pod settings
              </Button>
              <PodActionsMenu podId={pod.id} podName={pod.name} />
            </div>
          </div>
        </div>
      ) : null}

      <div className="mt-10">
        <ScreenLayoutBoard />
      </div>

      <PendingPingsTable pings={pending} />
    </div>
  );
}
