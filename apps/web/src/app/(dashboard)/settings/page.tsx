import { AiSettingsForm } from "@/components/dashboard/ai-settings-form";
import { DemoModeToggle } from "@/components/dashboard/demo-mode-toggle";
import { ThemeToggle } from "@/components/theme-toggle";
import { apiFetch } from "@/lib/api";
import type { AiSettings } from "@/types/api";

export default async function SettingsPage() {
  let settings: AiSettings | null = null;
  let error = "";
  try {
    ({ settings } = await apiFetch<{ settings: AiSettings | null }>("/v1/settings/ai"));
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Settings could not be loaded";
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-12 md:px-10 md:py-16">
      <header className="max-w-3xl border-b border-border pb-10">
        <h1 className="text-[clamp(2.5rem,6vw,4.5rem)] leading-none tracking-[-0.04em]">
          Choose the model behind Cloudy.
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground">
          Use OpenAI, Cerebras, OpenRouter, Anthropic, or another compatible API.
          Your key remains server-side and encrypted at rest.
        </p>
      </header>

      <section className="grid gap-8 py-10 md:grid-cols-[minmax(0,0.7fr)_minmax(22rem,1.3fr)] md:gap-16">
        <div>
          <h2 className="font-sans text-lg font-medium">AI provider</h2>
          <p className="mt-2 max-w-sm leading-6 text-muted-foreground">
            Pick a provider, enter its exact model ID, then save or run a small
            connection test.
          </p>
        </div>
        <div>
          {error ? (
            <p className="border-y border-destructive/30 py-3 text-sm text-destructive">
              {error}
            </p>
          ) : (
            <AiSettingsForm settings={settings} />
          )}
        </div>
      </section>

      <section className="grid gap-8 border-t border-border py-10 md:grid-cols-[minmax(0,0.7fr)_minmax(22rem,1.3fr)] md:gap-16">
        <div>
          <h2 className="font-sans text-lg font-medium">Appearance</h2>
          <p className="mt-2 max-w-sm leading-6 text-muted-foreground">
            Choose the theme used across the dashboard.
          </p>
        </div>
        <div className="flex items-center justify-between border-y border-border py-5">
          <div>
            <p className="text-sm font-medium">Color theme</p>
            <p className="mt-1 text-sm text-muted-foreground">Switch between light and dark.</p>
          </div>
          <ThemeToggle />
        </div>
      </section>

      <section className="grid gap-8 border-t border-border py-10 md:grid-cols-[minmax(0,0.7fr)_minmax(22rem,1.3fr)] md:gap-16">
        <div>
          <h2 className="font-sans text-lg font-medium">Presentation</h2>
          <p className="mt-2 max-w-sm leading-6 text-muted-foreground">
            Turn on a safe, local walkthrough for showing Cloudy to someone else.
          </p>
        </div>
        <DemoModeToggle />
      </section>
    </div>
  );
}
