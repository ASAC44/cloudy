import { AutomationsManager } from "@/components/dashboard/automations-manager";
import { apiFetch } from "@/lib/api";
import type { AutomationKey } from "@/types/api";

export default async function AutomationsPage() {
  let keys: AutomationKey[] = [];
  let error = "";
  try {
    keys = (await apiFetch<{ keys: AutomationKey[] }>("/v1/automation-keys")).keys;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Automation keys are unavailable";
  }

  const apiBaseUrl = (
    process.env.PODEX_PUBLIC_API_URL ??
    process.env.PODEX_API_URL ??
    "http://localhost:3001"
  ).replace(/\/$/, "");

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-12 md:px-10 md:py-16">
      <header className="max-w-4xl border-b border-border pb-10">
        <p className="mb-4 font-mono text-caption tracking-[0.16em] text-muted-foreground uppercase">
          n8n · human in the loop
        </p>
        <h1 className="text-[clamp(2.5rem,6vw,4.5rem)] leading-none tracking-[-0.04em]">
          Approve your HITL nodes from Podex!
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground">
          Send an action to your Pod, pause n8n, then continue from the exact
          decision you made. Your workflow stays asleep while it waits.
        </p>
      </header>

      <AutomationsManager
        initialKeys={keys}
        initialError={error || undefined}
        apiBaseUrl={apiBaseUrl}
      />
    </div>
  );
}
