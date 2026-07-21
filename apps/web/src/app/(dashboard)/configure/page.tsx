import { Button } from "@/components/ui/button";
import { PingRuleDefinitions } from "@/components/dashboard/ping-rule-definitions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api";
import type { PingRuleSummary } from "@/types/api";

export default async function ConfigurePage() {
  let rules: PingRuleSummary[] = [];
  let rulesError = "";
  try {
    rules = (await apiFetch<{ rules: PingRuleSummary[] }>("/v1/rules")).rules;
  } catch (error) {
    rulesError = error instanceof Error ? error.message : "Ping definitions could not be loaded";
  }

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
                <Label htmlFor="dictation">Dictated corrections · coming later</Label>
                <p className="mt-2 text-sm leading-5 text-muted-foreground">
                  Microphone input and rejection reasons are outside this milestone.
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
            <div className="flex items-center justify-between gap-6 py-5">
              <div>
                <Label htmlFor="personalization">
                  Personalize drafted replies
                </Label>
                <p className="mt-2 text-sm leading-5 text-muted-foreground">
                  Use approved replies, corrections, relationships, and writing
                  preferences to sound like you.
                </p>
              </div>
              <Switch id="personalization" defaultChecked />
            </div>

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
    </div>
  );
}
