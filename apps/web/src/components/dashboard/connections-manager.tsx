"use client";

import { useEffect, useState, useTransition, type FormEvent } from "react";
import { Search, X } from "lucide-react";
import { toast } from "sonner";

import {
  editConnection,
  removeConnection,
  saveConnection,
  startConnectionOAuth,
  testConnection,
} from "@/app/(dashboard)/actions";
import { AvailableProviders } from "@/components/dashboard/connections/available-providers";
import { ConnectionFormDialog } from "@/components/dashboard/connections/connection-form-dialog";
import { ConnectionList } from "@/components/dashboard/connections/connection-list";
import { DisconnectConnectionDialog } from "@/components/dashboard/connections/disconnect-connection-dialog";
import { getProvider, PROVIDERS } from "@/components/dashboard/connections/providers";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import type { Connection, ConnectionProvider } from "@/lib/api";

export function ConnectionsManager({
  initialConnections,
  initialError,
  oauthNotice,
}: {
  initialConnections: Connection[];
  initialError?: string;
  oauthNotice?: { type: "success" | "error"; text: string };
}) {
  const [connections, setConnections] = useState(initialConnections);
  const [selectedProvider, setSelectedProvider] = useState<ConnectionProvider | null>(null);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [authType, setAuthType] = useState<"none" | "bearer">("none");
  const [testing, setTesting] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Connection | null>(null);
  const [search, setSearch] = useState("");
  const [pending, startTransition] = useTransition();
  const activeProvider = editing?.provider ?? selectedProvider;
  const query = search.trim().toLowerCase();
  const visibleConnections = query
    ? connections.filter((connection) => {
        const provider = getProvider(connection.provider);
        return [connection.name, provider?.label, connection.account_label, connection.endpoint_url]
          .some((value) => value?.toLowerCase().includes(query));
      })
    : connections;
  const visibleProviders = query
    ? PROVIDERS.filter((provider) => [provider.label, provider.description]
        .some((value) => value.toLowerCase().includes(query)))
    : PROVIDERS;

  useEffect(() => {
    if (initialError) toast.error(initialError, { id: "connections-initial-error" });
    if (oauthNotice) toast[oauthNotice.type](oauthNotice.text, { id: "connections-oauth" });
  }, [initialError, oauthNotice]);

  function openProvider(provider: ConnectionProvider) {
    setEditing(null);
    setSelectedProvider(provider);
    setAuthType("none");
  }

  function openEdit(connection: Connection) {
    setSelectedProvider(null);
    setEditing(connection);
    setAuthType(connection.auth_type === "bearer" ? "bearer" : "none");
  }

  function closeDialog() {
    if (pending) return;
    setEditing(null);
    setSelectedProvider(null);
  }

  function replace(updated?: Connection) {
    if (!updated) return;
    setConnections((current) => current.some(({ id }) => id === updated.id)
      ? current.map((connection) => connection.id === updated.id ? updated : connection)
      : [...current, updated]);
  }

  function showError(error?: string) {
    toast.error(error ?? "Connection request failed.");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeProvider) return;
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const token = String(form.get("token") ?? "").trim();
    const endpoint = String(form.get("endpoint_url") ?? "").trim();

    startTransition(async () => {
      if ((activeProvider === "github" || activeProvider === "gmail") && !editing) {
        const result = await startConnectionOAuth(activeProvider, name);
        if (result.authorization_url) window.location.assign(result.authorization_url);
        else showError(result.error);
        return;
      }

      const result = editing
        ? await editConnection(editing.id, {
            name,
            ...(activeProvider === "custom_mcp" ? { endpoint_url: endpoint, auth_type: authType } : {}),
            ...(token ? { token } : {}),
          })
        : await saveConnection({
            provider: activeProvider,
            name,
            ...(activeProvider === "custom_mcp" ? { endpoint_url: endpoint, auth_type: authType } : {}),
            ...(token ? { token } : {}),
          });
      if (result.error) return showError(result.error);
      replace(result.connection);
      toast[result.connection?.status === "connected" ? "success" : "error"](
        result.connection?.status === "connected" ? `${name} connected.` : `${name} saved, but its test failed.`,
      );
      closeDialog();
    });
  }

  function runTest(connection: Connection) {
    setTesting(connection.id);
    startTransition(async () => {
      const result = await testConnection(connection.id);
      setTesting(null);
      if (result.error) return showError(result.error);
      replace(result.connection);
      toast[result.connection?.status === "connected" ? "success" : "error"](
        result.connection?.status === "connected"
          ? `${connection.name} is reachable.`
          : result.connection?.last_error ?? "Connection test failed.",
      );
    });
  }

  function reconnect(connection: Connection) {
    if (connection.provider !== "github" && connection.provider !== "gmail") return openEdit(connection);
    const provider = connection.provider;
    startTransition(async () => {
      const result = await startConnectionOAuth(provider, connection.name, connection.id);
      if (result.authorization_url) window.location.assign(result.authorization_url);
      else showError(result.error);
    });
  }

  function disconnect() {
    if (!removing) return;
    startTransition(async () => {
      const result = await removeConnection(removing.id);
      if (result.error) return showError(result.error);
      setConnections((current) => current.filter(({ id }) => id !== removing.id));
      toast.success(`${removing.name} disconnected.`);
      setRemoving(null);
    });
  }

  return (
    <>
      <div className="mb-10 border-y border-border py-4">
        <InputGroup className="h-11 max-w-xl rounded-xl bg-background">
          <InputGroupAddon aria-hidden="true">
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search MCPs and connections"
            aria-label="Search MCPs and connections"
          />
          {search ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setSearch("")}>
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
      </div>

      <ConnectionList
        connections={visibleConnections}
        totalCount={connections.length}
        searching={Boolean(query)}
        testingId={testing}
        onTest={runTest}
        onEdit={openEdit}
        onReconnect={reconnect}
        onRemove={setRemoving}
      />
      <AvailableProviders providers={visibleProviders} searching={Boolean(query)} onConnect={openProvider} />
      <ConnectionFormDialog
        provider={activeProvider}
        editing={editing}
        authType={authType}
        pending={pending}
        onAuthTypeChange={setAuthType}
        onClose={closeDialog}
        onSubmit={submit}
      />
      <DisconnectConnectionDialog
        connection={removing}
        pending={pending}
        onClose={() => setRemoving(null)}
        onConfirm={disconnect}
      />
    </>
  );
}
