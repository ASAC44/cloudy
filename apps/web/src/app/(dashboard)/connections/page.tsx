import Link from "next/link";

import { ConnectionsManager } from "@/components/dashboard/connections-manager";
import { OAuthChatResume } from "@/components/dashboard/new-ping-button";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import type { Connection } from "@/types/api";

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string; resume?: string; connect?: string }>;
}) {
  const query = await searchParams;
  let connections: Connection[] = [];
  let error = "";
  try {
    connections = (await apiFetch<{ connections: Connection[] }>("/v1/connections")).connections;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Connections are unavailable";
  }

  const oauthNotice = query.connected
    ? { type: "success" as const, text: `${providerName(query.connected)} connected.` }
    : query.error
      ? { type: "error" as const, text: "OAuth connection failed. Check the provider configuration and try again." }
      : undefined;

  return (
    <div className="mx-auto w-full max-w-6xl px-6 pt-16 pb-12 md:px-8 md:py-12">
      <OAuthChatResume connected={Boolean(query.connected)} failed={Boolean(query.error)} />
      <header className="mb-10 border-b border-border pb-10">
        <h1 className="text-[clamp(2.5rem,6vw,4.5rem)] leading-none tracking-[-0.04em]">Bring your tools to the Pod.</h1>
        <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground">
          Connect the services Podex may watch and use for approved actions. Every write still waits for an exact approval on your Pod.
        </p>
      </header>

      <ConnectionsManager
        initialConnections={connections}
        initialError={error || undefined}
        oauthNotice={oauthNotice}
        initialProvider={isProvider(query.connect) ? query.connect : undefined}
        resumeSessionId={query.resume}
      />
      {query.resume ? (
        <div className="mt-10 flex items-center justify-between gap-4 border-y border-border py-4">
          <p className="text-sm text-muted-foreground">Return when the required service is connected.</p>
          <Button size="sm" nativeButton={false} render={<Link href={`/home?chat=${encodeURIComponent(query.resume)}`} />}>
            Return to Ping setup
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function providerName(value: string) {
  return value === "github" ? "GitHub" : value === "gmail" ? "Gmail" : value === "google_calendar" ? "Google Calendar" : "Provider";
}

function isProvider(value?: string): value is Connection["provider"] {
  return Boolean(value && ["github", "gmail", "google_calendar", "vercel", "telegram", "linear", "stripe", "custom_mcp"].includes(value));
}
