"use client";

import { useActionState, useState } from "react";

import { saveAiSettings } from "@/app/(dashboard)/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AiSettings } from "@/lib/api";

const providers = {
  openai: {
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    model: "gpt-5",
    description: "OpenAI models through the official AI SDK provider.",
  },
  cerebras: {
    label: "Cerebras",
    endpoint: "https://api.cerebras.ai/v1",
    model: "gpt-oss-120b",
    description: "Fast inference through Cerebras' dedicated provider.",
  },
  openrouter: {
    label: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1",
    model: "openai/gpt-oss-120b",
    description: "Use OpenRouter's provider-prefixed model catalog.",
  },
  anthropic: {
    label: "Anthropic",
    endpoint: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-5",
    description: "Claude models through Anthropic's native API.",
  },
  custom: {
    label: "OpenAI-compatible",
    endpoint: "https://example.com/v1",
    model: "model-id",
    description: "Connect another public HTTPS endpoint with an OpenAI-compatible API.",
  },
} as const;

type Provider = keyof typeof providers;

export function AiSettingsForm({ settings }: { settings: AiSettings | null }) {
  const [state, action, pending] = useActionState(saveAiSettings, {});
  const [provider, setProvider] = useState<Provider>(settings?.provider ?? "cerebras");
  const [baseUrl, setBaseUrl] = useState(
    settings?.base_url ?? providers[provider].endpoint,
  );
  const [model, setModel] = useState(settings?.model ?? providers[provider].model);

  return (
    <form action={action} className="border-y border-border">
      <div className="grid gap-3 border-b border-border py-6 sm:grid-cols-[12rem_1fr] sm:gap-8">
        <div>
          <Label htmlFor="ai-provider">Provider</Label>
          <p className="mt-2 text-sm leading-5 text-muted-foreground">
            {providers[provider].description}
          </p>
        </div>
        <Select
          name="provider"
          value={provider}
          onValueChange={(value) => {
            if (!value) return;
            const next = value as Provider;
            setProvider(next);
            setBaseUrl(providers[next].endpoint);
            setModel(providers[next].model);
          }}
        >
          <SelectTrigger id="ai-provider" className="w-full">
            <SelectValue>
              {(value) => providers[value as Provider]?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectContent align="start">
            {Object.entries(providers).map(([value, option]) => (
              <SelectItem key={value} value={value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-3 border-b border-border py-6 sm:grid-cols-[12rem_1fr] sm:gap-8">
        <div>
          <Label htmlFor="ai-base-url">API endpoint</Label>
          <p className="mt-2 text-sm leading-5 text-muted-foreground">
            Include the version path used by the provider.
          </p>
        </div>
        <Input
          id="ai-base-url"
          name="base_url"
          type="url"
          required
          maxLength={2048}
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder={providers[provider].endpoint}
          className="font-mono"
        />
      </div>

      <div className="grid gap-3 border-b border-border py-6 sm:grid-cols-[12rem_1fr] sm:gap-8">
        <div>
          <Label htmlFor="ai-model">Model</Label>
          <p className="mt-2 text-sm leading-5 text-muted-foreground">
            Use the exact model ID from your provider.
          </p>
        </div>
        <Input
          id="ai-model"
          name="model"
          required
          maxLength={200}
          value={model}
          onChange={(event) => setModel(event.target.value)}
          placeholder={providers[provider].model}
          className="font-mono"
        />
      </div>

      <div className="grid gap-3 py-6 sm:grid-cols-[12rem_1fr] sm:gap-8">
        <div>
          <Label htmlFor="ai-api-key">API key</Label>
          <p className="mt-2 text-sm leading-5 text-muted-foreground">
            {settings?.has_api_key
              ? "A key is stored. Leave blank to keep it."
              : "Encrypted before it is stored."}
          </p>
        </div>
        <Input
          id="ai-api-key"
          name="api_key"
          type="password"
          required={!settings?.has_api_key}
          maxLength={1000}
          autoComplete="new-password"
          placeholder={settings?.has_api_key ? "••••••••••••••••" : "Enter API key"}
          className="font-mono"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border py-5">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {state.error ? <span className="text-destructive">{state.error}</span> : null}
          {state.success ? <span className="text-clay">{state.success}</span> : null}
          {!state.error && !state.success
            ? settings?.has_api_key ? "Provider configured" : "No provider configured"
            : null}
        </p>
        <div className="flex gap-2">
          <Button type="submit" name="intent" value="test" variant="outline" disabled={pending}>
            {pending ? "Working…" : "Save and test"}
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save settings"}
          </Button>
        </div>
      </div>
    </form>
  );
}
