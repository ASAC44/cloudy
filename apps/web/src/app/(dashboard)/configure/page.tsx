import { Button } from "@/components/ui/button";
import { PingRuleDefinitions } from "@/components/dashboard/ping-rule-definitions";
import { PersonalizationManager } from "@/components/dashboard/personalization-manager";
import { MemoryControls } from "@/components/dashboard/memory-controls";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api";
import type { AgentMemory, AiSettings, Connection, MemoryImport, MemoryPerson, PingRuleSummary } from "@/types/api";

export default async function ConfigurePage() {
  let rules: PingRuleSummary[] = [];
  let memories: AgentMemory[] = [];
  let aiSettings: AiSettings | null = null;
  let connections: Connection[] = [];
  let imports: MemoryImport[] = [];
  let people: MemoryPerson[] = [];
  let rulesError = "";
  const [rulesResult, memoriesResult, settingsResult, connectionsResult, importsResult, peopleResult] = await Promise.allSettled([
    apiFetch<{ rules: PingRuleSummary[] }>("/v1/rules"),
    apiFetch<{ memories: AgentMemory[] }>("/v1/memories?limit=50"),
    apiFetch<{ settings: AiSettings | null }>("/v1/settings/ai"),
    apiFetch<{ connections: Connection[] }>("/v1/connections"),
    apiFetch<{ imports: MemoryImport[] }>("/v1/memory/imports"),
    apiFetch<{ people: MemoryPerson[] }>("/v1/memory/people"),
  ]);
  if (rulesResult.status === "fulfilled") rules = rulesResult.value.rules;
  else rulesError = rulesResult.reason instanceof Error ? rulesResult.reason.message : "Ping definitions could not be loaded";
  if (memoriesResult.status === "fulfilled") memories = memoriesResult.value.memories.filter((memory) => ["preference", "writing_sample", "correction"].includes(String(memory.source.kind)));
  if (settingsResult.status === "fulfilled") aiSettings = settingsResult.value.settings;
  if (connectionsResult.status === "fulfilled") connections = connectionsResult.value.connections;
  if (importsResult.status === "fulfilled") imports = importsResult.value.imports;
  if (peopleResult.status === "fulfilled") people = peopleResult.value.people;

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-12 md:px-10 md:py-16">
      <header className="flex flex-col gap-8 border-b border-border pb-10 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-2xl">
          <h1 className="text-[clamp(2.5rem,6vw,4.5rem)] leading-none tracking-[-0.04em]">
            Make Cloudy work your way.
          </h1>
          <p className="mt-5 max-w-xl text-base leading-7 text-muted-foreground">
            Set what needs approval, how the Pod behaves, and how much
            context agents may use before asking you.
          </p>
        </div>
        <Button type="button" className="hover:bg-primary/85">
          Save changes
        </Button>
      </header>

      {rulesError ? (
        <section className="grid gap-8 border-b border-border py-10 md:grid-cols-[minmax(0,0.7fr)_minmax(22rem,1.3fr)] md:gap-16">
          <div>
            <h2 className="font-sans text-lg font-medium">Ping definitions</h2>
            <p className="mt-2 max-w-sm leading-6 text-muted-foreground">Your active and paused Ping automations.</p>
          </div>
          <p className="border-y border-destructive/30 py-3 text-sm text-destructive">{rulesError}</p>
        </section>
      ) : <PingRuleDefinitions initialRules={rules} />}

      <form>
        <section className="grid gap-8 border-b border-border py-10 md:grid-cols-[minmax(0,0.7fr)_minmax(22rem,1.3fr)] md:gap-16">
          <div>
            <h2 className="font-sans text-lg font-medium">Approval rules</h2>
            <p className="mt-2 max-w-sm leading-6 text-muted-foreground">
              Decide which actions can run automatically and when Cloudy must
              stop for your decision.
            </p>
          </div>

          <div className="divide-y divide-border border-y border-border">
            <div className="flex items-center justify-between gap-6 py-5">
              <div>
                <Label htmlFor="write-approval">Approve every write action</Label>
                <p className="mt-2 text-sm leading-5 text-muted-foreground">
                  Sending, creating, merging, deleting, and permission changes
                  always wait for you.
                </p>
              </div>
              <Switch id="write-approval" defaultChecked />
            </div>

            <div className="flex items-center justify-between gap-6 py-5">
              <div>
                <Label htmlFor="read-context">Allow read-only context</Label>
                <p className="mt-2 text-sm leading-5 text-muted-foreground">
                  Agents may read connected services to prepare a decision
                  brief without asking first.
                </p>
              </div>
              <Switch id="read-context" defaultChecked />
            </div>

            <div className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <Label htmlFor="request-expiry">Request expiry</Label>
                <p className="mt-2 text-sm leading-5 text-muted-foreground">
                  Unanswered actions expire instead of running later.
                </p>
              </div>
              <NativeSelect
                id="request-expiry"
                defaultValue="15"
                className="w-full sm:w-48"
              >
                <NativeSelectOption value="5">5 minutes</NativeSelectOption>
                <NativeSelectOption value="15">15 minutes</NativeSelectOption>
                <NativeSelectOption value="30">30 minutes</NativeSelectOption>
                <NativeSelectOption value="60">1 hour</NativeSelectOption>
              </NativeSelect>
            </div>
          </div>
        </section>

        <section className="grid gap-8 border-b border-border py-10 md:grid-cols-[minmax(0,0.7fr)_minmax(22rem,1.3fr)] md:gap-16">
          <div>
            <h2 className="font-sans text-lg font-medium">Pod behavior</h2>
            <p className="mt-2 max-w-sm leading-6 text-muted-foreground">
              Choose what appears on your keychain and how it handles the
              approval queue.
            </p>
          </div>

          <div className="divide-y divide-border border-y border-border">
            <div className="py-5">
              <Label htmlFor="pod-name">Pod name</Label>
              <Input
                id="pod-name"
                name="pod-name"
                defaultValue="My Pod"
                className="mt-3 max-w-sm"
              />
            </div>

            <div className="flex items-center justify-between gap-6 py-5">
              <div>
                <Label htmlFor="dictation">Pod-dictated corrections · coming later</Label>
                <p className="mt-2 text-sm leading-5 text-muted-foreground">
                  Dashboard text corrections are available now; microphone corrections remain outside this milestone.
                </p>
              </div>
              <Switch id="dictation" disabled />
            </div>

            <div className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium">Queue order</p>
                <p className="mt-2 text-sm leading-5 text-muted-foreground">
                  Pings stay in arrival order across every attached app.
                </p>
              </div>
              <span className="text-sm text-muted-foreground">Oldest Ping first</span>
            </div>
          </div>
        </section>

        <section className="grid gap-8 border-b border-border py-10 md:grid-cols-[minmax(0,0.7fr)_minmax(22rem,1.3fr)] md:gap-16">
          <div>
            <h2 className="font-sans text-lg font-medium">AI behavior</h2>
            <p className="mt-2 max-w-sm leading-6 text-muted-foreground">
              Control how Cloudy drafts responses and handles uncertainty.
            </p>
          </div>

          <div className="divide-y divide-border border-y border-border">
            <PersonalizationManager
              initialMemories={memories}
              initialEnabled={aiSettings?.personalization_enabled ?? false}
              configured={Boolean(aiSettings)}
            />

            <div className="flex items-center justify-between gap-6 py-5">
              <div>
                <Label htmlFor="live-calendar">Check live calendar context</Label>
                <p className="mt-2 text-sm leading-5 text-muted-foreground">
                  Verify current availability before drafting scheduling
                  responses.
                </p>
              </div>
              <Switch id="live-calendar" defaultChecked />
            </div>

            <div className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <Label htmlFor="low-confidence">When confidence is low</Label>
                <p className="mt-2 text-sm leading-5 text-muted-foreground">
                  Never invent a missing fact or commitment.
                </p>
              </div>
              <NativeSelect
                id="low-confidence"
                defaultValue="ask"
                className="w-full sm:w-56"
              >
                <NativeSelectOption value="ask">Ask one question</NativeSelectOption>
                <NativeSelectOption value="draft">Show a marked draft</NativeSelectOption>
                <NativeSelectOption value="reject">Recommend rejection</NativeSelectOption>
              </NativeSelect>
            </div>
          </div>
        </section>

        <div className="flex flex-wrap justify-end gap-3 py-8">
          <Button type="reset" variant="outline" className="!text-foreground">
            Reset
          </Button>
          <Button type="button" className="hover:bg-primary/85">
            Save changes
          </Button>
        </div>
      </form>

      <section className="grid gap-8 border-b border-border py-10 md:grid-cols-[minmax(0,0.7fr)_minmax(22rem,1.3fr)] md:gap-16">
        <div>
          <h2 className="font-sans text-lg font-medium">Memory controls</h2>
          <p className="mt-2 max-w-sm leading-6 text-muted-foreground">Choose what Cloudy may learn, inspect its verified people, and remove memory at any scope.</p>
        </div>
        <MemoryControls
          connections={connections.filter((connection): connection is Connection & { provider: "gmail" | "telegram" } => ["gmail", "telegram"].includes(connection.provider))}
          imports={imports}
          people={people}
          learnedActionsEnabled={aiSettings?.learned_actions_enabled ?? false}
          configured={Boolean(aiSettings)}
        />
      </section>
    </div>
  );
}
