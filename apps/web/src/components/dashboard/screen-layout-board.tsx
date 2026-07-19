"use client";

import { type DragEvent, type ReactNode, useState } from "react";
import {
  Bell,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  GitPullRequest,
  GripVertical,
  Mail,
  MessageSquare,
  MoreHorizontal,
  NotebookText,
  Rocket,
  Workflow,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

type LaneId = 0 | 1 | 2 | 3;
type Layout = Record<LaneId, string[]>;

type Feed = {
  name: string;
  detail: string;
  icon: LucideIcon;
};

const feeds: Record<string, Feed> = {
  calendar: { name: "Calendar", detail: "Upcoming events", icon: CalendarDays },
  notion: { name: "Notion", detail: "New tasks", icon: NotebookText },
  gmail: { name: "Gmail", detail: "Needs a reply", icon: Mail },
  important: { name: "Important", detail: "General alerts", icon: Bell },
  github: { name: "GitHub", detail: "Pull requests", icon: GitPullRequest },
  deployments: { name: "Deployments", detail: "Release actions", icon: Rocket },
  slack: { name: "Slack", detail: "Mentions and messages", icon: MessageSquare },
  n8n: { name: "n8n", detail: "Workflow approvals", icon: Workflow },
};

const initialLayout: Layout = {
  0: ["slack", "n8n"],
  1: ["calendar", "notion"],
  2: ["gmail", "important"],
  3: ["github", "deployments"],
};

const screenLabels: Record<LaneId, string> = {
  0: "Unassigned",
  1: "Screen 1",
  2: "Screen 2",
  3: "Screen 3",
};

const screens = [1, 2, 3] as const;

export function ScreenLayoutBoard() {
  // ponytail: screen layout remains a local prototype until Pod settings are persisted.
  const [layout, setLayout] = useState(initialLayout);

  function moveFeed(feedId: string, targetLane: LaneId, beforeId?: string) {
    setLayout((current) => {
      const next: Layout = {
        0: current[0].filter((id) => id !== feedId),
        1: current[1].filter((id) => id !== feedId),
        2: current[2].filter((id) => id !== feedId),
        3: current[3].filter((id) => id !== feedId),
      };
      const targetIndex = beforeId ? next[targetLane].indexOf(beforeId) : -1;

      next[targetLane].splice(
        targetIndex === -1 ? next[targetLane].length : targetIndex,
        0,
        feedId,
      );

      return next;
    });
  }

  function handleDrop(event: DragEvent, lane: LaneId, beforeId?: string) {
    event.preventDefault();
    event.stopPropagation();
    const feedId = event.dataTransfer.getData("text/plain");

    if (feeds[feedId]) moveFeed(feedId, lane, beforeId);
  }

  return (
    <>
      <section aria-labelledby="screen-layout-title">
        <div className="mb-4">
          <div>
            <h2 id="screen-layout-title" className="text-heading-sm">
              Screen layout
            </h2>
            <p className="mt-1 text-muted-foreground">
              Drag feeds between screens or use their move menu.
            </p>
          </div>
        </div>

        <div>
          <div className="grid gap-3 md:grid-cols-3">
            {screens.map((screen) => (
              <ScreenLane
                key={screen}
                screen={screen}
                feedIds={layout[screen]}
                moveFeed={moveFeed}
                onDrop={handleDrop}
              />
            ))}
          </div>

          <div
            className="mt-3 rounded-2xl border border-border/60 bg-card/45 px-4 py-4 shadow-sm shadow-foreground/5 sm:px-5"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => handleDrop(event, 0)}
          >
            <div className="mb-3 flex items-center justify-between gap-4">
              <div>
                <h3 className="font-sans text-sm font-medium">
                  Unassigned feeds
                </h3>
                <p className="text-caption text-muted-foreground">
                  Connected, but not shown on the Pod.
                </p>
              </div>
              <span className="text-caption text-muted-foreground">
                {layout[0].length}
              </span>
            </div>
            <div className="grid gap-1 sm:grid-cols-2 sm:gap-x-6">
              {layout[0].map((feedId) => (
                <FeedRow
                  key={feedId}
                  feedId={feedId}
                  lane={0}
                  moveFeed={moveFeed}
                  onDrop={handleDrop}
                />
              ))}
            </div>
          </div>
        </div>
      </section>

    </>
  );
}

function ScreenLane({
  screen,
  feedIds,
  moveFeed,
  onDrop,
}: {
  screen: 1 | 2 | 3;
  feedIds: string[];
  moveFeed: (feedId: string, targetLane: LaneId, beforeId?: string) => void;
  onDrop: (event: DragEvent, lane: LaneId, beforeId?: string) => void;
}) {
  const direction: Record<1 | 2 | 3, ReactNode> = {
    1: (
      <>
        <ChevronLeft aria-hidden="true" /> Left swipe
      </>
    ),
    2: "Default screen",
    3: (
      <>
        Right swipe <ChevronRight aria-hidden="true" />
      </>
    ),
  };

  return (
    <Card
      data-screen={screen}
      className={cn(
        "min-h-72 gap-0 border-border/70 bg-card/75 px-4 py-5 shadow-sm shadow-foreground/5 md:px-5",
        screen === 2 && "border-clay/25 bg-secondary/45",
      )}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => onDrop(event, screen)}
    >
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-sans text-sm font-medium">Screen {screen}</h3>
            {screen === 2 ? (
              <span className="rounded-md bg-foreground px-1.5 py-0.5 text-[0.625rem] font-medium text-background">
                Home
              </span>
            ) : null}
          </div>
          <p className="mt-1 flex items-center gap-0.5 text-caption text-muted-foreground [&_svg]:size-3">
            {direction[screen]}
          </p>
        </div>
        <span className="text-caption text-muted-foreground">
          {feedIds.length}
        </span>
      </div>

      <div className="space-y-1">
        {feedIds.map((feedId) => (
          <FeedRow
            key={feedId}
            feedId={feedId}
            lane={screen}
            moveFeed={moveFeed}
            onDrop={onDrop}
          />
        ))}
      </div>
    </Card>
  );
}

function FeedRow({
  feedId,
  lane,
  moveFeed,
  onDrop,
}: {
  feedId: string;
  lane: LaneId;
  moveFeed: (feedId: string, targetLane: LaneId, beforeId?: string) => void;
  onDrop: (event: DragEvent, lane: LaneId, beforeId?: string) => void;
}) {
  const feed = feeds[feedId];
  const Icon = feed.icon;

  return (
    <div
      draggable
      className="group flex cursor-grab items-center gap-3 rounded-xl px-2 py-3 transition-colors hover:bg-background/70 active:cursor-grabbing"
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", feedId);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => onDrop(event, lane, feedId)}
    >
      <GripVertical
        className="size-4 shrink-0 text-mist group-hover:text-graphite dark:group-hover:text-muted-foreground"
        aria-hidden="true"
      />
      <Icon className="size-4 shrink-0 text-graphite dark:text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{feed.name}</div>
        <div className="truncate text-caption text-muted-foreground">
          {feed.detail}
        </div>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Move ${feed.name}`}
            />
          }
        >
          <MoreHorizontal aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          {([1, 2, 3, 0] as const).map((target) => (
            <DropdownMenuItem
              key={target}
              disabled={target === lane}
              onClick={() => moveFeed(feedId, target)}
            >
              {screenLabels[target]}
              {target === 2 ? " (Home)" : ""}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
