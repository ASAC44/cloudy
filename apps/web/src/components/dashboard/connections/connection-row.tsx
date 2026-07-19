import { MoreHorizontal, Pencil, RefreshCw, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { Connection } from "@/types/api";
import { cn } from "@/lib/utils";

import { ProviderLogo } from "./provider-logo";
import { getProvider } from "./providers";

const dateTime = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export function ConnectionRow({
  connection,
  testing,
  onTest,
  onEdit,
  onReconnect,
  onRemove,
}: {
  connection: Connection;
  testing: boolean;
  onTest: () => void;
  onEdit: () => void;
  onReconnect: () => void;
  onRemove: () => void;
}) {
  const provider = getProvider(connection.provider)!;
  const status = testing ? "Testing" : connection.status === "connected" ? "Connected" : connection.status === "failed" ? "Needs attention" : "Not tested";

  return (
    <Card size="sm" className="h-full gap-0 py-0 transition-colors hover:border-clay/50">
      <CardHeader className="flex flex-row items-center border-b border-chalk py-4">
        <div className="relative flex size-10 items-center justify-center rounded-full border border-border bg-background">
          <span className={cn(
            "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-background",
            testing && "animate-pulse bg-clay",
            !testing && connection.status === "connected" && "bg-clay",
            !testing && connection.status !== "connected" && "bg-muted-foreground/45",
          )} aria-hidden="true" />
          <ProviderLogo provider={connection.provider} className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-sans font-medium">{connection.name}</p>
          <p className="truncate text-caption text-muted-foreground">{provider.label}</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More actions for ${connection.name}`} />}>
            <MoreHorizontal aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}><Pencil aria-hidden="true" />Edit</DropdownMenuItem>
            <DropdownMenuItem onClick={onReconnect}><RefreshCw aria-hidden="true" />{connection.auth_type === "oauth" ? "Reconnect" : "Replace token"}</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onRemove}><Trash2 aria-hidden="true" />Disconnect</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardHeader>
      <CardContent className="flex min-h-36 flex-1 flex-col py-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Badge variant={connection.status === "failed" ? "outline" : "secondary"}>{status}</Badge>
          {connection.account_label ? <span className="text-caption text-muted-foreground">{connection.account_label}</span> : null}
        </div>
        <p className="mt-4 line-clamp-2 break-all text-sm leading-5 text-muted-foreground">{connection.endpoint_url}</p>
        {connection.last_error ? <p className="mt-1 text-sm text-destructive">{connection.last_error}</p> : null}
        {connection.last_tested_at ? <p className="mt-auto pt-4 text-caption text-muted-foreground">Last tested {dateTime.format(new Date(connection.last_tested_at))} UTC</p> : null}
      </CardContent>
      <CardFooter className="justify-end border-chalk bg-secondary/35 px-4 py-3">
        <Button variant="ghost" size="sm" onClick={onTest} disabled={testing || undefined}>
          <RefreshCw className={cn(testing && "animate-spin")} aria-hidden="true" />
          {testing ? "Testing" : "Test"}
        </Button>
      </CardFooter>
    </Card>
  );
}
