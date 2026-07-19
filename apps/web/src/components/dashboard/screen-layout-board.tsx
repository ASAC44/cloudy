"use client";

import { type DragEvent, useRef, useState } from "react";
import {
  Bot,
  Box,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  GitPullRequest,
  GripVertical,
  Mail,
  MoreHorizontal,
  Send,
  Server,
  type LucideIcon,
} from "lucide-react";

import { savePodScreenLayout } from "@/app/(dashboard)/actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { CodexOverview, Connection, ScreenDirection, ScreenLayout } from "@/types/api";

type AppItem = {
  id: string;
  name: string;
  detail: string;
  status: "ready" | "disconnected" | "attention";
  icon: LucideIcon;
};

const directions: Array<{ id: ScreenDirection; label: string; hint: string; icon: LucideIcon }> = [
  { id: "left", label: "Swipe left", hint: "Move your finger left from Home", icon: ChevronLeft },
  { id: "right", label: "Swipe right", hint: "Move your finger right from Home", icon: ChevronRight },
  { id: "down", label: "Swipe down", hint: "Move your finger down from Home", icon: ChevronDown },
];

const appDefinitions: Array<{ provider: Connection["provider"] | "codex"; name: string; icon: LucideIcon }> = [
  { provider: "github", name: "GitHub", icon: GitPullRequest },
  { provider: "gmail", name: "Gmail", icon: Mail },
  { provider: "codex", name: "Codex", icon: Bot },
  { provider: "vercel", name: "Vercel", icon: Box },
  { provider: "telegram", name: "Telegram", icon: Send },
  { provider: "linear", name: "Linear", icon: CircleDot },
  { provider: "stripe", name: "Stripe", icon: Server },
];

export function ScreenLayoutBoard({
  podId,
  initialLayout,
  initialRevision,
  connections,
  codex,
}: {
  podId: string;
  initialLayout: ScreenLayout;
  initialRevision: number;
  connections: Connection[];
  codex: CodexOverview;
}) {
  const [layout, setLayout] = useState(initialLayout);
  const [syncStatus, setSyncStatus] = useState<"saved" | "saving" | "error">("saved");
  const layoutRef = useRef(initialLayout);
  const savedLayoutRef = useRef(initialLayout);
  const revisionRef = useRef(initialRevision);
  const pendingRef = useRef<ScreenLayout | null>(null);
  const savingRef = useRef(false);
  const items = buildItems(connections, codex);
  const assigned = new Set(Object.values(layout).flat());

  async function persist(next: ScreenLayout) {
    pendingRef.current = next;
    if (savingRef.current) return;
    savingRef.current = true;
    setSyncStatus("saving");
    while (pendingRef.current) {
      const target = pendingRef.current;
      pendingRef.current = null;
      const result = await savePodScreenLayout(podId, target, revisionRef.current);
      if (result.error || result.revision === undefined) {
        pendingRef.current = null;
        layoutRef.current = savedLayoutRef.current;
        setLayout(savedLayoutRef.current);
        setSyncStatus("error");
        savingRef.current = false;
        return;
      }
      savedLayoutRef.current = target;
      revisionRef.current = result.revision;
    }
    setSyncStatus("saved");
    savingRef.current = false;
  }

  function move(itemId: string, target?: ScreenDirection, beforeId?: string) {
    const current = layoutRef.current;
    const next: ScreenLayout = {
      left: current.left.filter((id) => id !== itemId),
      right: current.right.filter((id) => id !== itemId),
      down: current.down.filter((id) => id !== itemId),
    };
    if (target && next[target].length < 6) {
      const index = beforeId ? next[target].indexOf(beforeId) : -1;
      next[target].splice(index < 0 ? next[target].length : index, 0, itemId);
    }
    layoutRef.current = next;
    setLayout(next);
    void persist(next);
  }

  function drop(event: DragEvent, target: ScreenDirection, beforeId?: string) {
    event.preventDefault();
    event.stopPropagation();
    const itemId = event.dataTransfer.getData("text/plain");
    if (items[itemId]) move(itemId, target, beforeId);
  }

  return (
    <section aria-labelledby="keychain-title" className="border-y border-border py-8">
      <div className="mb-8 flex items-start justify-between gap-6">
        <div>
          <p className="mb-2 font-mono text-caption tracking-[0.16em] text-muted-foreground uppercase">AI keychain</p>
          <h2 id="keychain-title" className="text-heading-sm">Choose what each gesture opens</h2>
          <p className="mt-2 max-w-2xl text-muted-foreground">Attach connected apps and MCPs, then drag to set their order on the Pod.</p>
        </div>
        <span className={cn("shrink-0 text-caption", syncStatus === "error" ? "text-destructive" : "text-muted-foreground")} aria-live="polite">
          {syncStatus === "saving" ? "Syncing…" : syncStatus === "error" ? "Sync failed · reverted" : "Synced to Pod"}
        </span>
      </div>

      <div className="divide-y divide-border border-y border-border">
        {directions.map((direction) => {
          const DirectionIcon = direction.icon;
          return (
            <div
              key={direction.id}
              className="grid min-h-56 gap-6 py-7 lg:grid-cols-[15rem_1fr]"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => drop(event, direction.id)}
            >
              <div>
                <div className="flex items-center gap-2 text-lg font-medium"><DirectionIcon className="size-5" />{direction.label}</div>
                <p className="mt-2 text-sm text-muted-foreground">{direction.hint}</p>
                <p className="mt-5 font-mono text-caption text-muted-foreground">{layout[direction.id].length}/6 attached</p>
              </div>
              <div className="self-center">
                {layout[direction.id].length ? layout[direction.id].map((itemId) => (
                  <AppRow key={itemId} item={items[itemId] ?? missingItem(itemId)} direction={direction.id} move={move} drop={drop} />
                )) : (
                  <p className="py-8 text-sm text-muted-foreground">Nothing attached. Drag an app here or use its move menu.</p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="pt-8">
        <h3 className="text-lg font-medium">Available apps and MCPs</h3>
        <p className="mt-1 text-sm text-muted-foreground">Official apps combine connected accounts. Each Custom MCP stays separate.</p>
        <div className="mt-5 grid gap-x-8 sm:grid-cols-2">
          {Object.values(items).map((item) => (
            <AppRow key={item.id} item={item} move={move} disabled={assigned.has(item.id)} />
          ))}
        </div>
      </div>
    </section>
  );
}

function AppRow({ item, direction, move, drop, disabled }: {
  item: AppItem;
  direction?: ScreenDirection;
  move: (itemId: string, target?: ScreenDirection, beforeId?: string) => void;
  drop?: (event: DragEvent, target: ScreenDirection, beforeId?: string) => void;
  disabled?: boolean;
}) {
  const Icon = item.icon;
  return (
    <div
      draggable={!disabled}
      className={cn("group flex min-h-16 items-center gap-3 border-b border-border/70 py-3", disabled && "opacity-50")}
      onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item.id); }}
      onDragOver={(event) => direction && event.preventDefault()}
      onDrop={(event) => direction && drop?.(event, direction, item.id)}
    >
      <GripVertical className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <Icon className="size-5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2"><span className="truncate font-medium">{item.name}</span><StatusDot status={item.status} /></div>
        <p className="truncate text-caption text-muted-foreground">{item.detail}</p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`Move ${item.name}`} />}><MoreHorizontal /></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          {directions.map(({ id, label }) => <DropdownMenuItem key={id} disabled={id === direction} onClick={() => move(item.id, id)}>{label}</DropdownMenuItem>)}
          {direction ? <DropdownMenuItem onClick={() => move(item.id)}>Remove from Pod</DropdownMenuItem> : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function StatusDot({ status }: { status: AppItem["status"] }) {
  return <span className={cn("size-1.5 rounded-full", status === "ready" ? "bg-clay" : status === "attention" ? "bg-destructive" : "bg-muted-foreground/45")} aria-label={status} />;
}

function buildItems(connections: Connection[], codex: CodexOverview): Record<string, AppItem> {
  const items = Object.fromEntries(appDefinitions.map(({ provider, name, icon }) => {
    if (provider === "codex") {
      const online = codex.bridges.filter((bridge) => bridge.online).length;
      return [`app:${provider}`, { id: `app:${provider}`, name, icon, status: online && codex.target ? "ready" : codex.bridges.length ? "attention" : "disconnected", detail: online ? `${online} bridge online${codex.target ? " · target selected" : " · choose a target"}` : "Pair a local bridge" } satisfies AppItem];
    }
    const accounts = connections.filter((connection) => connection.provider === provider);
    const ready = accounts.filter((connection) => connection.status === "connected").length;
    return [`app:${provider}`, { id: `app:${provider}`, name, icon, status: ready ? "ready" : accounts.length ? "attention" : "disconnected", detail: ready ? `${ready} connected account${ready === 1 ? "" : "s"}` : accounts.length ? "Connection needs attention" : "Not connected" } satisfies AppItem];
  }));
  for (const connection of connections.filter(({ provider }) => provider === "custom_mcp")) {
    items[`connection:${connection.id}`] = { id: `connection:${connection.id}`, name: connection.name, icon: Server, status: connection.status === "connected" ? "ready" : connection.status === "failed" ? "attention" : "disconnected", detail: connection.account_label ?? connection.last_error ?? "Custom MCP" };
  }
  return items;
}

function missingItem(id: string): AppItem {
  return { id, name: "Unavailable MCP", icon: Server, status: "attention", detail: "Remove this attachment and reconnect it." };
}
