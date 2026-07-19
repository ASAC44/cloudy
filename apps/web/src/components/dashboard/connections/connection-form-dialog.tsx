import type { FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import type { Connection, ConnectionProvider } from "@/types/api";

import { getProvider } from "./providers";

export function ConnectionFormDialog({
  provider,
  editing,
  authType,
  pending,
  onAuthTypeChange,
  onClose,
  onSubmit,
}: {
  provider: ConnectionProvider | null;
  editing: Connection | null;
  authType: "none" | "bearer";
  pending: boolean;
  onAuthTypeChange: (authType: "none" | "bearer") => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const definition = getProvider(provider);
  const oauth = provider === "github" || provider === "gmail";
  const asksForToken = provider === "vercel" || provider === "telegram" || provider === "linear" || provider === "stripe" || (provider === "custom_mcp" && authType === "bearer");
  const tokenLabel = provider === "telegram"
    ? "Bot token"
    : provider === "linear"
      ? "Linear API key"
      : provider === "stripe"
        ? "Stripe restricted API key"
        : "Access token";

  return (
    <Dialog open={Boolean(provider)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <form key={`${editing?.id ?? "new"}-${provider}`} onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.name}` : `Connect ${definition?.label}`}</DialogTitle>
            <DialogDescription>{editing ? "Update the name or credentials, then run a fresh smoke test." : definition?.description}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-5 py-6">
            <div className="grid gap-2">
              <Label htmlFor="connection-name">Connection name</Label>
              <Input id="connection-name" name="name" required maxLength={80} defaultValue={editing?.name ?? definition?.label ?? ""} />
            </div>
            {provider === "custom_mcp" ? (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="connection-endpoint">MCP endpoint</Label>
                  <Input id="connection-endpoint" name="endpoint_url" type="url" required maxLength={2000} placeholder="https://example.com/mcp" defaultValue={editing?.endpoint_url} />
                  <p className="text-caption text-muted-foreground">Public HTTPS endpoints on port 443 only.</p>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="connection-auth">Authentication</Label>
                  <NativeSelect id="connection-auth" value={authType} onChange={(event) => onAuthTypeChange(event.target.value as "none" | "bearer")}>
                    <NativeSelectOption value="none">No authentication</NativeSelectOption>
                    <NativeSelectOption value="bearer">Bearer token</NativeSelectOption>
                  </NativeSelect>
                </div>
              </>
            ) : null}
            {asksForToken ? (
              <div className="grid gap-2">
                <Label htmlFor="connection-token">{tokenLabel}</Label>
                <Input id="connection-token" name="token" type="password" autoComplete="off" required={!editing || (provider === "custom_mcp" && editing.auth_type !== "bearer")} maxLength={5000} placeholder={editing ? "Leave blank to keep the saved token" : "Paste token"} />
                {provider === "stripe" ? <p className="text-caption text-muted-foreground">Use a restricted sandbox key with only the permissions this Ping needs. Avoid unrestricted and live keys while testing.</p> : null}
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Checking…" : editing ? "Save & test" : oauth ? "Continue with OAuth" : "Save & test"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
