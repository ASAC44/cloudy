import { CodexManager } from "@/components/dashboard/codex-manager";
import { apiFetch } from "@/lib/api";
import type { CodexOverview } from "@/types/api";

export default async function CodexPage() {
  let overview: CodexOverview = { bridges: [], workspaces: [], threads: [], target: null, voice_ready: false };
  let error = "";
  try {
    overview = await apiFetch<CodexOverview>("/v1/codex");
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Codex connections are unavailable";
  }
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-12 md:px-10 md:py-16">
      <header className="border-b border-border pb-10">
        <p className="mb-4 font-mono text-caption tracking-[0.16em] text-muted-foreground uppercase">Local Codex · human controlled</p>
        <h1 className="text-[clamp(2.5rem,6vw,4.5rem)] leading-none tracking-[-0.04em]">Vibecode from your Pod.</h1>
        <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground">Pair the bridge running beside your repositories, choose the active session here, then plan, revise, and approve work from Podex.</p>
      </header>
      <CodexManager key={`${overview.target?.revision ?? 0}:${overview.bridges.length}:${overview.workspaces.length}:${overview.threads.map((thread) => thread.updated_at).join(",")}`} initial={overview} initialError={error || undefined} />
    </div>
  );
}
