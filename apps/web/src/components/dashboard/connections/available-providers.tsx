import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import type { ConnectionProvider } from "@/types/api";

import { ProviderLogo } from "./provider-logo";
import type { ProviderDefinition } from "./providers";

export function AvailableProviders({
  providers,
  searching,
  onConnect,
}: {
  providers: ProviderDefinition[];
  searching: boolean;
  onConnect: (provider: ConnectionProvider) => void;
}) {
  return (
    <section className="mt-14" aria-labelledby="available-connections-title">
      <div className="mb-4">
        <h2 id="available-connections-title" className="text-heading-sm">Add a connection</h2>
        <p className="mt-1 text-muted-foreground">Smoke tests only read account identity or list available tools.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {providers.length ? providers.map((provider) => (
          <Card key={provider.key} size="sm" className="h-full gap-0 py-0 transition-colors hover:border-clay/50">
            <CardHeader className="border-b border-chalk py-4">
              <div className="flex size-10 items-center justify-center rounded-full border border-border bg-secondary/50">
              <ProviderLogo provider={provider.key} className="size-5" />
              </div>
            </CardHeader>
            <CardContent className="min-h-36 flex-1 py-5">
              <h3 className="font-sans text-lg font-medium">{provider.label}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{provider.description}</p>
            </CardContent>
            <CardFooter className="border-chalk bg-secondary/35 px-4 py-3">
              <Button className="w-full" variant="outline" onClick={() => onConnect(provider.key)}>Connect {provider.label}</Button>
            </CardFooter>
          </Card>
        )) : (
          <div className="border-y border-border py-8 md:col-span-2 xl:col-span-3">
            <p className="font-medium">No MCPs match.</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {searching ? "Try searching by provider, protocol, or capability." : "No providers are available."}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
