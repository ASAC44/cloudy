import { Badge } from "@/components/ui/badge";
import type { Connection } from "@/lib/api";

import { ConnectionRow } from "./connection-row";

export function ConnectionList({
  connections,
  totalCount,
  searching,
  testingId,
  onTest,
  onEdit,
  onReconnect,
  onRemove,
}: {
  connections: Connection[];
  totalCount: number;
  searching: boolean;
  testingId: string | null;
  onTest: (connection: Connection) => void;
  onEdit: (connection: Connection) => void;
  onReconnect: (connection: Connection) => void;
  onRemove: (connection: Connection) => void;
}) {
  return (
    <section aria-labelledby="saved-connections-title">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <h2 id="saved-connections-title" className="text-heading-sm">Your connections</h2>
          <p className="mt-1 text-muted-foreground">Credentials stay on the Podex server and are never sent to the Pod.</p>
        </div>
        <Badge variant="outline">{searching ? `${connections.length} of ${totalCount}` : totalCount} saved</Badge>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {connections.length ? connections.map((connection) => (
          <ConnectionRow
            key={connection.id}
            connection={connection}
            testing={testingId === connection.id}
            onTest={() => onTest(connection)}
            onEdit={() => onEdit(connection)}
            onReconnect={() => onReconnect(connection)}
            onRemove={() => onRemove(connection)}
          />
        )) : (
          <div className="border-y border-border py-8 md:col-span-2">
            <p className="font-medium">{searching ? "No saved connections match." : "No providers connected yet."}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {searching ? "Try a provider, account, or endpoint name." : "Choose a provider below to verify the first connection."}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
