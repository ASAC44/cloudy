import Link from "next/link";
import { Radio, Sparkles } from "lucide-react";

import { DashboardRefresh } from "@/components/dashboard/dashboard-refresh";
import { DemoMockLauncher } from "@/components/dashboard/demo-mock-launcher";
import { MascotControls } from "@/components/dashboard/mascot-controls";
import { PendingPingsTable } from "@/components/dashboard/pending-pings-table";
import { ScreenNavigationControls } from "@/components/dashboard/screen-navigation-controls";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import type { ApprovalRequest, Pod } from "@/types/api";

export default async function DemoPage() {
  let pod: Pod | undefined;
  let pending: ApprovalRequest[] = [];
  let apiError = "";
  const [podsResult, requestsResult] = await Promise.allSettled([
    apiFetch<{ pods: Pod[] }>("/v1/pods"),
    apiFetch<{ requests: ApprovalRequest[] }>("/v1/requests?status=pending"),
  ]);
  if (podsResult.status === "fulfilled") pod = podsResult.value.pods[0];
  if (requestsResult.status === "fulfilled") pending = requestsResult.value.requests;
  const failure = podsResult.status === "rejected" ? podsResult.reason : requestsResult.status === "rejected" ? requestsResult.reason : null;
  if (failure) apiError = failure instanceof Error ? failure.message : "Cloudy API unavailable";
  const online = Boolean(pod?.online);

  return (
    <main className="mx-auto w-full max-w-7xl px-5 pt-18 pb-12 md:px-10 md:py-10">
      <DashboardRefresh />
      <header className="mb-7 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.22em] text-clay">
            <Sparkles className="size-4" aria-hidden="true" />
            Pitch console
          </p>
          <h1 className="mt-3 max-w-3xl font-heading text-4xl leading-none tracking-tight md:text-6xl">Run the room from one screen.</h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground">Send a believable moment, direct the physical Pod, reveal the details, and land the decision without leaving this page.</p>
        </div>
        <div className="flex items-center gap-3 border-y border-border py-3 font-mono text-xs uppercase tracking-[0.14em]">
          <Radio className={`size-4 ${online ? "text-emerald-600" : "text-muted-foreground"}`} aria-hidden="true" />
          <span>{pod?.name ?? "No Pod"}</span>
          <span className="text-muted-foreground">·</span>
          <span className={online ? "text-emerald-700" : "text-muted-foreground"}>{online ? "Live" : "Offline"}</span>
          <span className="text-muted-foreground">· {pending.length} waiting</span>
        </div>
      </header>

      {apiError ? <p className="border-y border-destructive/30 py-3 text-sm text-destructive">{apiError}. Start the API before pitching.</p> : null}
      {!pod && !apiError ? (
        <div className="border-y border-border py-10">
          <h2 className="font-heading text-2xl">Pair a Pod before the pitch.</h2>
          <Button className="mt-5" render={<Link href="/home" />}>Open pairing</Button>
        </div>
      ) : null}

      {pod ? (
        <>
          <DemoMockLauncher online={online} />

          <div className="grid border-b border-border 2xl:grid-cols-[2fr_3fr] 2xl:divide-x 2xl:divide-border">
            <section className="min-w-0 px-5 py-5 md:px-7">
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-clay">2 · Give Cloudy a beat</p>
              <MascotControls podId={pod.id} online={online} />
            </section>
            <section className="min-w-0 px-5 py-5 md:px-7">
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-clay">3 · Reveal and decide</p>
              <ScreenNavigationControls podId={pod.id} online={online} requestId={pending.at(-1)?.id} />
            </section>
          </div>

          <section className="pt-8">
            <div className="mb-2 px-1">
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-clay">4 · Keep the queue clean</p>
            </div>
            <PendingPingsTable pings={pending} />
          </section>
        </>
      ) : null}
    </main>
  );
}
