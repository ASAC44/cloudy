"use client";

import { useSyncExternalStore } from "react";
import { Switch } from "@/components/ui/switch";

export const DEMO_MODE_STORAGE_KEY = "cloudy:demo-mode";

const subscribe = (onStoreChange: () => void) => {
  window.addEventListener("storage", onStoreChange);
  return () => window.removeEventListener("storage", onStoreChange);
};

const read = () => localStorage.getItem(DEMO_MODE_STORAGE_KEY) === "on";

export function DemoModeToggle() {
  const enabled = useSyncExternalStore(subscribe, read, () => false);

  function update(next: boolean) {
    localStorage.setItem(DEMO_MODE_STORAGE_KEY, next ? "on" : "off");
    window.dispatchEvent(new StorageEvent("storage", { key: DEMO_MODE_STORAGE_KEY }));
  }

  return (
    <div className="flex items-center justify-between border-y border-border py-5">
      <div>
        <p className="text-sm font-medium">Demo mode</p>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          Use a scripted Sentry and Datadog conversation on Home for screen recordings.
        </p>
      </div>
      <Switch checked={enabled} onCheckedChange={update} aria-label="Demo mode" />
    </div>
  );
}
