"use client";

import { type DragEvent, type ReactNode, useRef, useState } from "react";
import {
  Bot,
  Box,
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
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { CodexOverview, Connection, ScreenDirection, ScreenLayout } from "@/types/api";
import { moveScreenItem } from "./screen-layout-state";

type AppItem = {
  id: string;
  name: string;
  detail: string;
  status: "ready" | "disconnected" | "attention";
  icon: LucideIcon;
};

const directions: Array<{ id: ScreenDirection; label: string; gesture: ReactNode }> = [
  { id: "left", label: "Screen 1", gesture: <><ChevronLeft aria-hidden="true" /> Swipe left</> },
  { id: "down", label: "Screen 2", gesture: "Default screen" },
  { id: "right", label: "Screen 3", gesture: <>Swipe right <ChevronRight aria-hidden="true" /></> },
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
  const unassigned = Object.values(items).filter(({ id }) => !assigned.has(id));

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

  function move(itemId: string, target?: ScreenDirection) {
    const next = moveScreenItem(layoutRef.current, itemId, target);
    layoutRef.current = next;
    setLayout(next);
    void persist(next);
  }

  function drop(event: DragEvent, target: ScreenDirection) {
    event.preventDefault();
    event.stopPropagation();
    const itemId = event.dataTransfer.getData("text/plain");
    if (items[itemId]) move(itemId, target);
  }

  return (
    <section aria-labelledby="keychain-title" className="border-y border-border py-8">
      <div className="mb-6 flex items-start justify-between gap-6">
        <div>
          <h2 id="keychain-title" className="text-heading-sm">Screen layout</h2>
          <p className="mt-1 max-w-2xl text-muted-foreground">Drag apps between screens or use their move menu. Dropping onto an occupied screen swaps the apps. Screen 2 stays default; the mascot appears only after the Pod becomes inactive.</p>
        </div>
        <span className={cn("shrink-0 text-caption", syncStatus === "error" ? "text-destructive" : "text-muted-foreground")} aria-live="polite">
          {syncStatus === "saving" ? "Syncing…" : syncStatus === "error" ? "Sync failed · reverted" : "Synced to Pod"}
        </span>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {directions.map((direction) => {
          return (
            <Card
              key={direction.id}
              className="min-h-72 gap-0 border-border/70 bg-card/75 px-4 py-5 shadow-sm shadow-foreground/5 md:px-5"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => drop(event, direction.id)}
            >
              <div className="mb-5 flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-sans text-sm font-medium">{direction.label}</h3>
                  <p className="mt-1 flex items-center gap-0.5 text-caption text-muted-foreground [&_svg]:size-3">{direction.gesture}</p>
                </div>
                <span className="text-caption text-muted-foreground">{layout[direction.id].length}/1</span>
              </div>
              <div className="space-y-1">
                {layout[direction.id].length ? layout[direction.id].map((itemId) => (
                  <AppRow key={itemId} item={items[itemId] ?? missingItem(itemId)} direction={direction.id} move={move} drop={drop} />
                )) : (
                  <p className="py-8 text-sm text-muted-foreground">Drop an app here.</p>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      <div
        className="mt-3 rounded-2xl border border-border/60 bg-card/45 px-4 py-4 shadow-sm shadow-foreground/5 sm:px-5"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const itemId = event.dataTransfer.getData("text/plain");
          if (items[itemId]) move(itemId);
        }}
      >
        <div className="mb-3 flex items-center justify-between gap-4">
          <div>
            <h3 className="font-sans text-sm font-medium">Unassigned apps and MCPs</h3>
            <p className="text-caption text-muted-foreground">Connected, but not shown on a swipe screen.</p>
          </div>
          <span className="text-caption text-muted-foreground">{unassigned.length}</span>
        </div>
        <div className="grid gap-1 sm:grid-cols-2 sm:gap-x-6">
          {unassigned.length ? unassigned.map((item) => (
            <AppRow key={item.id} item={item} move={move} />
          )) : <p className="py-3 text-sm text-muted-foreground">Every app is assigned.</p>}
        </div>
      </div>
    </section>
  );
}

function AppRow({ item, direction, move, drop }: {
  item: AppItem;
  direction?: ScreenDirection;
  move: (itemId: string, target?: ScreenDirection) => void;
  drop?: (event: DragEvent, target: ScreenDirection) => void;
}) {
  const Icon = item.icon;
  return (
    <div
      draggable
      className="group flex min-h-14 cursor-grab items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-background/70 active:cursor-grabbing"
      onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item.id); }}
      onDragOver={(event) => direction && event.preventDefault()}
      onDrop={(event) => direction && drop?.(event, direction)}
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
