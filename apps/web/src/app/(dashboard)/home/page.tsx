import { NewPingChat } from "@/components/dashboard/new-ping-button";
import { DashboardRefresh } from "@/components/dashboard/dashboard-refresh";
import { PairPodButton } from "@/components/dashboard/pair-pod-form";
import { PendingPingsTable } from "@/components/dashboard/pending-pings-table";
import { MascotControls } from "@/components/dashboard/mascot-controls";
import { ScreenNavigationControls } from "@/components/dashboard/screen-navigation-controls";
import { ScreenLayoutBoard } from "@/components/dashboard/screen-layout-board";
import { TestPingButton } from "@/components/dashboard/test-ping-button";
import { apiFetch } from "@/lib/api";
import type { ApprovalRequest, CodexOverview, Connection, Pod } from "@/types/api";
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
  let connections: Connection[] = [];
  let codex: CodexOverview = { bridges: [], workspaces: [], threads: [], target: null, voice_ready: false };
  let apiError = "";
  const [podsResult, requestsResult, connectionsResult, codexResult] = await Promise.allSettled([
    apiFetch<{ pods: Pod[] }>("/v1/pods"),
    apiFetch<{ requests: ApprovalRequest[] }>("/v1/requests?status=pending"),
    apiFetch<{ connections: Connection[] }>("/v1/connections"),
    apiFetch<CodexOverview>("/v1/codex"),
  ]);
  if (podsResult.status === "fulfilled") pod = podsResult.value.pods[0];
  if (requestsResult.status === "fulfilled") pending = requestsResult.value.requests;
  if (connectionsResult.status === "fulfilled") connections = connectionsResult.value.connections;
  if (codexResult.status === "fulfilled") codex = codexResult.value;
  const coreError = podsResult.status === "rejected"
    ? podsResult.reason
    : requestsResult.status === "rejected"
      ? requestsResult.reason
      : null;
  if (coreError) apiError = coreError instanceof Error ? coreError.message : "Cloudy API unavailable";
  const podOnline = Boolean(pod?.online);

  return (
    <div className="mx-auto w-full max-w-6xl px-7 pt-18 pb-10 md:px-10 md:py-10">
      <DashboardRefresh />
      <header className="mb-6 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <h1 className="font-heading text-heading">Welcome, {displayName}!</h1>
        {pod ? (
          <div className="flex flex-wrap items-center gap-2">
            <TestPingButton />
            <NewPingChat
              podName={pod.name}
              userName={displayName}
              userAvatarUrl={userAvatarUrl}
              initialOpen={Boolean(query.chat || query.edit)}
              initialSessionId={query.chat && query.chat !== "new" ? query.chat : undefined}
              editingRuleId={query.edit}
              resumeError={query.connection === "error"}
            />
          </div>
        ) : !apiError ? <PairPodButton /> : null}
      </header>

      {apiError ? (
        <p className="mb-6 border-y border-destructive/30 py-3 text-sm text-destructive">
          {apiError}. Check the API environment and Supabase migration.
        </p>
      ) : null}

      {pod ? (
        <div className="mb-10">
          <MascotControls podId={pod.id} online={podOnline} />
          <ScreenNavigationControls podId={pod.id} online={podOnline} requestId={pending.at(-1)?.id} />
        </div>
      ) : null}

      {pod ? (
        <div className="mt-10">
          <ScreenLayoutBoard
            podId={pod.id}
            initialLayout={pod.screen_layout}
            initialRevision={pod.screen_layout_revision}
            connections={connections}
            codex={codex}
          />
        </div>
      ) : null}

      <PendingPingsTable pings={pending} />
    </div>
  );
}
