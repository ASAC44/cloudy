import type { ScreenDirection, ScreenLayout } from "@/types/api";

const screenDirections: ScreenDirection[] = ["left", "down", "right"];

export function moveScreenItem(layout: ScreenLayout, itemId: string, target?: ScreenDirection): ScreenLayout {
  const source = screenDirections.find((direction) => layout[direction].includes(itemId));
  const displaced = target ? layout[target][0] : undefined;
  const next = Object.fromEntries(screenDirections.map((direction) => [
    direction,
    layout[direction].filter((id) => id !== itemId),
  ])) as ScreenLayout;

  if (target) next[target] = [itemId];
  if (source && source !== target && displaced && displaced !== itemId) next[source] = [displaced];
  return next;
}
