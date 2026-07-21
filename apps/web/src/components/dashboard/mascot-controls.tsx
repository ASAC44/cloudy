"use client";

import { useState, useTransition } from "react";
import { ArrowUp, Cloud, EyeClosed, Moon } from "lucide-react";

import { playMascotAction } from "@/app/(dashboard)/actions";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import type { MascotAction } from "@/types/api";

const actions = [
  { action: "blink", label: "Blink", icon: EyeClosed },
  { action: "yawn", label: "Yawn", icon: Cloud },
  { action: "sleep", label: "Sleep", icon: Moon },
  { action: "jump", label: "Jump", icon: ArrowUp },
] satisfies Array<{ action: MascotAction; label: string; icon: typeof EyeClosed }>;

export function MascotControls({ podId, online }: { podId: string; online: boolean }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState(online ? "Pick a move." : "Bring your Pod online to play.");

  function play(action: MascotAction) {
    startTransition(async () => {
      const result = await playMascotAction(podId, action);
      setMessage(result.error ?? result.success ?? "Animation queued.");
    });
  }

  return (
    <div className="mt-5 flex flex-col items-start gap-4 py-4">
      <div>
        <div className="flex items-center gap-2">
          <p className="font-heading text-lg">Play with Cloudy</p>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={`size-2 rounded-full ${online ? "bg-emerald-500" : "bg-muted-foreground/50"}`} aria-hidden="true" />
            {online ? "Online" : "Offline"}
          </span>
        </div>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {pending ? "Sending a move…" : message}
        </p>
      </div>
      <ButtonGroup className="min-w-0 w-full max-w-sm" aria-label="Mascot animations">
        {actions.map(({ action, label, icon: Icon }) => (
          <Button
            key={action}
            type="button"
            variant="outline"
            size="sm"
            className="min-w-0 flex-1"
            disabled={!online || pending}
            onClick={() => play(action)}
          >
            <Icon aria-hidden="true" />
            {label}
          </Button>
        ))}
      </ButtonGroup>
    </div>
  );
}
