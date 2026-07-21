"use client";

import { useActionState, useState } from "react";
import { Activity, GitPullRequest, Mail, Rocket, TerminalSquare } from "lucide-react";

import { createPing } from "@/app/(dashboard)/actions";
import { MOCK_NOTIFICATIONS, type MockNotificationType, type MockScreen } from "@/components/dashboard/mock-notifications";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const icons = { general: Activity, github: GitPullRequest, deployment: Rocket, gmail: Mail, codex: TerminalSquare } as const;

export function DemoMockLauncher({ online }: { online: boolean }) {
  const [state, action, pending] = useActionState(createPing, {});
  const [screen, setScreen] = useState<MockScreen>("down");

  return (
    <section aria-labelledby="demo-scenarios" className="border-y border-border bg-clay/5">
      <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-end sm:justify-between md:px-7">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-clay">1 · Send the moment</p>
          <h2 id="demo-scenarios" className="mt-1 font-heading text-2xl">Choose the story you want to tell</h2>
          <p className="mt-1 text-sm text-muted-foreground" aria-live="polite">
            {pending ? "Sending to Cloudy…" : state.error ?? state.success ?? "Each scenario uses the real approval path."}
          </p>
        </div>
        <div className="grid min-w-56 gap-2">
          <Label htmlFor="demo-screen">Open on</Label>
          <Select value={screen} onValueChange={(value) => value && setScreen(value as MockScreen)}>
            <SelectTrigger id="demo-screen"><SelectValue /></SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="left">Screen 1 · Left</SelectItem>
              <SelectItem value="down">Screen 2 · Default</SelectItem>
              <SelectItem value="right">Screen 3 · Right</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid border-t border-border sm:grid-cols-2 xl:grid-cols-5">
        {(Object.entries(MOCK_NOTIFICATIONS) as Array<[MockNotificationType, typeof MOCK_NOTIFICATIONS[MockNotificationType]]>).map(([type, notification]) => {
          const Icon = icons[type];
          return (
            <form key={type} action={action} className="border-b border-border sm:odd:border-r xl:border-b-0 xl:not-last:border-r">
              <input type="hidden" name="mock_type" value={type} />
              <input type="hidden" name="screen" value={screen} />
              <input type="hidden" name="title" value={notification.title} />
              <input type="hidden" name="source" value={notification.source} />
              <input type="hidden" name="summary" value={notification.summary} />
              <input type="hidden" name="details" value={notification.details} />
              <input type="hidden" name="affected_context" value={notification.context} />
              <input type="hidden" name="risk" value={notification.risk} />
              <input type="hidden" name="warnings" value={notification.warnings} />
              <input type="hidden" name="expires_in_minutes" value="5" />
              <Button
                type="submit"
                variant="ghost"
                disabled={!online || pending}
                className="h-full min-h-44 w-full items-start justify-start rounded-none px-5 py-5 text-left md:px-7"
              >
                <span className="grid gap-3 whitespace-normal">
                  <span className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground">
                    <Icon className="size-4 text-clay" aria-hidden="true" />
                    {notification.label}
                  </span>
                  <span className="font-heading text-lg leading-tight">{notification.title}</span>
                  <span className="text-sm leading-6 text-muted-foreground">{notification.summary}</span>
                </span>
              </Button>
            </form>
          );
        })}
      </div>
    </section>
  );
}
